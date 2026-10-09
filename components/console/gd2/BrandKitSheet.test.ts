/** The brand-kit sheet's decisions, proved without a DOM — `brandKit.ts` is
 *  the sheet's logic layer and this is its only safety net beside `tsc`.
 *
 *  Each block is a promise the sheet makes: files the backend would refuse are
 *  refused here first and named; a save sends the JSON before any byte of a
 *  file, and every upload goes to the id the JSON reply carried; a server
 *  refusal reaches the person in the backend's own words; the reference count
 *  is drawn against the cap; archive is offered to admins and to no one else.
 */

import { describe, expect, it } from "vitest";
import type { GdBrandDetail, GdBrandInput, GdBrandReference, GdBrandSummary } from "@/lib/api";
import type { UploadHooks, UploadRow, UploadSummary } from "../../../lib/directUpload";
import {
  BRAND_HOLD_MS,
  BRAND_REFRESH_GAP_MS,
  DEFAULT_REFERENCE_CAP,
  REFERENCE_BATCH,
  REFERENCE_CREATIVE_TYPES,
  REFERENCE_TYPE_OTHER,
  brandRefreshDue,
  brandSummaryOf,
  canArchiveBrand,
  checkFiles,
  describeBrandFailure,
  draftFrom,
  emptyDraft,
  emptyPending,
  forgetBrand,
  mergeBrandList,
  normalizeHex,
  noteBrand,
  placeBrand,
  referenceCountLabel,
  referenceTypeLabel,
  referencesRemaining,
  saveBrandKit,
  settleBrandPick,
  toInput,
  validateDraft,
  type BrandDraft,
  type BrandKitApi,
  type BrandSightings,
  type FileLike,
} from "./brandKit";

/* ------------------------------------------------------------- fixtures -- */

const MB = 1024 * 1024;

const file = (name: string, size: number, type = ""): FileLike => ({ name, size, type });

const brand = (over: Partial<GdBrandDetail> = {}): GdBrandDetail => ({
  brand_id: "b_new",
  name: "Berry Virtual",
  slug: "berry-virtual",
  source: "user",
  editable: true,
  logo_url: null,
  primary_colors: ["#1746A2"],
  has_kit: true,
  reference_count: 0,
  archived_at: null,
  created_by: "u1",
  tone_of_voice: "",
  website: "",
  fonts: [],
  colors: { primary: ["#1746A2"], secondary: [], accent: [] },
  assets: { logos: [], fonts: [], guidelines: [] },
  references: [],
  reference_cap: 200,
  ...over,
});

const ref = (id: string): GdBrandReference => ({
  ref_id: id, url: `/r/${id}`, kind: "reference", creative_type: null, note: "", created_at: "2026-09-25T00:00:00Z",
  original: null,
});

/** A refusal as `directUpload` rejects with it: the reason in words as the
 *  message, the backend's code beside it (read structurally, like the sheet). */
const refused = (words: string, code: string | null = null): Error =>
  Object.assign(new Error(words), { code });

/** Finalize's `upload`, as the backend sends it for a stored file. */
const summary = (over: Partial<UploadSummary> = {}): UploadSummary => ({
  surface: "logo", file: "mark.png", status: "stored", already_finalized: false, kind: "png", content_id: "md5",
  original: { bytes: 10, width: 100, height: 100, pages: null, download_url: "https://storage.example/o?sig=1" },
  working: { width: 100, height: 100, format: "png" }, pages_used: null, flags: [],
  ...over,
});

/** An `ApiError` as `lib/api` throws it, without importing the module (vitest
 *  does not resolve `@/`; the sheet reads `.status` structurally for the same
 *  reason). */
const apiError = (detail: string, status: number): Error =>
  Object.assign(new Error(detail), { status });

const draft = (over: Partial<BrandDraft> = {}): BrandDraft => ({
  ...emptyDraft(),
  name: "Berry Virtual",
  colors: { primary: ["#1746a2"], secondary: [], accent: [] },
  ...over,
});

/** A fake backend that records every call. Each upload is ONE file. */
function fakeApi(over: Partial<BrandKitApi<FileLike>> = {}) {
  const calls: string[] = [];
  let refCount = 0;
  const api: BrandKitApi<FileLike> = {
    create: async (body: GdBrandInput) => {
      calls.push(`create:${body.name}`);
      return brand({ name: body.name, primary_colors: body.primary_colors });
    },
    patch: async (id, body) => {
      calls.push(`patch:${id}:${body.name ?? ""}`);
      return brand({ brand_id: id, name: body.name ?? "Berry Virtual" });
    },
    uploadAsset: async (id, kind, f) => {
      calls.push(`asset:${id}:${kind}:${f.name}`);
      return {
        brand: brand({ brand_id: id, logo_url: kind === "logo" ? "/logo.png" : null }),
        upload: summary({ surface: kind, file: f.name }),
        route: "direct",
      };
    },
    uploadReference: async (id, f, meta) => {
      calls.push(`ref:${id}:${f.name}:${meta.kind ?? ""}:${meta.note ?? ""}`);
      refCount += 1;
      return {
        references: [ref(f.name)],
        reference_count: refCount,
        upload: summary({ surface: "reference", file: f.name }),
        route: "direct",
      };
    },
    ...over,
  };
  return { api, calls };
}

