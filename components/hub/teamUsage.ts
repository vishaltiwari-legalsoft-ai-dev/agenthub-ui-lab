/** Home's usage board: the decisions behind the rows, with no React in them.
 *
 *  The payload says several things that are not a number — a person who has
 *  not signed in, a chart row two accounts could be, a record that could not
 *  be read — and each has to stay distinct from a count of zero all the way to
 *  the cell. Those rules, the window sentence, the chip order and the board's
 *  tab strip live here so `format.test.ts` can pin them without rendering
 *  anything.
 */

import type { HumansDay, HumansMonth, HumansUser, TeamReportee, TeamUsage, TeamUsageTeam } from "@/lib/api";
import { AGENTS, n } from "./model";

/* ------------------------------------------------------------- the rows -- */

export type RowState = "counted" | "not-signed-in" | "ambiguous" | "unread";

/** Match first, then readability. A row nobody is attached to has no record to
 *  read, so `read_ok` says nothing about it; and the counts on a row that is
 *  not `counted` are never looked at, whatever they hold. */
export function rowState(r: Pick<TeamReportee, "match" | "read_ok">): RowState {
  if (r.match === "none") return "not-signed-in";
  if (r.match === "ambiguous") return "ambiguous";
  if (!r.read_ok) return "unread";
  return "counted";
}

/** The quiet tag a row carries instead of its figures. */
export const ROW_NOTE: Record<Exclude<RowState, "counted">, string> = {
  "not-signed-in": "not signed in yet",
  ambiguous: "two accounts match — ask an admin",
  unread: "could not be read",
};

export interface AgentChip {
  id: string;
  name: string;
  count: number;
}

/** Busiest specialist first; ties keep the catalogue's order; an id the
 *  catalogue does not know keeps its id as its name rather than vanishing.
 *  A zero is not a chip. */
export function agentChips(byAgent: Record<string, number>): AgentChip[] {
  const rank = (id: string) => {
    const i = AGENTS.findIndex((a) => a.id === id);
    return i === -1 ? AGENTS.length : i;
  };
  return Object.entries(byAgent)
    .filter(([, count]) => count > 0)
    .map(([id, count]) => ({ id, name: AGENTS.find((a) => a.id === id)?.name ?? id, count }))
    .sort((a, b) => b.count - a.count || rank(a.id) - rank(b.id));
}

/* ---------------------------------------------------------- the windows -- */

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** `YYYY-MM-DD` and `YYYY-MM` are calendar dates, not instants, so they are
 *  read by hand: `new Date("2026-10-08")` is midnight UTC, which west of
 *  Greenwich is the evening before. */
function calendar(s: string): { y: number; m: number; d: number | null } | null {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(s);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { y: Number(m[1]), m: month, d: m[3] ? Number(m[3]) : null };
}

/** `8 October 2026`, or `8 October` without the year. Anything that is not a
 *  date comes back as it was — shown, not reinterpreted. */
export function dayName(ymd: string, withYear = true): string {
  const c = calendar(ymd);
  if (!c || c.d === null) return ymd;
  return `${c.d} ${MONTH_NAMES[c.m - 1]}${withYear ? ` ${c.y}` : ""}`;
}

/** `October 2026`. */
export function monthLabel(ym: string): string {
  const c = calendar(ym);
  if (!c) return ym;
  return `${MONTH_NAMES[c.m - 1]} ${c.y}`;
}

/** `Oct 2026` — a tab's width, not a heading's. */
export function monthShort(ym: string): string {
  const c = calendar(ym);
  if (!c) return ym;
  return `${MONTH_NAMES[c.m - 1].slice(0, 3)} ${c.y}`;
}

/** The sentence under the table that says which days the three columns cover,
 *  taken from the backend's own window rather than the reader's clock. */
export function windowNote(w: Pick<TeamUsageTeam, "today" | "week_from" | "month">): string {
  return `Today is ${dayName(w.today)} · the week counts from ${dayName(w.week_from, false)} · the month is ${monthLabel(w.month)}.`;
}

/* ------------------------------------------------------------ the totals -- */

export interface TeamSummary {
  counted: number;
  notSignedIn: number;
  ambiguous: number;
  unread: number;
  /** The backend's totals, passed through: they are the figures it stands
   *  behind, and this console does not re-add rows it has just said it could
   *  not read. */
  totals: TeamUsageTeam["totals"];
}

export function teamSummary(team: Pick<TeamUsageTeam, "reportees" | "totals">): TeamSummary {
  const s: TeamSummary = { counted: 0, notSignedIn: 0, ambiguous: 0, unread: 0, totals: team.totals };
  for (const r of team.reportees) {
    const st = rowState(r);
    if (st === "counted") s.counted += 1;
    else if (st === "not-signed-in") s.notSignedIn += 1;
    else if (st === "ambiguous") s.ambiguous += 1;
    else s.unread += 1;
  }
  return s;
}

/** `4 of 6 counted · 1 not signed in yet · 1 could not be read`, or `all 6
 *  counted` when there is nothing to explain. */
