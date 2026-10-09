import { describe, expect, it } from "vitest";
import { until } from "./format";
import type { Ask, HumansDay, HumansMonth, TeamReportee } from "@/lib/api";
import {
  STATUS_ACTION, askEmail, askLines, askTitle, askWho, filterAsks, kindLabel, nextStatuses, replaceAsk,
} from "./asks";
import {
  TREND_ID, agentChips, boardTabs, dayName, dayShort, dayWithWeekday, deltaFigure, hasExtras, hasTrend,
  monthLabel, monthShort, monthsNewestFirst, perDay, pickTab, rowState, summaryNote, teamSummary,
  trailingAverage, trendSeries, usersByRuns, weekOverWeek, weekSentence, windowNote, yTicks,
} from "./teamUsage";
import {
  GEO_AGENT_ID, LIVE_AGENTS, PANELS,
  agentsFor, canOpen, canOpenAgent, canOpenWorkspace, panelsFor, routeFromHash,
  type PanelId, type Viewer,
 } from "./model";

/* `until` mirrors `ago`, and like it takes an explicit `now` so a test never
 * depends on the machine's clock. */

const NOW = new Date("2026-09-01T10:00:00Z");
const plus = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

describe("until", () => {
  it("counts minutes", () => {
    expect(until(plus(3 * 60_000), NOW)).toBe("in 3 minutes");
    expect(until(plus(60_000), NOW)).toBe("in 1 minute");
  });

  it("counts hours", () => {
    expect(until(plus(6 * 3_600_000), NOW)).toBe("in 6 hours");
    expect(until(plus(3_600_000), NOW)).toBe("in 1 hour");
  });

  it("counts days", () => {
    expect(until(plus(2 * 86_400_000), NOW)).toBe("in 2 days");
    expect(until(plus(86_400_000), NOW)).toBe("in 1 day");
  });

  it("says a past or present time is due, not broken", () => {
    expect(until(plus(0), NOW)).toBe("any moment now");
    expect(until(plus(-3_600_000), NOW)).toBe("any moment now");
    expect(until(plus(30_000), NOW)).toBe("any moment now");
  });

  it("names the date once it is too far away to count", () => {
    expect(until(plus(45 * 86_400_000), NOW)).toBe("on October 16");
  });

  it("says nothing about a timestamp it cannot parse", () => {
    expect(until("not a date", NOW)).toBe("");
  });
});

/* ----------------------------------------------------------- scope wall -- */

/* The backend serves a GEO-only account sign-in, the shell's four reads, the
 * SEO/GEO overview and all 25 `/api/geo/*` routes, and refuses the other 143
 * with a 403. These are the console's half of that contract: every rail entry,
 * workspace and hash it will still offer such a reader, and — just as
 * load-bearing — that nobody else's view moved a pixel.
 *
 * `panelIds(viewer)` is the whole rail, so a panel added without deciding its
 * `inGeoScope` shows up here as a failure rather than as a 403 in production.
 */

const MEMBER: Viewer = {};
const ADMIN: Viewer = { is_admin: true };
const CREATOR: Viewer = { is_admin: true, is_creator: true };
const SCOPED: Viewer = { is_geo_only: true };
/* A session stored before the wall shipped carries no field at all. */
const STORED_BEFORE: Viewer = { is_admin: false, is_creator: false };

const panelIds = (v: Viewer): PanelId[] => panelsFor(v).map((p) => p.id);
const panel = (id: PanelId) => PANELS.find((p) => p.id === id)!;

describe("the rail a GEO-only account is offered", () => {
  it("is exactly the panels whose every read the backend still answers", () => {
    // Issues and Runs left this rail on 2026-10-08: both are the admin's now,
    // and /api/issues refuses a non-admin outright.
    expect(panelIds(SCOPED)).toEqual(["home", "agents", "settings"]);
  });

  it("keeps Agents, because it is the only way into the GEO workspace", () => {
    expect(canOpen(panel("agents"), SCOPED)).toBe(true);
  });

  it("drops Library, whose brand-kit read is an /api/gd route", () => {
    expect(canOpen(panel("library"), SCOPED)).toBe(false);
  });

  it("drops Integrations, whose connector read is an /api/mr route", () => {
    expect(canOpen(panel("integrations"), SCOPED)).toBe(false);
  });

  it("drops Models, Schedule and Admin", () => {
    expect(canOpen(panel("models"), SCOPED)).toBe(false);
    expect(canOpen(panel("schedule"), SCOPED)).toBe(false);
    expect(canOpen(panel("admin"), SCOPED)).toBe(false);
  });

  it("keeps Settings, which reads nothing from the backend at all", () => {
    expect(canOpen(panel("settings"), SCOPED)).toBe(true);
  });

  it("refuses a scoped account even when it also carries a role", () => {
    // The wall is the backend's decision; a role cannot argue with a 403.
    expect(canOpen(panel("admin"), { is_geo_only: true, is_admin: true })).toBe(false);
    expect(canOpen(panel("models"), { is_geo_only: true, is_creator: true })).toBe(false);
  });
});

