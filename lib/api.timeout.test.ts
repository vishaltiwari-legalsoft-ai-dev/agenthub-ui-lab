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
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiStatus,
  creativeGenerate,
  creativeGet,
  directUpload,
  gdArtifactBlob,
  gdBrand,
  getDbCollections,
  isAbortError,
  mrDeleteDataset,
  mrIngest,
  RequestTimeoutError,
  seoAnalyzeSite,
  seoBrandDetail,
  seoSetCompetitors,
  setAuthToken,
  setUnauthorizedHandler,
} from "./api";
import { UploadError } from "./directUpload";
import { DEFAULT_TIMEOUT_MS, isUnanswered, SLOW_TIMEOUT_MS } from "./requestPolicy";
import { downstreamHeaders, upstreamHeaders } from "./relay";

// The relay's one outside call — minting the Cloud Run identity token — is the
// only thing faked below; the route, Node's fetch and the server are real.
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getIdTokenClient() {
      return { idTokenProvider: { fetchIdToken: async () => "test-identity-token" } };
    }
  },
}));

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

/* ------------------------------------------------- the relay, end to end -- */

/** The other half of this transport: `app/backend/[...path]/route.ts`, the
 *  same-origin relay every production call goes through. Until 2026-10-09 any
 *  body over 1 MiB from curl got an EMPTY 500 and never reached Cloud Run —
 *  curl's `Expect: 100-continue` was copied onto the upstream fetch, which
 *  undici refuses. These run the real route module against a real local
 *  server with real multipart bodies at the sizes the probe failed on. */
