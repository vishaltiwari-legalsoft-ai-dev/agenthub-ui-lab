/** What the SEO agent's payloads mean on screen — pure, no React, no DOM.
 *
 *  These readings live here because each one used to be decided inline and
 *  got something untrue onto the page:
 *
 *  - **Search Console.** The Connect button rendered on servers where the
 *    connect flow could not finish, and the help text told people to share
 *    the property with a service account — contradicting the button beside
 *    it. `sources.gsc_connect` now decides whether a live button exists at all.
 *  - **The Google return.** `/oauth/google` serves two specialists. A state
 *    starting `gsc.` is Search Console's; anything else is the Inbox Triage
 *    path, untouched.
 *  - **Degraded notes.** A run's `degraded` list carries raw exception text
 *    (`Search Console: <HttpError 403 …>`). Known prefixes become a plain
 *    sentence; anything that still looks like a stack or a status line is
 *    replaced, never quoted.
 *  - **Topic provenance.** Every blog topic now says where it came from.
 *  - **Grounded advice.** Page rows whose chips are the whole message print no
 *    advice line (never a bare "Rule: "), audit findings show what backs them,
 *    decorative alt text is information rather than a severity, and whatever
 *    the evidence checks threw away is counted in one quiet line. The rows
 *    that draw these are in `rows.ts`.
 *
 *  Every new backend field is read with a default, because Vercel and Cloud
 *  Run deploy at different times and the older shape must still render.
 */

import type {
  SeoAuditIssue, SeoBrandCard, SeoBrief, SeoGa, SeoGscStatus, SeoOverview, SeoPageIntel, SeoPagesDoc,
  SeoPagesGrounding, SeoPlanItem, SeoReviewGrounding, SeoSiteReview, SeoTodo, SeoTopic,
} from "@/lib/api";
// Values come in by relative path: the test suite runs without the `@/` alias,
// which only erased type imports can use.
import { apiBody, apiCode, apiStatus, isTimeoutError } from "../../../lib/api";
import { describeFailure } from "../../../lib/load";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/* ------------------------------------------------------ Search Console -- */

/** Shown under the Connect button. The consent screen is external, so any
 *  Google account that has access to the property can connect. */
export const GSC_CONNECT_HINT = "Sign in with the Google account that has Search Console access to this site.";
/** Shown instead of a button when the server cannot finish the connect. */
export const GSC_CONNECT_UNAVAILABLE = "Search Console connect isn't set up on this server yet.";
/** A stored grant for some other site: not connected, and never "Connected by". */
export const GSC_MISMATCH = "Search Console connection is for a different site — reconnect it.";
/** Google Analytics has no connect flow — it is never drawn as a button. */
export const GA_SERVICE_ACCOUNT =
  "Google Analytics is read through our service account — a GA admin adds it as a Viewer on the property.";

/** The Integrations row for Google Analytics. There is no connect flow and
 *  no per-brand status in the overview, so the row states how access works
 *  and claims nothing else — no button, no Connected / Not connected. */
export const GA_INTEGRATION = {
  name: "Google Analytics",
  what: "Read through our service account; a GA admin adds it as a Viewer on each property.",
  usedBy: "SEO Analyst",
} as const;

/** A brand's Search Console block with every field present. `fallbackConnected`
 *  is the card's legacy `gsc_connected`, for a backend that sends no block.
 *  A GEO-only caller's cards carry neither, and read as not connected. A
 *  mismatched grant is never connected, whatever else the block says. */
export function readGsc(raw: Partial<SeoGscStatus> | null | undefined, fallbackConnected?: boolean): Required<SeoGscStatus> {
  const g = raw ?? {};
  const mismatch = g.mismatch === true;
  return {
    mismatch,
    connected: !mismatch && (typeof g.connected === "boolean" ? g.connected : fallbackConnected === true),
    property: str(g.property),
    connected_by: str(g.connected_by),
    connected_at: str(g.connected_at),
    service_account_property: str(g.service_account_property),
    reading: g.reading === true,
  };
}

/** Whether a live Connect button may be drawn. A backend older than the field
 *  had no working connect flow, so missing means no. */
export const canConnectGsc = (sources: Partial<SeoOverview["sources"]> | null | undefined): boolean =>
  sources?.gsc_connect === true;

/** "Oct 14, 2026" in the reader's zone; null for anything unparseable. */
export function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** "Connected by ana@brand.com · Oct 14, 2026", or as much of it as is known. */
export function connectedLine(g: Pick<SeoGscStatus, "connected" | "connected_by" | "connected_at">): string | null {
  if (!g.connected) return null;
  const by = str(g.connected_by);
  const when = shortDate(g.connected_at);
  if (by && when) return `Connected by ${by} · ${when}`;
  if (by) return `Connected by ${by}`;
  if (when) return `Connected · ${when}`;
  return null;
}

/** What the brand's action bar offers for Search Console.
 *  - `connected` — a chip, and the creator's Disconnect.
 *  - `connect` — a live button with the sign-in hint under it (or, for a
 *    grant on the wrong site, the line saying so).
 *  - `unavailable` — no button, one plain line.
 *  - `unknown` — the overview has not answered yet; no button, and no "not
 *    set up" flashed at a server where it is — only the mismatch line, which
 *    does not depend on the server. */
export type GscSlot =
  | { mode: "connected"; line: string | null }
  | { mode: "connect"; line: string }
  | { mode: "unavailable"; line: string }
  | { mode: "unknown"; line: string | null };