describe("what the scope wall leaves untouched", () => {
  it("shows a member Home, the specialists and Settings — the 2026-10-08 decision", () => {
    expect(panelIds(MEMBER)).toEqual(["home", "agents", "settings"]);
  });

  it("shows an admin and a creator what they saw before", () => {
    expect(panelIds(ADMIN)).toEqual([
      "home", "issues", "agents", "runs", "library", "integrations", "settings", "admin",
    ]);
    expect(panelIds(CREATOR)).toEqual([
      "home", "issues", "agents", "runs", "library", "models", "integrations",
      "schedule", "settings", "admin",
    ]);
  });

  it("treats a session stored before the wall exactly as a member", () => {
    expect(panelIds(STORED_BEFORE)).toEqual(panelIds(MEMBER));
    expect(agentsFor(STORED_BEFORE)).toEqual(LIVE_AGENTS);
  });

  it("leaves every specialist open to everyone who is not scoped", () => {
    for (const v of [MEMBER, ADMIN, CREATOR, STORED_BEFORE]) {
      expect(agentsFor(v)).toEqual(LIVE_AGENTS);
      expect(canOpenWorkspace("mr", v)).toBe(true);
      expect(canOpenWorkspace("art", v)).toBe(true);
    }
  });
});

describe("the specialists a GEO-only account is offered", () => {
  it("is GEO and nothing else", () => {
    expect(agentsFor(SCOPED).map((a) => a.id)).toEqual([GEO_AGENT_ID]);
  });

  it("refuses the four workspaces whose first read 403s", () => {
    expect(canOpenWorkspace("seo", SCOPED)).toBe(false);
    expect(canOpenWorkspace("mr", SCOPED)).toBe(false);
    expect(canOpenWorkspace("blog", SCOPED)).toBe(false);
    expect(canOpenWorkspace("art", SCOPED)).toBe(false);
  });

  it("allows the GEO workspace", () => {
    expect(canOpenWorkspace("geo", SCOPED)).toBe(true);
    expect(canOpenAgent(GEO_AGENT_ID, SCOPED)).toBe(true);
  });

  it("refuses a slug that names no specialist, for anybody", () => {
    expect(canOpenWorkspace("nope", SCOPED)).toBe(false);
    expect(canOpenWorkspace("nope", CREATOR)).toBe(false);
  });
});

describe("routeFromHash under the scope wall", () => {
  it("sends a bookmarked MR workspace home rather than into a 403", () => {
    expect(routeFromHash("#/w/mr/workspace/desk", SCOPED)).toEqual({ panel: "home", work: null });
  });

  it("still opens that same bookmark for a member", () => {
    expect(routeFromHash("#/w/mr/workspace/desk", MEMBER)).toEqual({
      panel: "agents",
      work: { slug: "mr", subject: "workspace", section: "desk" },
    });
  });

  it("keeps a GEO deep link working for a scoped reader", () => {
    expect(routeFromHash("#/w/geo/b1/answers", SCOPED)).toEqual({
      panel: "agents",
      work: { slug: "geo", subject: "b1", section: "answers" },
    });
  });

  it("sends a bookmarked Library or Integrations panel home", () => {
    expect(routeFromHash("#/library", SCOPED)).toEqual({ panel: "home", work: null });
    expect(routeFromHash("#/integrations", SCOPED)).toEqual({ panel: "home", work: null });
  });

  it("no longer opens Runs and Issues by link — they are the admin's since 2026-10-08", () => {
    expect(routeFromHash("#/runs", SCOPED)).toEqual({ panel: "home", work: null });
    expect(routeFromHash("#/issues", SCOPED)).toEqual({ panel: "home", work: null });
    expect(routeFromHash("#/runs", MEMBER)).toEqual({ panel: "home", work: null });
  });
});