describe("the relay passes large request bodies through intact", () => {
  type Seen = { url: string; headers: http.IncomingHttpHeaders; body: Buffer };
  const seen: Seen[] = [];
  let server: http.Server;
  let route: typeof import("../app/backend/[...path]/route");

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url?.startsWith("/api/drop")) {
        req.socket.destroy(); // Cloud Run gone mid-request
        return;
      }
      if (req.url?.startsWith("/api/expired")) {
        // FastAPI refusing an expired session, without reading the body.
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ detail: "Not authenticated" }));
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    // UPSTREAM is read when the module loads, so the env goes first.
    process.env.BACKEND_ORIGIN = `http://127.0.0.1:${port}`;
    process.env.GCP_SA_KEY = "{}";
    route = await import("../app/backend/[...path]/route");
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** A multipart body with a known boundary, the way a file upload sends it. */
  function multipart(bytes: number) {
    const boundary = `----relayProbe${bytes}`;
    const crlf = "\r\n";
    const head = Buffer.from(
      `--${boundary}${crlf}Content-Disposition: form-data; name="file"; filename="kit.pdf"${crlf}` +
        `Content-Type: application/pdf${crlf}${crlf}`,
    );
    const payload = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i += 1) payload[i] = (i * 31 + 7) & 0xff;
    const tail = Buffer.from(`${crlf}--${boundary}--${crlf}`);
    return { body: Buffer.concat([head, payload, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
  }

  const call = (path: string[], init: RequestInit) =>
    route.POST(
      new Request(`https://console.example/backend/${path.join("/")}`, init) as unknown as NextRequest,
      { params: Promise.resolve({ path }) },
    );

  for (const [label, bytes] of [["1.5 MB", 1_500_000], ["3 MB", 3_000_000], ["4.3 MB", 4_300_000]] as const) {
    it(`forwards a ${label} multipart upload sent with Expect: 100-continue, byte for byte`, async () => {
      const { body, contentType } = multipart(bytes);
      seen.length = 0;
      const res = await call(["api", "gd", "brands", "b1", "assets"], {
        method: "POST",
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(body.length),
          Authorization: "Bearer app-jwt",
          Expect: "100-continue", // what curl adds to any body over 1 MiB
          Connection: "keep-alive",
        },
        body,
      });

      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
      const got = seen[0];
      expect(got.url).toBe("/api/gd/brands/b1/assets");
      expect(got.body.length).toBe(body.length);
      expect(got.body.equals(body)).toBe(true);
      expect(got.headers["content-type"]).toBe(contentType); // boundary intact
      expect(got.headers.authorization).toBe("Bearer app-jwt");
      expect(got.headers["x-serverless-authorization"]).toBe("Bearer test-identity-token");
      expect(got.headers.expect).toBeUndefined();
    });
  }

  it("answers an upstream that drops the connection with a 502 that says so, not an empty 500", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call(["api", "drop"], { method: "POST", body: "{}" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toMatch(/^No answer from the backend/);
    // The cause stays in the function log, where an operator can read it.
    expect(logged).toHaveBeenCalledWith("backend relay: upstream fetch failed", "POST", "/api/drop", expect.anything());
    logged.mockRestore();
  });

  /* undici cannot hand back a 401 for a request whose body was a stream — it
     throws "expected non-null body source" — so a streamed relay turned every
     expired-session write into an empty 500 and the client never learned to
     sign in again. The body is buffered now; the 401 must come through. */
  it("returns the backend's 401 to a write, at any size, instead of failing it", async () => {
    for (const body of [JSON.stringify({ stage: 3 }), multipart(1_500_000).body]) {
      const res = await call(["api", "expired"], {
        method: "POST",
        headers: { Expect: "100-continue", Authorization: "Bearer expired-jwt" },
        body,
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ detail: "Not authenticated" });
    }
  });

  it("strips every per-hop header and keeps the request's own", () => {
    const out = upstreamHeaders(
      new Headers({
        Host: "console.example",
        Connection: "keep-alive, x-hop-only",
        "X-Hop-Only": "1",
        "Keep-Alive": "timeout=5",
        Expect: "100-continue",
        TE: "trailers",
        Upgrade: "h2c",
        "Content-Length": "123",
        "Accept-Encoding": "gzip",
        "Content-Type": "multipart/form-data; boundary=abc",
        Authorization: "Bearer app-jwt",
        "X-Forwarded-For": "203.0.113.9",
      }),
      "id-token",
    );
    for (const h of ["host", "connection", "x-hop-only", "keep-alive", "expect", "te", "upgrade", "content-length", "accept-encoding"]) {
      expect(out.has(h)).toBe(false);
    }
    expect(out.get("content-type")).toBe("multipart/form-data; boundary=abc");
    expect(out.get("authorization")).toBe("Bearer app-jwt");
    expect(out.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(out.get("x-serverless-authorization")).toBe("Bearer id-token");

    const back = downstreamHeaders(new Headers({ "Content-Encoding": "gzip", "Content-Length": "9", "Content-Type": "application/pdf" }));
    expect(back.has("content-encoding")).toBe(false);
    expect(back.has("content-length")).toBe(false);
    expect(back.get("content-type")).toBe("application/pdf");
  });
});

/* ------------------------------------------- direct uploads to storage -- */
/* The real `directUpload` against a stubbed backend: `fetch` answers the API
   by method and path, and a fake XHR stands in for the browser's PUT to
   Cloud Storage, so what actually goes on the wire is what is checked. */

type Route = (url: string, init: RequestInit) => Response;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Route => () =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

/** The API (and, without XHR, storage) as `fetch` sees them. A route given a
 *  list answers with each in turn; an unknown route is FastAPI's 404. */
function stubBackend(routes: Record<string, Route | Route[]>) {
  const calls: { key: string; url: string; init: RequestInit }[] = [];
  const seen: Record<string, number> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const key = `${(init.method ?? "GET").toUpperCase()} ${url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]}`;
      calls.push({ key, url, init });
      const route = routes[key];
      if (!route) return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 });
      const list = Array.isArray(route) ? route : [route];
      const i = (seen[key] = (seen[key] ?? -1) + 1);
      return list[Math.min(i, list.length - 1)](url, init);
    }),
  );
  return { calls, count: (key: string) => calls.filter((c) => c.key === key).length };
}