/* ----------------------------------------------------- client-side rules -- */

describe("checkFiles — the limits the backend enforces, applied before sending", () => {
  it("takes a raster logo up to the direct upload's 50 MB — the old 5 MB check is gone — and refuses one over it", () => {
    const ok = file("mark.png", 50 * MB, "image/png");
    const big = file("mark-hires.png", 50 * MB + 1, "image/png");
    const r = checkFiles("logo", [ok, big]);
    expect(r.accepted).toEqual([ok]);
    expect(r.rejected).toEqual([{ file: big, reason: "File too large (max 50 MB)" }]);
  });

  it("holds an SVG logo to its own 5 MB", () => {
    expect(checkFiles("logo", [file("mark.svg", 5 * MB, "image/svg+xml")]).accepted).toHaveLength(1);
    expect(checkFiles("logo", [file("mark.svg", 5 * MB + 1)]).rejected[0].reason).toBe("File too large (max 5 MB)");
  });

  it("takes a TIFF logo or reference — the direct upload reads it", () => {
    expect(checkFiles("logo", [file("mark.tif", MB)]).accepted).toHaveLength(1);
    expect(checkFiles("reference", [file("shoot.tiff", 48 * MB, "image/tiff")]).accepted).toHaveLength(1);
  });

  it("refuses a logo of the wrong type and says which types would do", () => {
    const r = checkFiles("logo", [file("mark.gif", 10, "image/gif")]);
    expect(r.accepted).toEqual([]);
    expect(r.rejected[0].reason).toBe("Not a PNG, SVG, WebP, JPEG or TIFF file");
  });

  it("judges fonts by extension, because browsers report their MIME type inconsistently", () => {
    const r = checkFiles("font", [file("Archivo.ttf", MB), file("Archivo.otf", MB, "font/otf"), file("Archivo.woff2", MB)]);
    expect(r.accepted.map((f) => f.name)).toEqual(["Archivo.ttf", "Archivo.otf"]);
    expect(r.rejected[0].reason).toBe("Not a TTF or OTF file");
  });

  it("caps fonts at 16 per brand, counting the ones already on file", () => {
    const r = checkFiles("font", [file("a.ttf", 10), file("b.ttf", 10)], 15);
    expect(r.accepted.map((f) => f.name)).toEqual(["a.ttf"]);
    expect(r.rejected[0].reason).toBe("Only 16 font files per brand");
  });

  it("refuses a font over 2 MB", () => {
    const r = checkFiles("font", [file("Heavy.ttf", 2 * MB + 1)]);
    expect(r.rejected[0].reason).toBe("File too large (max 2 MB)");
  });

  it("takes one PDF up to 50 MB as guidelines and nothing else", () => {
    const r = checkFiles("guidelines", [file("guide.pdf", 50 * MB, "application/pdf"), file("guide.docx", 10)]);
    expect(r.accepted.map((f) => f.name)).toEqual(["guide.pdf"]);
    expect(r.rejected[0].reason).toBe("Not a PDF file");
    expect(checkFiles("guidelines", [file("g.pdf", 50 * MB + 1)]).rejected[0].reason).toBe("File too large (max 50 MB)");
  });

  it("takes at most 10 references per pick, each up to 50 MB — a 50 MB image is not blocked here", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => file(`ref-${i}.jpg`, 50 * MB, "image/jpeg"));
    const r = checkFiles("reference", eleven);
    expect(r.accepted).toHaveLength(REFERENCE_BATCH);
    expect(r.rejected).toEqual([{ file: eleven[10], reason: "Only 10 files per upload" }]);
    expect(checkFiles("reference", [file("big.webp", 50 * MB + 1)]).rejected[0].reason).toBe("File too large (max 50 MB)");
  });
});

describe("normalizeHex", () => {
  it("accepts six or three hex digits with or without the hash, upper-cased", () => {
    expect(normalizeHex("#1746a2")).toBe("#1746A2");
    expect(normalizeHex("1746A2")).toBe("#1746A2");
    expect(normalizeHex(" abc ")).toBe("#AABBCC");
  });

  it("returns null for anything that is not a colour", () => {
    for (const bad of ["", "#12", "#GGGGGG", "blue", "#1746A2FF"]) expect(normalizeHex(bad)).toBeNull();
  });
});