/* The OAuth return lands on `#/w/inbox?connected=1`. The query is the
 * workspace's to read; the route must not mistake it for part of the slug. */
describe("routeFromHash with a query on the hash", () => {
  it("routes to the workspace and leaves the query to it", () => {
    expect(routeFromHash("#/w/inbox?connected=1", MEMBER)).toEqual({
      panel: "agents",
      work: { slug: "inbox", subject: "", section: "" },
    });
    expect(routeFromHash("#/w/inbox?error=The%20state%20did%20not%20match.", MEMBER)).toEqual({
      panel: "agents",
      work: { slug: "inbox", subject: "", section: "" },
    });
  });

  it("keeps the inbox behind the scope wall like every other non-GEO workspace", () => {
    expect(routeFromHash("#/w/inbox?connected=1", SCOPED)).toEqual({ panel: "home", work: null });
    expect(canOpenWorkspace("inbox", SCOPED)).toBe(false);
    expect(canOpenWorkspace("inbox", MEMBER)).toBe(true);
  });
});

/* ----------------------------------------------------- Home: usage blocks -- */

/* New tests join the owning area's module: Home's usage rules are pinned here
 * beside the rest of the hub's pure logic rather than in a file of their own.
 *
 * The contract: `match` says whether the chart row is tied to an account,
 * `read_ok` whether that account's record could be read, and a row that is
 * either untied or unread shows a note where its figures would be — never a
 * zero, whatever the payload's counts hold. */

const reportee = (over: Partial<TeamReportee> = {}): TeamReportee => ({
  name: "Priya Nair", title: "Content Lead", email: "priya@legalsoft.com", user_id: "u1",
  match: "email", last_login: "2026-10-08T08:00:00Z",
  today: 2, week: 9, month: 21, by_agent: { a9: 12, a2: 9 },
  last_run_at: "2026-10-08T09:00:00Z", read_ok: true,
  ...over,
});

describe("rowState", () => {
  it("counts a row tied by email or by name whose record was read", () => {
    expect(rowState(reportee())).toBe("counted");
    expect(rowState(reportee({ match: "name" }))).toBe("counted");
  });

  it("marks a person who has not signed in, whatever the counts say", () => {
    expect(rowState(reportee({ match: "none", today: 0, week: 0, month: 0 }))).toBe("not-signed-in");
    // Nothing is attached, so there was nothing to read: match wins.
    expect(rowState(reportee({ match: "none", read_ok: false }))).toBe("not-signed-in");
  });

  it("marks a row two accounts could be", () => {
    expect(rowState(reportee({ match: "ambiguous", email: null, user_id: null }))).toBe("ambiguous");
  });

  it("marks a record that could not be read, so its zeros are never shown", () => {
    expect(rowState(reportee({ read_ok: false, today: 0, week: 0, month: 0 }))).toBe("unread");
  });
});

describe("agentChips", () => {
  it("puts the busiest specialist first and names it from the catalogue", () => {
    expect(agentChips({ a2: 4, a9: 8, a1: 2 })).toEqual([
      { id: "a9", name: "Blog Writer", count: 8 },
      { id: "a2", name: "SEO Analyst", count: 4 },
      { id: "a1", name: "Graphic Designer", count: 2 },
    ]);
  });

  it("breaks a tie by the catalogue's order", () => {
    expect(agentChips({ a10: 3, a1: 3, a6: 3 }).map((c) => c.id)).toEqual(["a1", "a6", "a10"]);
  });

  it("drops a zero and keeps an id the catalogue does not know", () => {
    expect(agentChips({ a1: 0, a99: 1 })).toEqual([{ id: "a99", name: "a99", count: 1 }]);
    expect(agentChips({})).toEqual([]);
  });
});

describe("the window sentence", () => {
  it("reads the backend's calendar dates without the reader's zone shifting them", () => {
    expect(dayName("2026-10-08")).toBe("8 October 2026");
    expect(dayName("2026-10-02", false)).toBe("2 October");
    expect(monthLabel("2026-10")).toBe("October 2026");
  });

  it("names all three windows in one line", () => {
    expect(windowNote({ today: "2026-10-08", week_from: "2026-10-02", month: "2026-10" }))
      .toBe("Today is 8 October 2026 · the week counts from 2 October · the month is October 2026.");
  });

  it("shows what it cannot parse as it came, rather than inventing a date", () => {
    expect(dayName("soon")).toBe("soon");
    expect(monthLabel("2026-13")).toBe("2026-13");
  });
});

