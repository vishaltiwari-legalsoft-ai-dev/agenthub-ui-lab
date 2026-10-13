import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SeoTopic } from "@/lib/api";
import { ApiError, apiCode, seoOauthComplete, seoOauthStart } from "../../../lib/api";
import { describeFailure } from "../../../lib/load";
import {
  canConnectGsc, connectedLine, finishGoogleReturn, GA_SERVICE_ACCOUNT, GSC_CANCELLED, GSC_CONNECT_HINT,
  GSC_CONNECT_UNAVAILABLE, gscFailure, gscIntegration, gscNotice, gscReturnPath, gscSlot, gscStateBrand,
  googleReturn, looksRaw, NO_GSC_RETURN, plainNote, plainNotes, PLAIN_TOPIC_NOTES, readGsc, readGscReturn,
  topicOrigin, type GoogleReturnIO, type NoteContext,
} from "./seo";

/* Every Search Console, degraded-note and topic-provenance sentence the SEO
 * screens put up follows from these functions, so this pins what each payload
 * means — including the shapes an older backend still sends, because Vercel
 * and Cloud Run deploy at different times. */

/** A state the way the backend mints it: `gsc.<base64url JSON>.<sig>`. */
const gscState = (body: unknown) =>
  `gsc.${Buffer.from(JSON.stringify(body)).toString("base64url")}.c2lnbmF0dXJl`;
const STATE = gscState({ b: "berry-virtual", u: "6f1a2b", t: 1760400000, n: "x1" });

/** An a12 Inbox Triage state: a hex user id first, never `gsc.`. */
const INBOX_STATE = "6f1a2b9c0d.1760400000.abcdef";

/* ------------------------------------------------- the Connect button -- */

describe("gscSlot — the Connect button", () => {
  const off = { connected: false };

  it("is hidden when the server says connect cannot work", () => {
    expect(gscSlot(off, { gsc: false, serp: true, gsc_connect: false })).toEqual({
      mode: "unavailable", line: GSC_CONNECT_UNAVAILABLE,
    });
  });

  it("is hidden on an older backend that sends no gsc_connect at all", () => {
    expect(gscSlot(off, { gsc: true, serp: true })).toEqual({ mode: "unavailable", line: GSC_CONNECT_UNAVAILABLE });
    expect(canConnectGsc({ gsc: true, serp: true })).toBe(false);
    expect(canConnectGsc(undefined)).toBe(false);
  });

  it("is live, with the sign-in hint, only when gsc_connect is true", () => {
    expect(gscSlot(off, { gsc: false, serp: true, gsc_connect: true })).toEqual({ mode: "connect", line: GSC_CONNECT_HINT });
    expect(GSC_CONNECT_HINT).toBe("Sign in with the Google account that has Search Console access to this site.");
  });

  it("draws nothing until the overview answers, rather than flashing 'not set up'", () => {
    expect(gscSlot(off, null)).toEqual({ mode: "unknown", line: null });
  });

  it("shows who connected it, whatever the server can do now", () => {
    const g = { connected: true, connected_by: "ana@berry.com", connected_at: "2026-10-14T12:00:00Z" };
    expect(gscSlot(g, { gsc: true, serp: true, gsc_connect: false })).toEqual({
      mode: "connected", line: "Connected by ana@berry.com · Oct 14, 2026",
    });
  });
});

describe("readGsc / connectedLine", () => {
  it("defaults every field a pre-relay backend does not send", () => {
    expect(readGsc(undefined, true)).toEqual({
      connected: true, property: null, connected_by: null, connected_at: null,
      service_account_property: null, reading: false,
    });
    expect(readGsc(null).connected).toBe(false);
    expect(readGsc({ connected: false, property: null }).connected_by).toBeNull();
  });

  it("prefers the block over the legacy flag", () => {
    expect(readGsc({ connected: false, property: null }, true).connected).toBe(false);
  });

  it("says as much as is known and nothing invented", () => {
    expect(connectedLine({ connected: true, connected_by: "ana@berry.com", connected_at: null })).toBe("Connected by ana@berry.com");
    expect(connectedLine({ connected: true, connected_by: null, connected_at: "2026-10-14T12:00:00Z" })).toBe("Connected · Oct 14, 2026");
    expect(connectedLine({ connected: true, connected_by: " ", connected_at: "not a date" })).toBeNull();
    expect(connectedLine({ connected: false, connected_by: "ana@berry.com", connected_at: "2026-10-14T12:00:00Z" })).toBeNull();
  });
});

