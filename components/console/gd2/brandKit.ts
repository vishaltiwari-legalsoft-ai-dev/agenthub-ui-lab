/** The brand-kit sheet's decisions, kept out of the component so they can be
 *  proved without a DOM (there are no component tests in this repo — see
 *  `lib/load.ts`). Runtime imports are relative; `@/` is type-only, because
 *  vitest does not resolve the alias.
 *
 *  Three things live here: the client-side file rules the backend also
 *  enforces (so a 60 MB logo is refused before it is sent, not after), the
 *  save order — JSON first, then every file on its own against the returned
 *  id — and the words a server `detail` code turns into.
 */

import type {
  GdBrandAssetKind, GdBrandDetail, GdBrandInput, GdBrandReference, GdBrandReferenceKind,
  GdBrandSummary,
} from "@/lib/api";
import type { Viewer } from "@/components/hub/model";
import {
  directCapFor, uploadBatch,
  type UploadHooks, type UploadOutcome, type UploadRow,
} from "../../../lib/directUpload";

/* ------------------------------------------------------------ file rules -- */

export type KitFileKind = GdBrandAssetKind | "reference";

/** What the checks need of a `File`, so tests can hand in plain objects. */
export interface FileLike { name: string; type: string; size: number }

export interface FileRule {
  /** Shown in the rejection: "not a PNG, SVG, WebP, JPEG or TIFF". */
  accepts: string;
  exts: string[];
  mimes: string[];
  /** The largest file of this kind the direct upload takes — what the hint
   *  shows. `fileCap` is the per-file figure (an SVG logo takes less). */
  maxBytes: number;
  /** Per brand for logos/fonts/guidelines; per pick for references. */
  maxFiles: number;
  /** The `accept` attribute for the picker. */
  accept: string;
}

const MB = 1024 * 1024;

/** The caps are the direct upload's (`directUpload.directCapFor`): files go
 *  straight to storage, so a 50 MB original is no longer refused here. While
 *  a server has direct uploads off, a file over the old route's limit is
 *  refused at save, in words that say so. */
export const FILE_RULES: Record<KitFileKind, FileRule> = {
  logo: {
    accepts: "PNG, SVG, WebP, JPEG or TIFF",
    exts: ["png", "svg", "webp", "jpg", "jpeg", "tif", "tiff"],
    mimes: ["image/png", "image/svg+xml", "image/webp", "image/jpeg", "image/tiff"],
    maxBytes: 50 * MB,
    maxFiles: 8,
    accept: "image/png,image/svg+xml,image/webp,image/jpeg,image/tiff,.png,.svg,.webp,.jpg,.jpeg,.tif,.tiff",
  },
  font: {
    accepts: "TTF or OTF",
    exts: ["ttf", "otf"],
    // Browsers report fonts inconsistently (often as an empty type on
    // Windows), so the extension is the check that counts; the MIME list is
    // only what a picker may offer.
    mimes: ["font/ttf", "font/otf", "application/x-font-ttf", "application/x-font-otf", "application/font-sfnt"],
    maxBytes: 2 * MB,
    maxFiles: 16,
    accept: ".ttf,.otf,font/ttf,font/otf",
  },
  guidelines: {
    accepts: "PDF",
    exts: ["pdf"],
    mimes: ["application/pdf"],
    maxBytes: 50 * MB,
    maxFiles: 1,
    accept: "application/pdf,.pdf",
  },
  reference: {
    accepts: "PNG, JPEG, WebP or TIFF",
    exts: ["png", "jpg", "jpeg", "webp", "tif", "tiff"],
    mimes: ["image/png", "image/jpeg", "image/webp", "image/tiff"],
    maxBytes: 50 * MB,
    maxFiles: 10,
    accept: "image/png,image/jpeg,image/webp,image/tiff,.png,.jpg,.jpeg,.webp,.tif,.tiff",
  },
};