export function gscSlot(
  g: Pick<SeoGscStatus, "connected" | "connected_by" | "connected_at" | "mismatch"> | null,
  sources: Partial<SeoOverview["sources"]> | null | undefined,
): GscSlot {
  const mismatch = g?.mismatch === true;
  if (g?.connected && !mismatch) return { mode: "connected", line: connectedLine(g) };
  if (!sources) return { mode: "unknown", line: mismatch ? GSC_MISMATCH : null };
  if (canConnectGsc(sources)) return { mode: "connect", line: mismatch ? GSC_MISMATCH : GSC_CONNECT_HINT };
  return { mode: "unavailable", line: mismatch ? `${GSC_MISMATCH} ${GSC_CONNECT_UNAVAILABLE}` : GSC_CONNECT_UNAVAILABLE };
}

/** The Integrations row. Connected only on the backend's word that some brand
 *  really has Search Console behind it; otherwise "Not connected" with the
 *  hint that fits this server. `console` is set only when there is a working
 *  button to send the reader to. */
export function gscIntegration(sources: Partial<SeoOverview["sources"]> | null | undefined): {
  status: "on" | "off";
  note?: string;
  open: "dashboard" | "console" | null;
} {
  if (sources?.gsc === true) return { status: "on", open: "dashboard" };
  return canConnectGsc(sources)
    ? { status: "off", note: "Connect it per brand in the SEO console", open: "console" }
    : { status: "off", note: GSC_CONNECT_UNAVAILABLE, open: null };
}

/** The dashboard's Search Console notice, from the figures themselves:
 *  `measured` when the run has Search Console clicks, `mismatch` when the
 *  stored grant is for another site, `pending` when a grant exists but these
 *  figures predate it (or could not use it), `off` when there is none. */
export function gscNotice(
  gsc: Pick<SeoGscStatus, "connected" | "mismatch">,
  summary: { mode?: string; impressions_28d: number },
): "measured" | "mismatch" | "pending" | "off" {
  if (summary.mode !== "rank-tracking" && summary.impressions_28d > 0) return "measured";
  if (gsc.mismatch === true) return "mismatch";
  return gsc.connected ? "pending" : "off";
}

/* ------------------------------------------------------- the Google return -- */

export const GSC_STATE_PREFIX = "gsc.";
export const GSC_CANCELLED = "Search Console wasn't connected — the Google sign-in was cancelled.";
/** For any return code this console does not know. */
export const GSC_RETRY = "Search Console wasn't connected — try again.";
export const GSC_UNFINISHED = "Search Console wasn't connected — the connection couldn't be finished. Try again.";

function base64UrlText(part: string): string | null {
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** The brand a `gsc.<base64url JSON {b,u,t,n}>.<sig>` state names. Untrusted:
 *  the signature is the backend's to check, so this is for navigation and
 *  nothing else. Null for anything that does not decode to a sane id. */
export function gscStateBrand(state: string | null | undefined): string | null {
  if (!state || !state.startsWith(GSC_STATE_PREFIX)) return null;
  const body = state.slice(GSC_STATE_PREFIX.length).split(".")[0];
  if (!body) return null;
  const text = base64UrlText(body);
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    const b = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).b : null;
    // eslint-disable-next-line no-control-regex
    return typeof b === "string" && b.length > 0 && b.length <= 200 && !/[\u0000-\u001f]/.test(b) ? b : null;
  } catch {
    return null;
  }
}

/** Why Google sent the reader back without a code: they pressed Cancel, or
 *  something on Google's side (any other `error=`, or no code at all). */
export type GoogleRefusal = "cancelled" | "google_error";

export type GoogleReturn =
  | { kind: "inbox" }
  | { kind: "gsc"; code: string; state: string; brand: string | null }
  | { kind: "gsc-refused"; brand: string | null; reason: GoogleRefusal };

/** Which specialist a Google redirect belongs to, and what it carried. Inbox
 *  Triage states start with a hex user id, never `gsc.`, so anything without
 *  the prefix — including a bare `?error=` — is the inbox's, exactly as before. */
export function googleReturn(search: string): GoogleReturn {
  const q = new URLSearchParams(search);
  const state = q.get("state") ?? "";
  if (!state.startsWith(GSC_STATE_PREFIX)) return { kind: "inbox" };
  const brand = gscStateBrand(state);
  const error = q.get("error");
  if (error !== null) return { kind: "gsc-refused", brand, reason: error === "access_denied" ? "cancelled" : "google_error" };
  const code = q.get("code");
  if (!code) return { kind: "gsc-refused", brand, reason: "google_error" };
  return { kind: "gsc", code, state, brand };
}

/* The return link carries a code and nothing else. A sentence in the address
 * bar is a sentence anyone can write — "Your account is locked, call …" — and
 * the workspace would say it in the console's voice. So the link names what
 * happened and the sentence comes from this table; a code the table does not
 * know is the generic retry line. */

/** A code as the link may carry it: lowercase letters and underscores. */
const RETURN_CODE = /^[a-z_]{1,40}$/;

/** Every code's fixed sentence. `gsc_no_property` names the site from the
 *  brand the console already has, never from the link. Codes that cover more
 *  than one backend situation get a sentence true of each. */