/* -------------------------------------------------- the Google return -- */

describe("gscStateBrand", () => {
  it("reads field b of the state body", () => {
    expect(gscStateBrand(STATE)).toBe("berry-virtual");
  });

  it("is null for anything that is not a sane gsc state", () => {
    expect(gscStateBrand(INBOX_STATE)).toBeNull();
    expect(gscStateBrand("gsc.")).toBeNull();
    expect(gscStateBrand("gsc.!!!not-base64!!!.sig")).toBeNull();
    expect(gscStateBrand(gscState({ u: "x" }))).toBeNull();
    expect(gscStateBrand(gscState({ b: 42 }))).toBeNull();
    expect(gscStateBrand(gscState({ b: "" }))).toBeNull();
    expect(gscStateBrand(gscState({ b: "a\nb" }))).toBeNull();
    expect(gscStateBrand(null)).toBeNull();
  });
});

describe("googleReturn — which specialist a redirect belongs to", () => {
  it("routes a gsc. state with a code to the Search Console exchange", () => {
    const q = new URLSearchParams({ code: "4/0Abc", state: STATE, scope: "x" });
    expect(googleReturn(`?${q}`)).toEqual({ kind: "gsc", code: "4/0Abc", state: STATE, brand: "berry-virtual" });
  });

  it("turns a Google refusal into a plain sentence, never Google's code", () => {
    const q = new URLSearchParams({ error: "access_denied", state: STATE });
    expect(googleReturn(`?${q}`)).toEqual({ kind: "gsc-refused", brand: "berry-virtual", message: GSC_CANCELLED });
    const other = googleReturn(`?${new URLSearchParams({ error: "admin_policy_enforced", state: STATE })}`);
    expect(other.kind).toBe("gsc-refused");
    expect(other.kind === "gsc-refused" && other.message).not.toContain("admin_policy_enforced");
  });

  it("refuses a gsc return with no code", () => {
    expect(googleReturn(`?state=${encodeURIComponent(STATE)}`).kind).toBe("gsc-refused");
  });

  it("leaves everything else to the inbox path — success, error and bare", () => {
    expect(googleReturn(`?code=4/0Abc&state=${INBOX_STATE}`)).toEqual({ kind: "inbox" });
    expect(googleReturn(`?error=access_denied&state=${INBOX_STATE}`)).toEqual({ kind: "inbox" });
    expect(googleReturn("?error=access_denied")).toEqual({ kind: "inbox" });
    expect(googleReturn("")).toEqual({ kind: "inbox" });
  });
});