/** The browser's XHR, recording what the PUT carried. */
class FakeXhr {
  static made: FakeXhr[] = [];
  static answers: number[] = [];
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown = null;
  withCredentials = true; // the code under test must turn it off
  timeout = 0;
  status = 0;
  upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.made.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
    queueMicrotask(() => {
      this.upload.onprogress?.({ loaded: 4, total: 10, lengthComputable: true });
      this.status = FakeXhr.answers.shift() ?? 200;
      this.onload?.();
    });
  }
  abort() {
    this.onabort?.();
  }
}

const signed = (ticket: string, contentType = "image/jpeg") => ({
  surface: "reference",
  upload_url: `https://storage.example/uploads/pending/${ticket}?X-Goog-Signature=abc`,
  method: "PUT",
  // As the staging backend really answers (2026-10-09): the storage library
  // adds `Host` to the headers it signs. The browser sends its own.
  headers: {
    "Content-Type": contentType, "x-goog-content-length-range": "1,52428800", "x-goog-if-generation-match": "0",
    Host: "storage.googleapis.com",
  },
  max_bytes: 52428800,
  expires_at: "2026-10-09T10:10:00+00:00",
  ticket,
  ticket_expires_at: "2026-10-09T11:00:00+00:00",
});

const stored = (surface: string) => ({
  surface, file: "x", status: "stored", already_finalized: false, kind: "jpeg", content_id: "md5",
  original: { bytes: 10, width: 8000, height: 6000, pages: null, download_url: "https://storage.example/dl?sig=1" },
  working: { width: 4096, height: 3072, format: "jpeg" }, pages_used: null, flags: ["color_converted_without_profile"],
});

const jpeg = (bytes = 10, name = "shoot.jpg") => new File([new Uint8Array(bytes)], name, { type: "image/jpeg" });