describe("validateDraft — what stops a save before anything is sent", () => {
  it("needs a name and one primary colour", () => {
    expect(validateDraft(emptyDraft())).toEqual(["Give the brand a name.", "Add at least one primary colour."]);
  });

  it("names a hex it cannot read", () => {
    expect(validateDraft(draft({ colors: { primary: ["#1746A2"], secondary: ["teal"], accent: [] } })))
      .toEqual(['"teal" is not a hex colour — use six digits like #1746A2.']);
  });

  it("passes a complete draft", () => {
    expect(validateDraft(draft())).toEqual([]);
  });
});

describe("toInput / draftFrom", () => {
  it("normalises colours, trims text and drops blank colour rows", () => {
    const body = toInput(draft({
      name: "  Berry Virtual ",
      website: " https://berry.example ",
      tone_of_voice: " Plain. ",
      fonts: [" Archivo ", ""],
      colors: { primary: ["1746a2", ""], secondary: ["#ABC"], accent: [] },
    }));
    expect(body).toEqual({
      name: "Berry Virtual",
      primary_colors: ["#1746A2"],
      secondary_colors: ["#AABBCC"],
      accent_colors: [],
      fonts: ["Archivo"],
      tone_of_voice: "Plain.",
      website: "https://berry.example",
    });
  });

  it("sends `website` as an empty string when cleared, so a PATCH really clears it", () => {
    expect(toInput(draft()).website).toBe("");
    expect(toInput(draft({ website: "  " })).website).toBe("");
  });

  it("rebuilds a draft from what the backend holds, website included", () => {
    const d = draftFrom(brand({ tone_of_voice: "Warm.", website: "https://berry.example", fonts: ["Archivo"], colors: { primary: ["#1746A2"], secondary: ["#AABBCC"], accent: ["#FF6849"] } }));
    expect(d.name).toBe("Berry Virtual");
    expect(d.tone_of_voice).toBe("Warm.");
    expect(d.website).toBe("https://berry.example");
    expect(d.fonts).toEqual(["Archivo"]);
    expect(d.colors).toEqual({ primary: ["#1746A2"], secondary: ["#AABBCC"], accent: ["#FF6849"] });
  });
});

/* -------------------------------------------------------------- the save -- */

/** Rows as the save reported them last, by file name. */
const byName = (rows: UploadRow[]): Record<string, UploadRow> => Object.fromEntries(rows.map((r) => [r.name, r]));