describe("finishGoogleReturn — what /oauth/google actually does", () => {
  const io = (complete: GoogleReturnIO["completeGsc"] = async () => ({ brand_id: "berry-virtual" })) => ({
    completeGsc: vi.fn(complete),
    inbox: vi.fn(),
    go: vi.fn(),
  });

  it("posts code and state for a gsc. return, then lands on the brand's console", async () => {
    const x = io();
    await finishGoogleReturn(googleReturn(`?${new URLSearchParams({ code: "4/0Abc", state: STATE })}`), x);
    expect(x.completeGsc).toHaveBeenCalledWith("4/0Abc", STATE);
    expect(x.inbox).not.toHaveBeenCalled();
    expect(x.go).toHaveBeenCalledWith("/#/w/seo/berry-virtual/console?gsc=connected");
  });

  it("trusts the backend's brand_id over the state's", async () => {
    const x = io(async () => ({ brand_id: "berry" }));
    await finishGoogleReturn(googleReturn(`?${new URLSearchParams({ code: "c", state: STATE })}`), x);
    expect(x.go).toHaveBeenCalledWith("/#/w/seo/berry/console?gsc=connected");
  });

  it("never calls the backend when Google sent error= instead of a code", async () => {
    const x = io();
    await finishGoogleReturn(googleReturn(`?${new URLSearchParams({ error: "access_denied", state: STATE })}`), x);
    expect(x.completeGsc).not.toHaveBeenCalled();
    expect(x.inbox).not.toHaveBeenCalled();
    expect(x.go).toHaveBeenCalledWith(gscReturnPath("berry-virtual", { error: GSC_CANCELLED }));
  });

  it("hands a non-gsc return to the inbox path and nothing else", async () => {
    for (const search of [`?code=c&state=${INBOX_STATE}`, `?error=access_denied&state=${INBOX_STATE}`]) {
      const x = io();
      await finishGoogleReturn(googleReturn(search), x);
      expect(x.inbox).toHaveBeenCalledTimes(1);
      expect(x.completeGsc).not.toHaveBeenCalled();
      expect(x.go).not.toHaveBeenCalled();
    }
  });

  it("carries a coded refusal's message back as-is", async () => {
    const message = "That Google account can't see Search Console for berry.com — sign in with one that can.";
    const x = io(async () => { throw new ApiError("Request failed", 422, { detail: { code: "gsc_no_property", message } }); });
    await finishGoogleReturn(googleReturn(`?${new URLSearchParams({ code: "c", state: STATE })}`), x);
    expect(x.go).toHaveBeenCalledWith(gscReturnPath("berry-virtual", { error: message }));
  });

  it("the page wires both paths through it, and the inbox exchange is unchanged", () => {
    const page = readFileSync(join(__dirname, "../../../app/oauth/google/page.tsx"), "utf8");
    expect(page).toContain("finishGoogleReturn(ret, {");
    expect(page).toContain("completeGsc: seoOauthComplete");
    expect(page).toContain("inbox: inboxReturn");
    expect(page).toContain("inboxOauthComplete(code, state)");
    expect(page).toContain('.then(() => back("connected=1"))');
    expect(page).toContain('const WORKSPACE = "/#/w/inbox";');
  });
});

describe("gscReturnPath / readGscReturn round trip", () => {
  it("reads success, failure and nothing", () => {
    const ok = gscReturnPath("berry-virtual", { connected: true });
    expect(readGscReturn(ok.slice(1))).toEqual({ connected: true, error: null });
    const why = "Search Console connect isn't set up on this server yet — an admin needs to finish the Google setup.";
    expect(readGscReturn(gscReturnPath(null, { error: why }).slice(1))).toEqual({ connected: false, error: why });
    expect(readGscReturn("#/w/seo/berry-virtual/console")).toEqual(NO_GSC_RETURN);
    expect(readGscReturn("#/w/inbox?connected=1")).toEqual(NO_GSC_RETURN);
  });

  it("encodes the brand so an untrusted id cannot add path segments", () => {
    expect(gscReturnPath("a/b?c", { connected: true })).toBe("/#/w/seo/a%2Fb%3Fc/console?gsc=connected");
    expect(gscReturnPath(null, { connected: true })).toBe("/#/w/seo?gsc=connected");
  });
});

/* ---------------------------------------------- refusals off the wire -- */

describe("coded refusals as the API client reads them", () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (status: number, body: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json" },
    })));

  it("reads {detail: {code, message}} as the message and the code", async () => {
    const message = "Search Console connect isn't set up on this server yet — an admin needs to finish the Google setup.";
    reply(503, { detail: { code: "gsc_oauth_unconfigured", message } });
    const e = await seoOauthStart("berry").catch((x: unknown) => x);
    expect(apiCode(e)).toBe("gsc_oauth_unconfigured");
    expect(describeFailure(e, "fallback")).toBe(message);
    expect(gscFailure(e)).toBe(message);
  });

  it("still reads a top-level code first, and a string detail as before", async () => {
    reply(413, { code: "too_large", detail: "That file is too big." });
    const e = await seoOauthStart("berry").catch((x: unknown) => x);
    expect(apiCode(e)).toBe("too_large");
    expect(describeFailure(e, "fallback")).toBe("That file is too big.");
  });

  it("says something calm for an unknown brand or a broken reply", async () => {
    reply(404, { detail: "Unknown brand" });
    expect(gscFailure(await seoOauthComplete("c", STATE).catch((x: unknown) => x))).toBe("That brand isn't in the SEO list any more.");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Internal Server Error</html>", { status: 500 })));
    const broken = gscFailure(await seoOauthComplete("c", STATE).catch((x: unknown) => x), "Try again.");
    expect(broken).toBe("Try again.");
  });
});

