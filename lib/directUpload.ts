/** Graphics Designer uploads straight to Cloud Storage — the decision layer, pure.
 *
 *  Why the bytes skip the API: the Vercel relay refuses request bodies over
 *  4.5 MB (`relay.ts`), and the owner's originals run to ~50 MB. So each file
 *  goes **sign → PUT → finalize**: the API hands out a signed, write-once PUT
 *  for one server-named object plus a ticket; the browser PUTs the file to
 *  Cloud Storage with exactly the signed headers and no app token; finalize
 *  hands the ticket back and the API validates the bytes that actually landed.
 *  The backend keeps all of this behind `GD_DIRECT_UPLOADS`; while it is off
 *  the sign route answers 503 `direct_uploads_disabled` and the file goes up
 *  the old multipart route instead — when it fits through the relay.
 *
 *  What lives here is what can be proved without a network, a browser or a
 *  clock: which step to retry after which failure, when to fall back, how many
 *  times to try, what each refusal says in words, and the per-file row the
 *  screens draw. `api.ts` supplies the real effects (`directUpload`); the
 *  rules are pinned in `requestPolicy.test.ts`, the wiring in
 *  `api.timeout.test.ts`. Runtime imports are relative so vitest can load it.
 */

import { isAbortError, isUnanswered } from "./requestPolicy";
import { RELAY_BODY_LIMIT_BYTES } from "./relay";

const MB = 1024 * 1024;

/* ---------------------------------------------------------------- shapes -- */

export type BrandUploadSurface = "logo" | "font" | "guidelines" | "reference";
export type RunUploadSurface = "subject" | "background" | "prompt" | "element";
export type UploadSurface = BrandUploadSurface | RunUploadSurface;

/** Which way a file actually went up. */
export type UploadRoute = "direct" | "multipart";

const BRAND_SURFACES: readonly UploadSurface[] = ["logo", "font", "guidelines", "reference"];

export const isBrandSurface = (s: UploadSurface): s is BrandUploadSurface => BRAND_SURFACES.includes(s);

/** What these rules need of a `File`, so tests can hand in plain objects. */
export interface UploadFile { name: string; type: string; size: number }

/** The sign route's answer. `headers` go on the PUT exactly as given — the
 *  signature covers them, so one changed byte is a 403 from storage. */
export interface UploadSignature {
  surface: UploadSurface;
  upload_url: string;
  method: "PUT";
  headers: Record<string, string>;
  max_bytes: number;
  expires_at: string;
  ticket: string;
  ticket_expires_at: string;
}

export interface UploadOriginal {
  bytes: number | null;
  width: number | null;
  height: number | null;
  pages: number | null;
  /** A signed ATTACHMENT link: offered as a download, never put in an `<img>`. */
  download_url: string | null;
}

export interface UploadWorking { width: number; height: number; format: string }

/** Finalize's account of one stored file. */
export interface UploadSummary {
  surface: string;
  file: string | null;
  status: string;
  already_finalized: boolean;
  kind: string;
  content_id: string;
  original: UploadOriginal;
  working: UploadWorking | null;
  /** "1 of 3" when only the first page of a multi-page TIFF is used. */
  pages_used: string | null;
  flags: string[];
}

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** An `original` block, read with defaults — brand assets and references
 *  carry one only when they came in as a direct upload. */
export function readOriginal(raw: unknown): UploadOriginal | null {
  const o = obj(raw);
  if (!o) return null;
  return {
    bytes: num(o.bytes),
    width: num(o.width),
    height: num(o.height),
    pages: num(o.pages),
    download_url: str(o.download_url),
  };
}

/** Finalize's `upload`, read with a default for every field (the frontend
 *  ships minutes before the backend, so a field may be missing for a while). */
export function readUploadSummary(raw: unknown): UploadSummary | null {
  const o = obj(raw);
  if (!o) return null;
  const w = obj(o.working);
  const ww = num(w?.width);
  const wh = num(w?.height);
  return {
    surface: str(o.surface) ?? "",
    file: str(o.file),
    status: str(o.status) ?? "stored",
    already_finalized: o.already_finalized === true,
    kind: str(o.kind) ?? "",
    content_id: str(o.content_id) ?? "",
    original: readOriginal(o.original)
      ?? { bytes: null, width: null, height: null, pages: null, download_url: null },
    working: ww !== null && wh !== null ? { width: ww, height: wh, format: str(w?.format) ?? "" } : null,
    pages_used: str(o.pages_used),
    flags: Array.isArray(o.flags) ? o.flags.filter((f): f is string => typeof f === "string") : [],
  };
}