describe("teamSummary and its note", () => {
  const team = {
    reportees: [
      reportee(),
      reportee({ name: "Arjun", match: "name" }),
      reportee({ name: "Sana", match: "none", email: null, user_id: null }),
      reportee({ name: "Rohit", match: "ambiguous", email: null, user_id: null }),
      reportee({ name: "Meera", read_ok: false }),
    ],
    totals: { today: 3, week: 20, month: 41 },
  };

  it("tallies each state and passes the backend's totals through untouched", () => {
    expect(teamSummary(team)).toEqual({
      counted: 2, notSignedIn: 1, ambiguous: 1, unread: 1,
      totals: { today: 3, week: 20, month: 41 },
    });
  });

  it("says what was left out of the totals", () => {
    expect(summaryNote(teamSummary(team)))
      .toBe("2 of 5 counted · 1 not signed in yet · 1 matched two accounts · 1 could not be read");
    expect(summaryNote(teamSummary({ reportees: [reportee(), reportee()], totals: team.totals })))
      .toBe("all 2 counted");
    expect(summaryNote(teamSummary({ reportees: [], totals: team.totals }))).toBe("");
  });
});

describe("usage by humans", () => {
  const month = (year_month: string, runs = 0): HumansMonth => ({ year_month, runs, users: 0, by_user: [] });

  it("orders months newest first whatever order they arrived in, without mutating the payload", () => {
    const given = [month("2026-08"), month("2026-10"), month("2026-09")];
    expect(monthsNewestFirst(given).map((m) => m.year_month)).toEqual(["2026-10", "2026-09", "2026-08"]);
    expect(given.map((m) => m.year_month)).toEqual(["2026-08", "2026-10", "2026-09"]);
  });

  it("lists people by runs, ties by name", () => {
    const users = [
      { user_id: "b", email: "b@x", name: "Bo", runs: 3 },
      { user_id: "a", email: "a@x", name: "Al", runs: 3 },
      { user_id: "c", email: "c@x", name: "Cy", runs: 9 },
    ];
    expect(usersByRuns(users).map((u) => u.user_id)).toEqual(["c", "a", "b"]);
  });
});

describe("hasExtras", () => {
  it("is false for a plain member, so Home shows nothing extra", () => {
    expect(hasExtras({ team: null, humans: null })).toBe(false);
  });

  it("is true for a manager, an admin, or both", () => {
    const team = { manager: { name: "V", title: "Head" }, today: "2026-10-08", week_from: "2026-10-02", month: "2026-10", reportees: [], totals: { today: 0, week: 0, month: 0 } };
    const humans = { months: [], excluded: "Scheduled runs (the cron user) are not counted." };
    expect(hasExtras({ team, humans: null })).toBe(true);
    expect(hasExtras({ team: null, humans })).toBe(true);
    expect(hasExtras({ team, humans })).toBe(true);
  });
});

/* The board in the hero: one tab a view. "Your team" leads for a manager, an
 * admin's months follow newest first, and the remembered tab is honoured only
 * while the strip still has it. */
describe("the board's tabs", () => {
  const team = { manager: { name: "V", title: "Head" }, today: "2026-10-08", week_from: "2026-10-02", month: "2026-10", reportees: [], totals: { today: 0, week: 0, month: 0 } };
  const month = (year_month: string): HumansMonth => ({ year_month, runs: 0, users: 0, by_user: [] });
  const humans = { months: [month("2026-08"), month("2026-10"), month("2026-09")], excluded: "Scheduled runs are not counted." };

  it("labels a month the short way", () => {
    expect(monthShort("2026-10")).toBe("Oct 2026");
    expect(monthShort("2026-13")).toBe("2026-13");
  });

  it("puts Your team first, then the months newest first, each carrying its own data", () => {
    const tabs = boardTabs({ team, humans });
    expect(tabs.map((t) => [t.id, t.label])).toEqual([
      ["team", "Your team"], ["m:2026-10", "Oct 2026"], ["m:2026-09", "Sep 2026"], ["m:2026-08", "Aug 2026"],
    ]);
    const last = tabs[3];
    expect(last.id === "team" ? null : last.month.year_month).toBe("2026-08");
    expect(last.id === "team" ? null : last.excluded).toBe(humans.excluded);
  });

  it("gives a manager alone one tab and a member none", () => {
    expect(boardTabs({ team, humans: null }).map((t) => t.id)).toEqual(["team"]);
    expect(boardTabs({ team: null, humans: null })).toEqual([]);
    expect(boardTabs({ team: null, humans: { months: [], excluded: "" } })).toEqual([]);
  });

  it("opens the remembered tab while it exists, otherwise the first", () => {
    const tabs = boardTabs({ team, humans });
    expect(pickTab(tabs, "m:2026-09")?.id).toBe("m:2026-09");
    expect(pickTab(tabs, "m:2026-07")?.id).toBe("team");
    expect(pickTab(tabs, null)?.id).toBe("team");
    expect(pickTab(boardTabs({ team: null, humans }), "team")?.id).toBe("m:2026-10");
    expect(pickTab([], "team")).toBeNull();
  });
});