/* ------------------------------------------------------- Integrations -- */

describe("gscIntegration — the Integrations row", () => {
  it("never claims Connected on a configured server with no brand behind it", () => {
    expect(gscIntegration({ gsc: false, serp: true, gsc_connect: true })).toEqual({
      status: "off", note: "Connect it per brand in the SEO console", open: "console",
    });
  });

  it("offers no way in when connect is not set up here", () => {
    expect(gscIntegration({ gsc: false, serp: true })).toEqual({ status: "off", note: GSC_CONNECT_UNAVAILABLE, open: null });
    expect(gscIntegration(null).status).toBe("off");
  });

  it("is Connected only on sources.gsc === true", () => {
    expect(gscIntegration({ gsc: true, serp: true, gsc_connect: false })).toEqual({ status: "on", open: "dashboard" });
  });
});

/* ------------------------------------------------------ degraded notes -- */

const HTTP_403 =
  "Search Console: Search Console rejected sc-domain:berry.com: <HttpError 403 when requesting "
  + "https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aberry.com/searchAnalytics/query?alt=json "
  + "returned \"User does not have sufficient permission for site 'sc-domain:berry.com'\". Details: \"[{'message': 'x'}]\">";

const CTX: NoteContext = { site: "berry.com", gsc: "connectable" };

describe("plainNote — never the exception text", () => {
  it("turns the raw Search Console 403 into a sentence that points at the button", () => {
    const s = plainNote(HTTP_403, CTX);
    expect(s).toBe("Search Console couldn't be read for berry.com. Press Connect Search Console and sign in with the Google account that has access to this site, then refresh the data.");
    for (const leak of ["<", "HttpError", "403", "googleapis", "sc-domain", "service account"]) expect(s).not.toContain(leak);
  });

  it("fits the remedy to the brand: connected, or no button on this server", () => {
    expect(plainNote(HTTP_403, { ...CTX, gsc: "connected" })).toContain("may have lost access");
    expect(plainNote(HTTP_403, { ...CTX, gsc: "unavailable" })).toContain(GSC_CONNECT_UNAVAILABLE);
    expect(plainNote(HTTP_403, { ...CTX, gsc: "unavailable" })).not.toContain("Press Connect");
  });

  it("describes Google Analytics as a service-account Viewer grant, never a connect", () => {
    const s = plainNote("Google Analytics: no GA property is shared with the service account", CTX);
    expect(s).toBe(`Google Analytics isn't connected for berry.com. ${GA_SERVICE_ACCOUNT}`);
    expect(s).not.toMatch(/connect it|press|button/i);
  });

  it("maps every known prefix to plain words", () => {
    for (const raw of [
      "Rank tracking: Serper key missing — rank tracking needs live SERPs",
      "Serper key missing — topics built from Search Console data only",
      "Serper: HTTPError('429 Too Many Requests')",
      "New-topic ideation skipped: Site review needs the AI model: RuntimeError()",
      "Page analytics: Google Analytics rejected properties/123: <HttpError 403>",
      "Sitemap watch: ConnectTimeout()",
    ]) {
      const s = plainNote(raw, CTX);
      expect(looksRaw(s), s).toBe(false);
      expect(s).not.toMatch(/Serper|HTTPError|RuntimeError|properties\/|ConnectTimeout/);
    }
  });

  it("renders the topic branch's notes word for word", () => {
    for (const n of PLAIN_TOPIC_NOTES) expect(plainNote(n, CTX)).toBe(n);
    expect(PLAIN_TOPIC_NOTES).toContain("Topics aren't checked against what you sell yet — run Analyze website.");
  });

  it("replaces an unknown raw note, and keeps an unknown plain one", () => {
    const generic = plainNote("Keyword lab: KeyError('volume')", CTX);
    expect(generic).not.toContain("KeyError");
    expect(plainNote("Traceback (most recent call last)", CTX)).toBe(generic);
    expect(plainNote("{'error': 'quota'}", CTX)).toBe(generic);
    expect(plainNote("Competitor pages were read from cache this time.", CTX)).toBe("Competitor pages were read from cache this time.");
  });
});