const RETURN_SENTENCES: Record<string, (site: string) => string> = {
  cancelled: () => GSC_CANCELLED,
  google_error: () => "Search Console wasn't connected — Google didn't finish the sign-in. Try again.",
  unknown_brand: () => "Search Console wasn't connected — that brand isn't in the SEO list any more.",
  timeout: () => "Search Console wasn't connected — the server took too long to answer. Try again.",
  failed: () => GSC_UNFINISHED,
  gsc_oauth_unconfigured: () => "Search Console wasn't connected — connect isn't set up on this server yet. An admin needs to finish the Google setup.",
  gsc_offline: () => "Search Console wasn't connected — it can't be reached from this server right now.",
  gsc_state_invalid: () => "Search Console wasn't connected — the connect link wasn't valid. Start again from the SEO console.",
  gsc_state_expired: () => "Search Console wasn't connected — the connect window expired. Start again from the SEO console.",
  gsc_state_other_user: () => "Search Console wasn't connected — the connect link was started from a different account. Start again from the SEO console.",
  gsc_scope_not_granted: () => "Search Console wasn't connected — Google didn't grant read access to Search Console. Connect again and allow it.",
  gsc_no_property: (site) => `Search Console wasn't connected — this Google account has no Search Console access to ${site}. Sign in with an account that does, or ask the site owner to add it.`,
  gsc_exchange_failed: () => "Search Console wasn't connected — Google didn't complete the permission. Press Connect again; if it keeps failing, remove AgentOS at myaccount.google.com/permissions first.",
  gsc_google_unavailable: () => "Search Console wasn't connected — Google didn't answer properly. Press Connect again.",
  gsc_property_taken: () => "Search Console wasn't connected — that Search Console property is already connected to another brand.",
};

/** The sentence for a return code. `site` is the brand's domain as the
 *  console knows it (null while unknown). */
export function gscReturnSentence(code: string | null | undefined, site: string | null | undefined): string {
  const say = code ? RETURN_SENTENCES[code] : undefined;
  return say ? say(str(site) ?? "this site") : GSC_RETRY;
}

/** The code for a refused complete: the backend's own `gsc_*` code, or what
 *  kind of failure it was. Never its message — that stays off the link. */
export function gscFailureCode(e: unknown): string {
  const code = apiCode(e);
  if (code && code.startsWith("gsc_") && RETURN_CODE.test(code)) return code;
  if (apiStatus(e) === 404) return "unknown_brand";
  if (isTimeoutError(e)) return "timeout";
  return "failed";
}

/** Where the browser lands after the return: the brand's console, where the
 *  Connect button was, with one code for the workspace to say out loud. */
export function gscReturnPath(brand: string | null, outcome: { connected: true } | { code: string }): string {
  const route = brand ? `/#/w/seo/${encodeURIComponent(brand)}/console` : "/#/w/seo";
  const code = "code" in outcome ? (RETURN_CODE.test(outcome.code) ? outcome.code : "failed") : "connected";
  return `${route}?gsc=${code}`;
}

export interface GscReturnFlags {
  connected: boolean;
  /** What went wrong, as a code — null for success or no return at all. */
  code: string | null;
}

export const NO_GSC_RETURN: GscReturnFlags = { connected: false, code: null };

/** Whether the return toast has to wait for the overview: the success line
 *  names the brand, and `gsc_no_property` names its domain. Every other
 *  code's sentence is fixed, so it is said the moment the page opens. */
export const returnNeedsOverview = (f: GscReturnFlags): boolean =>
  f.connected || f.code === "gsc_no_property";

/** The code `gscReturnPath` left on the hash, read back by the workspace.
 *  Anything else on the link is ignored; a value that is not a code shape
 *  reads as an unknown code, so it gets the generic line. */
export function readGscReturn(hash: string): GscReturnFlags {
  const i = hash.indexOf("?");
  if (i < 0) return NO_GSC_RETURN;
  const flag = new URLSearchParams(hash.slice(i + 1)).get("gsc");
  if (flag === null || flag === "") return NO_GSC_RETURN;
  if (flag === "connected") return { connected: true, code: null };
  return { connected: false, code: RETURN_CODE.test(flag) ? flag : "unknown" };
}

/** The sentence for a refused Search Console call made from this page (the
 *  Connect button's start). A coded refusal's message is written for the
 *  reader and comes from an API reply, not a link, so it is shown as-is; a
 *  timeout keeps its own words; anything else — a 500, a dropped connection —
 *  gets one calm sentence rather than "Request failed (500)". */
export function gscFailure(e: unknown, fallback: string = GSC_UNFINISHED): string {
  const code = apiCode(e);
  if (code && code.startsWith("gsc_")) {
    const detail = apiBody(e).detail;
    const message = detail && typeof detail === "object" ? str((detail as Record<string, unknown>).message) : null;
    return message ?? describeFailure(e, fallback);
  }
  if (apiStatus(e) === 404) return "That brand isn't in the SEO list any more.";
  if (isTimeoutError(e)) return e.message;
  return fallback;
}

export interface GoogleReturnIO {
  completeGsc: (code: string, state: string) => Promise<{ brand_id?: unknown } | null | undefined>;
  /** The Inbox Triage exchange, run exactly as it always was. */
  inbox: () => void;
  go: (path: string) => void;
}

/** The whole `/oauth/google` decision, with the side effects handed in so the
 *  routing is provable without a browser. A Google refusal never reaches the
 *  backend: there is no code to exchange. */