describe("saveBrandKit — JSON first, then every file on its own against the returned id", () => {
  it("creates the brand, then sends each logo, font, guidelines PDF and reference to its new id as its own upload", async () => {
    const { api, calls } = fakeApi();
    const pending = emptyPending<FileLike>();
    pending.logo = [file("mark.png", 10)];
    pending.font = [file("Archivo.ttf", 10), file("Archivo-Bold.ttf", 10)];
    pending.guidelines = [file("guide.pdf", 10)];
    pending.reference = [file("r1.jpg", 10), file("r2.jpg", 10)];
    pending.reference_kind = "creative";
    pending.reference_note = "the layout";

    const out = await saveBrandKit(api, null, draft(), pending);

    expect(calls[0]).toBe("create:Berry Virtual");
    expect(calls.slice(1).sort()).toEqual([
      "asset:b_new:font:Archivo-Bold.ttf",
      "asset:b_new:font:Archivo.ttf",
      "asset:b_new:guidelines:guide.pdf",
      "asset:b_new:logo:mark.png",
      "ref:b_new:r1.jpg:creative:the layout",
      "ref:b_new:r2.jpg:creative:the layout",
    ]);
    expect(out.problems).toEqual([]);
    expect(out.brand?.brand_id).toBe("b_new");
    expect(out.brand?.references.map((r) => r.ref_id).sort()).toEqual(["r1.jpg", "r2.jpg"]);
    expect(out.brand?.reference_count).toBe(2);
    expect(out.rows.map((r) => [r.name, r.phase])).toEqual([
      ["mark.png", "stored"], ["Archivo.ttf", "stored"], ["Archivo-Bold.ttf", "stored"],
      ["guide.pdf", "stored"], ["r1.jpg", "stored"], ["r2.jpg", "stored"],
    ]);
    expect(out.failed).toEqual({ logo: [], font: [], guidelines: [], reference: [] });
  });

  it("patches an existing brand rather than creating a second one", async () => {
    const { api, calls } = fakeApi();
    const out = await saveBrandKit(api, "b_old", draft({ name: "Berry Virtual Ltd" }), emptyPending<FileLike>());
    expect(calls).toEqual(["patch:b_old:Berry Virtual Ltd"]);
    expect(out.brand?.brand_id).toBe("b_old");
  });

  it("sends nothing but the JSON when there is nothing to upload", async () => {
    const { api, calls } = fakeApi();
    const out = await saveBrandKit(api, null, draft(), emptyPending<FileLike>());
    expect(calls).toEqual(["create:Berry Virtual"]);
    expect(out.rows).toEqual([]);
  });

  it("sends every reference as its own upload — 23 files are 23 uploads with 23 rows, not batches of ten", async () => {
    const { api, calls } = fakeApi();
    const pending = emptyPending<FileLike>();
    pending.reference = Array.from({ length: 23 }, (_, i) => file(`r${i}.png`, 10));
    const out = await saveBrandKit(api, "b_old", draft(), pending);
    expect(calls.filter((c) => c.startsWith("ref:"))).toHaveLength(23);
    expect(out.rows).toHaveLength(23);
    expect(out.rows.every((r) => r.phase === "stored")).toBe(true);
    expect(out.brand?.references).toHaveLength(23);
  });

  it("on a 409 brand_exists, creates nothing, uploads nothing, and says so in words", async () => {
    const { api, calls } = fakeApi({
      create: async () => { throw apiError("brand_exists", 409); },
    });
    const pending = emptyPending<FileLike>();
    pending.logo = [file("mark.png", 10)];
    const out = await saveBrandKit(api, null, draft(), pending);
    expect(calls).toEqual([]);
    expect(out.brand).toBeNull();
    expect(out.problems).toEqual(["A brand with this name already exists."]);
    expect(out.rows).toEqual([]);
  });

  it("keeps a brand that was created when one file is refused, shows that file's reason on its own row, and keeps the file for a retry", async () => {
    const odd = file("odd.ttf", 10);
    const words = "This file type is not accepted for a font upload — use TTF or OTF.";
    const { api, calls } = fakeApi({
      uploadAsset: async (id, kind, f) => {
        calls.push(`asset:${id}:${kind}:${f.name}`);
        if (kind === "font") throw refused(words, "unsupported_file_type");
        return { brand: brand({ brand_id: id }), upload: null, route: "direct" };
      },
    });
    const pending = emptyPending<FileLike>();
    pending.logo = [file("mark.png", 10)];
    pending.font = [odd];
    pending.reference = [file("r.png", 10)];
    const out = await saveBrandKit(api, null, draft(), pending);
    expect(out.brand?.brand_id).toBe("b_new");
    expect(out.problems).toEqual([]);
    const rows = byName(out.rows);
    expect(rows["odd.ttf"].phase).toBe("failed");
    expect(rows["odd.ttf"].reason).toBe(words);
    expect(rows["mark.png"].phase).toBe("stored");
    expect(rows["r.png"].phase).toBe("stored");
    // The refusal of one file did not stop the ones after it.
    expect(calls).toContain("ref:b_new:r.png:creative:");
    expect(out.failed).toEqual({ logo: [], font: [odd], guidelines: [], reference: [] });
  });

  it("once the reference cap comes back, fails every reference not yet sent with the same reason — none is dropped silently", async () => {
    const cap = "This brand already holds as many references as it can.";
    const { api, calls } = fakeApi({
      uploadReference: async (id, f) => {
        calls.push(`ref:${id}:${f.name}`);
        throw refused(cap, "reference_cap_reached");
      },
    });
    const pending = emptyPending<FileLike>();
    pending.reference = Array.from({ length: 25 }, (_, i) => file(`r${i}.png`, 10));
    const out = await saveBrandKit(api, "b_old", draft(), pending);
    // Only the three already sending when the cap came back went out.
    expect(calls.filter((c) => c.startsWith("ref:"))).toHaveLength(3);
    expect(out.rows).toHaveLength(25);
    for (const row of out.rows) {
      expect(row.phase).toBe("failed");
      expect(row.reason).toBe(cap);
    }
    expect(out.failed.reference).toHaveLength(25);
  });

  it("stops every later file, of any kind, once the brand itself is gone", async () => {
    const gone = "This brand no longer exists — it may have been archived.";
    const { api, calls } = fakeApi({
      uploadAsset: async (id, kind, f) => {
        calls.push(`asset:${id}:${kind}:${f.name}`);
        throw refused(gone, "brand_not_found");
      },
    });
    const pending = emptyPending<FileLike>();
    pending.logo = ["a.png", "b.png", "c.png", "d.png"].map((n) => file(n, 10));
    pending.reference = [file("r.png", 10)];
    const out = await saveBrandKit(api, "b_old", draft(), pending);
    expect(calls.filter((c) => c.startsWith("asset:") || c.startsWith("ref:"))).toHaveLength(3);
    expect(out.rows.map((r) => r.reason)).toEqual(Array(5).fill(gone));
  });

  it("sends at most three files at once and finalizes them one at a time", async () => {
    let sending = 0;
    let maxSending = 0;
    let finalizing = 0;
    let maxFinalizing = 0;
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));
    const { api } = fakeApi({
      uploadReference: async (_id, f, _meta, hooks: UploadHooks) => {
        sending += 1;
        maxSending = Math.max(maxSending, sending);
        await tick();
        sending -= 1;
        await hooks.finalizeQueue(async () => {
          finalizing += 1;
          maxFinalizing = Math.max(maxFinalizing, finalizing);
          await tick();
          await tick();
          finalizing -= 1;
        });
        return { references: [ref(f.name)], reference_count: 1, upload: null, route: "direct" };
      },
    });
    const pending = emptyPending<FileLike>();
    pending.reference = Array.from({ length: 8 }, (_, i) => file(`r${i}.png`, 10));
    const out = await saveBrandKit(api, "b_old", draft(), pending);
    expect(out.rows.every((r) => r.phase === "stored")).toBe(true);
    expect(maxSending).toBe(3);
    expect(maxFinalizing).toBe(1);
  });

  it("shows each file's progress, then a calm note for anything the server changed on the way in", async () => {
    const seen: UploadRow[][] = [];
    const { api } = fakeApi({
      uploadAsset: async (id, _kind, _f, hooks) => {
        hooks.onProgress({ phase: "sending", route: "direct", sent: 5, total: 10 });
        return {
          brand: brand({ brand_id: id }),
          upload: summary({ flags: ["color_converted_without_profile"], pages_used: "1 of 3" }),
          route: "direct",
        };
      },
    });
    const pending = emptyPending<FileLike>();
    pending.logo = [file("mark.tif", 10)];
    const out = await saveBrandKit(api, "b_old", draft(), pending, (rows) => seen.push(rows));
    expect(seen.some((rows) => rows[0].phase === "sending" && rows[0].sent === 5)).toBe(true);
    expect(out.rows[0].phase).toBe("stored");
    expect(out.rows[0].notes).toEqual([
      "Colours were converted without a colour profile, so they may look slightly different.",
      "Only page 1 of 3 is used.",
    ]);
    expect(out.rows[0].downloadUrl).toBe("https://storage.example/o?sig=1");
  });
});

