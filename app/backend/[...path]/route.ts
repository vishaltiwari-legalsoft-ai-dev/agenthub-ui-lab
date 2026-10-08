/* Same-origin relay to the Cloud Run backend, authenticated as the project's
 * own service account.
 *
 * The org's Domain Restricted Sharing policy forbids `allUsers` on Cloud Run —
 * and silently re-strips it when granted — so the browser can never call the
 * backend directly in production. It CAN call this route (same origin as the
 * page), and this route invokes Cloud Run with a Google identity token minted
 * from GCP_SA_KEY. The token rides in X-Serverless-Authorization, which Cloud
 * Run verifies and strips, leaving the app's own Authorization header intact
 * for FastAPI's JWT auth. Responses are streamed back, so a large download is
 * not buffered against the platform's body-size ceiling; request bodies are
 * buffered (the platform already holds them, ≤ 4.5 MB) — see below.
 *
 * Local dev never comes through here: NEXT_PUBLIC_API_URL is unset there, so
 * lib/api.ts talks to localhost:8080 directly. Production sets it to
 * "/backend", which lands every /backend/api/* request on this file.
 */
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const UPSTREAM =
  process.env.BACKEND_ORIGIN ||
  "https://agentsbackend-255561670915.us-central1.run.app";

import { GoogleAuth } from "google-auth-library";
// Relative, not `@/`: the relay is exercised end to end in vitest, which does
// not resolve the alias.
import {
  downstreamHeaders,
  upstreamHeaders,
  upstreamUnreachable,
} from "../../../lib/relay";

// google-auth-library caches and refreshes the identity token per warm
// function instance; hand-rolled signing is exactly the kind of crypto that
// fails only in production, so the official client does it.
let auth: GoogleAuth | null = null;

async function identityToken(): Promise<string> {
  const raw = process.env.GCP_SA_KEY;
  if (!raw) throw new Error("GCP_SA_KEY is not configured on this deployment");
  auth ||= new GoogleAuth({ credentials: JSON.parse(raw) });
  const client = await auth.getIdTokenClient(UPSTREAM);
  return client.idTokenProvider.fetchIdToken(UPSTREAM);
}

async function relay(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await ctx.params;
  const search = new URL(req.url).search;
  const target = `${UPSTREAM}/${path.map(encodeURIComponent).join("/")}${search}`;

  let token: string;
  try {
    token = await identityToken();
  } catch (exc) {
    return Response.json(
      { detail: exc instanceof Error ? exc.message : "backend relay not configured" },
      { status: 503 },
    );
  }
  // Per-hop headers never cross. `Expect: 100-continue` (curl, on any body
  // over 1 MiB) was the one that broke uploads: undici refuses it — see
  // lib/relay.ts.
  const headers = upstreamHeaders(req.headers, token);

  // Buffered, never streamed on. The platform has already read the whole body
  // (Vercel caps it at 4.5 MB) before this runs, so streaming saved nothing —
  // and undici cannot hand back a 401 for a request whose body was a stream:
  // it throws "expected non-null body source" instead, which turned every
  // expired-session write into an empty 500. A buffered body keeps the 401.
  const raw = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
  const body = raw && raw.byteLength > 0 ? raw : undefined;
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
    });
  } catch (exc) {
    console.error("backend relay: upstream fetch failed", req.method, `/${path.join("/")}`, exc);
    return upstreamUnreachable(exc);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: downstreamHeaders(upstream.headers),
  });
}

export {
  relay as GET,
  relay as POST,
  relay as PUT,
  relay as PATCH,
  relay as DELETE,
  relay as HEAD,
};