export async function finishGoogleReturn(ret: GoogleReturn, io: GoogleReturnIO): Promise<void> {
  if (ret.kind === "inbox") {
    io.inbox();
    return;
  }
  if (ret.kind === "gsc-refused") {
    io.go(gscReturnPath(ret.brand, { code: ret.reason }));
    return;
  }
  try {
    const res = await io.completeGsc(ret.code, ret.state);
    io.go(gscReturnPath(str(res?.brand_id) ?? ret.brand, { connected: true }));
  } catch (e) {
    io.go(gscReturnPath(ret.brand, { code: gscFailureCode(e) }));
  }
}

/* -------------------------------------------------------- degraded notes -- */

/** What the brand's Search Console can do about a failed read. */
export type GscRemedy = "connected" | "connectable" | "unavailable";

export interface NoteContext {
  site: string;
  gsc: GscRemedy;
}

/** Notes the backend writes for people; they render word for word. */
export const PLAIN_TOPIC_NOTES: readonly string[] = [
  "Topics aren't checked against what you sell yet — run Analyze website.",
  "Your site review lists no covered or missing topics, so the blog plan isn't checked against what you sell — re-run Analyze website.",
];

const GENERIC_NOTE = "Part of this analysis couldn't be completed — the figures shown are the ones that came back.";

function searchConsoleNote(c: NoteContext): string {
  if (c.gsc === "connected") {
    return `Search Console is connected but couldn't be read for ${c.site} — the Google account that connected it may have lost access to the property.`;
  }
  if (c.gsc === "connectable") {
    return `Search Console couldn't be read for ${c.site}. Press Connect Search Console and sign in with the Google account that has access to this site, then refresh the data.`;
  }
  return `Search Console couldn't be read for ${c.site}. ${GSC_CONNECT_UNAVAILABLE}`;
}

/** First match wins, so a specific prefix sits above the general one it
 *  shares a start with. Every sentence has to be true wherever its prefix can
 *  appear — the run, the keyword map, competitor profiles and briefs all write
 *  `Serper…` and `LLM…` notes. */
const RULES: readonly { prefix: string; say: (c: NoteContext) => string }[] = [
  { prefix: "Search Console", say: searchConsoleNote },
  { prefix: "Google Analytics", say: (c) => `Google Analytics isn't connected for ${c.site}. ${GA_SERVICE_ACCOUNT}` },
  { prefix: "Page analytics", say: () => "Page-level analytics couldn't be read on this run, so some page figures may be missing." },
  { prefix: "Rank tracking", say: () => "Live Google rank checks aren't available on this server right now, so positions weren't checked on this run." },
  { prefix: "Serper key missing — topics", say: () => "Live Google checks aren't set up on this server, so blog topics come from our own search data only." },
  { prefix: "Serper key missing — expansion", say: () => "Live Google checks aren't set up on this server, so keyword ideas come from AI and our own search data only." },
  { prefix: "Serper key missing", say: () => "Live Google checks aren't set up on this server, so this part couldn't use live search results." },
  { prefix: "Serper", say: () => "Live Google results weren't available for part of this — what's shown is what came back." },
  { prefix: "New-topic ideation", say: () => "AI topic ideas were skipped on this run. The rest of the blog plan is unaffected." },
  { prefix: "LLM expansion skipped", say: () => "AI keyword ideas were skipped this time — the map is built from search data only." },
  { prefix: "LLM returned no usable clusters", say: () => "The AI grouping didn't work this time, so keywords are grouped by shared words instead." },
  { prefix: "LLM clustering skipped", say: () => "The AI grouping didn't work this time, so keywords are grouped by shared words instead." },
  { prefix: "LLM outline skipped", say: () => "The AI outline was skipped this time, so the outline follows the structure of the top results." },
  { prefix: "LLM", say: () => "An AI step was skipped this time — what's shown is what came back." },
  { prefix: "Sitemap watch", say: () => "The competitor sitemap check couldn't run this time." },
  { prefix: "Page fetch", say: () => "Some competitor pages couldn't be read this time." },
];

/** True for text that reads like a machine wrote it: markup or a repr
 *  (`<HttpError 403 …>`), braces, a URL, a traceback, an exception name, or a
 *  `Label: detail` line — the shape every raw backend note takes. */
export function looksRaw(note: string): boolean {
  return /[<>{}[\]]|https?:\/\/|traceback|exception|error\b|\n/i.test(note)
    || /^[A-Za-z][\w ./-]{0,40}:\s/.test(note);
}

/** One note as a sentence a busy owner can read. Never the exception. */
export function plainNote(note: string, c: NoteContext): string {
  const n = note.trim();
  if (PLAIN_TOPIC_NOTES.includes(n)) return n;
  const rule = RULES.find((r) => n.startsWith(r.prefix));
  if (rule) return rule.say(c);
  return looksRaw(n) ? GENERIC_NOTE : n;
}

/** Every note, plain and once each, minus any already said on this screen —
 *  the pages doc forwards the run's Search Console / Analytics notes, which
 *  the brand screen has already shown at the top. */
export function plainNotesExcept(notes: readonly unknown[] | null | undefined, c: NoteContext, said: readonly string[]): string[] {
  return plainNotes(notes, c).filter((n) => !said.includes(n));
}