/* ----------------------------------------------------------------- words -- */

describe("describeBrandFailure — the backend's detail, in words", () => {
  it("translates the brand-level codes", () => {
    expect(describeBrandFailure(apiError("brand_exists", 409), "x")).toBe("A brand with this name already exists.");
    expect(describeBrandFailure(apiError("brand_not_editable", 409), "x")).toBe("This brand is built in — its kit cannot be changed here.");
    expect(describeBrandFailure(apiError("brand_not_found", 404), "x")).toBe("This brand no longer exists — it may have been archived.");
    expect(describeBrandFailure(apiError("reference_cap_reached", 409), "x")).toBe("This brand already holds as many references as it can.");
  });

  // A file that did not upload is worded per file by lib/directUpload.ts
  // (requestPolicy.test.ts pins those words); these are the brand-level ones.
  it("speaks plainly about a file code that reaches a brand-level call", () => {
    expect(describeBrandFailure(apiError("file_too_large", 413), "x")).toBe("The file is larger than the upload limit.");
    expect(describeBrandFailure(apiError("unsupported_file_type", 415), "x")).toBe("That file type is not accepted.");
    expect(describeBrandFailure(apiError("too_many_files", 422), "x")).toBe("Too many files in one upload.");
    expect(describeBrandFailure(apiError("empty_file", 422), "x")).toBe("The file is empty.");
    expect(describeBrandFailure(apiError("no_files", 422), "x")).toBe("No file was sent.");
  });

  it("names the pixel and count limits the backend added", () => {
    expect(describeBrandFailure(apiError("image_too_large", 422), "x"))
      .toBe("Image is larger than 4096 px on a side (or an SVG with an embedded image) — please resize it.");
    expect(describeBrandFailure(apiError("logo_limit_reached", 409), "x")).toBe("This brand already has 8 logos — remove one first.");
    expect(describeBrandFailure(apiError("font_limit_reached", 409), "x")).toBe("This brand already has 16 font files — remove one first.");
  });

  it("says what a 413 / 415 / 422 with no detail means — an edge in front of the backend, not the backend — and keeps a sentence the backend wrote", () => {
    expect(describeBrandFailure(apiError("Request failed (413)", 413), "x")).toBe("File too large.");
    expect(describeBrandFailure(apiError("Request failed (415)", 415), "x")).toBe("That file type is not accepted.");
    expect(describeBrandFailure(apiError("Request failed", 422), "x")).toMatch(/not accepted/);
    // gd_brands.py's one prose 422 reaches the person as written.
    expect(describeBrandFailure(apiError("a brand name needs at least one letter or digit", 422), "x")).toBe("a brand name needs at least one letter or digit");
  });

  it("falls back to the caller's sentence when there is nothing better", () => {
    expect(describeBrandFailure(new Error(""), "The brand could not be saved.")).toBe("The brand could not be saved.");
    expect(describeBrandFailure("boom", "fallback")).toBe("fallback");
    expect(describeBrandFailure(new Error("Your session expired — please sign in again."), "x")).toBe("Your session expired — please sign in again.");
  });
});