/** The most references one pick may add. Each file then goes up on its own. */
export const REFERENCE_BATCH = FILE_RULES.reference.maxFiles;

/** The cap for this one file — an SVG logo takes 5 MB, a raster one 50. */
export const fileCap = (kind: KitFileKind, file: FileLike): number => directCapFor(kind, file);

export const formatMb = (bytes: number): string => {
  const mb = bytes / MB;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
};

const extOf = (name: string): string => {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
};

export interface FileRejection<F extends FileLike> { file: F; reason: string }

export interface FileCheck<F extends FileLike> {
  accepted: F[];
  rejected: FileRejection<F>[];
}

/** Sort a selection into what may be sent and what may not, with a reason per
 *  refusal that names the limit — the same one the backend enforces.
 *  `alreadyHave` is how many of this kind the brand (or, for references, this
 *  batch) already holds, so the count limit is applied to the total. */
export function checkFiles<F extends FileLike>(
  kind: KitFileKind,
  files: F[],
  alreadyHave = 0,
): FileCheck<F> {
  const rule = FILE_RULES[kind];
  const accepted: F[] = [];
  const rejected: FileRejection<F>[] = [];
  let room = Math.max(0, rule.maxFiles - alreadyHave);
  for (const file of files) {
    const typeOk = rule.exts.includes(extOf(file.name)) || (file.type !== "" && rule.mimes.includes(file.type));
    const cap = fileCap(kind, file);
    if (!typeOk) {
      rejected.push({ file, reason: `Not a ${rule.accepts} file` });
    } else if (file.size > cap) {
      rejected.push({ file, reason: `File too large (max ${formatMb(cap)})` });
    } else if (room <= 0) {
      rejected.push({
        file,
        reason: kind === "reference"
          ? `Only ${rule.maxFiles} files per upload`
          : rule.maxFiles === 1
            ? "Only one file — replace the one on file"
            : `Only ${rule.maxFiles} ${kind} files per brand`,
      });
    } else {
      accepted.push(file);
      room -= 1;
    }
  }
  return { accepted, rejected };
}

/* --------------------------------------------------------------- colours -- */

/** `#RRGGBB`, upper-case, from anything a person types — `abc`, `#ABCDEF`,
 *  ` #aabbcc `. Null when it is not a colour. */
