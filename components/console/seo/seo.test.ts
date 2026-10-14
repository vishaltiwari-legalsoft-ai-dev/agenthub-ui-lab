import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SeoAuditIssue, SeoBrandCard, SeoPageIntel, SeoPlanItem, SeoTodo, SeoTopic } from "@/lib/api";
import {
  API_URL, ApiError, apiCode, isAbortError, RequestTimeoutError, seoBrandDetail, seoOauthComplete, seoOauthDisconnect, seoOauthStart,
  seoPages, seoPagesRefresh, seoSetTodoStatus,
} from "../../../lib/api";
import { describeFailure } from "../../../lib/load";
import {
  auditEvidence, auditTone, briefSchema, canConnectGsc, connectedLine, finishGoogleReturn, flagChip,
  consoleHeadline, GA_INTEGRATION, GA_SERVICE_ACCOUNT, GSC_CANCELLED, GSC_MISMATCH, pageChips, returnNeedsOverview,
  subjectOpensInConsole, planItemView, topicAngle, refreshHref, todoPages, todoCategoryLabel, movedFixLinks,
  gaStory, morePagesLine, missingTopics, topicDifficulty, plainNotesExcept, GSC_CONNECT_HINT, GSC_CONNECT_UNAVAILABLE, GSC_RETRY, GSC_UNFINISHED, gscFailure,
  gscIntegration, gscReturnSentence,
  gscNotice, gscReturnPath, gscSlot, gscStateBrand, googleReturn, hiddenSuggestionsLine, looksRaw,
  NO_GSC_RETURN, notShownLine, pageRec, planHeading, plainFailure, plainMessage, plainNote, plainNotes, PLAIN_TOPIC_NOTES, readGsc,
  readGscReturn, reviewDropped, todoPage, topicOrigin, type GoogleReturnIO, type NoteContext,
} from "./seo";
import {
  AuditIssueRow, BriefSchema, HiddenSuggestions, MissingTopics, PageRow, PlanStrip, ReviewDropped, TodoPages, TopicRow,
} from "./rows";
import { loadSeoOverview, onSeoOverview, publishSeoOverview } from "./overview";

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
      service_account_property: null, reading: false, mismatch: false,
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

  it("reads a Google refusal as one of two reasons, never Google's own error value", () => {
    const q = new URLSearchParams({ error: "access_denied", state: STATE });
    expect(googleReturn(`?${q}`)).toEqual({ kind: "gsc-refused", brand: "berry-virtual", reason: "cancelled" });
    expect(googleReturn(`?${new URLSearchParams({ error: "admin_policy_enforced", state: STATE })}`))
      .toEqual({ kind: "gsc-refused", brand: "berry-virtual", reason: "google_error" });
  });

  it("refuses a gsc return with no code", () => {
    expect(googleReturn(`?state=${encodeURIComponent(STATE)}`)).toEqual({ kind: "gsc-refused", brand: "berry-virtual", reason: "google_error" });
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
    expect(x.go).toHaveBeenCalledWith("/#/w/seo/berry-virtual/console?gsc=cancelled");
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

  it("carries a coded refusal back as its code alone — the message stays off the link", async () => {
    const message = "That Google account can't see Search Console for berry.com — sign in with one that can.";
    const x = io(async () => { throw new ApiError(message, 422, { detail: { code: "gsc_no_property", message } }); });
    await finishGoogleReturn(googleReturn(`?${new URLSearchParams({ code: "c", state: STATE })}`), x);
    expect(x.go).toHaveBeenCalledWith("/#/w/seo/berry-virtual/console?gsc=gsc_no_property");
  });

  it("names an uncoded failure by its kind", async () => {
    const run = async (err: unknown) => {
      const x = io(async () => { throw err; });
      await finishGoogleReturn(googleReturn(`?${new URLSearchParams({ code: "c", state: STATE })}`), x);
      return String(x.go.mock.calls[0][0]).split("?")[1];
    };
    expect(await run(new ApiError("Unknown brand", 404, { detail: "Unknown brand" }))).toBe("gsc=unknown_brand");
    expect(await run(new RequestTimeoutError(90_000))).toBe("gsc=timeout");
    expect(await run(new ApiError("Request failed (500)", 500, null))).toBe("gsc=failed");
    expect(await run(new TypeError("Failed to fetch"))).toBe("gsc=failed");
    // a code that is not a code shape never rides the link
    expect(await run(new ApiError("x", 422, { detail: { code: "gsc_<script>", message: "x" } }))).toBe("gsc=failed");
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
  it("reads success, a code and nothing", () => {
    const ok = gscReturnPath("berry-virtual", { connected: true });
    expect(readGscReturn(ok.slice(1))).toEqual({ connected: true, code: null });
    expect(readGscReturn(gscReturnPath(null, { code: "gsc_state_expired" }).slice(1))).toEqual({ connected: false, code: "gsc_state_expired" });
    expect(readGscReturn("#/w/seo/berry-virtual/console")).toEqual(NO_GSC_RETURN);
    expect(readGscReturn("#/w/seo?gsc=")).toEqual(NO_GSC_RETURN);
    expect(readGscReturn("#/w/inbox?connected=1")).toEqual(NO_GSC_RETURN);
  });

  it("puts only a code shape on the link", () => {
    expect(gscReturnPath("b", { code: "Your account is locked" })).toBe("/#/w/seo/b/console?gsc=failed");
    expect(gscReturnPath("b", { code: "cancelled" })).toBe("/#/w/seo/b/console?gsc=cancelled");
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
      "Live Google results weren't available for part of this — what's shown is what came back.",
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

/* ------------------------------------- grounded advice (recs contract) -- */
/* Rendered, not just computed: the contract's failures were things that
 * showed up on screen — a bare "Rule: ", "low" on decorative images, an empty
 * "This week" box. The rows live in `rows.tsx` so these can draw them. */

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

const page = (over: Partial<SeoPageIntel> = {}): SeoPageIntel => ({
  path: "/services", url: "https://berry.com/services", title: "Services | Berry Virtual",
  views: 120, sessions: 90, engagement_rate: 0.5, clicks: 14, impressions: 900, position: 8.2,
  best_query: "virtual receptionist", flags: ["title-long"], recommendation: "Shorten the title under 60 characters.",
  word_count: 640, ...over,
});

describe("page rows — rec_source", () => {
  it("prints no recommendation line at all for a flags row", () => {
    const out = html(createElement(PageRow, { p: page({ rec_source: "flags", recommendation: "" }) }));
    expect(out).not.toContain("Rule:");
    expect(out).not.toContain("seo-pages__rec");
    expect(out).toContain("Title too long");
  });

  it("labels AI and rule advice by rec_source", () => {
    expect(html(createElement(PageRow, { p: page({ rec_source: "ai", ai: true, recommendation: "Lead the title with “legal VA pricing”." }) })))
      .toContain("AI: Lead the title with");
    expect(html(createElement(PageRow, { p: page({ rec_source: "rule", recommendation: "Expand this page past 300 words." }) })))
      .toContain("Rule: Expand this page past 300 words.");
  });

  it("renders an old-shape row (no rec_source) exactly as before", () => {
    expect(pageRec(page({ ai: true }))).toEqual({ label: "AI", text: "Shorten the title under 60 characters." });
    expect(pageRec(page({ ai: false }))).toEqual({ label: "Rule", text: "Shorten the title under 60 characters." });
    expect(pageRec(page({ recommendation: "" }))).toBeNull();
    expect(html(createElement(PageRow, { p: page() }))).toContain("Rule: Shorten the title");
  });

  it("gives every chip a readable label, known or not", () => {
    expect(flagChip("images-no-alt")).toEqual({ label: "Images missing alt text", ok: false });
    expect(flagChip("healthy")).toEqual({ label: "Healthy", ok: true });
    expect(flagChip("multi_h1-found")).toEqual({ label: "Multi h1 found", ok: false });
    expect(flagChip("--")).toEqual({ label: "Flag", ok: false });
  });

  it("says how many suggestions were hidden, quietly, and only when some were", () => {
    const dropped = (n: number) => ({ kept: 3, dropped: Array.from({ length: n }, (_, i) => ({ path: `/p${i}`, reason: "repeats-flags", recommendation: "x", detail: "y" })) });
    expect(hiddenSuggestionsLine(dropped(2))).toBe("2 suggestions hidden because they repeated the flags or didn't fit the page.");
    expect(hiddenSuggestionsLine(dropped(1))).toBe("1 suggestion hidden because it repeated the flags or didn't fit the page.");
    expect(hiddenSuggestionsLine(dropped(0))).toBeNull();
    expect(hiddenSuggestionsLine(undefined)).toBeNull();
    expect(html(createElement(HiddenSuggestions, {}))).toBe("");
  });
});

const issue = (over: Partial<SeoAuditIssue> = {}): SeoAuditIssue => ({
  issue: "Missing meta description", severity: "medium", count: 2,
  pages: ["https://berry.com/a", "https://berry.com/b"], fix: "Write one.", ...over,
});

describe("audit findings — kind and evidence", () => {
  it("renders decorative alt text as info, never a severity or 'missing'", () => {
    const decorative = issue({
      issue: "Images marked decorative (empty alt)", severity: "low", kind: "decorative-alt",
      informational: true, images: 12, fix: "Not missing: alt=\"\" tells screen readers to skip the image.",
    });
    expect(auditTone(decorative)).toBe("info");
    const out = html(createElement(AuditIssueRow, { issue: decorative }));
    expect(out).toContain("seo-chip--sev-info");
    expect(out).not.toContain("seo-chip--sev-low");
    expect(out).toContain("12 images with alt=&quot;&quot; — not missing");
  });

  it("renders an old-shape finding (no kind) as before: severity, fix, pages", () => {
    const out = html(createElement(AuditIssueRow, { issue: issue() }));
    expect(out).toContain("seo-chip--sev-medium");
    expect(out).toContain("https://berry.com/a");
    expect(auditEvidence(issue())).toBeNull();
    expect(auditEvidence(issue({ kind: null }))).toBeNull();
  });

  it("shows template images once, then the pages", () => {
    const t = issue({ kind: "template-alt", severity: "low", srcs: ["/logo.svg", "/badge.png"], issue: "Template image(s) without alt text — fix once in the header/footer" });
    expect(auditEvidence(t)).toEqual({ label: "Images in the shared header/footer", lines: ["/logo.svg", "/badge.png"], coversPages: false });
    expect(html(createElement(AuditIssueRow, { issue: t }))).toContain("https://berry.com/b");
  });

  it("lists per-page evidence instead of repeating the bare page list", () => {
    const fit = issue({
      kind: "schema-fit", schema_type: "Service", severity: "medium", issue: "2 service pages lack Service schema",
      evidence: [{ page: "https://berry.com/a", reason: "service page, no Service markup" }, { page: "https://berry.com/b", reason: "pricing page" }],
    });
    const ev = auditEvidence(fit);
    expect(ev?.label).toBe("Why Service fits");
    expect(ev?.coversPages).toBe(true);
    const out = html(createElement(AuditIssueRow, { issue: fit }));
    expect(out.split("https://berry.com/a").length - 1).toBe(1);

    const parse = issue({ kind: "schema-error", examples: [{ page: "https://berry.com/a", error: "Expecting ',' delimiter" }] });
    expect(auditEvidence(parse)?.lines).toEqual(["https://berry.com/a — Expecting ',' delimiter"]);
    // one example of two pages: the list is still printed
    expect(auditEvidence(parse)?.coversPages).toBe(false);

    const alt = issue({ kind: "page-alt", examples: [{ page: "https://berry.com/a", srcs: ["/team.jpg"] }, { page: "https://berry.com/b", srcs: [] }] });
    expect(auditEvidence(alt)?.lines).toEqual(["https://berry.com/a — /team.jpg", "https://berry.com/b"]);

    const title = issue({ kind: "title-template", suffix: "| Berry Virtual", suffix_chars: 15 });
    expect(auditEvidence(title)?.lines).toEqual(["“| Berry Virtual” adds 15 characters to every long title"]);
  });

  it("survives malformed evidence without inventing any", () => {
    expect(auditEvidence(issue({ kind: "schema-fit", evidence: "nope" as never }))).toBeNull();
    expect(auditEvidence(issue({ kind: "page-alt", examples: [null, { srcs: ["/x"] }] as never }))).toBeNull();
    expect(auditEvidence(issue({ kind: "title-template" }))).toBeNull();
    expect(auditEvidence(issue({ kind: "something-new" }))).toBeNull();
  });
});

describe("the This-week strip", () => {
  const item = (n: number) => ({ source: "fix list", action: `Move ${n}`, detail: `Why ${n}` });

  it("draws nothing at all for an empty plan — no empty box", () => {
    expect(html(createElement(PlanStrip, { plan: [] }))).toBe("");
    expect(planHeading(0)).toBeNull();
  });

  it("counts in words for the 1–3 moves it may hold", () => {
    expect(html(createElement(PlanStrip, { plan: [item(1)] }))).toContain("This week — do this one");
    expect(html(createElement(PlanStrip, { plan: [item(1), item(2)] }))).toContain("This week — do these two");
    const four = html(createElement(PlanStrip, { plan: [item(1), item(2), item(3), item(4)] }));
    expect(four).toContain("do these three");
    expect(four).not.toContain("Move 4");
  });
});

describe("the site review's dropped findings", () => {
  it("says 'no evidence' only when that is what every drop was", () => {
    expect(reviewDropped({ kept: 4, dropped: [
      { reason: "no-evidence-url", insight: "Add case studies", detail: "" },
      { reason: "invented-number", insight: "Your bounce rate is 80%", detail: "" },
    ] })?.line).toBe("2 findings dropped — no evidence on your pages");
    const mixed = reviewDropped({ kept: 4, dropped: [
      { reason: "duplicate", insight: "Add case studies", detail: "" },
      { reason: "brand-new-reason", insight: "", detail: "" },
    ] });
    expect(mixed?.line).toBe("2 findings dropped by the evidence check");
    expect(mixed?.items).toEqual([
      { insight: "Add case studies", reason: "it repeated another finding" },
      { insight: "A finding", reason: "it didn't pass the evidence check" },
    ]);
  });

  it("is absent for an old review and for one that dropped nothing", () => {
    expect(reviewDropped(null)).toBeNull();
    expect(reviewDropped(undefined)).toBeNull();
    expect(reviewDropped({ kept: 5, dropped: [] })).toBeNull();
    expect(html(createElement(ReviewDropped, { grounding: null }))).toBe("");
  });

  it("renders as a disclosure behind one quiet line", () => {
    const out = html(createElement(ReviewDropped, { grounding: { kept: 1, dropped: [{ reason: "audit-owned", insight: "Fix the titles", detail: "" }] } }));
    expect(out).toContain("<details");
    expect(out).toContain("1 finding dropped by the evidence check");
    expect(out).toContain("already covered by the technical audit");
  });
});

describe("fix list: page links, the cut, and briefs' schema", () => {
  it("links a cited URL and leaves an old evidence sentence as text", () => {
    expect(todoPage("https://berry.com/pricing")).toEqual({ href: "https://berry.com/pricing", text: "/pricing" });
    expect(todoPage("https://berry.com/")).toEqual({ href: "https://berry.com/", text: "berry.com" });
    expect(todoPage("The pricing page lists no fees")).toEqual({ href: null, text: "The pricing page lists no fees" });
    expect(todoPage("")).toBeNull();
    expect(todoPage("javascript:alert(1)")).toEqual({ href: null, text: "javascript:alert(1)" });
  });

  it("counts what the cap cut, and says nothing for an older run", () => {
    expect(notShownLine(3)).toBe("3 more not shown");
    expect(notShownLine(0)).toBeNull();
    expect(notShownLine(undefined)).toBeNull();
  });

  it("shows the schema note as the reason, or as the answer when there are no types", () => {
    expect(briefSchema({ schema_recommended: ["Article"], schema_note: "Seen on the ranking pages: Article (3 of 5 top pages)." }))
      .toEqual({ types: ["Article"], note: "Seen on the ranking pages: Article (3 of 5 top pages)." });
    expect(briefSchema({ schema_recommended: [], schema_note: "No schema seen on ranking pages." }))
      .toEqual({ types: [], note: "No schema seen on ranking pages." });
    // an older brief: types, no note
    expect(briefSchema({ schema_recommended: ["Article", "FAQPage"] })).toEqual({ types: ["Article", "FAQPage"], note: null });
    expect(briefSchema({ schema_recommended: [] })).toEqual({ types: [], note: "No schema suggested for this page." });
    expect(html(createElement(BriefSchema, { brief: { schema_recommended: [], schema_note: "No schema seen on ranking pages." } })))
      .toContain("No schema seen on ranking pages.");
  });

  it("the console draws these rows rather than its own copies", () => {
    const agent = readFileSync(join(__dirname, "SeoAgent.tsx"), "utf8");
    const labs = readFileSync(join(__dirname, "labs.tsx"), "utf8");
    expect(agent).not.toContain('"Rule: "');
    expect(agent).toContain("<PageRow key={p.path} p={p} />");
    expect(agent).toContain("<PlanStrip plan={plan} todos={run?.todos ?? []} onSeeFix={seeFix} />");
    expect(agent).toContain("<ReviewDropped grounding={siteReview.grounding} />");
    expect(labs).toContain("<AuditIssueRow");
    expect(labs).toContain("<BriefSchema brief={b} />");
  });
});

/* ------------------------------------ no raw text anywhere (follow-up) -- */
/* Every note the labs write — the keyword map, competitor profiles and
 * tracking, briefs — and every failure the SEO screens report, as the backend
 * actually words them today. None of it may reach the reader raw. */

const LAB_NOTES = [
  "Serper: HTTPError('403 Client Error: Forbidden for url: https://google.serper.dev/search')",
  "Serper key missing — expansion limited to the LLM and our own search data",
  "LLM expansion skipped: CredentialMissing('offline mode')",
  "LLM returned no usable clusters — heuristic grouping used",
  "LLM clustering skipped (ValueError('Expecting value: line 1 column 1')) — heuristic grouping used",
  "Sitemap watch: ConnectTimeout(<urllib3.connection.HTTPSConnection object at 0x7f>)",
  "Page fetch https://rival.com/blog/post: <HTTPError 404: 'Not Found'>",
  "Serper rival.com: ReadTimeout('read timed out')",
  "LLM outline skipped (CredentialMissing('offline mode')) — structural outline from SERP data",
  "Serper key missing — topics built from Search Console data only",
];

describe("lab notes — keyword map, competitors, briefs", () => {
  it("turns every note the labs write into words, with no vendor, model or exception in them", () => {
    for (const raw of LAB_NOTES) {
      const s = plainNote(raw, CTX);
      expect(looksRaw(s), `${raw} → ${s}`).toBe(false);
      expect(s, raw).not.toMatch(/Serper|LLM|heuristic|Error|Timeout|https?:|0x7f|rival\.com/);
    }
  });

  it("keeps each sentence true where its prefix appears", () => {
    expect(plainNote("Serper key missing — topics built from Search Console data only", CTX)).toContain("blog topics");
    expect(plainNote("Serper key missing — expansion limited to the LLM and our own search data", CTX)).toContain("keyword ideas");
    // competitor profiles and the keyword map share the bare `Serper` prefix:
    // the sentence must not claim to be about blog topics
    expect(plainNote("Serper rival.com: ReadTimeout()", CTX)).not.toContain("blog");
    expect(plainNote("LLM clustering skipped (x) — heuristic grouping used", CTX))
      .toBe(plainNote("LLM returned no usable clusters — heuristic grouping used", CTX));
  });

  it("the labs route every note and toast through it", () => {
    const labs = readFileSync(join(__dirname, "labs.tsx"), "utf8");
    expect(labs).toContain("const errMsg = plainFailure;");
    expect(labs).not.toContain("res.degraded[0]");
    expect(labs).not.toContain("doc.notes[0]");
    expect(labs).not.toMatch(/<Notes notes=\{[^}]*\} \/>/); // every <Notes> carries its ctx
    expect(labs.match(/<Notes notes=\{[^}]*\} ctx=\{noteCtx\} \/>/g)).toHaveLength(3);
    for (const file of ["labs.tsx", "SeoAgent.tsx"]) {
      expect(readFileSync(join(__dirname, file), "utf8"), file).not.toContain("describeFailure(");
    }
  });
});

describe("plainMessage / plainFailure — failures in words", () => {
  it("replaces a raw 503 detail with the caller's fallback", () => {
    const raw = "Google Analytics rejected properties/123: <HttpError 403 when requesting https://analyticsdata.googleapis.com/v1beta returned \"denied\">";
    expect(plainMessage(raw, "Could not refresh pages")).toBe("Could not refresh pages");
    expect(plainFailure(new ApiError(raw, 503, { detail: raw }), "Could not refresh pages")).toBe("Could not refresh pages");
    expect(plainMessage("Site review needs the AI model: RuntimeError('x')", "Site analysis failed")).toBe("Site analysis failed");
    expect(plainMessage("Status must be one of ['assigned', 'done', 'todo']", "Could not save status")).toBe("Could not save status");
  });

  it("lets a plain refusal, a timeout and a coded message through untouched", () => {
    expect(plainMessage("Run the site analysis first", "x")).toBe("Run the site analysis first");
    const timeout = new RequestTimeoutError(90_000);
    expect(plainFailure(timeout, "x")).toBe(timeout.message);
    const coded = "This Google account has no Search Console access to berry.com — sign in with an account that does, or ask the site owner to add it.";
    expect(plainFailure(new ApiError(coded, 422, { detail: { code: "gsc_no_property", message: coded } }), "x")).toBe(coded);
    expect(plainMessage("", "fallback")).toBe("fallback");
    expect(plainMessage(null, "")).toBe("");
  });

  it("keeps markup out of a plain message", () => {
    expect(plainMessage("<img src=x onerror=alert(1)>", GSC_UNFINISHED)).toBe(GSC_UNFINISHED);
  });
});

describe("chips the integration is moving out of the row sentences", () => {
  it("labels healthy and thin-content properly, not with the generic fallback", () => {
    expect(flagChip("healthy")).toEqual({ label: "Healthy", ok: true });
    expect(flagChip("thin-content")).toEqual({ label: "Thin content", ok: false });
    expect(flagChip("thin")).toEqual({ label: "Thin content", ok: false });
  });

  it("renders a flags row of them with no sentence under it", () => {
    const out = html(createElement(PageRow, { p: page({ rec_source: "flags", recommendation: "", flags: ["healthy"] }) }));
    expect(out).toContain('<span class="seo-chip seo-chip--on">Healthy</span>');
    expect(out).not.toContain("Rule:");
    expect(html(createElement(PageRow, { p: page({ rec_source: "flags", recommendation: "", flags: ["thin-content"] }) })))
      .toContain('<span class="seo-chip seo-chip--sev-medium">Thin content</span>');
  });
});

describe("the dashboard opens the console on its brand", () => {
  it("routes every console link through the workspace's focus, and the console lets go of it", () => {
    const dash = readFileSync(join(__dirname, "../../hub/work/seo/SeoDashboard.tsx"), "utf8");
    const ws = readFileSync(join(__dirname, "../../hub/work/SeoWorkspace.tsx"), "utf8");
    const agent = readFileSync(join(__dirname, "SeoAgent.tsx"), "utf8");
    expect(dash).not.toContain('openWork("seo", brandId, "console")');
    // connect, reconnect (mismatch), open (pending), work the list
    expect(dash.match(/onOpenConsole\(brandId\)/g)).toHaveLength(4);
    expect(ws).toContain("onOpenConsole={openInConsole}");
    expect(ws).toContain("focusBrand={focus} onFocused={releaseFocus}");
    expect(ws).toMatch(/setFocus\(id\);\s*openWork\("seo", id, "console"\);/);
    expect(agent).toMatch(/void openBrand\(focusBrand\);\s*onFocused\?\.\(\);/);
  });
});

/* -------------------------------- brand ids in API paths (security) -- */
/* The SEO workspace opens `#/w/seo/<brand>/console`, and that brand id —
 * anyone can write it into a link — reaches `seoBrandDetail` and `seoPages`
 * through `focusBrand`. Unencoded, `..%2F..%2Fx` decoded to `../../x` and the
 * browser sent the signed-in reader's bearer to another backend path. */

describe("brand ids never steer a request to another path", () => {
  afterEach(() => vi.unstubAllGlobals());
  const capture = () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    return urls;
  };

  it("encodes ../x so it stays one segment under /api/seo-geo/", async () => {
    const urls = capture();
    await seoBrandDetail("../x");
    await seoPages("../../admin");
    await seoOauthStart("a/b?c#d");
    await seoOauthDisconnect("..%2F..%2Fx");
    await seoSetTodoStatus("../b", "../t", "done");
    expect(urls).toEqual([
      `${API_URL}/api/seo-geo/brands/..%2Fx`,
      `${API_URL}/api/seo-geo/pages/..%2F..%2Fadmin`,
      `${API_URL}/api/seo-geo/oauth/start/a%2Fb%3Fc%23d`,
      `${API_URL}/api/seo-geo/oauth/disconnect/..%252F..%252Fx`,
      `${API_URL}/api/seo-geo/todos/..%2Fb/..%2Ft`,
    ]);
    // what the browser would actually request, after resolving dot-segments
    for (const u of urls) expect(new URL(u).pathname, u).toMatch(/^\/api\/seo-geo\/(brands|pages|oauth|todos)\//);
  });

  it("refuses a bare dot segment as a rejection, sending nothing", async () => {
    const urls = capture();
    await expect(seoBrandDetail("..")).rejects.toThrow("That brand isn't in the SEO list.");
    await expect(seoPagesRefresh(".")).rejects.toThrow("That brand isn't in the SEO list.");
    // a rejected promise, not a throw at the call site: `.then().catch()` chains catch it
    const pending = seoPages("..");
    expect(pending).toBeInstanceOf(Promise);
    await pending.catch(() => undefined);
    expect(urls).toEqual([]);
    expect(plainFailure(await seoOauthStart("..").catch((e: unknown) => e), "x")).toBe("That brand isn't in the SEO list.");
  });

  it("covers every SEO path builder", () => {
    const api = readFileSync(join(__dirname, "../../../lib/api.ts"), "utf8");
    const templates = api.match(/`\/api\/seo-geo\/[^`]*`/g) ?? [];
    expect(templates.length).toBeGreaterThan(20);
    for (const t of templates) {
      for (const hole of t.match(/\$\{[^}]*\}/g) ?? []) expect(hole, t).toMatch(/^\$\{pathSegment\(\w+\)\}$/);
    }
  });
});

/* ------------------------------- the return toast says only fixed words -- */
/* A link can be written by anyone. The return toast shows a sentence from
 * this console's own table, chosen by a code — never text from the link —
 * and names the site from the brand the console already has. */

/** Every sentence the return toast can show, for the "only these" check. */
const KNOWN_CODES = [
  "cancelled", "google_error", "unknown_brand", "timeout", "failed",
  "gsc_oauth_unconfigured", "gsc_offline", "gsc_state_invalid", "gsc_state_expired", "gsc_state_other_user",
  "gsc_scope_not_granted", "gsc_no_property", "gsc_exchange_failed", "gsc_google_unavailable",
];

/** What the workspace toasts for a hash: read the code, say its sentence. */
const toastFor = (hash: string, domain: string | null = "berry.com") => {
  const r = readGscReturn(hash);
  return r.code === null ? null : gscReturnSentence(r.code, domain);
};

describe("the Search Console return toast", () => {
  it("never renders a sentence written into the link", () => {
    const fixed = new Set([...KNOWN_CODES.map((c) => gscReturnSentence(c, "berry.com")), GSC_RETRY]);
    const crafted = [
      "Your account is locked — call +1 555 0100 to unlock it.",
      "<img src=x onerror=alert(1)>",
      "Search Console connected. Now paste your password below.",
    ];
    for (const text of crafted) {
      for (const hash of [
        `#/w/seo/b/console?gsc=${encodeURIComponent(text)}`,
        `#/w/seo/b/console?gsc=failed&why=${encodeURIComponent(text)}`,
        `#/w/seo/b/console?gsc=gsc_no_property&why=${encodeURIComponent(text)}&domain=${encodeURIComponent(text)}`,
      ]) {
        const said = toastFor(hash);
        expect(said, hash).not.toBeNull();
        expect(fixed.has(said as string), `${hash} → ${said}`).toBe(true);
        expect(said).not.toContain("555");
        expect(said).not.toContain("<img");
        expect(said).not.toContain("password");
      }
    }
  });

  it("an unknown code is the generic line", () => {
    expect(toastFor("#/w/seo/b/console?gsc=something_new")).toBe("Search Console wasn't connected — try again.");
    expect(toastFor("#/w/seo/b/console?gsc=Your%20account%20is%20locked")).toBe(GSC_RETRY);
    expect(gscReturnSentence(null, "berry.com")).toBe(GSC_RETRY);
  });

  it("maps every known code to its own fixed sentence", () => {
    expect(toastFor("#/w/seo/b/console?gsc=cancelled")).toBe(GSC_CANCELLED);
    expect(toastFor("#/w/seo/b/console?gsc=gsc_state_expired"))
      .toBe("Search Console wasn't connected — the connect window expired. Start again from the SEO console.");
    expect(toastFor("#/w/seo/b/console?gsc=gsc_oauth_unconfigured"))
      .toBe("Search Console wasn't connected — connect isn't set up on this server yet. An admin needs to finish the Google setup.");
    expect(toastFor("#/w/seo/b/console?gsc=google_error"))
      .toBe("Search Console wasn't connected — Google didn't finish the sign-in. Try again.");
    const sentences = KNOWN_CODES.map((c) => gscReturnSentence(c, "berry.com"));
    for (const [i, s] of sentences.entries()) {
      expect(s, KNOWN_CODES[i]).not.toBe(GSC_RETRY);
      expect(s, KNOWN_CODES[i]).toMatch(/^Search Console wasn't connected — /);
      expect(looksRaw(s), KNOWN_CODES[i]).toBe(false);
    }
  });

  it("names the site for gsc_no_property from the brand the console knows, not the link", () => {
    expect(toastFor("#/w/seo/b/console?gsc=gsc_no_property&domain=evil.example", "berry.com"))
      .toBe("Search Console wasn't connected — this Google account has no Search Console access to berry.com. Sign in with an account that does, or ask the site owner to add it.");
    expect(toastFor("#/w/seo/b/console?gsc=gsc_no_property", null)).toContain("access to this site.");
  });

  it("the workspace toasts the code's sentence with the overview's domain", () => {
    const ws = readFileSync(join(__dirname, "../../hub/work/SeoWorkspace.tsx"), "utf8");
    expect(ws).toContain("toast(gscReturnSentence(ret.code, known?.domain), \"error\")");
    expect(ws).not.toMatch(/toast\(ret\.(error|code)\b/);
  });
});

/* ------------------------------------------- the final backend contract -- */

describe("page rows: rec_chip, outside flags", () => {
  it("labels the verdict chips, and anything new readably", () => {
    expect(pageChips({ flags: [], rec_chip: "healthy" })).toEqual([{ key: "healthy", label: "Healthy", ok: true }]);
    expect(pageChips({ flags: [], rec_chip: "meta-long" })).toEqual([{ key: "meta-long", label: "Meta description too long", ok: false }]);
    expect(pageChips({ flags: [], rec_chip: "not-crawled" })).toEqual([{ key: "not-crawled", label: "Not in the site crawl", ok: false }]);
    expect(pageChips({ flags: [], rec_chip: "stale-content" })).toEqual([{ key: "stale-content", label: "Stale content", ok: false }]);
  });

  it("says Thin content once on a thin row, where it is both a flag and the chip", () => {
    expect(pageChips({ flags: ["thin", "no-h1"], rec_chip: "thin-content" }).map((c) => c.label)).toEqual(["Thin content", "No H1"]);
    const out = html(createElement(PageRow, { p: page({ rec_source: "flags", recommendation: "", flags: ["thin"], rec_chip: "thin-content" }) }));
    expect(out.split("Thin content").length - 1).toBe(1);
    expect(out).not.toContain("Rule:");
  });

  it("draws a healthy flags row as one green chip and no sentence", () => {
    const out = html(createElement(PageRow, { p: page({ rec_source: "flags", recommendation: "", flags: [], rec_chip: "healthy" }) }));
    expect(out).toContain('<span class="seo-chip seo-chip--on">Healthy</span>');
    expect(out).not.toContain("seo-pages__rec");
  });

  it("renders an older row with no rec_chip from its flags alone", () => {
    expect(pageChips({ flags: ["title-long"] })).toEqual([{ key: "title-long", label: "Title too long", ok: false }]);
    expect(pageChips({ flags: ["title-long"], rec_chip: null })).toHaveLength(1);
    expect(pageChips({ flags: [] })).toEqual([]);
  });
});

describe("gsc_property_taken on the return", () => {
  it("has its own fixed sentence", () => {
    expect(gscReturnSentence("gsc_property_taken", "berry.com"))
      .toBe("Search Console wasn't connected — that Search Console property is already connected to another brand.");
    expect(toastFor("#/w/seo/b/console?gsc=gsc_property_taken")).not.toBe(GSC_RETRY);
  });

  it("rides the link as its code when the complete call answers 409", async () => {
    const go = vi.fn();
    await finishGoogleReturn(googleReturn(`?${new URLSearchParams({ code: "c", state: STATE })}`), {
      completeGsc: async () => {
        throw new ApiError("x", 409, { detail: { code: "gsc_property_taken", message: "That Search Console property is already connected to another brand." } });
      },
      inbox: vi.fn(),
      go,
    });
    expect(go).toHaveBeenCalledWith("/#/w/seo/berry-virtual/console?gsc=gsc_property_taken");
  });
});

describe("a grant for a different site (mismatch)", () => {
  const block = { connected: false, property: "sc-domain:other.com", connected_by: "ana@berry.com", connected_at: "2026-10-14T12:00:00Z", mismatch: true };

  it("is never connected, even if a block claims both", () => {
    expect(readGsc(block).connected).toBe(false);
    expect(readGsc({ ...block, connected: true }).connected).toBe(false);
    expect(readGsc({ ...block, connected: true }).mismatch).toBe(true);
  });

  it("offers Connect with the reconnect line, never 'Connected by'", () => {
    const slot = gscSlot(readGsc({ ...block, connected: true }), { gsc: true, serp: true, gsc_connect: true });
    expect(slot).toEqual({ mode: "connect", line: GSC_MISMATCH });
    expect(GSC_MISMATCH).toBe("Search Console connection is for a different site — reconnect it.");
    expect(slot.line).not.toContain("Connected by");
  });

  it("says so without a button where connect is not set up, or before the overview answers", () => {
    expect(gscSlot(readGsc(block), { gsc: false, serp: true, gsc_connect: false }))
      .toEqual({ mode: "unavailable", line: `${GSC_MISMATCH} ${GSC_CONNECT_UNAVAILABLE}` });
    expect(gscSlot(readGsc(block), null)).toEqual({ mode: "unknown", line: GSC_MISMATCH });
  });

  it("is its own dashboard notice unless the run measured clicks anyway", () => {
    expect(gscNotice(readGsc(block), { mode: "rank-tracking", impressions_28d: 0 })).toBe("mismatch");
    expect(gscNotice(readGsc(block), { mode: "search-console", impressions_28d: 500 })).toBe("measured");
  });
});

describe("a GEO-only caller's overview: no gsc block, no gsc_connected", () => {
  const geoOnly: SeoBrandCard = {
    brand: { id: "berry", name: "Berry Virtual", domain: "berry.com", gsc_property: "", seeds: [], enabled: true },
    headline: null,
    last_run: null,
  };

  it("reads every Search Console field as its default", () => {
    expect(readGsc(geoOnly.gsc, geoOnly.gsc_connected)).toEqual({
      connected: false, property: null, connected_by: null, connected_at: null,
      service_account_property: null, reading: false, mismatch: false,
    });
  });

  it("feeds the card chip, the action bar and the dashboard notice without a gap", () => {
    const g = readGsc(geoOnly.gsc, geoOnly.gsc_connected);
    expect(g.connected).toBe(false); // the card draws no "GSC ✓"
    expect(gscSlot(g, { gsc: false, serp: true })).toEqual({ mode: "unavailable", line: GSC_CONNECT_UNAVAILABLE });
    expect(gscSlot(g, { gsc: false, serp: true, gsc_connect: true })).toEqual({ mode: "connect", line: GSC_CONNECT_HINT });
    expect(gscNotice(g, { mode: "rank-tracking", impressions_28d: 0 })).toBe("off");
    expect(connectedLine(g)).toBeNull();
  });

  it("every screen reads the card through readGsc, never the fields directly", () => {
    const agent = readFileSync(join(__dirname, "SeoAgent.tsx"), "utf8");
    const dash = readFileSync(join(__dirname, "../../hub/work/seo/SeoDashboard.tsx"), "utf8");
    expect(agent).toContain("readGsc(gscCard, gsc_connected).connected");
    expect(dash).toContain("readGsc(card.gsc, card.gsc_connected)");
    for (const src of [agent, dash]) expect(src).not.toMatch(/card\.gsc\.|gscCard\.|gsc_connected &&/);
  });
});

/* ------------------------------------------------ round 2: D6, D7, D8 -- */

/** A backend whose overview replies arrive only when the test says so. */
function deferredOverviews() {
  const pending: ((body: unknown) => void)[] = [];
  const fetchMock = vi.fn((url: string) => new Promise<Response>((resolve) => {
    expect(String(url)).toContain("/api/seo-geo/overview");
    pending.push((body) => resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })));
  }));
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, reply: (i: number, body: unknown) => pending[i](body) };
}
const OV = (tag: string) => ({ sources: { gsc: false, serp: true }, brands: [], tag });
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("D6 — one overview read per page load", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("the workspace and the console share one request", async () => {
    const { fetchMock, reply } = deferredOverviews();
    const a = loadSeoOverview();
    const b = loadSeoOverview({ signal: new AbortController().signal });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    reply(0, OV("one"));
    expect(await a).toEqual(await b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("one caller giving up does not cancel the request for the others", async () => {
    const { fetchMock, reply } = deferredOverviews();
    const ctrl = new AbortController();
    const quitter = loadSeoOverview({ signal: ctrl.signal });
    const stayer = loadSeoOverview();
    ctrl.abort();
    const gaveUp = await quitter.catch((e: unknown) => e);
    expect(isAbortError(gaveUp)).toBe(true);
    reply(0, OV("kept"));
    expect(await stayer).toMatchObject({ tag: "kept" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // a caller that had already given up starts nothing
    const before = fetchMock.mock.calls.length;
    const dead = new AbortController();
    dead.abort();
    expect(isAbortError(await loadSeoOverview({ signal: dead.signal }).catch((e: unknown) => e))).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it("keeps nothing once a read settles — the next load reads again", async () => {
    const { fetchMock, reply } = deferredOverviews();
    const first = loadSeoOverview();
    reply(0, OV("first"));
    await first;
    await settle();
    const second = loadSeoOverview();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    reply(1, OV("second"));
    expect(await second).toMatchObject({ tag: "second" });
  });

  it("a fresh read after a write publishes, and an older reply never overwrites it", async () => {
    const { reply } = deferredOverviews();
    const heard: unknown[] = [];
    const off = onSeoOverview((o) => heard.push((o as unknown as { tag: string }).tag));
    const stale = loadSeoOverview();
    const fresh = loadSeoOverview({ fresh: true });
    reply(1, OV("fresh"));
    await fresh;
    reply(0, OV("stale"));
    await stale;
    await settle();
    expect(heard).toEqual(["fresh"]);
    off();
    const after = loadSeoOverview({ fresh: true });
    reply(2, OV("unheard"));
    await after;
    await settle();
    expect(heard).toEqual(["fresh"]);
  });

  it("a failed read reaches every caller, and the next call tries again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const [a, b] = [loadSeoOverview(), loadSeoOverview()];
    expect((await a.catch((e: unknown) => e)) instanceof ApiError).toBe(true);
    expect((await b.catch((e: unknown) => e)) instanceof ApiError).toBe(true);
    await settle();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(OV("ok")), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadSeoOverview()).toMatchObject({ tag: "ok" });
  });

  it("says a fixed sentence at once; only the brand name or domain waits for the overview", () => {
    expect(returnNeedsOverview({ connected: true, code: null })).toBe(true);
    expect(returnNeedsOverview({ connected: false, code: "gsc_no_property" })).toBe(true);
    for (const code of ["cancelled", "google_error", "gsc_state_expired", "gsc_property_taken", "unknown"]) {
      expect(returnNeedsOverview({ connected: false, code }), code).toBe(false);
    }
  });

  it("both screens read the overview through the shared loader", () => {
    const ws = readFileSync(join(__dirname, "../../hub/work/SeoWorkspace.tsx"), "utf8");
    const agent = readFileSync(join(__dirname, "SeoAgent.tsx"), "utf8");
    for (const src of [ws, agent]) expect(src).not.toMatch(/\bseoOverview\(/);
    expect(ws).toContain("loadSeoOverview({ signal: s, fresh })");
    expect(ws).toContain("onSeoOverview(");
    expect(ws).toContain("if (returnNeedsOverview(ret) && ov.phase === \"loading\") return;");
    expect(agent).toContain("loadSeoOverview({ signal: attempt.signal, fresh })");
    expect(agent).toContain("void refreshOverview(false);");
  });
});

describe("D7 — the header follows the brand open in the console", () => {
  const card = (id: string, name: string, domain: string): SeoBrandCard => ({
    brand: { id, name, domain, gsc_property: "", seeds: [], enabled: true }, headline: null, last_run: null,
  });
  const brands = [card("legalsoft", "Legal Soft", "legalsoft.com"), card("verify-seo-1014", "verify-seo-1014", "legalsoft.com")];

  it("names the brand on screen, or all brands for the list", () => {
    expect(consoleHeadline("verify-seo-1014", brands)).toBe("verify-seo-1014 · legalsoft.com");
    expect(consoleHeadline(null, brands)).toBe("all brands");
    expect(consoleHeadline("just-added", brands)).toBe("reading the brand");
  });

  it("opens a brand picked in the switcher only while the console is open", () => {
    const base = { prevSubject: "legalsoft", subject: "verify-seo-1014", prevSection: "console", section: "console", shown: "legalsoft" };
    expect(subjectOpensInConsole(base)).toBe(true);
    // the console itself just opened it (the address bar followed the console)
    expect(subjectOpensInConsole({ ...base, shown: "verify-seo-1014" })).toBe(false);
    // moving between sections opens nothing by itself
    expect(subjectOpensInConsole({ ...base, prevSection: "dashboard" })).toBe(false);
    expect(subjectOpensInConsole({ ...base, section: "dashboard" })).toBe(false);
    expect(subjectOpensInConsole({ ...base, subject: "legalsoft" })).toBe(false);
    expect(subjectOpensInConsole({ ...base, subject: "" })).toBe(false);
  });

  it("the console reports what it opens, and the workspace follows it", () => {
    const agent = readFileSync(join(__dirname, "SeoAgent.tsx"), "utf8");
    const ws = readFileSync(join(__dirname, "../../hub/work/SeoWorkspace.tsx"), "utf8");
    expect(agent).toMatch(/setOpening\(id\);\s*onBrandChange\?\.\(id\);/);
    expect(agent).toMatch(/function closeBrand\(\) \{\s*setBrand\(null\);\s*setRun\(null\);\s*onBrandChange\?\.\(null\);/);
    expect(agent).not.toContain("setBrand(null), setRun(null)");
    expect(ws).toContain("onBrandChange={onBrandChange}");
    expect(ws).toContain('if (id && id !== subjectRef.current) openWork("seo", id, "console");');
    expect(ws).toMatch(/useHeadline\(sec === "console"\s*\? consoleHeadline\(shown, brands\)/);
  });
});

describe("D8 — Google Analytics on Integrations", () => {
  it("is a calm row that says how access works", () => {
    expect(GA_INTEGRATION).toEqual({
      name: "Google Analytics",
      what: "Read through our service account; a GA admin adds it as a Viewer on each property.",
      usedBy: "SEO Analyst",
    });
  });

  it("has no button and no Connected / Not connected claim", () => {
    const src = readFileSync(join(__dirname, "../../hub/panels/IntegrationsView.tsx"), "utf8");
    const row = src.slice(src.indexOf('key: "ga"'), src.indexOf('key: "serp"'));
    expect(row).toContain('status: "info"');
    expect(row).not.toContain("open:");
    // info rows are neither counted as connected nor as not
    expect(src).toContain('const on = hooks.filter((h) => h.status === "on");');
    expect(src).toContain('const off = hooks.filter((h) => h.status === "off");');
    expect(src).toContain('info: { label: "Admin grants access", cls: "" }');
  });
});

/* ------------------------------- round-2 backend contract (b17d136) -- */

/** Every <button> in a rendered tree, function components expanded — so a
 *  test can press one without a DOM. */
type El = { type: unknown; props?: { children?: unknown; onClick?: () => void } };
function buttonsIn(node: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(buttonsIn);
  if (!node || typeof node !== "object") return [];
  const el = node as El;
  if (typeof el.type === "function") return buttonsIn((el.type as (p: unknown) => unknown)(el.props));
  return [...(el.type === "button" ? [el] : []), ...buttonsIn(el.props?.children)];
}
const textOf = (b: El): string => {
  const c = b.props?.children;
  return Array.isArray(c) ? c.join("") : String(c ?? "");
};

const todo = (id: string, over: Partial<SeoTodo> = {}): SeoTodo => ({
  id, kind: "site", page: "", query: "", action: `Action ${id}`, why: `Why ${id}`,
  est_monthly_clicks: null, position: 0, impressions: null, status: "todo", ...over,
});
const TODOS = [todo("t1"), todo("t2"), todo("t3"), todo("pa-links", { origin: "page-advice", category: "internal-links" })];

describe("This week: one move, one place", () => {
  const item = (over: Partial<SeoPlanItem>): SeoPlanItem => ({
    source: "fix list", action: "Refresh the page targeting 'law firm intake services'",
    detail: "It sits at position 14 with 2,300 impressions", ...over,
  });

  it("points at the Fix-list item and repeats none of its text", () => {
    const p = item({ label: "Refresh: “law firm intake services”", ref_todo_id: "t2", ref_index: 2 });
    expect(planItemView(p, TODOS)).toEqual({ kind: "fix", index: 2, todoId: "t2", label: "Refresh: “law firm intake services”" });
    const out = html(createElement(PlanStrip, { plan: [p], todos: TODOS }));
    expect(out).toContain("See Fix list #2");
    expect(out).toContain("· Refresh: “law firm intake services”");
    expect(out).not.toContain("Refresh the page targeting");
    expect(out).not.toContain("It sits at position 14");
  });

  it("the link opens that item", () => {
    const seen: string[] = [];
    const p = item({ label: "Refresh it", ref_todo_id: "t3", ref_index: 3 });
    const [link] = buttonsIn(PlanStrip({ plan: [p], todos: TODOS, onSeeFix: (id) => seen.push(id) }));
    expect(textOf(link)).toBe("See Fix list #3");
    link.props?.onClick?.();
    expect(seen).toEqual(["t3"]);
  });

  it("finds the item by id first, then by position, and numbers it where it is now", () => {
    expect(planItemView(item({ label: "x", ref_todo_id: "t3", ref_index: 1 }), TODOS)).toMatchObject({ kind: "fix", index: 3, todoId: "t3" });
    expect(planItemView(item({ label: "x", ref_todo_id: "gone", ref_index: 2 }), TODOS)).toMatchObject({ kind: "fix", index: 2, todoId: "t2" });
    // neither the id nor the position is on this list: a plain move
    expect(planItemView(item({ label: "x", ref_todo_id: "gone", ref_index: 40 }), TODOS)).toEqual({ kind: "move", title: "x", detail: "It sits at position 14 with 2,300 impressions" });
  });

  it("shows a keyword or audit move as its label and detail", () => {
    const p = item({ source: "keywords", action: "Go after “virtual paralegal services”", label: "Go after “virtual paralegal services”", ref_todo_id: null, ref_index: null });
    const out = html(createElement(PlanStrip, { plan: [p], todos: TODOS }));
    expect(out).not.toContain("See Fix list");
    expect(out).toContain("Go after “virtual paralegal services”");
    expect(out).toContain("It sits at position 14");
  });

  it("renders an older backend's plan (no label, no refs) as before", () => {
    const p = { source: "fix list", action: "Old action text", detail: "Old detail" } as SeoPlanItem;
    expect(planItemView(p, TODOS)).toEqual({ kind: "move", title: "Old action text", detail: "Old detail" });
    const out = html(createElement(PlanStrip, { plan: [p] }));
    expect(out).toContain("Old action text");
    expect(out).toContain("Old detail");
  });

  it("the console opens the Fix list at the item", () => {
    const agent = readFileSync(join(__dirname, "SeoAgent.tsx"), "utf8");
    expect(agent).toContain("<PlanStrip plan={plan} todos={run?.todos ?? []} onSeeFix={seeFix} />");
    expect(agent).toMatch(/open=\{fixOpen\} onToggle=\{setFixOpen\}/);
    expect(agent).toContain("id={`seo-fix-${t.id}`} tabIndex={-1}");
    expect(agent).toMatch(/if \(at >= 10\) setShowAllTodos\(true\);/);
    expect(agent).toContain('el?.scrollIntoView({ behavior: "smooth", block: "center" });');
  });
});

const topic = (over: Partial<SeoTopic> = {}): SeoTopic => ({
  keyword: "virtual paralegal services", source: "seed", priority: "high", impact: "≈ 40 clicks/mo at position 5",
  angle: "service page", volume_est: 900, volume_label: "~900/mo (our impressions)", trend: "rising",
  difficulty: "medium", est_monthly_clicks: 40, why: "You listed this as a seed keyword", score: 0.8, ...over,
});

describe("topics: also on the Fix list, refresh instead, empty impact, angles", () => {
  it("says 'also on your Fix list' once — in the why, with no second chip", () => {
    const out = html(createElement(TopicRow, {
      t: topic({ also_in_fix: 3, why: "You listed this as a seed keyword · Also on your Fix list as #3" }), index: 1,
    }));
    expect(out.split("Fix list").length - 1).toBe(1);
  });

  it("links the page to refresh instead, and only a web address", () => {
    const out = html(createElement(TopicRow, { t: topic({ refresh_url: "https://legalsoft.com/virtual-paralegal" }), index: 1 }));
    expect(out).toContain('href="https://legalsoft.com/virtual-paralegal"');
    expect(out).toContain("Refresh this page instead");
    expect(html(createElement(TopicRow, { t: topic({ refresh_url: "javascript:alert(1)" }), index: 1 }))).not.toContain("Refresh this page instead");
    expect(refreshHref(null)).toBeNull();
  });

  it("draws no impact line for an empty impact", () => {
    expect(html(createElement(TopicRow, { t: topic({ impact: "" }), index: 1 }))).not.toContain("seo-topic__impact");
    expect(html(createElement(TopicRow, { t: topic(), index: 1 }))).toContain("≈ 40 clicks/mo at position 5");
  });

  it("names the new angles, and anything else as it came", () => {
    expect(topicAngle("service page")).toBe("Service page");
    expect(topicAngle("pricing explainer")).toBe("Pricing explainer");
    expect(topicAngle("how-to guide")).toBe("How-to guide");
    expect(topicAngle("pricing guide")).toBe("pricing guide");
    expect(topicAngle("")).toBeNull();
    expect(topicAngle(undefined)).toBeNull();
  });

  it("renders a topic from before the round-2 fields", () => {
    const old = topic({ angle: "An honest cost table both sides would sign.", source: "new idea" });
    delete (old as Partial<SeoTopic>).also_in_fix;
    delete (old as Partial<SeoTopic>).refresh_url;
    const out = html(createElement(TopicRow, { t: old, index: 2 }));
    expect(out).toContain("AI idea");
    expect(out).toContain("An honest cost table both sides would sign.");
    expect(out).not.toContain("Refresh this page instead");
    // and the console draws its topics through this row
    expect(readFileSync(join(__dirname, "SeoAgent.tsx"), "utf8")).toContain("<TopicRow key={t.keyword} t={t} index={i + 1} focused={topicFocus === i + 1} />");
  });
});

describe("Fix list: fixes that span pages, page-advice items", () => {
  it("lists the pages behind 'On N pages'", () => {
    expect(todoPages(["/pricing", "https://legalsoft.com/contact"])).toEqual({
      label: "On 2 pages",
      items: [{ text: "/pricing", href: null }, { text: "/contact", href: "https://legalsoft.com/contact" }],
    });
    const out = html(createElement(TodoPages, { pages: ["/a", "/b", "/c"] }));
    expect(out).toContain("<details");
    expect(out).toContain("<summary>On 3 pages</summary>");
  });

  it("draws nothing for an older to-do with no pages", () => {
    expect(todoPages(undefined)).toBeNull();
    expect(todoPages([])).toBeNull();
    expect(html(createElement(TodoPages, { pages: undefined }))).toBe("");
  });

  it("names the categories, page-advice ones included", () => {
    expect(todoCategoryLabel("internal-links")).toBe("Internal links");
    expect(todoCategoryLabel("cta")).toBe("Call to action");
    expect(todoCategoryLabel("trust")).toBe("Trust");
    expect(todoCategoryLabel("site-speed")).toBe("Site speed");
    expect(todoCategoryLabel(undefined)).toBeNull();
    const agent = readFileSync(join(__dirname, "SeoAgent.tsx"), "utf8");
    expect(agent).toContain("<TodoPages pages={t.pages} />");
    expect(agent).toContain('<span className="seo-chip seo-chip--src">{todoCategoryLabel(t.category)}</span>');
  });
});

describe("site review: contradicted and uncheckable drops", () => {
  const drop = (reason: string) => ({ reason, insight: `Finding ${reason}`, detail: "" });

  it("keeps the headline true for whatever was dropped", () => {
    expect(reviewDropped({ dropped: [drop("contradicted-by-page"), drop("contradicted-by-page")] })?.line)
      .toBe("2 findings dropped — your pages already have what they said was missing");
    expect(reviewDropped({ dropped: [drop("unverifiable-absence")] })?.line)
      .toBe("1 finding dropped — they couldn't be checked against your pages");
    expect(reviewDropped({ dropped: [drop("contradicted-by-page"), drop("unverifiable-absence")] })?.line)
      .toBe("2 findings dropped — your pages contradicted them or they couldn't be checked");
    expect(reviewDropped({ dropped: [drop("no-evidence-url"), drop("contradicted-by-page")] })?.line)
      .toBe("2 findings dropped — not supported by your pages");
    expect(reviewDropped({ dropped: [drop("no-evidence-url"), drop("invented-number")] })?.line)
      .toBe("2 findings dropped — no evidence on your pages");
    expect(reviewDropped({ dropped: [drop("contradicted-by-page"), drop("duplicate")] })?.line)
      .toBe("2 findings dropped by the evidence check");
  });

  it("says why each one went, in words", () => {
    expect(reviewDropped({ dropped: [drop("contradicted-by-page"), drop("unverifiable-absence")] })?.items.map((i) => i.reason))
      .toEqual(["your page already has it", "couldn't be checked against the page"]);
  });
});

describe("pages: hidden versus moved to the Fix list", () => {
  const g = (reasons: string[]) => ({ kept: 4, dropped: reasons.map((reason, i) => ({ path: `/p${i}`, reason, recommendation: "x", detail: "y" })) });

  it("counts moved advice apart from hidden advice", () => {
    expect(hiddenSuggestionsLine(g(["repeats-flags", "suggestion-too-long", "moved-to-fix-list", "moved-to-fix-list", "moved-to-fix-list"])))
      .toBe("2 suggestions hidden (repeated the flags or didn't fit) · 3 moved to your Fix list");
    expect(hiddenSuggestionsLine(g(["moved-to-fix-list"]))).toBe("1 suggestion moved to your Fix list");
    expect(hiddenSuggestionsLine(g(["suggestion-too-long"]))).toBe("1 suggestion hidden because it repeated the flags or didn't fit the page.");
  });

  it("links each moved category to its Fix-list item", () => {
    const fixItems = [
      { category: "internal-links", paths: ["/a", "/b", "/c", "/d", "/e"], todo_id: null },
      { category: "cta", paths: ["/x", "/y", "/z"], todo_id: "t1" },
      { category: "cta", paths: [], todo_id: "t1" },
    ];
    expect(movedFixLinks(fixItems, TODOS)).toEqual([
      { label: "Internal links on 5 pages", todoId: "pa-links" },
      { label: "Call to action on 3 pages", todoId: "t1" },
    ]);
    // a page pass newer than the run: the item is not on this list, so no link
    expect(movedFixLinks([{ category: "cta", paths: ["/x"], todo_id: "elsewhere" }], [])).toEqual([{ label: "Call to action on 1 page", todoId: null }]);
    expect(movedFixLinks(undefined, TODOS)).toEqual([]);

    const seen: string[] = [];
    const node = HiddenSuggestions({ grounding: g(["moved-to-fix-list"]), fixItems, todos: TODOS, onSeeFix: (id) => seen.push(id) });
    const links = buttonsIn(node);
    expect(links.map(textOf)).toEqual(["Internal links on 5 pages", "Call to action on 3 pages"]);
    links[0].props?.onClick?.();
    expect(seen).toEqual(["pa-links"]);
  });

  it("renders an older pages doc (no fix_items, no moves) as before", () => {
    expect(html(createElement(HiddenSuggestions, { grounding: g(["repeats-flags"]) })))
      .toBe('<p class="seo-lab__meta">1 suggestion hidden because it repeated the flags or didn&#x27;t fit the page.</p>');
  });
});

describe("audit: schema-fit reason once, pages as a list", () => {
  const fit = (over: Partial<SeoAuditIssue>): SeoAuditIssue => ({
    issue: "3 pages lack FAQPage schema", severity: "low", count: 3, fix: "Add FAQPage markup.",
    pages: ["https://legalsoft.com/a", "https://legalsoft.com/b", "https://legalsoft.com/c"],
    kind: "schema-fit", schema_type: "FAQPage", ...over,
  });

  it("states the finding's reason once and lists the pages", () => {
    const issue = fit({
      reason: "Visible question-and-answer pairs and no FAQPage markup.",
      evidence: [
        { page: "https://legalsoft.com/a", pairs: 4 },
        { page: "https://legalsoft.com/b", pairs: 3 },
        { page: "https://legalsoft.com/c", reason: "Q&A pairs in an accordion", pairs: 5 },
      ],
    });
    expect(auditEvidence(issue)).toEqual({
      label: "Why FAQPage fits",
      note: "Visible question-and-answer pairs and no FAQPage markup.",
      lines: [
        "https://legalsoft.com/a (4 Q&A pairs)",
        "https://legalsoft.com/b (3 Q&A pairs)",
        "https://legalsoft.com/c (5 Q&A pairs) — Q&A pairs in an accordion",
      ],
      coversPages: true,
    });
    const out = html(createElement(AuditIssueRow, { issue }));
    expect(out.split("Visible question-and-answer pairs and no FAQPage markup.").length - 1).toBe(1);
  });

  it("reads an older report with a reason on every page and none on the finding", () => {
    const ev = auditEvidence(fit({ evidence: [{ page: "https://legalsoft.com/a", reason: "service page" }] }));
    expect(ev?.note).toBeNull();
    expect(ev?.lines).toEqual(["https://legalsoft.com/a — service page"]);
  });
});

describe("coded 503s from the SEO routes", () => {
  it("show their message, as written for the reader", () => {
    const message = "The site review didn't finish — run it again in a minute.";
    expect(plainFailure(new ApiError(message, 503, { detail: { code: "site_review_failed", message } }), "Site analysis failed")).toBe(message);
  });
});

/* ------------------------------------------- round 3 (production fixes) -- */

describe("the analytics story calls each figure what it is", () => {
  const ga = {
    totals: { sessions: 21275, users: 17204, new_users: 15000, engagement_rate: 0.5, avg_session_sec: 60, pageviews: 40000 },
    prev_totals: { sessions: 27000, users: 22000, new_users: 19000, engagement_rate: 0.5, avg_session_sec: 60, pageviews: 50000 },
    key_events: [{ event: "generate_lead", count: 918 }],
    channels: [
      { channel: "Direct", sessions: 9000, prev_sessions: 8000 },
      { channel: "Organic Search", sessions: 7258, prev_sessions: 9000 },
    ],
  };

  it("counts people as GA's users — the Visitors figure — never sessions", () => {
    const st = gaStory(ga);
    expect(st).toMatchObject({ count: 17204, unit: "people", leads: 918, google: { visits: 7258, rank: 2 } });
    expect(st.trend).toBe("down 22% vs the month before"); // 17,204 against 22,000
  });

  it("falls back to visits, said as visits, for a payload without users", () => {
    const old = { ...ga, totals: { ...ga.totals, users: undefined as unknown as number }, prev_totals: { ...ga.prev_totals, users: undefined as unknown as number } };
    expect(gaStory(old)).toMatchObject({ count: 21275, unit: "visits" });
  });

  it("the console's story says people for users and visits for Google's sessions", () => {
    const agent = readFileSync(join(__dirname, "SeoAgent.tsx"), "utf8");
    expect(agent).toContain("const st = gaStory(ga);");
    expect(agent).toContain("Google search brought <strong>{fmt(st.google.visits)}</strong> visits");
    expect(agent).not.toContain("{fmt(ga.totals.sessions)} people");
    expect(agent).not.toMatch(/\bof them\b/);
  });
});

describe("a removed brand leaves the list at once", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("publishes the smaller list to every subscriber, and retires an older read", async () => {
    const { reply } = deferredOverviews();
    const heard: string[] = [];
    const off = onSeoOverview((o) => heard.push((o as unknown as { tag: string }).tag));
    const older = loadSeoOverview(); // in flight from before the delete
    publishSeoOverview(OV("without-the-brand") as unknown as Parameters<typeof publishSeoOverview>[0]);
    reply(0, OV("with-the-brand"));
    await older;
    await settle();
    expect(heard).toEqual(["without-the-brand"]);
    off();
  });

  it("the console removes it from its own list and the workspace's on a successful delete", () => {
    const agent = readFileSync(join(__dirname, "SeoAgent.tsx"), "utf8");
    expect(agent).toMatch(/await seoDeleteBrand\(b\.id\);[\s\S]{0,400}overview\.brands\.filter\(\(c\) => c\.brand\.id !== b\.id\)[\s\S]{0,120}publishSeoOverview\(next\);[\s\S]{0,40}await refreshOverview\(\);/);
  });
});

describe("audit findings say when they list only some of their pages", () => {
  const many = (over: Partial<SeoAuditIssue> = {}): SeoAuditIssue => ({
    issue: "Missing meta description", severity: "medium", count: 25, fix: "Write one.",
    pages: Array.from({ length: 15 }, (_, i) => `https://legalsoft.com/p${i}`), ...over,
  });

  it("adds '+N more' when the count is larger than the list", () => {
    expect(morePagesLine(many())).toBe("+10 more");
    expect(html(createElement(AuditIssueRow, { issue: many() }))).toContain("+10 more");
  });

  it("says nothing when every page is listed", () => {
    expect(morePagesLine(many({ count: 15 }))).toBeNull();
    expect(html(createElement(AuditIssueRow, { issue: many({ count: 15 }) }))).not.toContain("more</div>");
  });

  it("still counts the rest under per-page evidence", () => {
    const fitIssue = many({
      kind: "schema-fit", schema_type: "Service", reason: "Service page with no Service markup.",
      evidence: Array.from({ length: 15 }, (_, i) => ({ page: `https://legalsoft.com/p${i}` })),
    });
    expect(html(createElement(AuditIssueRow, { issue: fitIssue }))).toContain("+10 more");
  });
});

describe("site-review gaps point at the blog plan instead of repeating it", () => {
  it("reads strings as before, and objects with their plan position", () => {
    expect(missingTopics(["remote legal staff security"])).toEqual([{ text: "remote legal staff security", inPlan: null }]);
    expect(missingTopics([{ topic: "virtual legal assistant cost comparison", in_blog_plan: 3 }]))
      .toEqual([{ text: "virtual legal assistant cost comparison", inPlan: 3 }]);
    expect(missingTopics([{ text: "onboarding guide", in_blog_plan: null }])).toEqual([{ text: "onboarding guide", inPlan: null }]);
    expect(missingTopics([{ in_blog_plan: 2 }, "", 7 as never, null as never])).toEqual([]);
    expect(missingTopics(undefined)).toEqual([]);
  });

  it("links 'In your blog plan as #n' to that topic", () => {
    const seen: number[] = [];
    const node = MissingTopics({
      list: ["security protocols", { topic: "cost comparison", in_blog_plan: 3 }], planSize: 10, onSeeTopic: (n) => seen.push(n),
    });
    const [link] = buttonsIn(node);
    expect(textOf(link)).toBe("In your blog plan as #3");
    link.props?.onClick?.();
    expect(seen).toEqual([3]);
    const out = html(createElement(MissingTopics, { list: ["security protocols", { topic: "cost comparison", in_blog_plan: 3 }], planSize: 10 }));
    expect(out).toContain("security protocols");
    expect(out).toContain("cost comparison · <button");
  });

  it("never points at a place the plan on screen does not have", () => {
    const out = html(createElement(MissingTopics, { list: [{ topic: "cost comparison", in_blog_plan: 12 }], planSize: 10 }));
    expect(out).not.toContain("In your blog plan");
    expect(out).toContain("cost comparison");
  });

  it("the console opens the Blog plan at that topic", () => {
    const agent = readFileSync(join(__dirname, "SeoAgent.tsx"), "utf8");
    expect(agent).toContain("onSeeTopic={seeTopic}");
    expect(agent).toContain("open={planOpen} onToggle={setPlanOpen}");
    expect(agent).toContain("focused={topicFocus === i + 1}");
    expect(html(createElement(TopicRow, { t: topic(), index: 4 }))).toContain('id="seo-topic-4"');
  });
});

describe("a typed seed we already rank top 3 for", () => {
  it("says 'we rank #n' instead of a red 'hard', from either field", () => {
    expect(topicDifficulty({ difficulty: "hard", difficulty_label: "we rank #2" })).toEqual({ label: "we rank #2", tone: "rank" });
    expect(topicDifficulty({ difficulty: "hard", own_rank: 1 })).toEqual({ label: "we rank #1", tone: "rank" });
    const out = html(createElement(TopicRow, { t: topic({ difficulty: "hard", difficulty_label: "we rank #2" }), index: 1 }));
    expect(out).toContain('<span class="seo-chip seo-chip--on">we rank #2</span>');
    expect(out).not.toContain("seo-chip--diff-hard");
  });

  it("keeps the difficulty as before without them, or outside the top 3", () => {
    expect(topicDifficulty({ difficulty: "hard" })).toEqual({ label: "hard", tone: "hard" });
    expect(topicDifficulty({ difficulty: "hard", own_rank: 7 })).toEqual({ label: "hard", tone: "hard" });
    expect(topicDifficulty({ difficulty: "easy win", difficulty_label: "" })).toEqual({ label: "easy win", tone: "easy" });
    expect(topicDifficulty({ difficulty: null })).toEqual({ label: "—", tone: "none" });
  });
});

describe("the Search Console note is said once, at the top", () => {
  it("drops from the Pages tab what the brand screen already said", () => {
    const said = plainNotes(["Search Console: rejected"], CTX);
    expect(plainNotesExcept(["Search Console: rejected", "Google Analytics: no property"], CTX, said))
      .toEqual([`Google Analytics isn't connected for berry.com. ${GA_SERVICE_ACCOUNT}`]);
    expect(plainNotesExcept(["Search Console: rejected"], CTX, [])).toEqual(said);
  });

  it("the Pages tab is handed the run's notes", () => {
    const agent = readFileSync(join(__dirname, "SeoAgent.tsx"), "utf8");
    expect(agent).toContain("saidAbove={run ? plainNotes(run.degraded, noteCtx) : []}");
    expect(agent).toContain("<DegradedNotes notes={doc.notes} ctx={noteCtx} except={saidAbove} />");
  });
});

/* ------------------------------ final field names (backend 289d864) -- */

describe("missing topics: the detail list carries the pointer", () => {
  it("reads missing_topics_detail as the backend sends it", () => {
    const detail = [
      { topic: "virtual legal assistant cost comparison", in_blog_plan: 3 },
      { topic: "remote legal staff security protocols", in_blog_plan: null },
    ];
    expect(missingTopics(detail)).toEqual([
      { text: "virtual legal assistant cost comparison", inPlan: 3 },
      { text: "remote legal staff security protocols", inPlan: null },
    ]);
    const out = html(createElement(MissingTopics, { list: detail, planSize: 10 }));
    expect(out).toContain("In your blog plan as #3");
    expect(out.split("In your blog plan").length - 1).toBe(1);
  });

  it("falls back to the plain strings of an older backend, with no pointer", () => {
    const review = { missing_topics: ["cost comparison", "security protocols"] } as { missing_topics: string[]; missing_topics_detail?: null };
    const out = html(createElement(MissingTopics, { list: review.missing_topics_detail ?? review.missing_topics, planSize: 10 }));
    expect(out).toContain("cost comparison");
    expect(out).not.toContain("In your blog plan");
  });

  it("the console prefers the detail and falls back to the strings", () => {
    const agent = readFileSync(join(__dirname, "SeoAgent.tsx"), "utf8");
    expect(agent).toContain("<MissingTopics list={siteReview.missing_topics_detail ?? siteReview.missing_topics} onSeeTopic={seeTopic}");
  });
});

describe("an invented-number drop says what the reader can check", () => {
  const drop = (over: Record<string, unknown>) => ({ reason: "invented-number", insight: "Pricing page lists no tiers", detail: "x", ...over });
  const why = (d: Record<string, unknown>) => reviewDropped({ dropped: [drop(d)] as never })?.items[0].reason;

  it("names the figures the finding itself cited", () => {
    expect(why({ field: "insight", numbers: ["30%", "$4,000"] })).toBe("it cited 30% and $4,000 — not on the page");
    expect(why({ field: "insight", numbers: ["1100", "1700", "28"] })).toBe("it cited 1100, 1700 and 28 — not on the page");
  });

  it("says when only the evidence behind it cited them", () => {
    expect(why({ field: "evidence", numbers: ["920"], evidence: "https://legalsoft.com/bookkeeper (920w) — …" }))
      .toBe("the evidence behind it cites 920, not in the page's data");
  });

  it("keeps the general wording for an older review, or one without figures", () => {
    expect(why({})).toBe("it cited a number that isn't on the page");
    expect(why({ field: "insight", numbers: [] })).toBe("it cited a number that isn't on the page");
    expect(why({ field: "elsewhere", numbers: ["5"] })).toBe("it cited a number that isn't on the page");
    // other reasons are untouched by the new fields
    expect(reviewDropped({ dropped: [{ reason: "duplicate", insight: "x", detail: "y", field: "insight", numbers: ["1"] }] })?.items[0].reason)
      .toBe("it repeated another finding");
  });
});