/* ------------------------------------------------ who sees which panel -- */
/* Joins this module (house rule: a change ships with its tests in the owning
 * area's existing module). Pins the 2026-10-08 decision: a member — a
 * sub-manager or a reportee — gets Home, the specialists and Settings; the
 * workspace-wide panels are the admin's. */

describe("panel gates", () => {
  const ids = (v: Parameters<typeof panelsFor>[0]) => panelsFor(v).map((p) => p.id);

  it("a member sees Home, Agents and Settings only", () => {
    expect(ids({})).toEqual(["home", "agents", "settings"]);
    expect(ids({ is_admin: false, is_creator: false })).toEqual(["home", "agents", "settings"]);
  });

  it("an admin also sees Issues, Runs, Brands, Integrations and Admin", () => {
    expect(ids({ is_admin: true })).toEqual(
      ["home", "issues", "agents", "runs", "library", "integrations", "settings", "admin"],
    );
  });

  it("a creator who is not an admin gets the creator panels but not the admin ones", () => {
    const got = ids({ is_creator: true });
    expect(got).toContain("models");
    expect(got).toContain("schedule");
    expect(got).not.toContain("issues");
    expect(got).not.toContain("runs");
  });

  it("the scope wall still outranks every gate", () => {
    expect(ids({ is_geo_only: true, is_admin: true })).toEqual(["home", "issues", "agents", "runs", "settings"]);
    expect(ids({ is_geo_only: true })).toEqual(["home", "agents", "settings"]);
  });

  it("every gated panel answers canOpen the same way panelsFor does", () => {
    for (const p of PANELS) expect(canOpen(p, {})).toBe(ids({}).includes(p.id));
  });
});

/* ------------------------------------------------- the admin's inbox -- */
/* Joins this module (house rule). The rules behind the Admin panel's inbox of
 * feedback, problems and agent requests live in `./asks.ts`; what is pinned
 * here is what a row says and which buttons it offers, so a backend row with
 * a field missing never blanks a line or offers a button for its own status. */

const askRow = (over: Partial<Ask> = {}): Ask => ({
  id: "k1", kind: "feedback", fields: { note: "The runs page is great." },
  from: { user_id: "u9", email: "sana@legalsoft.com", name: "Sana" },
  page: "#/runs", status: "new",
  created_at: "2026-10-08T09:00:00Z", updated_at: "2026-10-08T09:00:00Z",
  ...over,
});

describe("kindLabel", () => {
  it("names the three kinds and shows an unknown one as it came", () => {
    expect(kindLabel("feedback")).toBe("Feedback");
    expect(kindLabel("issue")).toBe("Problem");
    expect(kindLabel("agent")).toBe("Agent request");
    expect(kindLabel("praise")).toBe("praise");
  });
});

describe("filterAsks", () => {
  const rows = [askRow({ id: "a" }), askRow({ id: "b", status: "seen" }), askRow({ id: "c", status: "done" })];

  it("keeps only the unseen rows for New, in the order given", () => {
    expect(filterAsks(rows, "new").map((a) => a.id)).toEqual(["a"]);
  });

  it("keeps every row for All without mutating the payload", () => {
    const all = filterAsks(rows, "all");
    expect(all.map((a) => a.id)).toEqual(["a", "b", "c"]);
    expect(all).not.toBe(rows);
  });
});

