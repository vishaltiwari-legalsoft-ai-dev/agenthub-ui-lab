import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDeadline,
  deadlineFor,
  humanDuration,
  isAbortError,
  isTimeoutError,
  isUnanswered,
  DEFAULT_TIMEOUT_MS,
  NO_TIMEOUT,
  RequestSequence,
  RequestTimeoutError,
  SLOW_TIMEOUT_MS,
  UPLOAD_PUT_TIMEOUT_MS,
} from "./requestPolicy";
import {
  describeUploadError,
  linkKind,
  MAX_FINALIZE_RETRIES,
  MAX_ROUNDS,
  multipartLimit,
  multipartRefusal,
  nextStep,
  readUploadSummary,
  retryWaitMs,
  runDirectUpload,
  StoragePutError,
  storageHeaders,
  uploadNotes,
  UploadError,
  type UploadEffects,
  type UploadProgress,
  type UploadSignature,
} from "./directUpload";

afterEach(() => {
  vi.useRealTimers();
});

describe("deadlineFor", () => {
  it("gives database-shaped reads the default deadline", () => {
    expect(deadlineFor("/api/mr/snapshots/vendor/lifted?date_iso=2026-08-14")).toBe(DEFAULT_TIMEOUT_MS);
    expect(deadlineFor("/api/admin/db/collections/runs?limit=50")).toBe(DEFAULT_TIMEOUT_MS);
    expect(deadlineFor("/api/seo-geo/brands/abc")).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("gives model, crawl and render work the slow deadline", () => {
    expect(deadlineFor("/api/gd/runs/r1/generate", "POST")).toBe(SLOW_TIMEOUT_MS);
    expect(deadlineFor("/api/seo-geo/site-review/b1", "POST")).toBe(SLOW_TIMEOUT_MS);
    expect(deadlineFor("/api/seo-geo/keywords/b1/run", "POST")).toBe(SLOW_TIMEOUT_MS);
    expect(deadlineFor("/api/seo-geo/competitors/b1/profiles/refresh", "POST")).toBe(SLOW_TIMEOUT_MS);
    expect(deadlineFor("/api/blog/runs/r1/research/step", "POST")).toBe(SLOW_TIMEOUT_MS);
    expect(deadlineFor("/api/geo/brands/b1/poll/step", "POST")).toBe(SLOW_TIMEOUT_MS);
    expect(deadlineFor("/api/mr/snapshots/capture", "POST")).toBe(SLOW_TIMEOUT_MS);
    expect(deadlineFor("/api/mr/snapshots/vendor/lifted/pdf?date_iso=2026-08-14")).toBe(SLOW_TIMEOUT_MS);
    // The board report writes no narrative and makes no model call, but it
    // loads the whole dataset and scans this workspace's runs behind it; its
    // documents render server-side.
    expect(deadlineFor("/api/mr/board-report", "POST")).toBe(SLOW_TIMEOUT_MS);
    expect(deadlineFor("/api/mr/board-report/run_1/pdf")).toBe(SLOW_TIMEOUT_MS);
  });

  it("separates the two methods that share the briefs path", () => {
    // POST builds a brief off live SERP data; GET just lists what is stored.
    expect(deadlineFor("/api/seo-geo/briefs/b1", "POST")).toBe(SLOW_TIMEOUT_MS);
    expect(deadlineFor("/api/seo-geo/briefs/b1", "GET")).toBe(DEFAULT_TIMEOUT_MS);
    expect(deadlineFor("/api/seo-geo/briefs/b1")).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("lets a call site override the table, including opting out entirely", () => {
    expect(deadlineFor("/api/mr/overview", "GET", 5_000)).toBe(5_000);
    expect(deadlineFor("/api/gd/runs/r1/generate", "POST", NO_TIMEOUT)).toBe(0);
    expect(deadlineFor("/api/mr/overview", "GET", -1)).toBe(0);
  });

  it("matches on the route, not the query string", () => {
    expect(deadlineFor("/api/mr/lead-analysis/pdf?month=2026-08")).toBe(SLOW_TIMEOUT_MS);
  });

  it("gives a direct upload's finalize the slow deadline and its sign the default", () => {
    // Finalize may wait 30 s for the decode slot, decode ~100 MP and copy 50 MB.
    expect(deadlineFor("/api/gd/brands/b1/uploads/finalize", "POST")).toBe(SLOW_TIMEOUT_MS);
    expect(deadlineFor("/api/gd/runs/r1/uploads/finalize", "POST")).toBe(SLOW_TIMEOUT_MS);
    expect(deadlineFor("/api/gd/brands/b1/uploads", "POST")).toBe(DEFAULT_TIMEOUT_MS);
    expect(deadlineFor("/api/gd/runs/r1/uploads", "POST")).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("gives the PUT to storage ten minutes — the whole 50 MB transfer, not a server's think time", () => {
    expect(UPLOAD_PUT_TIMEOUT_MS).toBe(600_000);
  });
});

describe("humanDuration", () => {
  it("reads as something a non-engineer can act on", () => {
    expect(humanDuration(DEFAULT_TIMEOUT_MS)).toBe("90 seconds");
    expect(humanDuration(SLOW_TIMEOUT_MS)).toBe("10 minutes");
    expect(humanDuration(1_000)).toBe("1 second");
    expect(humanDuration(30_000)).toBe("30 seconds");
  });
});

describe("error classification", () => {
  it("tells a timeout apart from a cancellation", () => {
    const timeout = new RequestTimeoutError(DEFAULT_TIMEOUT_MS);
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });

    expect(isTimeoutError(timeout)).toBe(true);
    expect(isAbortError(timeout)).toBe(false); // a timeout is a real failure to show

    expect(isAbortError(abort)).toBe(true); // supersession: stay silent
    expect(isTimeoutError(abort)).toBe(false);

    expect(isAbortError(new Error("Request failed (500)"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });

  it("says how long it waited, in the message the user sees", () => {
    expect(new RequestTimeoutError(SLOW_TIMEOUT_MS).message).toContain("10 minutes");
    expect(new RequestTimeoutError(DEFAULT_TIMEOUT_MS).message).toContain("cancelled");
  });

  /* A long POST the relay cut at 300 s is still running on Cloud Run; the
     creative watch reads the run back by id instead of calling it failed. */
  it("counts the relay's 504, a dropped connection and our deadline as unanswered", () => {
    const relayCut = Object.assign(new Error("Request failed (504)"), { status: 504 });
    expect(isUnanswered(relayCut)).toBe(true);
    expect(isUnanswered(new TypeError("Failed to fetch"))).toBe(true);
    expect(isUnanswered(new TypeError("Load failed"))).toBe(true);
    expect(isUnanswered(new RequestTimeoutError(SLOW_TIMEOUT_MS))).toBe(true);
  });

  it("never mistakes the backend's own answer, or a cancellation, for a lost one", () => {
    // 503 is "engine missing" / "file storage unavailable" — said by the backend.
    expect(isUnanswered(Object.assign(new Error("storage down"), { status: 503 }))).toBe(false);
    expect(isUnanswered(Object.assign(new Error("Plan must be approved"), { status: 400 }))).toBe(false);
    expect(isUnanswered(Object.assign(new Error("Run not found"), { status: 404 }))).toBe(false);
    expect(isUnanswered(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(false);
    expect(isUnanswered(new Error("Your session expired — please sign in again."))).toBe(false);
    expect(isUnanswered(null)).toBe(false);
    expect(isUnanswered("504")).toBe(false);
  });
});

describe("createDeadline", () => {
  it("aborts once the deadline passes and reports it as expired", () => {
    vi.useFakeTimers();
    const deadline = createDeadline("/api/mr/overview", "GET");

    expect(deadline.signal?.aborted).toBe(false);
    expect(deadline.expired).toBe(false);

    vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS);

    expect(deadline.signal?.aborted).toBe(true);
    expect(deadline.expired).toBe(true);
  });

  it("does not cut off work that legitimately takes minutes", () => {
    vi.useFakeTimers();
    const deadline = createDeadline("/api/gd/runs/r1/generate", "POST");

    vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS * 2);
    expect(deadline.signal?.aborted).toBe(false);

    vi.advanceTimersByTime(SLOW_TIMEOUT_MS);
    expect(deadline.expired).toBe(true);
  });

  it("clear() stops the timer, so a settled request is never aborted late", () => {
    vi.useFakeTimers();
    const deadline = createDeadline("/api/mr/overview", "GET");
    deadline.clear();

    vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS * 10);
    expect(deadline.signal?.aborted).toBe(false);
    expect(deadline.expired).toBe(false);
  });

  it("relays the caller's cancellation without calling it a timeout", () => {
    const outer = new AbortController();
    const deadline = createDeadline("/api/mr/overview", "GET", { signal: outer.signal });

    outer.abort();

    expect(deadline.signal?.aborted).toBe(true);
    expect(deadline.expired).toBe(false); // superseded, not slow — stay silent
  });

  it("starts already-aborted when the caller's signal is", () => {
    const outer = new AbortController();
    outer.abort();
    const deadline = createDeadline("/api/mr/overview", "GET", { signal: outer.signal });

    expect(deadline.signal?.aborted).toBe(true);
    expect(deadline.expired).toBe(false);
  });

  it("hands fetch no signal only when nothing could ever cancel the call", () => {
    expect(createDeadline("/api/mr/overview", "GET", { timeoutMs: NO_TIMEOUT }).signal).toBeUndefined();
    expect(createDeadline("/api/mr/overview", "GET").signal).toBeInstanceOf(AbortSignal);
  });
});

describe("RequestSequence", () => {
  it("aborts the previous request when a newer one starts", () => {
    const seq = new RequestSequence();
    const first = seq.start();
    const second = seq.start();

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  it("blocks the stale write even when the old response already arrived", () => {
    // The bug this exists for: aborting a fetch whose response has landed does
    // nothing — the `.then` still runs. Only the ticket check stops vendor A's
    // numbers rendering under vendor B's name.
    const seq = new RequestSequence();
    const vendorA = seq.start();
    const vendorB = seq.start();

    expect(seq.isCurrent(vendorA)).toBe(false);
    expect(seq.isCurrent(vendorB)).toBe(true);
  });

  it("keeps the newest ticket current across many rapid switches", () => {
    const seq = new RequestSequence();
    const tickets = [seq.start(), seq.start(), seq.start(), seq.start()];
    const newest = tickets[tickets.length - 1];

    for (const t of tickets.slice(0, -1)) {
      expect(t.signal.aborted).toBe(true);
      expect(seq.isCurrent(t)).toBe(false);
    }
    expect(seq.isCurrent(newest)).toBe(true);
    expect(newest.signal.aborted).toBe(false);
  });

  it("cancel() leaves nothing current, so a late reply is dropped", () => {
    const seq = new RequestSequence();
    const ticket = seq.start();

    seq.cancel();

    expect(ticket.signal.aborted).toBe(true);
    expect(seq.isCurrent(ticket)).toBe(false);
  });

  it("survives cancel() with nothing in flight", () => {
    const seq = new RequestSequence();
    expect(() => seq.cancel()).not.toThrow();
    const ticket = seq.start();
    expect(seq.isCurrent(ticket)).toBe(true);
  });
});

/* ----------------------------------------------- direct uploads to GCS -- */
/* The rules in lib/directUpload.ts: each file goes sign -> PUT -> finalize;
   which step is tried again after which failure, when a file falls back to
   the multipart route, and what the person reads. */

/** A rejection as `lib/api` throws it, built structurally (vitest does not
 *  resolve `@/`): the backend's `detail` object, its code, `Retry-After`. */
const apiErr = (status: number, detail: unknown, retryAfterS: number | null = null): Error => {
  const d = typeof detail === "object" && detail !== null ? (detail as { code?: string; message?: string }) : null;
  const message = typeof detail === "string" ? detail : d?.message ?? "Request failed";
  return Object.assign(new Error(message), { name: "ApiError", status, code: d?.code ?? null, detail, retryAfterS });
};
const coded = (status: number, code: string, message = `${code} words`, facts: Record<string, unknown> = {}) =>
  apiErr(status, { code, message, ...facts });
const aborted = () => Object.assign(new Error("aborted"), { name: "AbortError" });
const first = { rounds: 1, finalizeRetries: 0 };

describe("nextStep — sign", () => {
  it("falls back to the multipart route when direct uploads are switched off", () => {
    expect(nextStep("sign", coded(503, "direct_uploads_disabled"), first)).toEqual({ kind: "fallback" });
  });

  it("falls back when an older backend has no such route — a 404 or 405 with no code", () => {
    expect(nextStep("sign", apiErr(404, "Not Found"), first)).toEqual({ kind: "fallback" });
    expect(nextStep("sign", apiErr(405, "Method Not Allowed"), first)).toEqual({ kind: "fallback" });
  });

  it("does not fall back on a 404 that is the backend's answer about the brand or run", () => {
    expect(nextStep("sign", coded(404, "brand_not_found", "brand_not_found"), first)).toEqual({ kind: "stop" });
    expect(nextStep("sign", coded(404, "run_not_found", "Run not found"), first)).toEqual({ kind: "stop" });
  });

  it("asks again after a sign that may pass — storage unavailable, a relay 504, a dropped connection — within the round budget", () => {
    const wait = expect.objectContaining({ kind: "retry" });
    expect(nextStep("sign", coded(503, "upload_storage_unavailable"), first)).toEqual(wait);
    expect(nextStep("sign", apiErr(504, "Request failed"), first)).toEqual(wait);
    expect(nextStep("sign", new TypeError("Failed to fetch"), first)).toEqual(wait);
    expect(nextStep("sign", new RequestTimeoutError(90_000), first)).toEqual(wait);
    expect(nextStep("sign", coded(503, "upload_storage_unavailable"), { rounds: MAX_ROUNDS, finalizeRetries: 0 }))
      .toEqual({ kind: "stop" });
  });

  it("stops on a refusal — the file is too large, the wrong type, or the brand is full", () => {
    expect(nextStep("sign", coded(413, "file_too_large"), first)).toEqual({ kind: "stop" });
    expect(nextStep("sign", coded(415, "unsupported_file_type"), first)).toEqual({ kind: "stop" });
    expect(nextStep("sign", coded(409, "logo_limit_reached", "logo_limit_reached"), first)).toEqual({ kind: "stop" });
    expect(nextStep("sign", coded(409, "prompt_image_limit_reached"), first)).toEqual({ kind: "stop" });
  });

  it("says nothing when the caller cancelled", () => {
    expect(nextStep("sign", aborted(), first)).toEqual({ kind: "drop" });
  });
});

describe("nextStep — PUT", () => {
  it("starts over from sign after any failed PUT: a header mismatch, out of range, a second PUT, no answer", () => {
    for (const e of [
      new StoragePutError(403, "status"), new StoragePutError(400, "status"), new StoragePutError(412, "status"),
      new StoragePutError(503, "status"), new StoragePutError(0, "network"), new StoragePutError(0, "timeout"),
    ]) {
      expect(nextStep("put", e, first), `${e.status} ${e.failure}`).toEqual({ kind: "restart" });
    }
  });

  it("stops once the rounds are spent, and says nothing on a cancel", () => {
    expect(nextStep("put", new StoragePutError(403, "status"), { rounds: MAX_ROUNDS, finalizeRetries: 0 })).toEqual({ kind: "stop" });
    expect(nextStep("put", aborted(), first)).toEqual({ kind: "drop" });
  });
});

describe("nextStep — finalize", () => {
  it("retries a 503 with the SAME ticket, waiting what Retry-After says", () => {
    expect(nextStep("finalize", apiErr(503, { code: "upload_busy", message: "busy", retry_after: 30 }, 30), { rounds: 1, finalizeRetries: 1 }))
      .toEqual({ kind: "retry", waitMs: 30_000 });
    expect(nextStep("finalize", coded(503, "upload_storage_unavailable"), { rounds: 1, finalizeRetries: 1 }).kind).toBe("retry");
  });

  it("retries the same ticket when the answer never came — a retried finalize answers the recorded result", () => {
    expect(nextStep("finalize", apiErr(504, "Request failed"), { rounds: 1, finalizeRetries: 1 }).kind).toBe("retry");
    expect(nextStep("finalize", new TypeError("Failed to fetch"), { rounds: 1, finalizeRetries: 1 }).kind).toBe("retry");
    expect(nextStep("finalize", new RequestTimeoutError(600_000), { rounds: 1, finalizeRetries: 1 }).kind).toBe("retry");
  });

  it("stops retrying the ticket once the retries are spent", () => {
    expect(nextStep("finalize", coded(503, "upload_busy"), { rounds: 1, finalizeRetries: MAX_FINALIZE_RETRIES }).kind).toBe("retry");
    expect(nextStep("finalize", coded(503, "upload_busy"), { rounds: 1, finalizeRetries: MAX_FINALIZE_RETRIES + 1 }))
      .toEqual({ kind: "stop" });
  });

  it("does not retry a host that cannot render SVG at all — its words already say what to do", () => {
    expect(nextStep("finalize", coded(503, "svg_renderer_unavailable"), { rounds: 1, finalizeRetries: 1 })).toEqual({ kind: "stop" });
  });

  it("starts over from sign when the ticket or the uploaded object is gone", () => {
    for (const code of ["upload_ticket_expired", "upload_ticket_invalid", "upload_ticket_wrong_user", "upload_ticket_wrong_target"]) {
      expect(nextStep("finalize", coded(403, code), { rounds: 1, finalizeRetries: 1 }), code).toEqual({ kind: "restart" });
    }
    expect(nextStep("finalize", coded(404, "upload_not_found"), { rounds: 1, finalizeRetries: 1 })).toEqual({ kind: "restart" });
    expect(nextStep("finalize", coded(403, "upload_ticket_expired"), { rounds: MAX_ROUNDS, finalizeRetries: 1 })).toEqual({ kind: "stop" });
  });

  it("stops with the reason when the FILE is refused — sending all 50 MB again would be refused again", () => {
    for (const [status, code] of [
      [413, "file_too_large"], [415, "unsupported_file_type"], [422, "image_too_large"], [422, "unsafe_svg"],
      [422, "pdf_too_many_pages"], [409, "reference_cap_reached"], [404, "brand_not_found"], [404, "run_not_found"],
    ] as const) {
      expect(nextStep("finalize", coded(status, code), { rounds: 1, finalizeRetries: 1 }), code).toEqual({ kind: "stop" });
    }
  });

  it("stops on an expired session — a status-less refusal that is not a lost connection", () => {
    expect(nextStep("finalize", new Error("Your session expired — please sign in again."), { rounds: 1, finalizeRetries: 1 }))
      .toEqual({ kind: "stop" });
  });
});

describe("retryWaitMs", () => {
  it("takes the server's Retry-After, from the header or detail.retry_after, clamped to a minute", () => {
    expect(retryWaitMs(apiErr(503, { code: "upload_busy" }, 30), 1)).toBe(30_000);
    expect(retryWaitMs(apiErr(503, { code: "upload_busy", retry_after: 12 }), 1)).toBe(12_000);
    expect(retryWaitMs(apiErr(503, { code: "upload_busy" }, 600), 1)).toBe(60_000);
    expect(retryWaitMs(apiErr(503, { code: "upload_busy" }, 0), 1)).toBe(1_000);
  });

  it("doubles from 1.5 s without one", () => {
    expect(retryWaitMs(apiErr(503, "x"), 1)).toBe(1_500);
    expect(retryWaitMs(apiErr(503, "x"), 2)).toBe(3_000);
    expect(retryWaitMs(apiErr(503, "x"), 3)).toBe(6_000);
  });
});

describe("the multipart fallback's limits", () => {
  const MB = 1024 * 1024;
  it("is the route's own limit locally, and never more than the relay passes in production", () => {
    expect(multipartLimit("subject", false)).toBe(10 * MB);
    expect(multipartLimit("guidelines", false)).toBe(20 * MB);
    expect(multipartLimit("subject", true)).toBeLessThan(4_500_000);
    expect(multipartLimit("font", true)).toBe(2 * MB);
  });

  it("refuses plainly, before a byte is sent, a file the fallback cannot carry", () => {
    const words = multipartRefusal("reference", { name: "shoot.jpg", type: "image/jpeg", size: 48 * MB }, true);
    expect(words).toMatch(/^This file is 48 MB\. Large uploads are not switched on for this server yet, so it takes files up to 4\.\d MB — use a smaller file\.$/);
    expect(multipartRefusal("reference", { name: "s.jpg", type: "image/jpeg", size: 2 * MB }, true)).toBeNull();
  });
});

describe("describeUploadError — every refusal in words", () => {
  it("shows a 415 with the backend's export hint AND the formats accepted here", () => {
    const e = coded(415, "unsupported_file_type", "HEIC/HEIF and AVIF images are not supported — export as JPEG/PNG.", {
      got: "heic", accepted: ["png", "jpeg", "webp", "tiff"], file: "IMG_0001.HEIC",
    });
    expect(describeUploadError(e, "reference")).toBe(
      "HEIC/HEIF and AVIF images are not supported — export as JPEG/PNG. Accepted here: PNG, JPEG, WebP or TIFF.",
    );
  });

  it("does not repeat formats the backend's sentence already lists", () => {
    const msg = "This file type is not accepted for a logo upload — use PNG, JPEG, WEBP, TIFF, SVG.";
    const e = coded(415, "unsupported_file_type", msg, { got: "unknown", accepted: ["png", "jpeg", "webp", "tiff", "svg"] });
    expect(describeUploadError(e, "logo")).toBe(msg);
  });

  it("always gives an oversized image's dimensions", () => {
    const said = "The image is 12000x9000 px; decoding it would need about 432 MB and the limit is 400 MB. Export it smaller (under ~100 megapixels) and upload again.";
    expect(describeUploadError(coded(422, "image_too_large", said, { width: 12000, height: 9000 }), "subject")).toBe(said);
    expect(describeUploadError(coded(422, "image_too_large", "image_too_large", { width: 12000, height: 9000 }), "subject"))
      .toBe("The image is 12000×9000 px. The image is too large to process — export it smaller and upload again.");
  });

  it("puts a bare code into words — a router's string refusal, or a multipart route's", () => {
    expect(describeUploadError(coded(409, "logo_limit_reached", "logo_limit_reached"), "logo"))
      .toBe("This brand already has 8 logos — remove one first.");
    expect(describeUploadError(apiErr(409, "reference_cap_reached"), "reference"))
      .toBe("This brand already holds as many references as it can.");
    expect(describeUploadError(apiErr(413, "file_too_large"), "logo")).toBe("The file is larger than a logo upload takes.");
  });

  it("keeps the backend's own sentence", () => {
    expect(describeUploadError(coded(413, "file_too_large", "The file is 61.2 MB; the limit here is 50 MB."), "background"))
      .toBe("The file is 61.2 MB; the limit here is 50 MB.");
  });

  it("speaks plainly about storage and the network", () => {
    expect(describeUploadError(new StoragePutError(403, "status"), "logo")).toMatch(/upload link did not match/);
    expect(describeUploadError(new StoragePutError(0, "network"), "logo")).toMatch(/could not be sent to storage/);
    expect(describeUploadError(new StoragePutError(0, "timeout"), "logo")).toMatch(/more than 10 minutes/);
    expect(describeUploadError(new TypeError("Failed to fetch"), "logo")).toMatch(/connection to the server dropped/);
    expect(describeUploadError(apiErr(500, "Request failed (500)"), "logo")).toMatch(/could not take the file/);
  });
});

describe("storageHeaders — what the PUT sets", () => {
  it("keeps Content-Type and every x-goog-* header exactly as signed, and leaves Host to the browser", () => {
    expect(storageHeaders({
      "Content-Type": "image/tiff",
      "x-goog-content-length-range": "1,52428800",
      "x-goog-if-generation-match": "0",
      Host: "storage.googleapis.com",
      "Content-Length": "123",
    })).toEqual({
      "Content-Type": "image/tiff",
      "x-goog-content-length-range": "1,52428800",
      "x-goog-if-generation-match": "0",
    });
  });
});

describe("what a stored file says", () => {
  it("reads finalize's `upload` with a default for every field", () => {
    const u = readUploadSummary({ status: "stored", flags: ["color_converted_without_profile", 7] });
    expect(u?.original).toEqual({ bytes: null, width: null, height: null, pages: null, download_url: null });
    expect(u?.working).toBeNull();
    expect(u?.flags).toEqual(["color_converted_without_profile"]);
    expect(readUploadSummary(null)).toBeNull();
  });

  it("turns flags and a partly used TIFF into calm notes", () => {
    const u = readUploadSummary({ flags: ["alpha_flattened_to_white", "some_new_flag"], pages_used: "1 of 3" });
    expect(uploadNotes(u)).toEqual([
      "Transparent areas were filled with white.", "Some new flag.", "Only page 1 of 3 is used.",
    ]);
  });

  it("opens an absolute https link as it is, sends an /api path through the authed fetch, and draws nothing else", () => {
    expect(linkKind("https://storage.googleapis.com/b/o?X-Goog-Signature=1")).toBe("direct");
    expect(linkKind("/api/gd/runs/r1/artifact/a.png")).toBe("authed");
    expect(linkKind("javascript:alert(1)")).toBeNull();
    expect(linkKind("http://insecure.example/o")).toBeNull();
    expect(linkKind(null)).toBeNull();
  });
});

describe("runDirectUpload — one file, end to end on fakes", () => {
  const FILE = { name: "shoot.jpg", type: "image/jpeg", size: 48 * 1024 * 1024 };
  const sig = (ticket: string): UploadSignature => ({
    surface: "reference", upload_url: `https://storage.example/${ticket}`, method: "PUT",
    headers: { "Content-Type": "image/jpeg", "x-goog-content-length-range": "1,52428800", "x-goog-if-generation-match": "0" },
    max_bytes: 52428800, expires_at: "", ticket, ticket_expires_at: "",
  });

  /** A scripted backend: each list is what successive calls answer (an Error
   *  rejects); the last entry repeats. */
  function backend(script: { sign?: unknown[]; put?: unknown[]; finalize?: unknown[]; multipart?: unknown[] }) {
    const log: string[] = [];
    const sleeps: number[] = [];
    let n = 0;
    const next = (list: unknown[] | undefined, i: number, dflt: unknown) => {
      const v = list && list.length ? list[Math.min(i, list.length - 1)] : dflt;
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
    };
    const counts = { sign: 0, put: 0, finalize: 0, multipart: 0 };
    const fx: UploadEffects<{ ref: string }> = {
      sign: () => {
        n += 1;
        log.push(`sign#${n}`);
        return next(script.sign, counts.sign++, sig(`t${n}`)) as Promise<UploadSignature>;
      },
      put: (s, onBytes) => {
        log.push(`put:${s.ticket}`);
        onBytes(FILE.size / 2, FILE.size);
        return next(script.put, counts.put++, 200) as Promise<number>;
      },
      finalize: (ticket) => {
        log.push(`finalize:${ticket}`);
        return next(script.finalize, counts.finalize++, { ref: `ref-${ticket}` }) as Promise<{ ref: string }>;
      },
      multipart: () => {
        log.push("multipart");
        return next(script.multipart, counts.multipart++, { ref: "multipart-ref" }) as Promise<{ ref: string }>;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    };
    return { fx, log, sleeps };
  }

  const run = (fx: UploadEffects<{ ref: string }>, relayed = true, onProgress?: (p: UploadProgress) => void) =>
    runDirectUpload({ surface: "reference", file: FILE, relayed, onProgress }, fx);

  it("signs, PUTs and finalizes once, reporting each step", async () => {
    const { fx, log } = backend({});
    const seen: string[] = [];
    const out = await run(fx, true, (p) => seen.push(`${p.phase}:${p.sent}`));
    expect(out).toEqual({ route: "direct", body: { ref: "ref-t1" } });
    expect(log).toEqual(["sign#1", "put:t1", "finalize:t1"]);
    expect(seen).toEqual(["preparing:0", "sending:0", `sending:${FILE.size / 2}`, `checking:${FILE.size}`]);
  });

  it("falls back to multipart when direct uploads are off, for a file the fallback can carry", async () => {
    const { fx, log } = backend({ sign: [coded(503, "direct_uploads_disabled")] });
    const small = { ...FILE, size: 1024 * 1024 };
    const out = await runDirectUpload({ surface: "reference", file: small, relayed: true }, fx);
    expect(out).toEqual({ route: "multipart", body: { ref: "multipart-ref" } });
    expect(log).toEqual(["sign#1", "multipart"]);
  });

  it("falls back when the route is absent on an older backend", async () => {
    const { fx, log } = backend({ sign: [apiErr(404, "Not Found")] });
    const out = await runDirectUpload({ surface: "subject", file: { ...FILE, size: 1024 }, relayed: false }, fx);
    expect(out.route).toBe("multipart");
    expect(log).toEqual(["sign#1", "multipart"]);
  });

  it("says plainly, and sends nothing, when the fallback cannot carry the file", async () => {
    const { fx, log } = backend({ sign: [coded(503, "direct_uploads_disabled")] });
    const err = await run(fx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).message).toMatch(/^This file is 48 MB\. Large uploads are not switched on/);
    expect(log).toEqual(["sign#1"]);
  });

  it("retries finalize with the SAME ticket on a 503, honouring Retry-After, and never re-sends the file", async () => {
    const busy = apiErr(503, { code: "upload_busy", message: "busy", retry_after: 30 }, 30);
    const { fx, log, sleeps } = backend({ finalize: [busy, busy, { ref: "stored" }] });
    const out = await run(fx);
    expect(out.body).toEqual({ ref: "stored" });
    expect(log).toEqual(["sign#1", "put:t1", "finalize:t1", "finalize:t1", "finalize:t1"]);
    expect(sleeps).toEqual([30_000, 30_000]);
  });

  it("starts over from sign — a new object and ticket — when the ticket expired before finalize", async () => {
    const { fx, log } = backend({ finalize: [coded(403, "upload_ticket_expired"), { ref: "stored" }] });
    const out = await run(fx);
    expect(out.body).toEqual({ ref: "stored" });
    expect(log).toEqual(["sign#1", "put:t1", "finalize:t1", "sign#2", "put:t2", "finalize:t2"]);
  });

  it("starts over from sign when storage refuses the PUT", async () => {
    const { fx, log } = backend({ put: [403, 200] });
    await run(fx);
    expect(log).toEqual(["sign#1", "put:t1", "sign#2", "put:t2", "finalize:t2"]);
  });

  it("stops after the round budget when every PUT fails, with words about storage", async () => {
    const { fx, log } = backend({ put: [new StoragePutError(0, "network")] });
    const err = await run(fx).catch((e: unknown) => e);
    expect((err as UploadError).step).toBe("put");
    expect((err as Error).message).toMatch(/could not be sent to storage/);
    expect(log.filter((l) => l.startsWith("sign"))).toHaveLength(MAX_ROUNDS);
  });

  it("stops at once when finalize refuses the file, with the reason, and does not send it again", async () => {
    const refusal = coded(415, "unsupported_file_type", "HEIC/HEIF and AVIF images are not supported — export as JPEG/PNG.", {
      accepted: ["png", "jpeg", "webp", "tiff"],
    });
    const { fx, log } = backend({ finalize: [refusal] });
    const err = await run(fx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).code).toBe("unsupported_file_type");
    expect((err as Error).message).toBe("HEIC/HEIF and AVIF images are not supported — export as JPEG/PNG. Accepted here: PNG, JPEG, WebP or TIFF.");
    expect(log).toEqual(["sign#1", "put:t1", "finalize:t1"]);
  });

  it("passes a caller's abort through untouched, so the screen can say nothing", async () => {
    const { fx } = backend({ sign: [aborted()] });
    const err = await run(fx).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UploadError);
    expect(isAbortError(err)).toBe(true);
  });
});