/** Request headers a browser will not let a page set (the Fetch standard's
 *  forbidden names): it sends its own and refuses ours, and Chrome logs each
 *  refusal as a console error. The sign answer carries `Host` — the storage
 *  library adds it to the headers it signs — and the browser's own `Host` is
 *  the same value, so leaving it to the browser keeps the signature valid. */
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "accept-charset", "accept-encoding", "access-control-request-headers", "access-control-request-method",
  "connection", "content-length", "cookie", "cookie2", "date", "dnt", "expect", "host", "keep-alive",
  "origin", "referer", "te", "trailer", "transfer-encoding", "upgrade", "via",
]);

/** The signed headers to set on the PUT: every one as signed — `Content-Type`
 *  and each `x-goog-*` exactly — except names only the browser may send. */
export function storageHeaders(signed: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(signed)) {
    const lower = name.toLowerCase();
    if (FORBIDDEN_REQUEST_HEADERS.has(lower) || lower.startsWith("proxy-") || lower.startsWith("sec-")) continue;
    out[name] = value;
  }
  return out;
}

/* ---------------------------------------------------------------- limits -- */

/** "48 MB", "4.3 MB" — and "12 KB" under a megabyte, never "0.0 MB". */
export const formatSize = (bytes: number): string => {
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / MB;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
};

const extOf = (name: string): string => {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
};

const isSvg = (f: UploadFile): boolean => f.type === "image/svg+xml" || extOf(f.name) === "svg";

/** The most the direct route takes for this file — the backend's
 *  `upload_intake.SURFACES`. The sign answer's `max_bytes` is the authority;
 *  this is what a picker checks before anything is sent. */
export function directCapFor(surface: UploadSurface, file: UploadFile): number {
  if (surface === "font") return 2 * MB;
  if (surface === "logo" && isSvg(file)) return 5 * MB;
  return 50 * MB;
}

/** The old multipart routes' own limits (`gd_brands.ASSET_RULES`,
 *  `REFERENCE_RULE`, `graphics_designer._*_UPLOAD_MAX_BYTES`). */
export const MULTIPART_LIMIT_BYTES: Readonly<Record<UploadSurface, number>> = {
  logo: 5 * MB,
  font: 2 * MB,
  guidelines: 20 * MB,
  reference: 10 * MB,
  subject: 10 * MB,
  background: 10 * MB,
  prompt: 10 * MB,
  element: 8 * MB,
};

/** Room a relayed request keeps for the multipart framing around the file. */
const MULTIPART_FRAMING_BYTES = 16 * 1024;

/** The largest file the multipart route can take on this deployment: its own
 *  limit, and through the relay never more than the relay passes. */
export function multipartLimit(surface: UploadSurface, relayed: boolean): number {
  const route = MULTIPART_LIMIT_BYTES[surface];
  return relayed ? Math.min(route, RELAY_BODY_LIMIT_BYTES - MULTIPART_FRAMING_BYTES) : route;
}

/** Words for a file the fallback cannot carry, or null when it can. Said
 *  plainly and before a byte is sent — the relay would answer an HTML 413. */
export function multipartRefusal(surface: UploadSurface, file: UploadFile, relayed: boolean): string | null {
  const limit = multipartLimit(surface, relayed);
  if (file.size <= limit) return null;
  return `This file is ${formatSize(file.size)}. Large uploads are not switched on for this server yet, ` +
    `so it takes files up to ${formatSize(limit)} — use a smaller file.`;
}

/* ---------------------------------------------------------------- errors -- */

export type UploadStep = "sign" | "put" | "finalize";

/** A PUT to storage that did not land: GCS's status, or 0 with why not. */
export class StoragePutError extends Error {
  readonly name = "StoragePutError";
  constructor(readonly status: number, readonly failure: "status" | "network" | "timeout") {
    super(failure === "status" ? `Storage answered ${status}` : `Storage upload ${failure}`);
  }
}

/** One file that did not upload, with words the person can act on as its
 *  message. `code` is the backend's when it gave one. */
export class UploadError extends Error {
  readonly name = "UploadError";
  constructor(
    message: string,
    readonly step: UploadStep | "multipart",
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
  }
}