/* ------------------------------------------------------ count and archive -- */

describe("the reference count against the cap", () => {
  it("is drawn as n / cap, with the backend's cap when the brand exists", () => {
    expect(referenceCountLabel(12, 200)).toBe("12 / 200");
    expect(referenceCountLabel(0, DEFAULT_REFERENCE_CAP)).toBe("0 / 200");
    expect(referenceCountLabel(brand({ reference_cap: 50 }).references.length, brand({ reference_cap: 50 }).reference_cap)).toBe("0 / 50");
  });

  it("never reports negative room", () => {
    expect(referencesRemaining(200, 200)).toBe(0);
    expect(referencesRemaining(205, 200)).toBe(0);
    expect(referencesRemaining(3, 200)).toBe(197);
  });
});

describe("canArchiveBrand — the one control reserved for admins", () => {
  it("is offered to an admin and to a creator who is one", () => {
    expect(canArchiveBrand({ is_admin: true })).toBe(true);
    expect(canArchiveBrand({ is_admin: true, is_creator: true })).toBe(true);
  });

  it("is hidden from a member, from a session stored before the flag, and from no one at all", () => {
    expect(canArchiveBrand({})).toBe(false);
    expect(canArchiveBrand({ is_admin: false })).toBe(false);
    expect(canArchiveBrand({ is_geo_only: true })).toBe(false);
    expect(canArchiveBrand(null)).toBe(false);
    expect(canArchiveBrand(undefined)).toBe(false);
  });
});

/* ---------------------------------------- verification pass, 2026-09-25 -- */

describe("checkFiles — what a real picker hands over", () => {
  it("judges the extension case-insensitively and takes .jpeg as well as .jpg", () => {
    const r = checkFiles("logo", [file("MARK.PNG", 10), file("photo.JPEG", 10), file("photo.jpeg", 10, "image/jpeg")]);
    expect(r.accepted.map((f) => f.name)).toEqual(["MARK.PNG", "photo.JPEG", "photo.jpeg"]);
  });

  it("refuses a file whose MIME lies but whose extension is right only when the size is wrong — the backend sniffs the bytes", () => {
    // The client cannot read bytes; it lets an `.exe` renamed `logo.png` through
    // and relies on the backend's 415. That contract is pinned server-side
    // (test_gd_elements_api: an executable renamed to an image is refused).
    const r = checkFiles("logo", [file("logo.png", 10, "application/x-msdownload")]);
    expect(r.accepted).toHaveLength(1);
  });

  it("applies the guidelines limit as one PDF per brand, replacing rather than adding", () => {
    const r = checkFiles("guidelines", [file("a.pdf", 10), file("b.pdf", 10)], 0);
    expect(r.accepted.map((f) => f.name)).toEqual(["a.pdf"]);
    expect(r.rejected[0].reason).toBe("Only one file — replace the one on file");
  });
});

describe("describeBrandFailure — the codes the backend really sends", () => {
  // gd_brands.py answers with snake_case codes in `detail`: file_too_large (413),
  // unsupported_file_type (415), empty_file / no_files / too_many_files /
  // image_too_large (422), font_limit_reached / logo_limit_reached (409),
  // brand_not_found (404). None may reach the person as a code.
  it("turns every backend code into words rather than showing the code", () => {
    const codes = [
      "brand_exists", "brand_not_editable", "brand_not_found", "reference_cap_reached",
      "file_too_large", "unsupported_file_type", "image_too_large", "empty_file", "no_files",
      "too_many_files", "font_limit_reached", "logo_limit_reached",
    ];
    for (const code of codes) {
      const words = describeBrandFailure(apiError(code, 400), "x");
      expect(words, code).not.toBe(code);
      expect(words, code).not.toMatch(/_/);
    }
  });

  it("shows an unknown code as sent — the backend's word beats a guess", () => {
    expect(describeBrandFailure(apiError("something_new", 409), "x")).toBe("something_new");
  });
});

describe("reference uploads — kind and type", () => {
  it("defaults to past creatives, the common upload", () => {
    expect(emptyPending().reference_kind).toBe("creative");
    expect(emptyPending().reference_creative_type).toBe("");
  });

  it("offers exactly the backend's REFERENCE_CATEGORIES plus 'not sure', which sends nothing", () => {
    expect(REFERENCE_CREATIVE_TYPES.map((t) => t.value)).toEqual(["brand_gradient", "newsletter"]);
    expect(REFERENCE_TYPE_OTHER.value).toBe("");
  });

  it("labels a stored type, shows an unknown one as sent, and nothing for none", () => {
    expect(referenceTypeLabel("brand_gradient")).toBe("Brand gradient");
    expect(referenceTypeLabel("legacy_social")).toBe("legacy_social");
    expect(referenceTypeLabel(null)).toBeNull();
    expect(referenceTypeLabel("")).toBeNull();
  });
});

