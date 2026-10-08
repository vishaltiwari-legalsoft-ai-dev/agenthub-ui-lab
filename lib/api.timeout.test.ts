/** The deadline and cancellation behaviour of the API client's one choke point.
 *
 *  `requestPolicy.test.ts` proves the rules; this proves they are actually
 *  wired into `request()` — that a backend which never answers now ends in a
 *  rejection (so `finally { setBusy(false) }` runs) instead of a promise that
 *  stays pending for the life of the tab.
 *
 *  `fetch` is stubbed with a promise that only settles when its signal aborts,
 *  which is exactly how the browser behaves against a wedged server.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiStatus,
  creativeGenerate,
  creativeGet,
  gdArtifactBlob,
  getDbCollections,
  isAbortError,
  mrDeleteDataset,
  mrIngest,
  RequestTimeoutError,
  seoAnalyzeSite,
  seoBrandDetail,
  seoSetCompetitors,
  setUnauthorizedHandler,
} from "./api";
import { DEFAULT_TIMEOUT_MS, isUnanswered, SLOW_TIMEOUT_MS } from "./requestPolicy";

/** A server that accepts the connection and then never answers. */
function stubHangingFetch() {
  const fetchMock = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // no signal: hangs for ever, which is the old bug
        if (signal.aborted) reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Headers land immediately, then the body stream stops. The deadline has to
 *  stay armed past the headers or the read hangs exactly like the old client
 *  did — which is what every call site that hand-rolled its own `.json()` used
 *  to do, because it went through `request()` and got the timer cleared. */
function stubStalledBody(reader: "json" | "blob" = "json") {
  const fetchMock = vi.fn(
    async (_url: string, init?: RequestInit) =>
      ({
        ok: true,
        status: 200,
        [reader]: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      }) as unknown as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Headers land immediately and the body is handed over only when `deliver()`
 *  is called — a large download that is slow to *transfer*, not a server that
 *  is slow to *answer*. */
function stubHeldBlobBody() {
  let release!: (blob: Blob) => void;
  const body = new Promise<Blob>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, blob: () => body }) as unknown as Response),
  );
  return { deliver: release };
}

/** A server that answers at once with a FastAPI-style error. */
function stubErrorReply(status: number, detail: string) {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ detail }), { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setUnauthorizedHandler(() => {});
});

describe("request deadlines", () => {
  it("ends a hung request as a timeout instead of pending for ever", async () => {
    vi.useFakeTimers();
    stubHangingFetch();

    const pending = getDbCollections();
    const settled = expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    await settled;
  });

  it("says how long it waited, so the toast is honest", async () => {
    vi.useFakeTimers();
    stubHangingFetch();

    const pending = seoBrandDetail("brand-1");
    const settled = expect(pending).rejects.toThrow(/90 seconds/);

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    await settled;
  });

  it("does not cut off a crawl that legitimately runs for minutes", async () => {
    vi.useFakeTimers();
    stubHangingFetch();

    const pending = seoAnalyzeSite("brand-1"); // POST /api/seo-geo/site-review/:id
    let rejected = false;
    void pending.catch(() => {
      rejected = true;
    });

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS * 2);
    expect(rejected).toBe(false);

    const settled = expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(SLOW_TIMEOUT_MS);
    await settled;
  });

  it("passes fetch the signal it never used to get", async () => {
    vi.useFakeTimers();
    const fetchMock = stubHangingFetch();

    const pending = getDbCollections();
    const settled = expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    await settled;
  });
});

describe("caller cancellation", () => {
  it("rejects a superseded request as an abort, not as a failure to show", async () => {
    stubHangingFetch();
    const controller = new AbortController();

    const pending = seoBrandDetail("brand-1", { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toSatisfy(isAbortError);
    await expect(pending).rejects.not.toBeInstanceOf(RequestTimeoutError);
  });
});

describe("responses that stall halfway", () => {
  it("times out a reply whose body never finishes arriving", async () => {
    vi.useFakeTimers();
    stubStalledBody("json");

    const pending = getDbCollections();
    const settled = expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    await settled;
  });
});

describe("responses that do arrive", () => {
  it("still parses a normal reply and leaves no timer armed to abort it", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ collections: [], connected: true }), { status: 200 })),
    );

    await expect(getDbCollections()).resolves.toMatchObject({ connected: true });
    // Nothing left to fire: a stray timer would abort a request that is done.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still reports an expired session rather than a timeout", async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));

    await expect(getDbCollections()).rejects.toThrow(/sign in again/);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

/* The Vercel relay is cut at its 300 s maxDuration while Cloud Run carries on;
 * the browser then gets the platform's own 504 page, not a FastAPI detail.
 * These pin that the real client hands the creative watch a rejection it can
 * recognise as "go and look", and the backend's own refusals as answers. */