interface ErrorFacts {
  status: number | null;
  code: string | null;
  message: string;
  detail: Record<string, unknown> | null;
  retryAfterS: number | null;
}

/** What a rejection carries, read structurally — `ApiError` lives in `api.ts`,
 *  which imports this module. Upload routes answer `{detail: {code, message,
 *  ...facts}}`; `ApiError` keeps that `detail`, the `code` and `Retry-After`. */
export function errorFacts(e: unknown): ErrorFacts {
  const o = obj(e);
  const detail = obj(o?.detail);
  return {
    status: num(o?.status),
    code: str(o?.code) ?? str(detail?.code),
    message: e instanceof Error ? e.message.trim() : "",
    detail,
    retryAfterS: num(o?.retryAfterS) ?? num(detail?.retry_after),
  };
}

/* -------------------------------------------------------------- verdicts -- */

/** What to do after a step fails.
 *  - `fallback` — send this file up the multipart route instead;
 *  - `restart`  — start over from sign (a new object, a new ticket);
 *  - `retry`    — the same step again after `waitMs` (finalize: same ticket);
 *  - `stop`     — the file did not upload; say why;
 *  - `drop`     — the caller cancelled; say nothing. */
export type Next =
  | { kind: "fallback" }
  | { kind: "restart" }
  | { kind: "retry"; waitMs: number }
  | { kind: "stop" }
  | { kind: "drop" };

/** Sign → PUT rounds one file may take, the first included. */
export const MAX_ROUNDS = 3;
/** Finalize retries on one ticket, after its first try. */
export const MAX_FINALIZE_RETRIES = 4;
export const RETRY_MIN_MS = 1_000;
export const RETRY_MAX_MS = 60_000;

export interface Tries {
  /** Sign → PUT rounds started so far, this one included (≥ 1). */
  rounds: number;
  /** Finalize failures on the current ticket so far, this one included. */
  finalizeRetries: number;
}

/** How long to wait before trying again: the server's `Retry-After` when it
 *  gave one, else a doubling backoff — clamped either way. */
export function retryWaitMs(e: unknown, attempt: number): number {
  const { retryAfterS } = errorFacts(e);
  const ms = retryAfterS !== null ? retryAfterS * 1000 : 1_500 * 2 ** Math.max(0, attempt - 1);
  return Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, ms));
}

/** An older backend without the route: a 404/405 with no code. A 404 WITH a
 *  code (`brand_not_found`, `run_not_found`) is the backend's answer. */
const routeMissing = (f: ErrorFacts): boolean => (f.status === 404 || f.status === 405) && f.code === null;

/** No answer, or one that may pass: a cut connection, our own deadline, a
 *  relay 504, a 5xx, a 429. */
const mayPass = (e: unknown, f: ErrorFacts): boolean =>
  isUnanswered(e) || (f.status !== null && (f.status >= 500 || f.status === 429));

export function nextStep(step: UploadStep, e: unknown, tries: Tries): Next {
  if (isAbortError(e)) return { kind: "drop" };
  const f = errorFacts(e);
  const roundLeft = tries.rounds < MAX_ROUNDS;

  if (step === "sign") {
    if (f.code === "direct_uploads_disabled" || routeMissing(f)) return { kind: "fallback" };
    // Signing creates nothing durable, so a sign that may pass is simply asked again.
    if (mayPass(e, f)) return roundLeft ? { kind: "retry", waitMs: retryWaitMs(e, tries.rounds) } : { kind: "stop" };
    return { kind: "stop" };
  }

  if (step === "put") {
    // A refused PUT (403 header mismatch, 4xx out of range, 412 a second PUT),
    // a dropped connection, a timeout: the signed URL is spent either way.
    return roundLeft ? { kind: "restart" } : { kind: "stop" };
  }

  // finalize
  // The host cannot render SVG at all; asking again only delays the answer,
  // which already says what to do instead.
  if (f.code === "svg_renderer_unavailable") return { kind: "stop" };
  // A 503 is an infrastructure fault that touched nothing (busy decode slot,
  // storage): the same ticket again. So is no answer at all — a retried
  // finalize with the same ticket answers the recorded result.
  if (f.status === 503 || mayPass(e, f)) {
    return tries.finalizeRetries <= MAX_FINALIZE_RETRIES
      ? { kind: "retry", waitMs: retryWaitMs(e, tries.finalizeRetries) }
      : { kind: "stop" };
  }
  // The ticket or the object is gone — a new upload can succeed where this
  // one cannot. A refusal of the FILE (413/415/422/409) would only be refused
  // again after re-sending all of it, so that stops with its reason instead.
  const ticketGone = (f.status === 403 && (f.code ?? "").startsWith("upload_ticket_")) || f.code === "upload_not_found";
  if (ticketGone) return roundLeft ? { kind: "restart" } : { kind: "stop" };
  return { kind: "stop" };
}