describe("saveBrandKit — a create that lands but whose uploads all fail is still a create", () => {
  it("returns the created brand with each file's own reason, in the order they were sent", async () => {
    const tooBig = "The file is 61.0 MB; the limit here is 50 MB.";
    const heic = "HEIC/HEIF and AVIF images are not supported — export as JPEG/PNG. Accepted here: PNG, JPEG, WebP or TIFF.";
    const { api, calls } = fakeApi({
      uploadAsset: async (id, kind, f) => {
        calls.push(`asset:${id}:${kind}:${f.name}`);
        throw refused(tooBig, "file_too_large");
      },
      uploadReference: async (id, f) => {
        calls.push(`ref:${id}:${f.name}`);
        throw refused(heic, "unsupported_file_type");
      },
    });
    const pending = emptyPending<FileLike>();
    pending.logo = [file("mark.png", 10)];
    pending.guidelines = [file("g.pdf", 10)];
    pending.reference = [file("r.heic", 10)];
    const out = await saveBrandKit(api, null, draft(), pending);
    expect(out.brand?.brand_id).toBe("b_new");
    expect(out.problems).toEqual([]);
    expect(out.rows.map((r) => [r.name, r.phase, r.reason])).toEqual([
      ["mark.png", "failed", tooBig],
      ["g.pdf", "failed", tooBig],
      ["r.heic", "failed", heic],
    ]);
    expect(calls[0]).toBe("create:Berry Virtual");
    expect(calls.slice(1).sort()).toEqual(["asset:b_new:guidelines:g.pdf", "asset:b_new:logo:mark.png", "ref:b_new:r.heic"]);
  });

  it("keeps the brand the PATCH returned when nothing was uploaded, so the sheet shows the server's copy", async () => {
    const { api } = fakeApi({
      patch: async (id) => brand({ brand_id: id, name: "Renamed by the server", fonts: ["Archivo"] }),
    });
    const out = await saveBrandKit(api, "b_old", draft({ name: "Anything" }), emptyPending<FileLike>());
    expect(out.brand?.name).toBe("Renamed by the server");
    expect(out.brand?.fonts).toEqual(["Archivo"]);
  });
});

/* ------------------------------------------------ the studio's brand picker -- */

/** A picker row. `legalsoft` is the backend's default and a built-in pack. */
const row = (brand_id: string, name: string, source: GdBrandSummary["source"] = "user"): GdBrandSummary => ({
  brand_id, name, slug: brand_id, source, editable: source === "user",
  logo_url: null, primary_colors: ["#1746A2"], has_kit: false, reference_count: 0,
});
const legalSoft = row("legalsoft", "Legal Soft", "builtin");
const acme = row("acme", "Acme Law");
const T0 = 1_000_000;

/** One list read as the studio applies it: merge, then settle the pick. */
function read(server: GdBrandSummary[], seen: BrandSightings, now: number, current: string) {
  const merged = mergeBrandList(server, seen, now);
  return { ...merged, pick: settleBrandPick(current, merged.brands, "legalsoft") };
}