/** Every note, plain and once each — two Serper failures are one sentence. */
export function plainNotes(notes: readonly unknown[] | null | undefined, c: NoteContext): string[] {
  const out: string[] = [];
  for (const raw of notes ?? []) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const s = plainNote(raw, c);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** An error sentence, safe to show. Many SEO routes answer a failure with
 *  `detail=str(exc)`, which can be `Google Analytics rejected properties/123:
 *  <HttpError 403 …>`; that becomes the caller's own fallback. A plain refusal
 *  ("Run the site analysis first"), a timeout's sentence and a coded message
 *  pass through unchanged. */
export function plainMessage(message: string | null | undefined, fallback: string): string {
  const m = (message ?? "").trim();
  if (!m) return fallback;
  return looksRaw(m) ? fallback : m;
}

/** `describeFailure`, then `plainMessage`: the one way the SEO screens turn a
 *  rejection into words. */
export const plainFailure = (e: unknown, fallback: string): string =>
  plainMessage(describeFailure(e, fallback), fallback);

/* ---------------------------------------------------- topic provenance -- */

const SOURCES: Record<string, { key: string; label: string }> = {
  "seed": { key: "seed", label: "Your seed" },
  "site gap": { key: "gap", label: "Site gap" },
  "suggested seed": { key: "suggested", label: "Suggested by site review" },
  "google suggestion": { key: "google", label: "Google suggestion" },
  "search data": { key: "search", label: "Search data" },
  "new idea": { key: "idea", label: "AI idea" },
  "competitor-content": { key: "competitor", label: "Competitor" },
};

export interface TopicOrigin {
  /** CSS modifier: `seo-chip--src-<key>`. */
  key: string;
  label: string;
  /** "from: <seed>" — Google suggestions only. */
  fromSeed: string | null;
}

/** Where a blog topic came from. An unknown or missing source renders as a
 *  neutral "Other source" chip, never as the raw value. */
export function topicOrigin(t: Partial<Pick<SeoTopic, "source" | "from_seed">>): TopicOrigin {
  const source = typeof t.source === "string" ? t.source : "";
  const known = SOURCES[source];
  return {
    key: known?.key ?? "other",
    label: known?.label ?? "Other source",
    fromSeed: source === "google suggestion" ? str(t.from_seed) : null,
  };
}

/* ------------------------------------------- recommendations & the audit -- */
/* The backend now grounds its advice in the crawl and says what it threw
 * away. Every field below is additive: an older backend's payload has none of
 * them, and each reads as the old behaviour. */

/** A page row's flag id as a chip. Unknown ids — the backend is moving more
 *  of its per-row sentences into chips — get a readable label, not the id. */
const FLAG_LABELS: Record<string, string> = {
  "no-title": "No title",
  "title-long": "Title too long",
  "no-meta": "No meta description",
  "meta-long": "Meta description too long",
  "thin": "Thin content",
  // `rec_chip`: the per-row "thin" / "Healthy — keep it fresh…" sentences as chips
  "thin-content": "Thin content",
  "no-h1": "No H1",
  "images-no-alt": "Images missing alt text",
  "not-crawled": "Not in the site crawl",
  "healthy": "Healthy",
};

export function flagChip(id: string): { label: string; ok: boolean } {
  const label = FLAG_LABELS[id]
    ?? (id.replace(/[-_]+/g, " ").trim().replace(/^\w/, (c) => c.toUpperCase()) || "Flag");
  return { label, ok: id === "healthy" };
}

/** A page row's chips: its `flags`, then its `rec_chip` — each label once. A
 *  thin page carries `thin` in `flags` and `thin-content` as its `rec_chip`;
 *  both read "Thin content", and the row says it once. */
export function pageChips(p: Pick<SeoPageIntel, "flags" | "rec_chip">): { key: string; label: string; ok: boolean }[] {
  const ids = [...(Array.isArray(p.flags) ? p.flags : []), ...(str(p.rec_chip) ? [String(p.rec_chip).trim()] : [])];
  const out: { key: string; label: string; ok: boolean }[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !id) continue;
    const chip = flagChip(id);
    if (!out.some((c) => c.label === chip.label)) out.push({ key: id, ...chip });
  }
  return out;
}

/** The page row's advice line: "AI: …" / "Rule: …", or none at all. A
 *  `flags` row has no sentence on purpose — the chips are the message and the
 *  fix lives in the audit — so it must not print a bare "Rule: ". */