export function summaryNote(s: TeamSummary): string {
  const all = s.counted + s.notSignedIn + s.ambiguous + s.unread;
  if (all === 0) return "";
  if (s.counted === all) return `all ${all} counted`;
  const parts = [`${s.counted} of ${all} counted`];
  if (s.notSignedIn) parts.push(`${s.notSignedIn} not signed in yet`);
  if (s.ambiguous) parts.push(`${s.ambiguous} matched two accounts`);
  if (s.unread) parts.push(`${s.unread} could not be read`);
  return parts.join(" · ");
}

/* ------------------------------------------------------------ by humans -- */

/** Newest month first, whatever order the backend sent. `YYYY-MM` sorts as a
 *  string. Returns a copy. */
export function monthsNewestFirst(months: readonly HumansMonth[]): HumansMonth[] {
  return [...months].sort((a, b) => (a.year_month < b.year_month ? 1 : a.year_month > b.year_month ? -1 : 0));
}

/** Most runs first; ties by name, so the list is stable between reads. */
export function usersByRuns(users: readonly HumansUser[]): HumansUser[] {
  return [...users].sort((a, b) => b.runs - a.runs || (a.name || a.email).localeCompare(b.name || b.email));
}

/* ------------------------------------------------------------- the gate -- */

/** A plain member gets both sections null, and Home shows nothing extra. */
export const hasExtras = (p: Pick<TeamUsage, "team" | "humans">): boolean =>
  p.team !== null || p.humans !== null;

/* ------------------------------------------------------------- the tabs -- */

/** One tab a view. "Your team" leads when the viewer is a manager; an admin's
 *  months follow, newest first. Each tab carries what its panel renders, so
 *  the board never reaches back into a section that might be null. */
export type BoardTab =
  | { id: "team"; label: string; team: TeamUsageTeam }
  | { id: `m:${string}`; label: string; month: HumansMonth; excluded: string };

export function boardTabs(p: Pick<TeamUsage, "team" | "humans">): BoardTab[] {
  const tabs: BoardTab[] = [];
  if (p.team) tabs.push({ id: "team", label: "Your team", team: p.team });
  if (p.humans) {
    for (const month of monthsNewestFirst(p.humans.months)) {
      tabs.push({ id: `m:${month.year_month}`, label: monthShort(month.year_month), month, excluded: p.humans.excluded });
    }
  }
  return tabs;
}

/** The tab to open: the remembered one if the strip still has it, otherwise
 *  the first. A month that has since dropped off the window, or a "Your team"
 *  remembered by someone no longer a manager, must not leave the board blank. */
export function pickTab(tabs: readonly BoardTab[], remembered: string | null | undefined): BoardTab | null {
  if (tabs.length === 0) return null;
  return tabs.find((t) => t.id === remembered) ?? tabs[0];
}

/* ------------------------------------------------------- the daily trend -- */
/* "Is it going up or down?" — asked of the days people ran the specialists,
 * cron never among them. The backend sends the last 60 calendar days, oldest
 * first, every day present, today last; today is still going, so it is drawn
 * (marked as partial) but never compared and never averaged. */

/** What the board remembers for its trend view, beside the tab ids. No tab is
 *  ever called this (`team`, `m:YYYY-MM`), so when the trend is gone `pickTab`
 *  falls back past it to the first tab. */
export const TREND_ID = "trend";

/** The days the week-over-week compares and the average line spans. */
export const AVG_DAYS = 7;

export type TrendSpan = 30 | 60;

/** Offered on the admin board only, and only when the backend sent days. An
 *  older backend sends none, and then there is no button at all. */
export function hasTrend(p: Pick<TeamUsage, "humans">): boolean {
  return (p.humans?.daily?.length ?? 0) > 0;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 0 for Sunday … 6 for Saturday, read off the calendar date itself, so the
 *  reader's timezone cannot move a day across midnight. */
function weekdayOf(ymd: string): number | null {
  const c = calendar(ymd);
  if (!c || c.d === null) return null;
  return new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay();
}

/** `6 Oct` — an axis label. */
export function dayShort(ymd: string): string {
  const c = calendar(ymd);
  if (!c || c.d === null) return ymd;
  return `${c.d} ${MONTH_NAMES[c.m - 1].slice(0, 3)}`;
}

/** `Tue 6 Oct` — the heading of a day's readout. */
export function dayWithWeekday(ymd: string): string {
  const w = weekdayOf(ymd);
  return w === null ? ymd : `${WEEKDAYS[w]} ${dayShort(ymd)}`;
}

/** Oldest first, whatever order arrived. `YYYY-MM-DD` sorts as a string.
 *  Returns a copy. */
export function daysOldestFirst(daily: readonly HumansDay[]): HumansDay[] {
  return [...daily].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** The mean of each value and the `k - 1` before it; null until there are `k`
 *  to average — a short average would claim a week it has not seen. */
export function trailingAverage(values: readonly number[], k = AVG_DAYS): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= k) sum -= values[i - k];
    out.push(i >= k - 1 ? sum / k : null);
  }
  return out;
}