/* ----------------------------------------------------------------- words -- */

const KIND_LABEL: Readonly<Record<string, string>> = {
  png: "PNG", jpeg: "JPEG", webp: "WebP", tiff: "TIFF", svg: "SVG", pdf: "PDF", ttf: "TTF", otf: "OTF",
};

const listWords = (items: string[]): string =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;

const SURFACE_NOUN: Readonly<Record<UploadSurface, string>> = {
  logo: "logo", font: "font", guidelines: "guidelines PDF", reference: "reference",
  subject: "photo", background: "background photo", prompt: "attached image", element: "image element",
};

/** Words for a code whose message is not a sentence — a router's bare string
 *  refusal comes back as `{code: "logo_limit_reached", message:
 *  "logo_limit_reached"}`, and the multipart routes answer bare codes too. */
const CODE_WORDS: Readonly<Record<string, (s: UploadSurface) => string>> = {
  direct_uploads_disabled: () => "Large uploads are switched off on this server.",
  brand_not_editable: () => "This brand is built in — its kit cannot be changed here.",
  brand_not_found: () => "This brand no longer exists — it may have been archived.",
  run_not_found: () => "This design is no longer on file — start a new one.",
  logo_limit_reached: () => "This brand already has 8 logos — remove one first.",
  font_limit_reached: () => "This brand already has 16 font files — remove one first.",
  reference_cap_reached: () => "This brand already holds as many references as it can.",
  prompt_image_limit_reached: () => "This design already has 3 attached images.",
  file_too_large: (s) => `The file is larger than a ${SURFACE_NOUN[s]} upload takes.`,
  unsupported_file_type: (s) => `That file type is not accepted for a ${SURFACE_NOUN[s]}.`,
  image_too_large: () => "The image is too large to process — export it smaller and upload again.",
  empty_file: () => "The file is empty.",
  upload_ticket_expired: () => "The upload took too long to finish — please try again.",
  upload_ticket_invalid: () => "The upload could not be matched to its ticket — please try again.",
  upload_ticket_wrong_user: () => "The upload could not be matched to your session — please try again.",
  upload_ticket_wrong_target: () => "The upload could not be matched to this brand or design — please try again.",
  upload_ticket_wrong_surface: () => "The upload could not be matched to this kind of file — please try again.",
  upload_not_found: () => "The file did not reach storage — please try again.",
  upload_busy: () => "The server is busy with another large file — try again in a minute.",
  upload_storage_unavailable: () => "File storage did not answer — try again in a moment.",
  svg_renderer_unavailable: () => "SVG logos cannot be processed on this server right now — upload a PNG instead.",
};

const hasWords = (key: string | null): key is string =>
  key !== null && Object.prototype.hasOwnProperty.call(CODE_WORDS, key);

/** A message the backend wrote for a person — not a bare code, not the
 *  client's own "Request failed (500)" for a reply that had no `detail`. */
const isSentence = (msg: string, key: string | null): boolean =>
  msg !== "" && msg !== key && !/^Request failed/.test(msg) && /\s/.test(msg);

function putWords(e: StoragePutError): string {
  if (e.failure === "timeout") {
    return "Sending the file took more than 10 minutes, so it was stopped — try again on a faster connection.";
  }
  if (e.failure === "network") {
    return "The file could not be sent to storage — the connection failed, or storage turned this browser away. Please try again.";
  }
  if (e.status === 403) return "Storage refused the file because the upload link did not match — please try again.";
  if (e.status >= 500) return `Storage did not take the file (it answered ${e.status}) — please try again in a moment.`;
  return `Storage refused the file (it answered ${e.status}) — please try again.`;
}