export function normalizeHex(raw: string): string | null {
  const s = raw.trim().replace(/^#/, "");
  if (/^[0-9a-f]{6}$/i.test(s)) return `#${s.toUpperCase()}`;
  if (/^[0-9a-f]{3}$/i.test(s)) return `#${s.split("").map((c) => c + c).join("").toUpperCase()}`;
  return null;
}

/* ----------------------------------------------------------------- draft -- */

export type ColorRole = "primary" | "secondary" | "accent";
export const COLOR_ROLES: ColorRole[] = ["primary", "secondary", "accent"];

/** What the sheet edits. Colours are kept as typed so a half-typed hex is not
 *  thrown away on every keystroke; they are normalised on save. */
export interface BrandDraft {
  name: string;
  website: string;
  tone_of_voice: string;
  fonts: string[];
  colors: Record<ColorRole, string[]>;
}

export const emptyDraft = (): BrandDraft => ({
  name: "",
  website: "",
  tone_of_voice: "",
  fonts: [],
  colors: { primary: [""], secondary: [], accent: [] },
});

export const draftFrom = (b: GdBrandDetail): BrandDraft => ({
  name: b.name,
  website: b.website ?? "",
  tone_of_voice: b.tone_of_voice ?? "",
  fonts: [...(b.fonts ?? [])],
  colors: {
    primary: [...(b.colors?.primary ?? [])],
    secondary: [...(b.colors?.secondary ?? [])],
    accent: [...(b.colors?.accent ?? [])],
  },
});

/** What stops a save before anything is sent. Empty means "go". */
export function validateDraft(d: BrandDraft): string[] {
  const problems: string[] = [];
  if (!d.name.trim()) problems.push("Give the brand a name.");
  const primary = d.colors.primary.filter((c) => c.trim() !== "");
  if (primary.length === 0) problems.push("Add at least one primary colour.");
  for (const role of COLOR_ROLES) {
    for (const c of d.colors[role]) {
      if (c.trim() !== "" && normalizeHex(c) === null) {
        problems.push(`"${c.trim()}" is not a hex colour — use six digits like #1746A2.`);
      }
    }
  }
  return problems;
}

const hexes = (list: string[]): string[] =>
  list.map(normalizeHex).filter((c): c is string => c !== null);

/** The JSON body for create and PATCH alike. Blank strings stay blank rather
 *  than being dropped, so clearing the tone of voice — or the website — on a
 *  PATCH actually clears it (the backend stores `website` as sent). */
export function toInput(d: BrandDraft): GdBrandInput {
  return {
    name: d.name.trim(),
    primary_colors: hexes(d.colors.primary),
    secondary_colors: hexes(d.colors.secondary),
    accent_colors: hexes(d.colors.accent),
    fonts: d.fonts.map((f) => f.trim()).filter(Boolean),
    tone_of_voice: d.tone_of_voice.trim(),
    website: d.website.trim(),
  };
}

/* ------------------------------------------------------- reference types -- */

/** The `creative_type` values the library indexes as style categories —
 *  `REFERENCE_CATEGORIES` in the backend's `reference_library.py`, verbatim.
 *  Anything else the pipeline ignores, so the sheet offers exactly these plus
 *  "not sure" (sent as empty). The type is a hint only: Stage 2 grounds on
 *  every uploaded reference whatever its type. */
export const REFERENCE_CREATIVE_TYPES: { value: string; label: string }[] = [
  { value: "brand_gradient", label: "Brand gradient" },
  { value: "newsletter", label: "Newsletter graphic" },
];

export const REFERENCE_TYPE_OTHER = { value: "", label: "Other / not sure" };

/** The words for a stored `creative_type`; an unknown key is shown as sent. */
export const referenceTypeLabel = (value: string | null): string | null => {
  if (!value) return null;
  return REFERENCE_CREATIVE_TYPES.find((t) => t.value === value)?.label ?? value;
};

/* ------------------------------------------------------------------ words -- */

/** The cap a brand that does not exist yet is shown against; once it does,
 *  the backend's `reference_cap` is the figure. */
export const DEFAULT_REFERENCE_CAP = 200;

export const referenceCountLabel = (count: number, cap: number): string => `${count} / ${cap}`;

export const referencesRemaining = (count: number, cap: number): number => Math.max(0, cap - count);

/** Archive is the one action reserved for admins — the same gate `canOpen`
 *  applies to the Admin panel. Absent reads as "not an admin", so a session
 *  stored before the flag is hidden the button rather than offered a 403. */
export const canArchiveBrand = (viewer: Viewer | null | undefined): boolean => !!viewer?.is_admin;

/** The backend's `detail` codes (gd_brands.py), in words. This is for the
 *  brand-level calls — create, PATCH, a reference removed, an archive. A file
 *  that did not upload is worded by `lib/directUpload.ts`, per file, with the
 *  limit that applied to it. Anything else is shown as sent — a sentence the
 *  backend wrote is better than one this file guessed. */
const DETAIL_WORDS: Record<string, () => string> = {
  brand_exists: () => "A brand with this name already exists.",
  brand_not_editable: () => "This brand is built in — its kit cannot be changed here.",
  brand_not_found: () => "This brand no longer exists — it may have been archived.",
  reference_cap_reached: () => "This brand already holds as many references as it can.",
  file_too_large: () => "The file is larger than the upload limit.",
  unsupported_file_type: () => "That file type is not accepted.",
  image_too_large: () => "Image is larger than 4096 px on a side (or an SVG with an embedded image) — please resize it.",
  empty_file: () => "The file is empty.",
  no_files: () => "No file was sent.",
  too_many_files: () => "Too many files in one upload.",
  font_limit_reached: () => `This brand already has ${FILE_RULES.font.maxFiles} font files — remove one first.`,
  logo_limit_reached: () => `This brand already has ${FILE_RULES.logo.maxFiles} logos — remove one first.`,
};

/** `ApiError.status`, read structurally so this module needs no runtime import
 *  from `lib/api` (vitest does not resolve `@/`). */
const statusOf = (e: unknown): number | null => {
  if (!(e instanceof Error)) return null;
  const status: unknown = (e as unknown as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
};

export function describeBrandFailure(e: unknown, fallback: string): string {
  const msg = e instanceof Error ? e.message.trim() : "";
  if (Object.prototype.hasOwnProperty.call(DETAIL_WORDS, msg)) return DETAIL_WORDS[msg]();
  // A reply with no `detail` is not the backend's — an edge in front of it
  // (Cloud Run's request-size limit answers 413 with an HTML body).
  const generic = msg === "" || /^Request failed/.test(msg);
  switch (statusOf(e)) {
    case 413: return generic ? "File too large." : msg;
    case 415: return generic ? "That file type is not accepted." : msg;
    case 422: return generic ? "Something in the form was not accepted — check the name and colours." : msg;
    default: return generic ? fallback : msg;
  }
}

/* ------------------------------------------------------------------- save -- */

/** The calls the save needs, as an interface so a test can hand in fakes.
 *  Each upload is ONE file (`directUpload` in the sheet): its own request, its
 *  own progress and its own result. */
export interface BrandKitApi<F extends FileLike = File> {
  create: (body: GdBrandInput) => Promise<GdBrandDetail>;
  patch: (brandId: string, body: Partial<GdBrandInput>) => Promise<GdBrandDetail>;
  uploadAsset: (
    brandId: string,
    kind: GdBrandAssetKind,
    file: F,
    hooks: UploadHooks,
  ) => Promise<{ brand: GdBrandDetail } & UploadOutcome>;
  uploadReference: (
    brandId: string,
    file: F,
    meta: { kind?: GdBrandReferenceKind; creative_type?: string; note?: string },
    hooks: UploadHooks,
  ) => Promise<{ references: GdBrandReference[]; reference_count: number } & UploadOutcome>;
}

export interface PendingUploads<F extends FileLike = File> {
  logo: F[];
  font: F[];
  guidelines: F[];
  reference: F[];
  reference_kind: GdBrandReferenceKind;
  reference_creative_type: string;
  reference_note: string;
}

/** Past creatives are the common upload, so `creative` is the default kind. */
export const emptyPending = <F extends FileLike = File>(): PendingUploads<F> => ({
  logo: [], font: [], guidelines: [], reference: [],
  reference_kind: "creative", reference_creative_type: "", reference_note: "",
});

export const hasPending = (p: PendingUploads<FileLike>): boolean =>
  p.logo.length + p.font.length + p.guidelines.length + p.reference.length > 0;

export interface SaveOutcome<F extends FileLike = File> {
  /** The brand as the backend last returned it. Null only when the JSON step
   *  itself failed — nothing was created and there is nothing to keep. */
  brand: GdBrandDetail | null;
  /** What stopped the save itself, in words — the JSON step. A file that did
   *  not land is not here: it is a `failed` row. */
  problems: string[];
  /** One row per file, in the order they were sent: stored, or the reason. */
  rows: UploadRow[];
  /** The files that did not land, by kind — kept so a retry needs no re-pick. */
  failed: Pick<PendingUploads<F>, KitFileKind>;
}

/** The backend refusal that holds for every later file of the same kind. */
const CAP_CODES: Partial<Record<KitFileKind, string>> = {
  logo: "logo_limit_reached",
  font: "font_limit_reached",
  reference: "reference_cap_reached",
};
/** …and the ones that hold for every later file at all. */
const BRAND_GONE_CODES = ["brand_not_editable", "brand_not_found"];

const codeOf = (e: unknown): string | null => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
};

const sameRef = (a: GdBrandReference, b: GdBrandReference) => a.ref_id === b.ref_id;

/** Add references the brand does not hold yet, by id. */
const withReferences = (
  brand: GdBrandDetail,
  added: GdBrandReference[],
  count: number,
): GdBrandDetail => ({
  ...brand,
  references: [...brand.references, ...added.filter((r) => !brand.references.some((x) => sameRef(x, r)))],
  reference_count: count,
});

/** JSON first, then every file on its own against the returned id: at most
 *  three sending at once, finalized one at a time. Each file is its own
 *  request and its own result — a font that is refused does not stop the
 *  logo, and a brand that was created is never reported as if it was not.
 *  A cap one file hits fails the later files of its kind with the same
 *  reason, unsent; no file is dropped without one. */
export async function saveBrandKit<F extends FileLike>(
  api: BrandKitApi<F>,
  brandId: string | null,
  draft: BrandDraft,
  pending: PendingUploads<F>,
  onRows: (rows: UploadRow[]) => void = () => {},
): Promise<SaveOutcome<F>> {
  const failed: SaveOutcome<F>["failed"] = { logo: [], font: [], guidelines: [], reference: [] };
  const body = toInput(draft);
  let brand: GdBrandDetail;
  try {
    brand = brandId ? await api.patch(brandId, body) : await api.create(body);
  } catch (e) {
    return { brand: null, problems: [describeBrandFailure(e, "The brand could not be saved.")], rows: [], failed };
  }
  const id = brand.brand_id;

  const jobs: { kind: KitFileKind; file: F }[] = [
    ...pending.logo.map((file) => ({ kind: "logo" as const, file })),
    ...pending.font.map((file) => ({ kind: "font" as const, file })),
    ...pending.guidelines.map((file) => ({ kind: "guidelines" as const, file })),
    ...pending.reference.map((file) => ({ kind: "reference" as const, file })),
  ];
  const meta = {
    kind: pending.reference_kind,
    creative_type: pending.reference_creative_type || undefined,
    note: pending.reference_note || undefined,
  };
  const stopped: Partial<Record<KitFileKind, string>> = {};
  let allStopped: string | null = null;
  let rows: UploadRow[] = [];

  const results = await uploadBatch(
    jobs,
    async (job, hooks) => {
      if (job.kind === "reference") {
        const r = await api.uploadReference(id, job.file, meta, hooks);
        brand = withReferences(brand, r.references, r.reference_count);
        return r;
      }
      const r = await api.uploadAsset(id, job.kind, job.file, hooks);
      // The asset's reply is the whole brand as stored now; keep any
      // reference this save added that it does not list yet.
      const fresh = withReferences(r.brand, brand.references, Math.max(r.brand.reference_count, brand.reference_count));
      brand = fresh;
      return r;
    },
    (next) => {
      rows = next;
      onRows(next);
    },
    {
      skip: (job) => allStopped ?? stopped[job.kind] ?? null,
      onFailure: (job, error) => {
        const code = codeOf(error);
        const reason = error instanceof Error ? error.message : null;
        if (!code || !reason) return;
        if (BRAND_GONE_CODES.includes(code)) allStopped = reason;
        else if (CAP_CODES[job.kind] === code) stopped[job.kind] = reason;
      },
    },
  );

  for (const r of results) if ("error" in r) failed[r.job.kind].push(r.job.file);
  return { brand, problems: [], rows, failed };
}

/* ------------------------------------------------------- the brand picker -- */

/** How long the picker keeps a brand after it was last seen — in a list read,
 *  or in the reply to the member's own save — when a later read leaves it out.
 *
 *  The backend caches the brand list per Cloud Run instance for 60 s
 *  (`firestore_repo._BRANDS_TTL_SECONDS`), so a read that lands on another
 *  instance can be a minute behind the one before it, or behind the create
 *  that just answered. Past this window every instance has re-read the store
 *  since the sighting, so a brand that is still left out is really gone. */
export const BRAND_HOLD_MS = 90_000;

/** The least time between two list reads the picker asks for on focus. */
export const BRAND_REFRESH_GAP_MS = 4_000;

export interface BrandSighting { brand: GdBrandSummary; at: number }
export type BrandSightings = Readonly<Record<string, BrandSighting>>;

/** The picker's row for a brand the sheet saved — the detail's heavy fields
 *  (references, assets) stay out of the list. */
export const brandSummaryOf = (b: GdBrandSummary): GdBrandSummary => ({
  brand_id: b.brand_id,
  name: b.name,
  slug: b.slug,
  source: b.source,
  editable: b.editable,
  logo_url: b.logo_url,
  primary_colors: b.primary_colors,
  has_kit: b.has_kit,
  reference_count: b.reference_count,
});

/** Put a row in the list: in place of the row with its id, else where the
 *  backend would list it — a member's brand among the members' brands (they
 *  come first, by name), anything else at the end. */
export function placeBrand(list: GdBrandSummary[], brand: GdBrandSummary): GdBrandSummary[] {
  const same = list.findIndex((b) => b.brand_id === brand.brand_id);
  if (same >= 0) return list.map((b, i) => (i === same ? brand : b));
  if (brand.source !== "user") return [...list, brand];
  const name = brand.name.toLowerCase();
  const after = list.findIndex((b) => b.source !== "user" || b.name.toLowerCase().localeCompare(name) > 0);
  const at = after < 0 ? list.length : after;
  return [...list.slice(0, at), brand, ...list.slice(at)];
}

/** Record that a brand exists as of `now` — the sheet's save reply is proof. */
export const noteBrand = (s: BrandSightings, brand: GdBrandSummary, now: number): BrandSightings =>
  ({ ...s, [brand.brand_id]: { brand: brandSummaryOf(brand), at: now } });

/** An archived brand leaves the picker at once; the hold must not bring it back. */
export function forgetBrand(s: BrandSightings, brandId: string): BrandSightings {
  const rest: Record<string, BrandSighting> = { ...s };
  delete rest[brandId];
  return rest;
}

/** One list read, merged with what the picker has seen recently. The server's
 *  rows win for every id it lists; a brand it leaves out is kept while it was
 *  seen within `BRAND_HOLD_MS` — the read may come from an instance whose
 *  cache predates it — and dropped after that. */
export function mergeBrandList(
  server: GdBrandSummary[],
  seen: BrandSightings,
  now: number,
): { brands: GdBrandSummary[]; sightings: BrandSightings } {
  const sightings: Record<string, BrandSighting> = {};
  for (const b of server) sightings[b.brand_id] = { brand: b, at: now };
  let brands = server;
  for (const [id, s] of Object.entries(seen)) {
    if (id in sightings || now - s.at >= BRAND_HOLD_MS) continue;
    sightings[id] = s; // the hold runs from the last real sighting, not this read
    brands = placeBrand(brands, s.brand);
  }
  return { brands, sightings };
}

/** Which brand the picker holds after a list read. Nothing chosen yet → the
 *  backend's default. A brand the member chose is never swapped for another:
 *  if it is not in the list it stays chosen, and `missing` says so, so the
 *  screen can say it plainly and hold Generate until they pick again. */
export function settleBrandPick(
  current: string,
  brands: GdBrandSummary[],
  fallback: string,
): { brandId: string; missing: boolean } {
  if (!current) return { brandId: fallback, missing: false };
  return { brandId: current, missing: !brands.some((b) => b.brand_id === current) };
}

/** Whether focusing the picker should read the list again: not when it was
 *  read moments ago — focus and pointer-down both fire on one click. */
export const brandRefreshDue = (lastAt: number | null, now: number): boolean =>
  lastAt === null || now - lastAt >= BRAND_REFRESH_GAP_MS;