describe("what an ask row says", () => {
  it("leads feedback with nothing and shows its note", () => {
    expect(askTitle(askRow())).toBe("");
    expect(askLines(askRow())).toEqual(["The runs page is great."]);
  });

  it("leads a problem with where it happened", () => {
    const row = askRow({ kind: "issue", fields: { where: "SEO dashboard", note: "The chart is blank." } });
    expect(askTitle(row)).toBe("SEO dashboard");
    expect(askLines(row)).toEqual(["The chart is blank."]);
  });

  it("leads an agent request with its name and spells out the rest", () => {
    const row = askRow({
      kind: "agent",
      fields: { name: "PR Writer", job: "Draft press releases.", gets: "A ready draft", cadence: "Weekly" },
    });
    expect(askTitle(row)).toBe("PR Writer");
    expect(askLines(row)).toEqual(["Draft press releases.", "Hands back: A ready draft", "Used: weekly"]);
  });

  it("drops a line whose field is missing or blank rather than printing a label over nothing", () => {
    const row = askRow({ kind: "agent", fields: { name: "PR Writer", job: "  ", gets: "" } });
    expect(askLines(row)).toEqual([]);
    expect(askLines(askRow({ fields: {} }))).toEqual([]);
  });
});

describe("who sent an ask", () => {
  it("names the person, with the email dim beside it", () => {
    expect(askWho(askRow())).toBe("Sana");
    expect(askEmail(askRow())).toBe("sana@legalsoft.com");
  });

  it("falls back to the email, then the id, and never to a blank", () => {
    const noName = askRow({ from: { user_id: "u9", email: "sana@legalsoft.com", name: "" } });
    expect(askWho(noName)).toBe("sana@legalsoft.com");
    expect(askEmail(noName)).toBe("");
    expect(askWho(askRow({ from: { user_id: "u9", email: "", name: "" } }))).toBe("u9");
    expect(askWho(askRow({ from: { user_id: "", email: "", name: "" } }))).toBe("Someone");
  });
});

describe("the status buttons a row offers", () => {
  it("offers both to a new row, and never the status it already has", () => {
    expect(nextStatuses("new")).toEqual(["seen", "done"]);
    expect(nextStatuses("seen")).toEqual(["done"]);
    expect(nextStatuses("done")).toEqual(["seen"]);
  });

  it("names them the way the panel prints them", () => {
    expect(STATUS_ACTION.seen).toBe("Mark seen");
    expect(STATUS_ACTION.done).toBe("Done");
  });
});

describe("replaceAsk", () => {
  const list = { asks: [askRow({ id: "a" }), askRow({ id: "b", status: "seen" })], total: 2, new: 1 };

  it("swaps the row in place and moves the new count with it", () => {
    const seen = replaceAsk(list, askRow({ id: "a", status: "seen" }));
    expect(seen.asks.map((a) => a.status)).toEqual(["seen", "seen"]);
    expect(seen.new).toBe(0);
    expect(seen.total).toBe(2);
  });

  it("leaves the count alone when the status did not cross new", () => {
    expect(replaceAsk(list, askRow({ id: "b", status: "done" })).new).toBe(1);
  });

  it("ignores a row it does not hold and never goes below zero", () => {
    expect(replaceAsk(list, askRow({ id: "zz", status: "done" }))).toBe(list);
    expect(replaceAsk({ ...list, new: 0 }, askRow({ id: "a", status: "done" })).new).toBe(0);
  });
});

/* ----------------------------------------------------- the daily trend -- */
/* Joins this module (house rule). The board's "Daily trend": runs by people
 * a day at a time, today last and partial. Pinned here: the week-over-week
 * (today never in it), the average line (today never in it either), the
 * 30/60 window, the sentence, and the fallback when the days stop coming. */