describe("a long creative call that comes back unanswered", () => {
  it("rejects the relay's non-JSON 504 as unanswered, with the status kept", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("An error occurred with your deployment. FUNCTION_INVOCATION_TIMEOUT", { status: 504 })),
    );
    const err = await creativeGenerate("run_1").catch((e: unknown) => e);
    expect(apiStatus(err)).toBe(504);
    expect(isUnanswered(err)).toBe(true);
  });

  it("rejects a dropped connection as unanswered", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const err = await creativeGenerate("run_1").catch((e: unknown) => e);
    expect(isUnanswered(err)).toBe(true);
  });

  it("keeps the backend's 503 an answer, in its own words", async () => {
    stubErrorReply(503, "The creative was generated but its files could not be saved — file storage is unavailable. Please try again.");
    const err = await creativeGenerate("run_1").catch((e: unknown) => e);
    expect(isUnanswered(err)).toBe(false);
    expect((err as Error).message).toContain("file storage is unavailable");
  });

  it("passes each artifact's provenance through untouched", async () => {
    const artifacts = [
      { name: "slide-1.png", mime: "image/png", ref: "r1", bytes: 10, url: "/u1", ai: true, fallback_reason: null },
      { name: "slide-3.png", mime: "image/png", ref: "r3", bytes: 10, url: "/u3", ai: false, fallback_reason: "The image model returned no picture for slide 3." },
      { name: "deck.pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ref: "d", bytes: 10, url: "/d" },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "run_1", state: "DONE", artifacts }), { status: 200 })));
    const run = await creativeGet("run_1");
    expect(run.artifacts[1]).toMatchObject({ ai: false, fallback_reason: "The image model returned no picture for slide 3." });
    expect(run.artifacts[2].ai).toBeUndefined();
  });
});

/* Until these verbs existed, 22 call sites reached past `requestJson` to
 * `request()` and re-implemented its body by hand — and 11 of them parsed JSON
 * with the deadline already disarmed. These prove the whole surface, not just
 * the GET and POST paths that happened to be covered. */

describe("PUT", () => {
  it("times out a reply whose body stalls after the headers", async () => {
    vi.useFakeTimers();
    stubStalledBody("json");

    // The hand-rolled version of this call cleared the deadline before reading
    // the body, so this promise never settled and the panel stayed "Saving…".
    const pending = seoSetCompetitors("legalsoft", []);
    const settled = expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    await settled;
  });

  it("still sends PUT with a JSON body and returns the parsed reply", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ tracked: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(seoSetCompetitors("legalsoft", [])).resolves.toEqual({ tracked: [] });

    const init = fetchMock.mock.calls[0][1];
    expect(init?.method).toBe("PUT");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
  });
});

describe("DELETE", () => {
  it("surfaces a non-ok response as the server's own message", async () => {
    stubErrorReply(404, "dataset not found");

    await expect(mrDeleteDataset("ds-1")).rejects.toThrow("dataset not found");
  });

  it("sends DELETE and resolves on success", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ deleted: "ds-1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(mrDeleteDataset("ds-1")).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
  });
});

describe("multipart upload", () => {
  const csv = () => new File(["date,spend\n"], "export.csv", { type: "text/csv" });

  it("surfaces a non-ok response as the server's own message", async () => {
    stubErrorReply(400, "Could not read that export");

    await expect(mrIngest(csv(), "google_ads")).rejects.toThrow("Could not read that export");
  });

  it("leaves the browser to set the multipart boundary itself", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ dataset_id: "d1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await mrIngest(csv(), "google_ads");

    const init = fetchMock.mock.calls[0][1];
    expect(init?.body).toBeInstanceOf(FormData);
    // A hand-set application/json here would corrupt every upload: the boundary
    // only the browser knows would never reach the server.
    expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
  });
});

describe("streamed bodies", () => {
  it("returns an object URL and is not cut off by the body-read deadline", async () => {
    vi.useFakeTimers();
    const held = stubHeldBlobBody();

    const pending = gdArtifactBlob("/api/gd/artifact/ad-1.png");
    let failure: unknown = null;
    void pending.catch((e) => {
      failure = e;
    });

    // Once the headers land the timer is released, so nothing is armed to abort
    // the transfer.
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);

    // A 4K render or a report PDF may take longer to come down the wire than
    // any request deadline. The timer guards a slow *server*, never a slow
    // *transfer* — routing this through requestJson would break downloads.
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS * 2);
    expect(failure).toBeNull();

    held.deliver(new Blob(["PNG"]));
    await expect(pending).resolves.toMatch(/^blob:/);
  });

  it("still surfaces a failed download as the server's own message", async () => {
    stubErrorReply(404, "Artifact expired");

    await expect(gdArtifactBlob("/api/gd/artifact/gone.png")).rejects.toThrow("Artifact expired");
  });
});

/* ------------------------------------------------------------ live by default -- */

/** The console must never boot into the UI-lab fixtures by omission. Two
 *  pins: the build config sets no preview default, and with the flag unset the
 *  transport asks the network for a path the fixture table knows. */
describe("preview mode is off unless a build asks for it", () => {
  const saved = process.env.NEXT_PUBLIC_PREVIEW_NO_AUTH;
  afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_PREVIEW_NO_AUTH;
    else process.env.NEXT_PUBLIC_PREVIEW_NO_AUTH = saved;
    vi.unstubAllGlobals();
  });

  it("next.config.mjs does not default NEXT_PUBLIC_PREVIEW_NO_AUTH on", async () => {
    delete process.env.NEXT_PUBLIC_PREVIEW_NO_AUTH;
    const cfg = (await import("../next.config.mjs")).default as { env?: Record<string, string> };
    expect(cfg.env?.NEXT_PUBLIC_PREVIEW_NO_AUTH).toBeUndefined();
  });

  it("a fixture-known GET still goes to the network when the flag is unset", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ runs: [], total: 0, live: { running: 0, queued: 0 } }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const { listRuns } = await import("./api");
    await listRuns({ limit: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/runs");
  });
});