describe("plainNotes", () => {
  it("says each thing once, skips junk, and survives a missing list", () => {
    expect(plainNotes(["Serper: a", "Serper: b", 7, null, "  ", PLAIN_TOPIC_NOTES[0]], CTX)).toEqual([
      "Live Google checks aren't available on this server right now, so blog topics come from our own search data only.",
      PLAIN_TOPIC_NOTES[0],
    ]);
    expect(plainNotes(undefined, CTX)).toEqual([]);
  });
});

describe("gscNotice — the dashboard's Search Console line", () => {
  it("is quiet when the run measured clicks, whatever the flags say", () => {
    expect(gscNotice({ connected: false }, { mode: "search-console", impressions_28d: 900 })).toBe("measured");
    // an old run with no mode at all, read by the service account
    expect(gscNotice({ connected: false }, { impressions_28d: 900 })).toBe("measured");
  });

  it("does not say 'not connected' for a grant the figures predate", () => {
    expect(gscNotice({ connected: true }, { mode: "rank-tracking", impressions_28d: 0 })).toBe("pending");
  });

  it("is off with neither", () => {
    expect(gscNotice({ connected: false }, { mode: "rank-tracking", impressions_28d: 0 })).toBe("off");
    expect(gscNotice({ connected: false }, { mode: "search-console", impressions_28d: 0 })).toBe("off");
  });
});

/* --------------------------------------------------- topic provenance -- */

describe("topicOrigin — the source chip", () => {
  it("labels every source the backend sends", () => {
    const labels = Object.fromEntries([
      "seed", "site gap", "suggested seed", "google suggestion", "search data", "new idea", "competitor-content",
    ].map((source) => [source, topicOrigin({ source }).label]));
    expect(labels).toEqual({
      "seed": "Your seed",
      "site gap": "Site gap",
      "suggested seed": "Suggested by site review",
      "google suggestion": "Google suggestion",
      "search data": "Search data",
      "new idea": "AI idea",
      "competitor-content": "Competitor",
    });
  });

  it("shows from_seed for a Google suggestion only", () => {
    expect(topicOrigin({ source: "google suggestion", from_seed: "virtual receptionist" }).fromSeed).toBe("virtual receptionist");
    expect(topicOrigin({ source: "google suggestion", from_seed: null }).fromSeed).toBeNull();
    expect(topicOrigin({ source: "seed", from_seed: "virtual receptionist" }).fromSeed).toBeNull();
  });

  it("renders an unknown or missing source generically, never the raw value", () => {
    expect(topicOrigin({ source: "keyword_lab_v2" })).toEqual({ key: "other", label: "Other source", fromSeed: null });
    expect(topicOrigin({})).toEqual({ key: "other", label: "Other source", fromSeed: null });
  });

  it("reads a run persisted before the topics branch", () => {
    // the old shape: no from_seed, the old source vocabulary
    const old: Omit<SeoTopic, "from_seed"> = {
      keyword: "legal answering service", source: "new idea", priority: "medium", impact: "",
      angle: "how-to", volume_est: null, volume_label: "no volume data", trend: "new",
      difficulty: null, est_monthly_clicks: null, why: "Model idea", score: 0.4,
    };
    expect(topicOrigin(old)).toEqual({ key: "idea", label: "AI idea", fromSeed: null });
    expect(topicOrigin({ ...old, source: "google suggestion" })).toEqual({ key: "google", label: "Google suggestion", fromSeed: null });
  });
});