export function pageRec(p: Pick<SeoPageIntel, "recommendation" | "ai" | "rec_source">): { label: "AI" | "Rule"; text: string } | null {
  if (p.rec_source === "flags") return null;
  const text = str(p.recommendation);
  if (!text) return null;
  return { label: p.rec_source === "ai" || (p.rec_source === undefined && p.ai === true) ? "AI" : "Rule", text };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const MOVED = "moved-to-fix-list";

/** The quiet line under the pages list, or null when nothing was dropped.
 *  Advice that moved to the Fix list was not hidden — it is counted apart:
 *  "2 suggestions hidden (repeated the flags or didn't fit) · 5 moved to your
 *  Fix list". */
export function hiddenSuggestionsLine(g: SeoPagesGrounding | null | undefined): string | null {
  const dropped = Array.isArray(g?.dropped) ? g.dropped : [];
  const moved = dropped.filter((d) => d && d.reason === MOVED).length;
  const hidden = dropped.length - moved;
  if (hidden && moved) {
    return `${hidden} ${plural(hidden, "suggestion", "suggestions")} hidden (repeated the flags or didn't fit) · ${moved} moved to your Fix list`;
  }
  if (hidden) {
    return `${hidden} ${plural(hidden, "suggestion", "suggestions")} hidden because ${plural(hidden, "it", "they")} repeated the flags or didn't fit the page.`;
  }
  if (moved) return `${moved} ${plural(moved, "suggestion", "suggestions")} moved to your Fix list`;
  return null;
}

/** A Fix-list category in words. */
const TODO_CATEGORIES: Record<string, string> = {
  "internal-links": "Internal links",
  "cta": "Call to action",
  "content": "Content",
  "structure": "Structure",
  "trust": "Trust",
  "other": "Other",
};

export function todoCategoryLabel(category: string | null | undefined): string | null {
  const c = str(category);
  if (!c) return null;
  return TODO_CATEGORIES[c] ?? c.replace(/[-_]+/g, " ").replace(/^\w/, (x) => x.toUpperCase());
}

/** The Fix-list items the page rows' moved advice became, each with the
 *  to-do it links to: its `todo_id`, or — for a new item — the run's
 *  page-advice to-do of that category. `todoId` null: not on this run's list
 *  (an older run, or a page pass newer than the run), so no link. */
export function movedFixLinks(
  fixItems: SeoPagesDoc["fix_items"] | null | undefined,
  todos: readonly Pick<SeoTodo, "id" | "origin" | "category">[],
): { label: string; todoId: string | null }[] {
  return rows<{ category?: unknown; paths?: unknown; todo_id?: unknown }>(fixItems).flatMap((item) => {
    const n = strs(item.paths).length;
    const category = typeof item.category === "string" ? item.category : "";
    if (!n || !category) return [];
    const byId = typeof item.todo_id === "string" ? todos.find((t) => t.id === item.todo_id) : undefined;
    const byCategory = todos.find((t) => t.origin === "page-advice" && t.category === category);
    return [{
      label: `${todoCategoryLabel(category)} on ${n} ${plural(n, "page", "pages")}`,
      todoId: (byId ?? byCategory)?.id ?? null,
    }];
  });
}

/** "On 4 pages" and the list, for a fix that spans pages; null for none. */
export function todoPages(pages: unknown): { label: string; items: { text: string; href: string | null }[] } | null {
  const list = strs(pages);
  if (!list.length) return null;
  return {
    label: `On ${list.length} ${plural(list.length, "page", "pages")}`,
    items: list.map((p) => todoPage(p) ?? { text: p, href: null }),
  };
}

/** The chip on an audit finding. Decorative alt text is information, never
 *  a severity — "info", not "low", and never "missing". */
export const auditTone = (i: Pick<SeoAuditIssue, "severity" | "informational" | "kind">): "info" | SeoAuditIssue["severity"] =>
  i.informational === true || i.kind === "decorative-alt" ? "info" : i.severity;

export interface AuditEvidence {
  label: string;
  /** Said once, under the label — the reason every listed page shares. */
  note?: string | null;
  lines: string[];
  /** The lines name every page themselves, so the bare page list is not
   *  printed under them a second time. */
  coversPages: boolean;
}

const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
const rows = <T,>(v: unknown): T[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") as T[] : []);

/** What backs an audit finding, for its expandable detail. Null for an older
 *  report (no `kind`) and for kinds that carry nothing beyond their pages. */
export function auditEvidence(i: SeoAuditIssue): AuditEvidence | null {
  switch (i.kind) {
    case "title-template": {
      const suffix = str(i.suffix);
      if (!suffix) return null;
      const n = typeof i.suffix_chars === "number" ? i.suffix_chars : suffix.length;
      return { label: "Shared title ending", lines: [`“${suffix}” adds ${n} ${plural(n, "character", "characters")} to every long title`], coversPages: false };
    }
    case "template-alt": {
      const srcs = strs(i.srcs);
      return srcs.length ? { label: "Images in the shared header/footer", lines: srcs, coversPages: false } : null;
    }
    case "page-alt": {
      const ex = rows<{ page?: unknown; srcs?: unknown }>(i.examples).filter((e) => str(e.page));
      if (!ex.length) return null;
      return {
        label: "Images without alt text, by page",
        lines: ex.map((e) => { const s = strs(e.srcs); return s.length ? `${e.page} — ${s.join(", ")}` : String(e.page); }),
        coversPages: ex.length >= i.pages.length,
      };
    }
    case "decorative-alt": {
      const n = typeof i.images === "number" ? i.images : 0;
      return n > 0
        ? { label: "Marked decorative", lines: [`${n} ${plural(n, "image", "images")} with alt="" — not missing, just skipped by screen readers`], coversPages: false }
        : null;
    }
    case "schema-error": {
      const ex = rows<{ page?: unknown; error?: unknown }>(i.examples).filter((e) => str(e.page));
      if (!ex.length) return null;
      return {
        label: "What didn't parse",
        lines: ex.map((e) => (str(e.error) ? `${e.page} — ${e.error}` : String(e.page))),
        coversPages: ex.length >= i.pages.length,
      };
    }
    case "schema-fit": {
      // The finding's reason once; each page a bare URL unless its own reason
      // differs, FAQ pages with their Q&A pairs. An older report put a reason
      // on every page and none on the finding.
      const ev = rows<{ page?: unknown; reason?: unknown; pairs?: unknown }>(i.evidence).filter((e) => str(e.page));
      if (!ev.length) return null;
      const type = str(i.schema_type);
      const pairsOf = (e: { pairs?: unknown }) =>
        typeof e.pairs === "number" && e.pairs > 0 ? ` (${e.pairs} Q&A ${plural(e.pairs, "pair", "pairs")})` : "";
      return {
        label: type ? `Why ${type} fits` : "Why it fits",
        note: str(i.reason),
        lines: ev.map((e) => `${e.page}${pairsOf(e)}${str(e.reason) ? ` — ${e.reason}` : ""}`),
        coversPages: ev.length >= i.pages.length,
      };
    }
    default:
      return null;
  }
}

/** Why the expert review dropped a finding, in plain words. */
const REVIEW_DROP_REASONS: Record<string, string> = {
  "audit-owned": "already covered by the technical audit",
  "no-evidence-url": "no page on your site backs it up",
  "invented-number": "it cited a number that isn't on the page",
  "schema-not-fit": "schema advice that doesn't fit the page",
  "duplicate": "it repeated another finding",
  "malformed": "the answer came back incomplete",
  "over-limit": "over the limit for one review",
  "contradicted-by-page": "your page already has it",
  "unverifiable-absence": "couldn't be checked against the page",
};
/** Drops for want of support on the page — what the headline is about. */
const NO_EVIDENCE = new Set(["no-evidence-url", "invented-number", "schema-not-fit"]);
const CONTRADICTED = "contradicted-by-page";
const UNCHECKABLE = "unverifiable-absence";
const EVIDENCE_REASONS = new Set([...NO_EVIDENCE, CONTRADICTED, UNCHECKABLE]);

/** The headline over the dropped findings — true of every drop it counts. */
function droppedHeadline(n: number, reasons: readonly unknown[]): string {
  const head = `${n} ${plural(n, "finding", "findings")} dropped`;
  const all = (ok: (r: string) => boolean) => reasons.every((r) => typeof r === "string" && ok(r));
  if (all((r) => NO_EVIDENCE.has(r))) return `${head} — no evidence on your pages`;
  if (all((r) => r === CONTRADICTED)) return `${head} — your pages already have what they said was missing`;
  if (all((r) => r === UNCHECKABLE)) return `${head} — they couldn't be checked against your pages`;
  if (all((r) => r === CONTRADICTED || r === UNCHECKABLE)) {
    return `${head} — your pages contradicted them or they couldn't be checked`;
  }
  if (all((r) => EVIDENCE_REASONS.has(r))) return `${head} — not supported by your pages`;
  return `${head} by the evidence check`;
}

/** The review's quiet line and its disclosure, or null when nothing was
 *  dropped (or the review predates the check). The headline claims "no
 *  evidence" only when that is what every drop was. */
export function reviewDropped(g: SeoReviewGrounding | null | undefined): {
  line: string;
  items: { insight: string; reason: string }[];
} | null {
  const dropped = rows<{ reason?: unknown; insight?: unknown }>(g?.dropped);
  if (!dropped.length) return null;
  return {
    line: droppedHeadline(dropped.length, dropped.map((d) => d.reason)),
    items: dropped.map((d) => ({
      insight: str(d.insight) ?? "A finding",
      reason: (typeof d.reason === "string" && REVIEW_DROP_REASONS[d.reason]) || "it didn't pass the evidence check",
    })),
  };
}

/** A to-do's page: a link when it is a URL (site to-dos now cite the page),
 *  plain text otherwise (an older review stored its evidence sentence here). */
export function todoPage(page: string | null | undefined): { href: string | null; text: string } | null {
  const p = str(page);
  if (!p) return null;
  if (!/^https?:\/\//i.test(p)) return { href: null, text: p };
  try {
    const u = new URL(p);
    return { href: p, text: u.pathname === "/" ? u.hostname : u.pathname };
  } catch {
    return { href: null, text: p };
  }
}

/** "3 more not shown", or null. */
export function notShownLine(n: unknown): string | null {
  return typeof n === "number" && n > 0 ? `${Math.round(n)} more not shown` : null;
}

/** A brief's schema: the types, and the note that says why — or why none. */
export function briefSchema(b: Pick<SeoBrief, "schema_recommended" | "schema_note">): { types: string[]; note: string | null } {
  const types = strs(b.schema_recommended);
  const note = str(b.schema_note);
  return { types, note: note ?? (types.length ? null : "No schema suggested for this page.") };
}

/** One "This week" move. A move that is a Fix-list item points there —
 *  "See Fix list #n · label" — and repeats none of its text; the item is found
 *  by id first, then by position, and its position on this list is the n. Any
 *  other move is its label (an older backend: its action) and its detail. */
export type PlanItemView =
  | { kind: "fix"; index: number; todoId: string; label: string }
  | { kind: "move"; title: string; detail: string };

export function planItemView(p: SeoPlanItem, todos: readonly Pick<SeoTodo, "id">[]): PlanItemView {
  const label = str(p.label);
  const at = typeof p.ref_index === "number" && p.ref_index >= 1 ? Math.floor(p.ref_index) - 1 : -1;
  if (at >= 0 || str(p.ref_todo_id)) {
    const byId = str(p.ref_todo_id) ? todos.findIndex((t) => t.id === p.ref_todo_id) : -1;
    const i = byId >= 0 ? byId : at >= 0 && at < todos.length ? at : -1;
    if (i >= 0) return { kind: "fix", index: i + 1, todoId: todos[i].id, label: label ?? str(p.action) ?? "" };
  }
  return { kind: "move", title: label ?? str(p.action) ?? "", detail: str(p.detail) ?? "" };
}

/* --------------------------------------------------------- topic rows -- */

const ANGLES: Record<string, string> = {
  "service page": "Service page",
  "pricing explainer": "Pricing explainer",
  "comparison": "Comparison",
  "how-to guide": "How-to guide",
  "FAQ answer": "FAQ answer",
};

/** A topic's angle as its chip: the known ones in their own words, anything
 *  else (an older run's wording) as it came, none for an empty one. */
export function topicAngle(angle: unknown): string | null {
  const a = str(angle);
  if (!a) return null;
  return ANGLES[a] ?? a;
}

/** The page a typed seed should refresh instead — only a web address. */
export function refreshHref(url: unknown): string | null {
  const u = str(url);
  return u && /^https?:\/\//i.test(u) ? u : null;
}

/** The "This week" strip's heading — or null, and no strip, for an empty plan. */
export function planHeading(n: number): string | null {
  if (n <= 0) return null;
  if (n === 1) return "This week — do this one";
  return `This week — do these ${["two", "three"][Math.min(n, 3) - 2]}`;
}

/* ------------------------------------------- the workspace and its console -- */
/* The workspace's header and brand switcher name one brand; the console shows
 * one brand (or the list). They used to disagree: the header followed the
 * address bar while the console opened brands on its own. Now the console
 * reports what it opens, the address bar follows it, and the header names
 * what the console shows. */

/** The header while the console section is open: the brand on screen, or
 *  "all brands" while the console shows its list. */
export function consoleHeadline(shown: string | null, brands: readonly SeoBrandCard[]): string {
  if (!shown) return "all brands";
  const b = brands.find((c) => c.brand.id === shown)?.brand;
  return b ? `${b.name} · ${b.domain}` : "reading the brand";
}

/** Whether a change of the workspace's subject should open that brand in
 *  the console: only a change made while the console was already open (the
 *  brand switcher), and only to a brand the console is not already showing.
 *  Moving between sections never opens anything by itself. */
export function subjectOpensInConsole(t: {
  prevSubject: string; subject: string; prevSection: string; section: string; shown: string | null;
}): boolean {
  return t.prevSection === "console" && t.section === "console"
    && t.subject !== t.prevSubject && !!t.subject && t.subject !== t.shown;
}

/* --------------------------------------------------- round 3 readings -- */

/** "up 12% vs the month before", "" when there is nothing to compare. */
export function pctPhrase(now: number, prev: number): string {
  if (!prev) return "";
  const d = Math.round(((now - prev) / prev) * 100);
  if (d === 0) return "steady vs the month before";
  return d > 0 ? `up ${d}% vs the month before` : `down ${Math.abs(d)}% vs the month before`;
}

/** The analytics story's figures, each called what it is. People are GA's
 *  users (the Visitors tile); sessions are visits and are never called
 *  people. A payload without users falls back to visits, said as visits. */
export function gaStory(ga: Pick<SeoGa, "totals" | "prev_totals" | "key_events" | "channels">): {
  count: number; unit: "people" | "visits"; trend: string; leads: number | null;
  google: { visits: number; rank: number } | null;
} {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const users = num(ga.totals?.users);
  const people = users !== null;
  const count = people ? users : num(ga.totals?.sessions) ?? 0;
  const prev = people ? num(ga.prev_totals?.users) ?? 0 : num(ga.prev_totals?.sessions) ?? 0;
  const lead = (ga.key_events ?? []).find((e) => e.event === "generate_lead");
  const channels = ga.channels ?? [];
  const organic = channels.find((c) => c.channel === "Organic Search");
  return {
    count,
    unit: people ? "people" : "visits",
    trend: pctPhrase(count, prev),
    leads: lead ? lead.count : null,
    google: organic
      ? { visits: organic.sessions, rank: channels.filter((c) => c.sessions > organic.sessions).length + 1 }
      : null,
  };
}

/** "+10 more" when an audit finding lists fewer pages than it counts. */
export function morePagesLine(i: Pick<SeoAuditIssue, "count" | "pages">): string | null {
  const shown = Array.isArray(i.pages) ? i.pages.length : 0;
  const n = typeof i.count === "number" ? i.count - shown : 0;
  return n > 0 ? `+${n} more` : null;
}

/** The review's missing topics, each with its blog-plan position when it
 *  has one. Strings (every backend so far) read as before. */
export function missingTopics(list: SeoSiteReview["missing_topics"] | null | undefined): { text: string; inPlan: number | null }[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    if (typeof item === "string") return item.trim() ? [{ text: item, inPlan: null }] : [];
    if (!item || typeof item !== "object") return [];
    const text = str(item.topic) ?? str(item.text) ?? str(item.keyword);
    if (!text) return [];
    const n = item.in_blog_plan;
    return [{ text, inPlan: typeof n === "number" && n >= 1 ? Math.floor(n) : null }];
  });
}

/** A topic's difficulty chip. A typed seed we already rank top 3 for says so
 *  ("we rank #2") instead of a red "hard". */
export function topicDifficulty(t: Pick<SeoTopic, "difficulty" | "difficulty_label" | "own_rank">): {
  label: string; tone: "rank" | "easy" | "medium" | "hard" | "none";
} {
  const label = str(t.difficulty_label);
  if (label) return { label, tone: "rank" };
  const rank = t.own_rank;
  if (typeof rank === "number" && rank >= 1 && rank <= 3) return { label: `we rank #${Math.floor(rank)}`, tone: "rank" };
  const d = str(t.difficulty);
  if (!d) return { label: "—", tone: "none" };
  return { label: d, tone: d === "easy win" ? "easy" : d === "medium" ? "medium" : "hard" };
}