/** `runs`, oldest first, the last of them today (`end`). */
const daysOf = (runs: readonly number[], end = "2026-10-09"): HumansDay[] => {
  const [y, m, d] = end.split("-").map(Number);
  const last = Date.UTC(y, m - 1, d);
  return runs.map((r, i) => ({
    day: new Date(last - (runs.length - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    runs: r,
    people: Math.min(r, 3),
  }));
};
const TODAY_HUGE = 999; // a partial day that would swing anything it touched
const PREV_349 = [50, 50, 50, 50, 50, 50, 49];
const UP_412 = [60, 60, 60, 60, 60, 56, 56];
const DOWN_328 = [47, 47, 47, 47, 47, 47, 46];
/** Two filler weeks, then the week before, then the last seven, then today. */
const twoWeeks = (previous: number[], recent: number[], today = TODAY_HUGE) =>
  daysOf([...Array<number>(14).fill(5), ...previous, ...recent, today]);

describe("the trend's days", () => {
  it("names a day the axis way and the readout way, and leaves a non-date alone", () => {
    expect(dayShort("2026-10-06")).toBe("6 Oct");
    expect(dayWithWeekday("2026-10-06")).toBe("Tue 6 Oct");
    expect(dayWithWeekday("2026-10-11")).toBe("Sun 11 Oct");
    expect(dayWithWeekday("soon")).toBe("soon");
  });

  it("averages each day with the six before it, and claims nothing until there are seven", () => {
    const avg = trailingAverage([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(avg.slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(avg[6]).toBe(4);
    expect(avg[9]).toBe(7);
  });

  it("marks today as partial and keeps it out of the average line", () => {
    const days = trendSeries(daysOf([...Array<number>(20).fill(4), TODAY_HUGE]), 30);
    const today = days[days.length - 1];
    expect(today.today).toBe(true);
    expect(today.avg).toBeNull();
    expect(days.filter((d) => d.today)).toHaveLength(1);
    // the day before today averages only complete days
    expect(days[days.length - 2].avg).toBe(4);
  });

  it("slices 30 or 60 days, today included, with the average carried in from before the window", () => {
    const sixty = daysOf(Array.from({ length: 60 }, (_, i) => i));
    const thirty = trendSeries(sixty, 30);
    expect(thirty).toHaveLength(30);
    expect(thirty[0].day).toBe(sixty[30].day);
    expect(thirty[thirty.length - 1].day).toBe("2026-10-09");
    expect(thirty[0].avg).toBe(27); // days 24..30, a full week behind it
    const all = trendSeries(sixty, 60);
    expect(all).toHaveLength(60);
    expect(all.slice(0, 6).every((d) => d.avg === null)).toBe(true);
    expect(all[6].avg).toBe(3);
  });

  it("shows every day it has when there are fewer than the window asks for", () => {
    expect(trendSeries(daysOf([1, 2, 3]), 30)).toHaveLength(3);
    expect(trendSeries([], 30)).toEqual([]);
  });

  it("reads the days oldest first whatever order they arrived in, without touching the payload", () => {
    const given = daysOf([1, 2, 3]).reverse();
    const days = trendSeries(given, 30);
    expect(days.map((d) => d.day)).toEqual(["2026-10-07", "2026-10-08", "2026-10-09"]);
    expect(days[2].today).toBe(true);
    expect(given[0].day).toBe("2026-10-09");
  });

  it("knows weekends and Mondays from the date, not the reader's clock", () => {
    const days = trendSeries(daysOf([0, 0, 0, 0, 0, 0, 0], "2026-10-11"), 30); // Mon 5 to Sun 11 Oct
    expect(days.map((d) => d.weekend)).toEqual([false, false, false, false, false, true, true]);
    expect(days.map((d) => d.monday)).toEqual([true, false, false, false, false, false, false]);
  });
});

describe("the week against the week before", () => {
  it("says up, with the figures", () => {
    const c = weekOverWeek(twoWeeks(PREV_349, UP_412));
    expect(c).toMatchObject({ kind: "compare", recent: 412, previous: 349, pct: 18, dir: "up" });
    expect(deltaFigure(c)).toBe("+18%");
    expect(weekSentence(c)).toBe("Up 18% on the week before — 412 runs vs 349.");
  });

  it("says down with a true minus, and never as an alarm word", () => {
    const c = weekOverWeek(twoWeeks(PREV_349, DOWN_328));
    expect(c).toMatchObject({ recent: 328, previous: 349, pct: -6, dir: "down" });
    expect(deltaFigure(c)).toBe("−6%");
    expect(weekSentence(c)).toBe("Down 6% on the week before — 328 runs vs 349.");
  });

  it("says no change when the weeks match, or differ by less than half a percent", () => {
    const same = weekOverWeek(twoWeeks(PREV_349, PREV_349));
    expect(same).toMatchObject({ pct: 0, dir: "flat" });
    expect(deltaFigure(same)).toBe("no change");
    expect(weekSentence(same)).toBe("No change on the week before — 349 runs in each.");
    const near = weekOverWeek(twoWeeks([143, 143, 143, 143, 143, 143, 143], [143, 143, 143, 143, 143, 143, 142]));
    expect(near).toMatchObject({ recent: 1000, previous: 1001, pct: 0, dir: "flat" });
    expect(weekSentence(near)).toBe("No change on the week before — 1,000 runs vs 1,001.");
  });

  it("gives no percentage when the week before had no runs", () => {
    const c = weekOverWeek(twoWeeks([0, 0, 0, 0, 0, 0, 0], [1, 0, 2, 0, 0, 0, 0]));
    expect(c).toMatchObject({ kind: "compare", recent: 3, previous: 0, pct: null, dir: "up" });
    expect(deltaFigure(c)).toBe("No runs the week before");
    expect(weekSentence(c)).toBe("No runs the week before — 3 runs in the last 7 days.");
  });

  it("says so plainly when nobody ran anything, and the chart still has a scale to draw flat against", () => {
    const daily = daysOf(Array<number>(60).fill(0));
    const c = weekOverWeek(daily);
    expect(c).toMatchObject({ recent: 0, previous: 0, pct: null, dir: "flat" });
    expect(deltaFigure(c)).toBe("no change");
    expect(weekSentence(c)).toBe("No runs in either of the last two weeks.");
    const days = trendSeries(daily, 30);
    expect(days.every((d) => d.runs === 0 && (d.avg === null || d.avg === 0))).toBe(true);
    expect(yTicks(0)).toEqual([0, 1, 2]);
  });

  it("does not compare until there are fourteen complete days, and today does not count toward them", () => {
    const fourteenWithToday = weekOverWeek(daysOf(Array<number>(14).fill(4)));
    expect(fourteenWithToday).toMatchObject({ kind: "short", complete: 13, days: 7, recent: 28 });
    expect(deltaFigure(fourteenWithToday)).toBeNull();
    expect(weekSentence(fourteenWithToday)).toBe(
      "Too few days to compare yet: that takes two full weeks of days, and 13 are complete so far.",
    );
    expect(weekOverWeek(daysOf(Array<number>(15).fill(4))).kind).toBe("compare");
    const few = weekOverWeek(daysOf([2, 3, 9]));
    expect(few).toMatchObject({ kind: "short", complete: 2, days: 2, recent: 5 });
    expect(weekSentence(weekOverWeek(daysOf([9])))).toBe(
      "Too few days to compare yet: that takes two full weeks of days, and none is complete so far.",
    );
  });

  it("leaves today out of both weeks, however big its partial count", () => {
    const quiet = weekOverWeek(twoWeeks(PREV_349, UP_412, 0));
    const busy = weekOverWeek(twoWeeks(PREV_349, UP_412, TODAY_HUGE));
    expect(busy).toEqual(quiet);
  });
});

describe("the trend's scale and figures", () => {
  it("draws three quiet gridlines from zero on whole, readable steps", () => {
    expect(yTicks(47)).toEqual([0, 25, 50]);
    expect(yTicks(3)).toEqual([0, 2, 4]);
    expect(yTicks(9)).toEqual([0, 5, 10]);
    expect(yTicks(412)).toEqual([0, 250, 500]);
    expect(yTicks(2)).toEqual([0, 1, 2]);
    expect(yTicks(Number.NaN)).toEqual([0, 1, 2]);
  });

  it("writes a per-day average with one decimal while it is small", () => {
    expect(perDay(81 / 7)).toBe("11.6");
    expect(perDay(12)).toBe("12");
    expect(perDay(1204.4)).toBe("1,204");
  });
});

describe("whether the board offers the trend", () => {
  const month = (year_month: string): HumansMonth => ({ year_month, runs: 0, users: 0, by_user: [] });
  const humans = { months: [month("2026-10"), month("2026-09")], excluded: "Scheduled runs are not counted." };

  it("offers it only when the backend sent days", () => {
    expect(hasTrend({ humans: null })).toBe(false);
    expect(hasTrend({ humans })).toBe(false);
    expect(hasTrend({ humans: { ...humans, daily: [] } })).toBe(false);
    expect(hasTrend({ humans: { ...humans, daily: daysOf([1]) } })).toBe(true);
  });

  it("opens the first tab when the trend is remembered but the days are gone", () => {
    const tabs = boardTabs({ team: null, humans });
    expect(tabs.map((t): string => t.id)).not.toContain(TREND_ID);
    expect(pickTab(tabs, TREND_ID)?.id).toBe("m:2026-10");
  });
});
