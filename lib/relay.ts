/** What the same-origin relay (`app/backend/[...path]/route.ts`) passes on to
 *  Cloud Run, and what it must not.
 *
 *  Kept out of the route file because Next refuses any export from a route
 *  module other than its handlers and config, and because these are decisions
 *  that can be proved without a server (see `api.timeout.test.ts`). Imported
 *  relatively by the route so vitest, which does not resolve `@/`, can load it.
 *
 *  The defect this exists for (2026-10-09): every request body over 1 MiB sent
 *  by curl — and by any client that does the same — failed with an EMPTY 500
 *  and never reached Cloud Run. curl adds `Expect: 100-continue` to any body
 *  larger than 1 MiB; the relay copied every inbound header onto its upstream
 *  `fetch`; Node's fetch (undici) refuses that header outright ("expect header
 *  not supported"); and the throw was uncaught, so Next answered 500 with no
 *  body. 1,048,000 bytes passed and 1,049,000 failed because the line is
 *  curl's 1,048,576, not any size limit. Browsers never send `Expect`.
 *
 *  Found beside it, and hitting browsers: the route streamed the body on, and
 *  undici cannot return a 401 for a streamed body ("expected non-null body
 *  source"), so every write answered 401 — an expired session — became the
 *  same empty 500, and the client's sign-in-again path never ran on a POST.
 *  The route now buffers the body (see there).
 */

/** Request headers that describe this one hop rather than the request, so a
 *  proxy never passes them on (RFC 9110 §7.6.1). undici rejects several of
 *  them outright — `expect`, `transfer-encoding`, `upgrade`, `keep-alive` —
 *  so forwarding one is a thrown request, not a harmless extra header. The
 *  platform already answered `Expect` and de-chunked the body on its side.
 *  `content-length` is recomputed for the re-streamed body; `accept-encoding`
 *  is dropped so the reply comes back unencoded and re-streams as it is. */
export const DROPPED_REQUEST_HEADERS: readonly string[] = [
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  "content-length",
  "accept-encoding",
];

/** Response headers the platform recomputes for the re-streamed body. */
export const DROPPED_RESPONSE_HEADERS: readonly string[] = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
];

/** The headers the relay sends upstream: the browser's own — `Authorization`
 *  (the app JWT) and `Content-Type` (with its multipart boundary) untouched —
 *  minus every per-hop one, plus the Cloud Run identity token. */
export function upstreamHeaders(incoming: Headers, identityToken: string): Headers {
  const out = new Headers(incoming);
  // `Connection` may name further per-hop headers of its own.
  for (const named of (incoming.get("connection") ?? "").split(",")) {
    const name = named.trim().toLowerCase();
    if (!name) continue;
    try {
      out.delete(name);
    } catch {
      /* not a valid header name, so nothing by that name was copied */
    }
  }
  for (const h of DROPPED_REQUEST_HEADERS) out.delete(h);
  out.set("X-Serverless-Authorization", `Bearer ${identityToken}`);
  return out;
}

export function downstreamHeaders(upstream: Headers): Headers {
  const out = new Headers(upstream);
  for (const h of DROPPED_RESPONSE_HEADERS) out.delete(h);
  return out;
}

/** The answer when the upstream call itself throws — Cloud Run unreachable,
 *  the connection reset. A 502 with a `detail` the client shows (`parseError`
 *  in `lib/api.ts` reads it), instead of the empty 500 an uncaught throw gives,
 *  which read as "Request failed (500)" and blamed a backend that may never
 *  have seen the request. It does not claim nothing ran: a connection can drop
 *  after the backend started. The cause's code is named; its message, which
 *  can carry the upstream address, stays in the function log. */
export function upstreamUnreachable(e: unknown): Response {
  const cause = (e as { cause?: { code?: unknown } } | null)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : null;
  return Response.json(
    {
      detail:
        "No answer from the backend — the relay's connection to it failed" +
        (code ? ` (${code})` : "") +
        ". Please try again.",
    },
    { status: 502 },
  );
}