const genericWords = (status: number | null): string => {
  if (status === 413) return "The file is too large.";
  if (status === 415) return "That file type is not accepted.";
  if (status !== null && status >= 500) return "The server could not take the file right now — please try again.";
  return status === null ? "The file did not upload." : `The file did not upload (the server answered ${status}).`;
};

/** A 415 names what would have been accepted, beside the export hint. */
function withAccepted(words: string, detail: Record<string, unknown> | null): string {
  const accepted = Array.isArray(detail?.accepted)
    ? detail.accepted.filter((k): k is string => typeof k === "string").map((k) => KIND_LABEL[k] ?? k.toUpperCase())
    : [];
  if (accepted.length === 0) return words;
  const said = words.toUpperCase();
  if (accepted.every((label) => said.includes(label.toUpperCase()))) return words;
  return `${words} Accepted here: ${listWords(accepted)}.`;
}

/** An `image_too_large` always says how large. */
function withDimensions(words: string, detail: Record<string, unknown> | null): string {
  const w = num(detail?.width);
  const h = num(detail?.height);
  if (w === null || h === null) return words;
  if (words.includes(`${w}x${h}`) || words.includes(`${w}×${h}`)) return words;
  return `The image is ${w}×${h} px. ${words}`;
}

/** One failure in words: the backend's own sentence when it wrote one, with
 *  the accepted formats on a 415 and the dimensions on an oversized image;
 *  words for a bare code; plain words for storage and the network. */
export function describeUploadError(e: unknown, surface: UploadSurface): string {
  if (e instanceof UploadError) return e.message;
  if (e instanceof StoragePutError) return putWords(e);
  if (e instanceof TypeError) return "The connection to the server dropped — please try again.";
  const f = errorFacts(e);
  const key = f.code ?? (hasWords(f.message) ? f.message : null);
  let words = isSentence(f.message, key)
    ? f.message
    : hasWords(key) ? CODE_WORDS[key](surface) : genericWords(f.status);
  if (key === "unsupported_file_type") words = withAccepted(words, f.detail);
  if (key === "image_too_large") words = withDimensions(words, f.detail);
  return words;
}

const FLAG_WORDS: Readonly<Record<string, string>> = {
  color_converted_without_profile: "Colours were converted without a colour profile, so they may look slightly different.",
  alpha_flattened_to_white: "Transparent areas were filled with white.",
};

/** Calm notes about a stored file — what the backend changed on the way in. */
export function uploadNotes(u: UploadSummary | null): string[] {
  if (!u) return [];
  const notes = u.flags.map((flag) => {
    const known = FLAG_WORDS[flag];
    if (known) return known;
    const plain = flag.replace(/_/g, " ").trim();
    return plain ? `${plain.charAt(0).toUpperCase()}${plain.slice(1)}.` : "";
  }).filter(Boolean);
  if (u.pages_used) notes.push(`Only page ${u.pages_used} is used.`);
  return notes;
}

/** How to render a URL from these responses: an absolute `https://` link is
 *  opened as it is — no app token, it is a signed link to storage; a relative
 *  `/api/...` path needs the authed blob fetch; anything else is not drawn. */