export interface TrendDay extends HumansDay {
  /** The average of the seven complete days ending on this one; null for
   *  today and for any day without seven complete days behind it. */
  avg: number | null;
  /** The last day sent: still going, so its count is partial. */
  today: boolean;
  weekend: boolean;
  /** The axis labels sit on Mondays. */
  monday: boolean;
}

/** The days the chart draws: the last `span` of them, today among them. The
 *  average is taken across every complete day sent, so the first column of a
 *  30-day window still has its full week behind it; today is left out of it,
 *  because a morning's count would bend the line down every day before noon. */
export function trendSeries(daily: readonly HumansDay[], span: TrendSpan): TrendDay[] {
  const days = daysOldestFirst(daily);
  const complete = days.length - 1;
  const avg = trailingAverage(days.slice(0, complete).map((d) => d.runs));
  return days
    .map((d, i) => {
      const w = weekdayOf(d.day);
      return {
        ...d,
        avg: i < complete ? avg[i] : null,
        today: i === complete,
        weekend: w === 0 || w === 6,
        monday: w === 1,
      };
    })
    .slice(-span);
}

/** This week against last, where a "week" is seven complete days: the seven
 *  ending yesterday against the seven before them. `short` until fourteen
 *  complete days exist — a comparison with a hole in it is not one. */
export type WeekCompare =
  | { kind: "short"; complete: number; recent: number; days: number }
  | {
      kind: "compare";
      recent: number;
      previous: number;
      /** Whole percent, rounded away from zero symmetrically; null when the
       *  earlier week had no runs, because a change on nothing has no size. */
      pct: number | null;
      dir: "up" | "down" | "flat";
    };

export function weekOverWeek(daily: readonly HumansDay[]): WeekCompare {
  const complete = daysOldestFirst(daily).slice(0, -1);
  const total = (ds: readonly HumansDay[]) => ds.reduce((s, d) => s + d.runs, 0);
  const last = complete.slice(-AVG_DAYS);
  const recent = total(last);
  if (complete.length < 2 * AVG_DAYS) {
    return { kind: "short", complete: complete.length, recent, days: last.length };
  }
  const previous = total(complete.slice(-2 * AVG_DAYS, -AVG_DAYS));
  if (previous === 0) {
    return { kind: "compare", recent, previous, pct: null, dir: recent > 0 ? "up" : "flat" };
  }
  const raw = ((recent - previous) / previous) * 100;
  const pct = Math.sign(raw) * Math.round(Math.abs(raw)) || 0;
  return { kind: "compare", recent, previous, pct, dir: pct > 0 ? "up" : pct < 0 ? "down" : "flat" };
}

const runsWord = (v: number) => `${n(v)} run${v === 1 ? "" : "s"}`;

/** The plain sentence under the headline figures. */
export function weekSentence(c: WeekCompare): string {
  if (c.kind === "short") {
    const have = c.complete === 0 ? "none is" : c.complete === 1 ? "one is" : `${n(c.complete)} are`;
    return `Too few days to compare yet: that takes two full weeks of days, and ${have} complete so far.`;
  }
  if (c.pct === null) {
    return c.recent === 0
      ? "No runs in either of the last two weeks."
      : `No runs the week before — ${runsWord(c.recent)} in the last ${AVG_DAYS} days.`;
  }
  const vs = c.recent === c.previous ? `${runsWord(c.recent)} in each` : `${runsWord(c.recent)} vs ${n(c.previous)}`;
  if (c.dir === "up") return `Up ${n(c.pct)}% on the week before — ${vs}.`;
  if (c.dir === "down") return `Down ${n(-c.pct)}% on the week before — ${vs}.`;
  return `No change on the week before — ${vs}.`;
}

/** The headline change: `+18%`, `−6%` (a true minus), `no change`, or — when
 *  the week before had no runs — the words instead of a percentage. Null while
 *  there is nothing to compare. */
export function deltaFigure(c: WeekCompare): string | null {
  if (c.kind === "short") return null;
  if (c.pct === null) return c.recent === 0 ? "no change" : "No runs the week before";
  if (c.pct > 0) return `+${n(c.pct)}%`;
  if (c.pct < 0) return `−${n(-c.pct)}%`;
  return "no change";
}

/** A per-day average: one decimal while a decimal still matters. */
export function perDay(v: number): string {
  return v >= 100 ? n(Math.round(v)) : n(Math.round(v * 10) / 10);
}

/** Three quiet gridlines from zero, `[0, step, 2 × step]`, the top at or above
 *  `max` and every step a whole count on a 1-2-2.5-5 style ladder. A window
 *  with nothing in it still gets an axis, `[0, 1, 2]`, so the flat line is
 *  drawn against a scale rather than floating. */
export function yTicks(max: number): [number, number, number] {
  const half = Math.max(max, 0) / 2;
  if (!(half > 1)) return [0, 1, 2];
  const mag = 10 ** Math.floor(Math.log10(half));
  const ladder = mag >= 10 ? [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10] : [1, 2, 3, 4, 5, 6, 8, 10];
  const step = ladder.map((m) => m * mag).find((s) => s >= half) ?? 10 * mag;
  return [0, step, 2 * step];
}