describe("direct uploads to storage", () => {
  afterEach(() => {
    FakeXhr.made = [];
    FakeXhr.answers = [];
    setAuthToken(null);
  });

  it("PUTs the file straight to storage with exactly the signed headers — no app token, no cookies — and finalizes with the ticket", async () => {
    setAuthToken("app-jwt");
    const sig = signed("tkt-1");
    const api = stubBackend({
      "POST /api/gd/brands/b1/uploads": json(sig),
      "POST /api/gd/brands/b1/uploads/finalize": json({
        references: [{ ref_id: "r1", url: "https://view.example/r1", kind: "creative", note: "the palette", created_at: "x" }],
        reference_count: 4,
        upload: stored("reference"),
      }),
    });
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const file = jpeg();
    const sent: number[] = [];

    const out = await directUpload("reference", "b1", file, {
      meta: { kind: "creative", creative_type: "newsletter", note: "the palette" },
      onProgress: (p) => { if (p.phase === "sending") sent.push(p.sent); },
    });

    const [xhr] = FakeXhr.made;
    expect(FakeXhr.made).toHaveLength(1);
    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toBe(sig.upload_url);
    // Every signed header exactly — nothing added (no Authorization), no
    // x-goog-* altered — less only the Host a page may not set.
    expect(xhr.headers).toEqual({
      "Content-Type": "image/jpeg", "x-goog-content-length-range": "1,52428800", "x-goog-if-generation-match": "0",
    });
    expect(xhr.withCredentials).toBe(false);
    expect(xhr.body).toBe(file); // the raw File, not FormData
    expect(xhr.timeout).toBe(600_000);
    expect(sent).toContain(4);

    // Only the API went over fetch, and it carried the session.
    expect(api.calls.map((c) => c.key)).toEqual(["POST /api/gd/brands/b1/uploads", "POST /api/gd/brands/b1/uploads/finalize"]);
    for (const c of api.calls) expect(new Headers(c.init.headers).get("Authorization")).toBe("Bearer app-jwt");
    expect(JSON.parse(String(api.calls[0].init.body))).toEqual({
      surface: "reference", content_type: "image/jpeg", size: 10, file_name: "shoot.jpg",
    });
    expect(JSON.parse(String(api.calls[1].init.body))).toEqual({
      ticket: "tkt-1", file_name: "shoot.jpg", kind: "creative", creative_type: "newsletter", note: "the palette",
    });

    expect(out.route).toBe("direct");
    expect(out.reference_count).toBe(4);
    expect(out.references[0]).toMatchObject({ ref_id: "r1", original: null }); // read with a default
    expect(out.upload?.original.download_url).toBe("https://storage.example/dl?sig=1");
    expect(out.upload?.flags).toEqual(["color_converted_without_profile"]);
  });

  it("finalizes a font with its real file name — the face name is derived from it", async () => {
    stubBackend({
      "POST /api/gd/brands/b1/uploads": json(signed("tkt-f", "font/ttf")),
      "POST /api/gd/brands/b1/uploads/finalize": (_u, init) => {
        expect(JSON.parse(String(init.body))).toEqual({ ticket: "tkt-f", file_name: "Archivo-Bold.ttf" });
        return json({ brand: { brand_id: "b1", name: "Berry", assets: { fonts: [{ path: "brands/b1/originals/x.ttf", url: "https://dl" }] } }, upload: stored("font") })(_u, init);
      },
    });
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const out = await directUpload("font", "b1", new File([new Uint8Array(4)], "Archivo-Bold.ttf", { type: "" }));
    expect(out.brand.assets.fonts[0]).toEqual({ path: "brands/b1/originals/x.ttf", url: "https://dl", name: "x.ttf", original: null });
    expect(FakeXhr.made[0].headers["Content-Type"]).toBe("font/ttf");
  });

  it("falls back to the multipart route while the backend has direct uploads off", async () => {
    const api = stubBackend({
      "POST /api/gd/runs/r1/uploads": json({ detail: { code: "direct_uploads_disabled", message: "Direct uploads are switched off on this deployment — use the regular upload." } }, 503),
      "POST /api/gd/runs/r1/subject/upload": json({ ref: "s-abc.png", role: "subject" }),
    });
    vi.stubGlobal("XMLHttpRequest", FakeXhr);

    const out = await directUpload("subject", "r1", jpeg(2048));

    expect(out).toEqual({ ref: "s-abc.png", role: "subject", upload: null, route: "multipart" });
    expect(FakeXhr.made).toHaveLength(0);
    const mp = api.calls.find((c) => c.key === "POST /api/gd/runs/r1/subject/upload");
    expect(mp?.url).toContain("role=subject");
    expect(mp?.init.body).toBeInstanceOf(FormData);
  });

  it("falls back when an older backend has no sign route at all", async () => {
    const api = stubBackend({
      "POST /api/gd/brands/b1/assets": json({ brand: { brand_id: "b1", name: "Berry", logo_url: "https://view/logo.png" } }),
    });
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const out = await directUpload("logo", "b1", new File([new Uint8Array(8)], "mark.png", { type: "image/png" }));
    expect(out.route).toBe("multipart");
    expect(out.brand.logo_url).toBe("https://view/logo.png");
    expect(api.count("POST /api/gd/brands/b1/uploads")).toBe(1);
  });

  it("says plainly, and sends nothing more, when direct uploads are off and the file is over the old route's limit", async () => {
    const api = stubBackend({
      "POST /api/gd/runs/r1/uploads": json({ detail: { code: "direct_uploads_disabled", message: "off" } }, 503),
    });
    const err = await directUpload("background", "r1", jpeg(11 * 1024 * 1024)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect((err as Error).message).toBe(
      "This file is 11 MB. Large uploads are not switched on for this server yet, so it takes files up to 10 MB — use a smaller file.",
    );
    expect(api.calls.map((c) => c.key)).toEqual(["POST /api/gd/runs/r1/uploads"]);
  });

  it("retries finalize with the SAME ticket after a 503, waiting what Retry-After says, without sending the file again", async () => {
    vi.useFakeTimers();
    const api = stubBackend({
      "POST /api/gd/runs/r1/uploads": json(signed("tkt-1")),
      "POST /api/gd/runs/r1/uploads/finalize": [
        json({ detail: { code: "upload_busy", message: "Another large file is being processed — try again shortly.", retry_after: 30 } }, 503, { "Retry-After": "2" }),
        json({ ref: "md5-w4096.jpg", role: "background", upload: stored("background") }),
      ],
    });
    vi.stubGlobal("XMLHttpRequest", FakeXhr);

    const pending = directUpload("background", "r1", jpeg());
    await vi.advanceTimersByTimeAsync(1_999);
    expect(api.count("POST /api/gd/runs/r1/uploads/finalize")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const out = await pending;

    expect(out).toMatchObject({ ref: "md5-w4096.jpg", role: "background", route: "direct" });
    const finals = api.calls.filter((c) => c.key === "POST /api/gd/runs/r1/uploads/finalize");
    expect(finals.map((c) => JSON.parse(String(c.init.body)).ticket)).toEqual(["tkt-1", "tkt-1"]);
    expect(api.count("POST /api/gd/runs/r1/uploads")).toBe(1);
    expect(FakeXhr.made).toHaveLength(1);
  });

  it("starts over from sign when storage refuses the PUT, and finalizes the new ticket", async () => {
    FakeXhr.answers = [403, 200];
    const api = stubBackend({
      "POST /api/gd/runs/r1/uploads": [json(signed("tkt-1")), json(signed("tkt-2"))],
      "POST /api/gd/runs/r1/uploads/finalize": json({ ref: "md5-w4096.png", role: "prompt", upload: stored("prompt") }),
    });
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    await directUpload("prompt", "r1", jpeg());
    expect(FakeXhr.made.map((x) => x.url)).toEqual([signed("tkt-1").upload_url, signed("tkt-2").upload_url]);
    const finals = api.calls.filter((c) => c.key === "POST /api/gd/runs/r1/uploads/finalize");
    expect(finals.map((c) => JSON.parse(String(c.init.body)).ticket)).toEqual(["tkt-2"]);
  });

  it("without XHR, still PUTs with credentials omitted and no app token", async () => {
    setAuthToken("app-jwt");
    const api = stubBackend({
      "POST /api/gd/runs/r1/uploads": json(signed("tkt-1")),
      "PUT /uploads/pending/tkt-1": () => new Response(null, { status: 200 }),
      "POST /api/gd/runs/r1/uploads/finalize": json({ ref: "md5-w4096.png", role: "element", upload: stored("element") }),
    });
    const file = jpeg();
    const out = await directUpload("element", "r1", file);
    const put = api.calls.find((c) => c.key === "PUT /uploads/pending/tkt-1");
    expect(put?.init.credentials).toBe("omit");
    expect(put?.init.body).toBe(file);
    expect(new Headers(put?.init.headers).has("Authorization")).toBe(false);
    expect(Object.fromEntries(new Headers(put?.init.headers))).toEqual({
      "content-type": "image/jpeg", "x-goog-content-length-range": "1,52428800", "x-goog-if-generation-match": "0",
    });
    expect(out.ref).toBe("md5-w4096.png");
  });

  it("keeps a reply's structured detail — code, facts and Retry-After — on the ApiError, with its message as the text", async () => {
    stubBackend({
      "GET /api/gd/brands/b1": json(
        { detail: { code: "upload_busy", message: "Another large file is being processed — try again shortly.", retry_after: 30 } },
        503,
        { "Retry-After": "7" },
      ),
    });
    const err = await gdBrand("b1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.status).toBe(503);
    expect(e.code).toBe("upload_busy");
    expect(e.retryAfterS).toBe(7);
    expect(e.message).toBe("Another large file is being processed — try again shortly.");
    expect((e.detail as { retry_after: number }).retry_after).toBe(30);
  });
});
