import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SeoAuditIssue, SeoPageIntel, SeoTopic } from "@/lib/api";
import {
  API_URL, ApiError, apiCode, RequestTimeoutError, seoBrandDetail, seoOauthComplete, seoOauthDisconnect, seoOauthStart,
  seoPages, seoPagesRefresh, seoSetTodoStatus,
} from "../../../lib/api";
import { describeFailure } from "../../../lib/load";
import {
  auditEvidence, auditTone, briefSchema, canConnectGsc, connectedLine, finishGoogleReturn, flagChip,
  GA_SERVICE_ACCOUNT, GSC_CANCELLED, GSC_CONNECT_HINT, GSC_CONNECT_UNAVAILABLE, GSC_UNFINISHED, gscFailure, gscIntegration,
  gscNotice, gscReturnPath, gscSlot, gscStateBrand, googleReturn, hiddenSuggestionsLine, looksRaw,
  NO_GSC_RETURN, notShownLine, pageRec, planHeading, plainFailure, plainMessage, plainNote, plainNotes, PLAIN_TOPIC_NOTES, readGsc,
  readGscReturn, reviewDropped, todoPage, topicOrigin, type GoogleReturnIO, type NoteContext,
} from "./seo";
import { AuditIssueRow, BriefSchema, HiddenSuggestions, PageRow, PlanStrip, ReviewDropped } from "./rows";

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
    expect(agent).toContain("<PlanStrip plan={plan} />");
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

  it("will not toast markup someone put in the return link", () => {
    expect(plainMessage("<img src=x onerror=alert(1)>", GSC_UNFINISHED)).toBe(GSC_UNFINISHED);
    const why = "Google didn't grant read access to Search Console — connect again and allow it.";
    expect(plainMessage(readGscReturn(gscReturnPath("b", { error: why }).slice(1)).error, GSC_UNFINISHED)).toBe(why);
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
    expect(dash.match(/onOpenConsole\(brandId\)/g)).toHaveLength(3);
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