export function linkKind(url: string | null | undefined): "direct" | "authed" | null {
  if (!url) return null;
  if (/^https:\/\//i.test(url)) return "direct";
  if (url.startsWith("/api/")) return "authed";
  return null;
}

/* ------------------------------------------------------------ the rows -- */

export type UploadPhase = "preparing" | "sending" | "checking";

export interface UploadProgress {
  phase: UploadPhase;
  route: UploadRoute;
  sent: number;
  total: number;
}

export type RowPhase = "waiting" | UploadPhase | "stored" | "failed";

/** One file's line on screen, from waiting to stored or its reason. */
export interface UploadRow {
  id: string;
  name: string;
  size: number;
  phase: RowPhase;
  route: UploadRoute | null;
  sent: number;
  total: number;
  /** Why it did not upload; null unless `failed`. */
  reason: string | null;
  /** Calm notes about a stored file. */
  notes: string[];
  /** The original, as an attachment link — direct uploads only. */
  downloadUrl: string | null;
}

export const newRow = (id: string, file: UploadFile): UploadRow => ({
  id, name: file.name, size: file.size, phase: "waiting", route: null,
  sent: 0, total: file.size, reason: null, notes: [], downloadUrl: null,
});

export const rowProgress = (row: UploadRow, p: UploadProgress): UploadRow => ({
  ...row, phase: p.phase, route: p.route, sent: p.sent, total: p.total > 0 ? p.total : row.size,
});

export function rowStored(row: UploadRow, upload: UploadSummary | null, route: UploadRoute): UploadRow {
  const link = upload?.original.download_url ?? null;
  return {
    ...row, phase: "stored", route, sent: row.size, total: row.size, reason: null,
    notes: uploadNotes(upload),
    downloadUrl: linkKind(link) ? link : null,
  };
}

export const rowFailed = (row: UploadRow, reason: string): UploadRow => ({ ...row, phase: "failed", reason });

export const rowPercent = (row: UploadRow): number =>
  row.total > 0 ? Math.min(100, Math.round((row.sent / row.total) * 100)) : 0;

/** The row's status in words. */
export function rowStatus(row: UploadRow): string {
  switch (row.phase) {
    case "waiting": return "Waiting to upload";
    case "preparing": return "Preparing the upload…";
    case "sending":
      return row.route === "multipart"
        ? `Sending ${formatSize(row.size)}…`
        : `Sending — ${rowPercent(row)}% of ${formatSize(row.total)}`;
    case "checking": return "Checking the file…";
    case "stored": return "Stored";
    case "failed": return row.reason ?? "Did not upload.";
  }
}

/** The reason a row shows for any rejection. */
export function failureWords(e: unknown): string {
  if (isAbortError(e)) return "Stopped before it finished.";
  if (e instanceof Error && e.message.trim()) return e.message.trim();
  return "The file did not upload.";
}

/* ----------------------------------------------------------- one file -- */

/** At most this many files send at once in one batch. */
export const UPLOAD_CONCURRENCY = 3;

/** Runs tasks one at a time, in the order they were queued. A batch shares
 *  one so its finalizes never overlap: the backend decodes one large file per
 *  instance and answers 503 `upload_busy` to a second. */
export type SerialQueue = <T>(task: () => Promise<T>) => Promise<T>;

export function serialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** The effects one upload needs. `put` resolves with storage's HTTP status
 *  for any answer, and rejects with a `StoragePutError` when there was none
 *  (or with an `AbortError` when the caller cancelled). */
export interface UploadEffects<R> {
  sign: () => Promise<UploadSignature>;
  put: (sig: UploadSignature, onBytes: (sent: number, total: number) => void) => Promise<number>;
  finalize: (ticket: string) => Promise<R>;
  /** The old multipart route, for this one file. */
  multipart: () => Promise<R>;
  sleep?: (ms: number) => Promise<void>;
  finalizeQueue?: SerialQueue;
}

export interface UploadJob {
  surface: UploadSurface;
  file: UploadFile;
  /** True when API calls go through the Vercel relay (its 4.5 MB ceiling). */
  relayed: boolean;
  onProgress?: (p: UploadProgress) => void;
}

/** One file, sign → PUT → finalize, with the retry and fallback rules above.
 *  Resolves with the finalize body (or the multipart one) and the route it
 *  took; rejects with an `UploadError` whose message is the reason, or with
 *  the caller's own `AbortError`. */
export async function runDirectUpload<R>(
  job: UploadJob,
  fx: UploadEffects<R>,
): Promise<{ route: UploadRoute; body: R }> {
  const sleep = fx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const queue: SerialQueue = fx.finalizeQueue ?? (<T>(task: () => Promise<T>) => task());
  const { surface, file } = job;
  const tell = (phase: UploadPhase, route: UploadRoute, sent = 0, total = file.size) =>
    job.onProgress?.({ phase, route, sent, total });
  const stop = (step: UploadStep | "multipart", e: unknown): UploadError => {
    const f = errorFacts(e);
    return new UploadError(describeUploadError(e, surface), step, f.status, f.code);
  };

  const viaMultipart = async (): Promise<{ route: UploadRoute; body: R }> => {
    const refusal = multipartRefusal(surface, file, job.relayed);
    if (refusal) throw new UploadError(refusal, "multipart", null, "multipart_too_large");
    tell("sending", "multipart");
    try {
      const body = await fx.multipart();
      return { route: "multipart", body };
    } catch (e) {
      if (isAbortError(e)) throw e;
      throw stop("multipart", e);
    }
  };

  for (let rounds = 1; ; rounds += 1) {
    tell("preparing", "direct");
    let sig: UploadSignature;
    try {
      sig = await fx.sign();
    } catch (e) {
      const next = nextStep("sign", e, { rounds, finalizeRetries: 0 });
      if (next.kind === "fallback") return viaMultipart();
      if (next.kind === "drop") throw e;
      if (next.kind === "retry") {
        await sleep(next.waitMs);
        continue;
      }
      throw stop("sign", e);
    }

    tell("sending", "direct", 0, file.size);
    let putFailure: unknown = null;
    try {
      const status = await fx.put(sig, (sent, total) => tell("sending", "direct", sent, total));
      if (status < 200 || status >= 300) putFailure = new StoragePutError(status, "status");
    } catch (e) {
      putFailure = e;
    }
    if (putFailure !== null) {
      const next = nextStep("put", putFailure, { rounds, finalizeRetries: 0 });
      if (next.kind === "drop") throw putFailure;
      if (next.kind === "restart") continue;
      throw stop("put", putFailure);
    }

    let restart = false;
    for (let finalizeRetries = 0; !restart; ) {
      tell("checking", "direct", file.size, file.size);
      try {
        const body = await queue(() => fx.finalize(sig.ticket));
        return { route: "direct", body };
      } catch (e) {
        finalizeRetries += 1;
        const next = nextStep("finalize", e, { rounds, finalizeRetries });
        if (next.kind === "drop") throw e;
        if (next.kind === "retry") {
          await sleep(next.waitMs);
          continue;
        }
        if (next.kind === "restart") {
          restart = true;
          continue;
        }
        throw stop("finalize", e);
      }
    }
  }
}

/* ----------------------------------------------------------- a batch -- */

/** What every upload result carries, whichever route it took. */
export interface UploadOutcome { upload: UploadSummary | null; route: UploadRoute }

export interface UploadHooks {
  onProgress: (p: UploadProgress) => void;
  finalizeQueue: SerialQueue;
}

export type BatchResult<J, T> = { job: J; value: T } | { job: J; error: unknown };

export interface BatchOptions<J> {
  concurrency?: number;
  /** A reason to fail this job without sending it — a cap another file hit. */
  skip?: (job: J) => string | null;
  /** Told of every failure as it lands, before any later job is started. */
  onFailure?: (job: J, error: unknown) => void;
  /** Told of every success as it lands. */
  onStored?: (job: J, value: unknown) => void;
}

/** Several files, each with its own row and its own result: at most
 *  `UPLOAD_CONCURRENCY` sending at once, finalizes one at a time. No file is
 *  skipped silently — a skipped one fails with the reason `skip` gave. */
export async function uploadBatch<J extends { file: UploadFile }, T extends UploadOutcome>(
  jobs: readonly J[],
  send: (job: J, hooks: UploadHooks) => Promise<T>,
  onRows: (rows: UploadRow[]) => void,
  opts: BatchOptions<J> = {},
): Promise<BatchResult<J, T>[]> {
  let rows = jobs.map((j, i) => newRow(String(i), j.file));
  onRows(rows);
  const set = (i: number, fn: (r: UploadRow) => UploadRow) => {
    rows = rows.map((r, j) => (j === i ? fn(r) : r));
    onRows(rows);
  };
  const results: BatchResult<J, T>[] = new Array(jobs.length);
  const finalizeQueue = serialQueue();
  let next = 0;
  const lane = async () => {
    while (next < jobs.length) {
      const i = next;
      next += 1;
      const job = jobs[i];
      const skipped = opts.skip?.(job) ?? null;
      if (skipped) {
        set(i, (r) => rowFailed(r, skipped));
        results[i] = { job, error: new UploadError(skipped, "sign", null, null) };
        continue;
      }
      try {
        const value = await send(job, {
          onProgress: (p) => set(i, (r) => rowProgress(r, p)),
          finalizeQueue,
        });
        set(i, (r) => rowStored(r, value.upload, value.route));
        results[i] = { job, value };
        opts.onStored?.(job, value);
      } catch (error) {
        set(i, (r) => rowFailed(r, failureWords(error)));
        results[i] = { job, error };
        opts.onFailure?.(job, error);
      }
    }
  };
  const width = Math.max(1, Math.min(opts.concurrency ?? UPLOAD_CONCURRENCY, jobs.length));
  await Promise.all(Array.from({ length: width }, lane));
  return results;
}