describe("S3 — a brand just saved stays chosen when the list read is behind it", () => {
  it("keeps the new brand listed and chosen when the refetch lands on an instance whose cache predates it", () => {
    // The save reply says Berry exists; the list read that follows does not.
    const saved = noteBrand({}, brand({ brand_id: "berry", name: "Berry Virtual" }), T0);
    const r = read([acme, legalSoft], saved, T0 + 2_000, "berry");
    expect(r.brands.map((b) => b.brand_id)).toEqual(["acme", "berry", "legalsoft"]);
    expect(r.pick).toEqual({ brandId: "berry", missing: false });
  });

  it("uses the server's row once the list returns the brand, with no duplicate", () => {
    const saved = noteBrand({}, brand({ brand_id: "berry", name: "Berry Virtual" }), T0);
    const fromServer = { ...row("berry", "Berry Virtual"), reference_count: 4 };
    const r = read([acme, fromServer, legalSoft], saved, T0 + 5_000, "berry");
    expect(r.brands).toEqual([acme, fromServer, legalSoft]);
    expect(r.sightings.berry).toEqual({ brand: fromServer, at: T0 + 5_000 });
  });

  it("does not drop a brand again when a fresh read is followed by a stale one inside the cache window", () => {
    const first = read([acme, row("berry", "Berry Virtual"), legalSoft], {}, T0, "berry");
    const stale = read([acme, legalSoft], first.sightings, T0 + 30_000, "berry");
    expect(stale.brands.map((b) => b.brand_id)).toContain("berry");
    expect(stale.pick).toEqual({ brandId: "berry", missing: false });
  });

  it("says a chosen brand is missing once the hold has passed, and never substitutes Legal Soft for it", () => {
    const saved = noteBrand({}, row("berry", "Berry Virtual"), T0);
    const later = read([acme, legalSoft], saved, T0 + BRAND_HOLD_MS, "berry");
    expect(later.brands.map((b) => b.brand_id)).toEqual(["acme", "legalsoft"]);
    expect(later.sightings).not.toHaveProperty("berry");
    expect(later.pick).toEqual({ brandId: "berry", missing: true });
  });

  it("holds from the last sighting, not from each read that leaves the brand out", () => {
    const saved = noteBrand({}, row("berry", "Berry Virtual"), T0);
    const a = read([legalSoft], saved, T0 + 60_000, "berry");
    expect(a.sightings.berry.at).toBe(T0);
    expect(read([legalSoft], a.sightings, T0 + BRAND_HOLD_MS - 1, "berry").pick.missing).toBe(false);
    expect(read([legalSoft], a.sightings, T0 + BRAND_HOLD_MS, "berry").pick.missing).toBe(true);
  });

  it("does not hold a brand the member archived", () => {
    const seen = forgetBrand(noteBrand({}, row("berry", "Berry Virtual"), T0), "berry");
    expect(read([legalSoft], seen, T0 + 1_000, "").brands).toEqual([legalSoft]);
  });

  it("projects the save reply to a picker row, leaving the kit's heavy fields out", () => {
    const summary = brandSummaryOf(brand({ brand_id: "berry", references: [ref("r1")] }));
    expect(Object.keys(summary).sort()).toEqual([
      "brand_id", "editable", "has_kit", "logo_url", "name", "primary_colors", "reference_count", "slug", "source",
    ]);
    expect(noteBrand({}, brand({ brand_id: "berry" }), T0).berry.brand).toEqual(summary);
  });
});

describe("settleBrandPick — the backend's default only when nothing was chosen", () => {
  it("takes the default on first load", () => {
    expect(settleBrandPick("", [acme, legalSoft], "legalsoft")).toEqual({ brandId: "legalsoft", missing: false });
  });

  it("keeps a listed choice", () => {
    expect(settleBrandPick("acme", [acme, legalSoft], "legalsoft")).toEqual({ brandId: "acme", missing: false });
  });

  it("keeps an unlisted choice and flags it, rather than falling back to the default", () => {
    expect(settleBrandPick("gone", [acme, legalSoft], "legalsoft")).toEqual({ brandId: "gone", missing: true });
  });
});

describe("placeBrand — where a held brand sits in the list", () => {
  it("puts a member's brand among the members' brands, by name, ahead of the built-in packs", () => {
    const list = [acme, row("zeta", "Zeta Legal"), legalSoft];
    expect(placeBrand(list, row("berry", "berry virtual")).map((b) => b.brand_id)).toEqual(["acme", "berry", "zeta", "legalsoft"]);
    expect(placeBrand([legalSoft], row("berry", "Berry")).map((b) => b.brand_id)).toEqual(["berry", "legalsoft"]);
    expect(placeBrand([acme], row("zz", "Zz")).map((b) => b.brand_id)).toEqual(["acme", "zz"]);
  });

  it("replaces the row with the same id in place — an edit renames, it does not add", () => {
    const out = placeBrand([acme, legalSoft], row("acme", "Acme Law LLP"));
    expect(out.map((b) => b.name)).toEqual(["Acme Law LLP", "Legal Soft"]);
  });

  it("puts anything that is not a member's brand at the end", () => {
    expect(placeBrand([acme, legalSoft], row("ingested", "Aaa Ingested", "builtin")).map((b) => b.brand_id))
      .toEqual(["acme", "legalsoft", "ingested"]);
  });
});

describe("S7 — the picker reads the list again on focus, lightly", () => {
  it("reads when it never has, and again once the gap has passed", () => {
    expect(brandRefreshDue(null, T0)).toBe(true);
    expect(brandRefreshDue(T0, T0 + BRAND_REFRESH_GAP_MS)).toBe(true);
  });

  it("does not read twice for one click (focus and pointer-down both fire) or on rapid refocus", () => {
    expect(brandRefreshDue(T0, T0)).toBe(false);
    expect(brandRefreshDue(T0, T0 + BRAND_REFRESH_GAP_MS - 1)).toBe(false);
  });

  it("shows a brand another member added as soon as a read returns it", () => {
    const before = read([acme, legalSoft], {}, T0, "acme");
    const after = read([acme, row("berry", "Berry Virtual"), legalSoft], before.sightings, T0 + BRAND_REFRESH_GAP_MS, "acme");
    expect(after.brands.map((b) => b.name)).toContain("Berry Virtual");
    expect(after.pick).toEqual({ brandId: "acme", missing: false });
  });
});
