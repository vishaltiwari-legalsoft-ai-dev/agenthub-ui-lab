"use client";

/** Home — the field guide, contained.
 *
 *  Orientation, in three moves that stay out of each other's way: how the hub
 *  works in one slim line, the specialists in a single master–detail module
 *  (their list on the left, one manual open on the right — never six cards
 *  fighting down the page), and the FAQ in two quiet columns. Everything
 *  operational lives where it belongs — what needs you on Issues, what is
 *  running on Runs — and the two links at the foot go there.
 *
 *  The guide is not fetched. It is authored (`../guide`), so the front page
 *  opens instantly and can never greet somebody with an error card. The one
 *  fetched thing is the board in the hero — what your reportees asked of the
 *  agents, and for an admin what humans ran per month — and it owns its own
 *  loading: the greeting and the guide never wait on it, and a failure there
 *  is one card beside the cosmos, never the greeting.
 */

import {
  useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type KeyboardEvent, type PointerEvent, type RefObject,
} from "react";
import {
  apiStatus, teamUsage,
  type HumansDay, type HumansMonth, type HumansUser, type TeamReportee, type TeamUsage, type TeamUsageTeam,
} from "@/lib/api";
import { loadPending, useLoadSession, type Load } from "@/lib/load";
import { useHeadline, useHub } from "../context";
import Cosmos from "../Cosmos";
import { FAQS, GUIDES } from "../guide";
import { JOBS } from "../jobs";
import { WORKSPACE_SLUG, agentsFor, greeting, n, word, type HubAgent } from "../model";
import { ago, clock } from "../format";
import {
  AVG_DAYS, ROW_NOTE, TREND_ID, agentChips, boardTabs, dayShort, dayWithWeekday, deltaFigure, hasExtras,
  monthLabel, perDay, pickTab, rowState, summaryNote, teamSummary, trendSeries, usersByRuns, weekOverWeek,
  weekSentence, windowNote, yTicks, type AgentChip, type BoardTab, type TrendDay, type TrendSpan,
} from "../teamUsage";
import { Ic } from "../Sprite";
import { Oops, RuleHead } from "../ui";

export function HomeView() {
  const { user, revision, openWork, openBrief, go, toast } = useHub();

  useHeadline("the field guide to your specialists");

  const firstName = (user.name || user.email || "").split(/[\s@]/)[0] || "there";
  const mine = agentsFor(user);

  // The cosmos and the manual share one selection: picking a planet up in
  // the hero opens that specialist's manual below — the decoration is also
  // a door.
  const [picked, setPicked] = useState<string | null>(null);
  const pickFromCosmos = (id: string) => {
    setPicked(id);
    document.getElementById("specialists")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const openSlug = (agentId: string, section?: string) => {
    const slug = WORKSPACE_SLUG[agentId];
    if (slug) openWork(slug, "", section || "");
    else toast("That specialist has no workspace yet.", "warn");
  };

  return (
    <>
      {/* The hero: the greeting choreographed line by line on the left, the
          usage board under it, and on the right the cosmos — AI at the
          centre, the staff in orbit around it (see Cosmos). */}
      <div className="hero">
        <div className="hero__copy">
          <p className="statement">
            <span className="hero__line"><span>{greeting()}, {firstName}.</span></span>
            <span className="hero__line">
              <span>You have <b>{word(mine.length)} specialist{mine.length === 1 ? "" : "s"}</b> on staff.</span>
            </span>
          </p>

          {/* A GEO-only account is refused this read with a 403, like every
              other route outside its allowance, so it is never asked. */}
          {!user.is_geo_only && <UsageBoard revision={revision} expected={!!user.is_admin} />}

          <p className="lede">
            <span className="hgw">
              <span><b>1</b> Brief one</span>
              <i aria-hidden="true" />
              <span><b>2</b> {user.is_admin ? "Watch the run on Runs" : "Watch it work in the workspace"}</span>
              <i aria-hidden="true" />
              <span><b>3</b> Collect it in the workspace</span>
            </span>
          </p>
        </div>

        <div className="hero__stage">
          <Cosmos agents={mine} onPick={pickFromCosmos} />
        </div>
      </div>

      {mine.length > 0 && (
        <section className="band" id="specialists">
          <RuleHead
            title="The specialists"
            note="Pick one — its manual opens beside the list, and takes a minute to read."
          />
          <GuideModule
            agents={mine}
            selected={picked ?? mine[0].id}
            onSelect={setPicked}
            onBrief={openBrief}
            onOpen={openSlug}
          />
        </section>
      )}

      <section className="band">
        <RuleHead title="Questions everyone asks" note="The first-week questions, answered once." />
        <Faqs />
      </section>

      {/* Issues and Runs are the admin's panels; a member's Home ends at the
          questions, with nothing offered that the shell would refuse. */}
      {user.is_admin && (
        <p className="hgfoot">
          Looking for what needs you?{" "}
          <button type="button" onClick={() => go("issues")}>Issues</button>
          {" "}· Watching something run?{" "}
          <button type="button" onClick={() => go("runs")}>Runs</button>
        </p>
      )}
    </>
  );
}

/* ------------------------------------------------------- the usage board -- */

/** One read for the board, bound to `lib/load` the way `useRuns` is. Re-read
 *  when the console's revision moves and when the window regains focus — a
 *  manager glancing back at the tab after a reportee's run should see it —
 *  and nothing more aggressive than that.
 *
 *  A 404 is the backend not serving this endpoint yet (the frontend deploys
 *  minutes ahead of Cloud Run), and the right rendering of that is nothing:
 *  `data` becomes `null` while the phase is `ready`, which the board reads as
 *  "no sections". Every other failure is shown, with a retry. */
function useTeamUsage(revision: number) {
  const session = useLoadSession();
  const [state, setState] = useState<Load<TeamUsage | null>>(loadPending);
  const [beat, setBeat] = useState(0);
  const reload = useCallback(() => setBeat((b) => b + 1), []);

  useEffect(() => {
    void session.run(
      "team-usage",
      (signal) => teamUsage(3, { signal }).catch((e: unknown) => {
        if (apiStatus(e) === 404) return null;
        throw e;
      }),
      setState,
      "Usage could not be read.",
      // A focus refresh that fails must not blank numbers already on screen.
      { keepStale: true },
    );
  }, [session, revision, beat]);

  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  return { state, reload };
}

/** The tab a viewer last chose, remembered in this browser only. Storage can
 *  be absent or refuse (a private window, cleared site data); either way the
 *  board simply opens on its first tab. */
const TAB_KEY = "home.board.tab";

function rememberedTab(): string | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage.getItem(TAB_KEY); } catch { return null; }
}

function rememberTab(id: string): void {
  try { window.localStorage.setItem(TAB_KEY, id); } catch { /* a convenience, not state */ }
}

/** `expected` — an admin is sure to get a board, so a skeleton of its size
 *  holds the place and nothing under it moves when the figures land. A member
 *  may or may not be a manager on the chart, and their Home must not flash a
 *  card that then vanishes, so for them the board waits in silence and
 *  appears only once the read says there is one. */
function UsageBoard({ revision, expected }: { revision: number; expected: boolean }) {
  const { state, reload } = useTeamUsage(revision);
  const data = state.data;

  if (state.phase === "failed" && !data) {
    return (
      <section className="hboard" aria-label="Usage by your team">
        <div className="hboard__body hboard__body--oops">
          <Oops what="Usage could not be read." error={state.error || ""} onRetry={reload} />
        </div>
      </section>
    );
  }
  if (state.phase === "loading" && !data) return expected ? <BoardWait /> : null;
  // Ready with nothing: the backend does not serve this yet, or the reader is
  // a plain member. The hero is exactly what it was.
  if (!data || !hasExtras(data)) return null;

  return <Board data={data} />;
}

function BoardWait() {
  return (
    <div className="hboard is-wait" role="status" aria-live="polite" aria-label="Reading usage…">
      <div className="hboard__tabs" aria-hidden="true"><i /><i /><i /></div>
      <div className="hboard__body" aria-hidden="true"><i /><i /><i /><i /></div>
    </div>
  );
}

const tabDom = (id: string) => `hboard-tab-${id.replace(/\W/g, "-")}`;
const TREND_DOM = "hboard-trend";

/** One card, a tab a view. The strip is a real tablist: the selected tab is
 *  the one in the tab order, arrows move along it, Home and End jump.
 *
 *  At the strip's right end, outside the tablist, sits the "Daily trend"
 *  toggle (admin board, and only when the backend sent days). Pressed, it
 *  takes the body; any tab returns to that tab; pressing it again returns to
 *  the tab it covered. It is remembered like a tab, as `trend` — and if the
 *  days stop coming, `pickTab` simply opens the first tab instead. */
function Board({ data }: { data: TeamUsage }) {
  const tabs = boardTabs(data);
  const daily = data.humans?.daily ?? [];
  const canTrend = daily.length > 0;
  const [chosen, setChosen] = useState<string | null>(rememberedTab);
  // The tab the trend covers, so un-pressing it goes back where it came from.
  const [under, setUnder] = useState<string | null>(() => (chosen === TREND_ID ? null : chosen));
  const trendOn = canTrend && chosen === TREND_ID;
  const tab = pickTab(tabs, trendOn ? under : chosen);

  const choose = (t: BoardTab) => {
    setChosen(t.id);
    setUnder(t.id);
    rememberTab(t.id);
  };

  const toggleTrend = () => {
    if (!trendOn) {
      setChosen(TREND_ID);
      rememberTab(TREND_ID);
      return;
    }
    if (tab) {
      choose(tab);
    } else {
      setChosen(null);
      rememberTab("");
    }
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!tab) return;
    const i = tabs.findIndex((t) => t.id === tab.id);
    let next = i;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next === i) return;
    e.preventDefault();
    choose(tabs[next]);
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <section className="hboard" aria-label="Usage by your team">
      {(tabs.length > 0 || canTrend) && (
        <div className="hboard__tabs">
          {tabs.length > 0 && (
            <div className="hboard__tablist" role="tablist" aria-label="Usage views" onKeyDown={onKey}>
              {tabs.map((t) => {
                const on = tab?.id === t.id;
                return (
                  <button
                    type="button"
                    role="tab"
                    key={t.id}
                    id={tabDom(t.id)}
                    className="hboard__tab"
                    aria-selected={on && !trendOn}
                    aria-controls="hboard-panel"
                    tabIndex={on ? 0 : -1}
                    onClick={() => choose(t)}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          )}
          {canTrend && (
            <button
              type="button"
              id={TREND_DOM}
              className="hboard__trend"
              aria-pressed={trendOn}
              aria-controls="hboard-panel"
              onClick={toggleTrend}
            >
              <Ic name="lines" />
              Daily trend
            </button>
          )}
        </div>
      )}
      <div
        className="hboard__body"
        role={trendOn ? "region" : "tabpanel"}
        id="hboard-panel"
        aria-labelledby={trendOn ? TREND_DOM : tab ? tabDom(tab.id) : undefined}
        key={trendOn ? TREND_ID : tab?.id ?? "none"}
      >
        {trendOn ? (
          <TrendPanel daily={daily} excluded={data.humans?.excluded ?? ""} />
        ) : tab === null ? (
          <>
            <p className="hboard__none">
              Nothing has been recorded yet. Runs that people start appear here by month, with who started them.
            </p>
            {data.humans && <p className="hboard__foot">{data.humans.excluded}</p>}
          </>
        ) : tab.id === "team" ? (
          <TeamPanel team={tab.team} />
        ) : (
          <MonthPanel month={tab.month} excluded={tab.excluded} generatedAt={data.generated_at} />
        )}
      </div>
    </section>
  );
}

/* --- your team --- */

function TeamPanel({ team }: { team: TeamUsageTeam }) {
  const rows = team.reportees;
  const summary = teamSummary(team);

  return (
    <>
      {rows.length === 0 ? (
        <p className="hboard__none">
          Nobody reports to you on the chart yet. When the chart lists someone under you, what they ask of
          the specialists appears here.
        </p>
      ) : (
        <div className="hboard__scroll">
          <table className="hboard__tbl">
            <caption className="vh">Agent usage by your reportees</caption>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col" className="num">Today</th>
                <th scope="col" className="num">Week</th>
                <th scope="col" className="num">Month</th>
                <th scope="col">Specialists</th>
                <th scope="col">Last run</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => <ReporteeRow key={`${r.user_id ?? r.email ?? r.name}-${i}`} r={r} />)}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td className="num">{n(team.totals.today)}</td>
                <td className="num">{n(team.totals.week)}</td>
                <td className="num">{n(team.totals.month)}</td>
                <td colSpan={2} className="dim">{summaryNote(summary)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="hboard__foot">{windowNote(team)}</p>
    </>
  );
}

/** A row that is not counted shows why, where its figures would be — never a
 *  zero, which would be a claim that this person did nothing. */
function ReporteeRow({ r }: { r: TeamReportee }) {
  const state = rowState(r);

  return (
    <tr className={`hboard__r is-${state}`}>
      <td>
        <b>{r.name}</b>
        {r.title && <span className="sub">{r.title}</span>}
      </td>
      {state === "counted" ? (
        <>
          <td className="num">{n(r.today)}</td>
          <td className="num">{n(r.week)}</td>
          <td className="num">{n(r.month)}</td>
          <td><Chips chips={agentChips(r.by_agent)} who={r.name} /></td>
          <td className="dim">
            {r.last_run_at ? <span title={r.last_run_at}>{ago(r.last_run_at)}</span> : "—"}
          </td>
        </>
      ) : (
        <>
          <td colSpan={3}>
            <span className={`tag${state === "unread" ? " is-bad" : ""}`}>{ROW_NOTE[state]}</span>
          </td>
          <td className="dim">—</td>
          <td className="dim">—</td>
        </>
      )}
    </tr>
  );
}

/** The specialists one person used this month, busiest first; a dash when
 *  there is nothing to list. */
function Chips({ chips, who }: { chips: AgentChip[]; who: string }) {
  if (chips.length === 0) return <span className="dim">—</span>;
  return (
    <ul className="chips hboard__chips" aria-label={`Specialists ${who} used this month`}>
      {chips.map((c) => (
        <li key={c.id} className="chip" title={`${c.name}: ${n(c.count)} this month`}>
          <span className="chip__n">{n(c.count)}</span>{c.name}
        </li>
      ))}
    </ul>
  );
}

/* --- by humans, one month --- */

function MonthPanel({ month, excluded, generatedAt }: { month: HumansMonth; excluded: string; generatedAt: string }) {
  const users = usersByRuns(month.by_user);
  const label = monthLabel(month.year_month);
  const at = clock(generatedAt);

  return (
    <>
      <div className="hboard__figs">
        <p className="hboard__fig">
          <b>{n(month.runs)}</b>
          <span>run{month.runs === 1 ? "" : "s"}</span>
        </p>
        <p className="hboard__fig">
          <b>{n(month.users)}</b>
          <span>{month.users === 1 ? "person" : "people"}</span>
        </p>
        {at && <span className="hboard__as">as of {at}</span>}
      </div>
      {users.length === 0 ? (
        <p className="hboard__none">Nobody is on record for {label}.</p>
      ) : (
        <ol className="hboard__people" aria-label={`Who ran the specialists in ${label}`}>
          {users.map((u) => <Person key={u.user_id} u={u} />)}
        </ol>
      )}
      <p className="hboard__foot">{excluded}</p>
    </>
  );
}

/** Name, email dim, the specialists they used when the backend says which
 *  (absent or empty: no chips, which is not "no runs"), runs on the right.
 *  A person with no name is their email, said once. */
function Person({ u }: { u: HumansUser }) {
  const chips = agentChips(u.by_agent ?? {});
  return (
    <li>
      <span className="hboard__who">
        <b>{u.name || u.email}</b>
        {u.name && <em>{u.email}</em>}
      </span>
      {chips.length > 0 && <Chips chips={chips} who={u.name || u.email} />}
      <span className="num">{n(u.runs)}</span>
    </li>
  );
}

/* --- by humans, day by day --- */

const SPANS: readonly TrendSpan[] = [30, 60];

/** "Is it going up or down?" First the answer — the last seven complete days
 *  against the seven before, as a figure and a sentence — then the days
 *  themselves, so the answer can be checked against them. Down is said in
 *  ink: red in this console means something failed, and fewer runs is not a
 *  failure. */
function TrendPanel({ daily, excluded }: { daily: HumansDay[]; excluded: string }) {
  const [span, setSpan] = useState<TrendSpan>(30);
  const cmp = weekOverWeek(daily);
  const delta = deltaFigure(cmp);
  const days = trendSeries(daily, span);
  const today = days[days.length - 1];

  return (
    <div className="hbt">
      <div className="hboard__figs hbt__head">
        {cmp.kind === "compare" || cmp.days > 0 ? (
          <p className="hboard__fig">
            <b>{n(cmp.recent)}</b>
            <span>
              {cmp.kind === "short" && cmp.days < AVG_DAYS
                ? `run${cmp.recent === 1 ? "" : "s"} · last ${word(cmp.days)} full day${cmp.days === 1 ? "" : "s"}`
                : `run${cmp.recent === 1 ? "" : "s"} · last ${AVG_DAYS} full days`}
            </span>
          </p>
        ) : null}
        {cmp.kind === "compare" && delta && (
          <p className={`hbt__delta is-${cmp.dir}`}>
            <b>
              <Ic name={cmp.dir === "up" ? "up" : cmp.dir === "down" ? "down" : "flat"} />
              {delta}
            </b>
            {(cmp.pct !== null || cmp.recent === 0) && <span>vs the {AVG_DAYS} days before</span>}
          </p>
        )}
        {daily.length > SPANS[0] && (
          <div className="sg hbt__span" role="group" aria-label="Days on the chart">
            {SPANS.map((s) => (
              <button
                type="button"
                key={s}
                className={`sg__b${span === s ? " is-on" : ""}`}
                aria-pressed={span === s}
                onClick={() => setSpan(s)}
              >
                {s} days
              </button>
            ))}
          </div>
        )}
      </div>

      <p className="hbt__say">{weekSentence(cmp)}</p>

      <TrendChart days={days} />

      <ul className="hbt__key">
        <li><i className="hbt__sw hbt__sw--col" aria-hidden="true" />Runs a day</li>
        <li><i className="hbt__sw hbt__sw--avg" aria-hidden="true" />{AVG_DAYS}-day average</li>
        <li><i className="hbt__sw hbt__sw--today" aria-hidden="true" />Today, so far</li>
        <li><i className="hbt__sw hbt__sw--we" aria-hidden="true" />Weekend</li>
      </ul>

      <p className="hboard__foot">
        {today ? `Today, ${dayWithWeekday(today.day)}, is still going, so it is left out of both weeks and of the average. ` : ""}
        {excluded}
      </p>
    </div>
  );
}

/** The card's width, read before paint so the chart is drawn at its real size
 *  — text at its own size, columns at their own width — rather than a scaled
 *  picture of one. */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setW(el.clientWidth);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** Plot height including the x-axis band, so the card never scrolls inside.
 *  `.hbt__plot` in hub-live.css reserves the same height before the width is
 *  known. */
const CH = 136;
const CPAD = { t: 8, r: 2, b: 20 };

/** A rounded data end, square at the baseline. */
function columnPath(x: number, w: number, top: number, base: number): string {
  const h = base - top;
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  return `M${x} ${base}V${top + r}Q${x} ${top} ${x + r} ${top}H${x + w - r}Q${x + w} ${top} ${x + w} ${top + r}V${base}Z`;
}

/** One column a day with the 7-day average over it. Hover, or focus and use
 *  the arrow keys, for a day's readout; the same figures are in a table for
 *  screen readers, so nothing is reachable only by pointing. */
function TrendChart({ days }: { days: TrendDay[] }) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const uid = useId().replace(/[^\w-]/g, "");
  const [at, setAt] = useState<number | null>(null);
  const [keyed, setKeyed] = useState(false);

  const len = days.length;
  if (len === 0) return null;

  const cur = at === null ? null : Math.min(at, len - 1);
  const first = days[0];
  const last = days[len - 1];
  const quiet = days.every((d) => d.runs === 0);

  const ticks = yTicks(Math.max(...days.map((d) => Math.max(d.runs, d.avg ?? 0))));
  const top = ticks[2];
  const padL = Math.max(...ticks.map((t) => n(t).length)) * 6 + 8;
  const plotW = Math.max(0, width - padL - CPAD.r);
  const slot = plotW / len;
  const bw = Math.max(1, Math.min(24, slot - 2));
  const y = (v: number) => CPAD.t + (1 - v / top) * (CH - CPAD.t - CPAD.b);
  const y0 = y(0);
  const left = (i: number) => padL + i * slot;
  const cx = (i: number) => left(i) + slot / 2;

  let line = "";
  let pen = false;
  let end = -1;
  days.forEach((d, i) => {
    if (d.avg === null) {
      pen = false;
      return;
    }
    line += `${pen ? "L" : "M"}${cx(i).toFixed(1)} ${y(d.avg).toFixed(1)}`;
    pen = true;
    end = i;
  });

  // A label on a Monday, every week while there is room, every other (or
  // fewer) when the columns are thin — counted back from the latest, so the
  // newest week is always named.
  const every = Math.max(1, Math.ceil(64 / Math.max(slot * 7, 1)));
  const mondays = days.flatMap((d, i) => (d.monday ? [i] : [])).reverse();
  const labelled = mondays.filter((_, k) => k % every === 0).filter((i) => cx(i) - 16 >= 0 && cx(i) + 16 <= width);

  const indexAt = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || slot <= 0) return null;
    return Math.max(0, Math.min(len - 1, Math.floor((clientX - rect.left - padL) / slot)));
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    setKeyed(false);
    setAt(indexAt(e.clientX));
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = cur ?? len - 1;
    let next: number;
    if (e.key === "ArrowRight") next = Math.min(len - 1, i + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, i - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = len - 1;
    else return;
    e.preventDefault();
    setKeyed(true);
    setAt(next);
  };

  const read = cur === null ? null : days[cur];
  const tipLeft = cur !== null && cx(cur) < width / 2;

  return (
    <div
      ref={box}
      className="hbt__plot"
      tabIndex={0}
      role="group"
      aria-roledescription="chart"
      aria-label={`Runs a day by people, ${dayShort(first.day)} to ${dayShort(last.day)}. Arrow keys move from day to day.`}
      onPointerMove={onPointerMove}
      onPointerLeave={() => { if (!keyed) setAt(null); }}
      onFocus={(e) => {
        // Only a keyboard arrival opens a readout; a click lands with the
        // pointer already showing one.
        if (!e.currentTarget.matches(":focus-visible")) return;
        setKeyed(true);
        setAt((a) => a ?? len - 1);
      }}
      onBlur={() => { setKeyed(false); setAt(null); }}
      onKeyDown={onKey}
    >
      {width > 0 && (
        <svg width={width} height={CH} viewBox={`0 0 ${width} ${CH}`} aria-hidden="true" focusable="false">
          <defs>
            <pattern id={`hbt-hatch-${uid}`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect className="hbt__hatch-bg" width="4" height="4" />
              <line className="hbt__hatch-ln" x1="0" y1="0" x2="0" y2="4" />
            </pattern>
          </defs>

          {days.map((d, i) => d.weekend && (
            <rect key={`w${d.day}`} className="hbt__we" x={left(i)} y={CPAD.t} width={slot} height={y0 - CPAD.t} />
          ))}
          {cur !== null && <rect className="hbt__hl" x={left(cur)} y={CPAD.t} width={slot} height={y0 - CPAD.t} />}

          {ticks.slice(1).map((t) => (
            <line key={`g${t}`} className="hbt__grid" x1={padL} x2={width - CPAD.r} y1={Math.round(y(t)) + 0.5} y2={Math.round(y(t)) + 0.5} />
          ))}
          {ticks.map((t) => (
            <text key={`t${t}`} className="hbt__ax" x={padL - 6} y={y(t) + 3.5} textAnchor="end">{n(t)}</text>
          ))}

          {days.map((d, i) => {
            const p = columnPath(left(i) + (slot - bw) / 2, bw, y(d.runs), y0);
            if (!p) return null;
            // Today's count is partial, so its column is hatched rather than
            // solid. Inline, because the class's fill would outrank an attribute.
            return (
              <path
                key={`c${d.day}`}
                d={p}
                className={`hbt__col${i === cur ? " is-on" : ""}`}
                style={d.today ? { fill: `url(#hbt-hatch-${uid})` } : undefined}
              />
            );
          })}

          <line className="hbt__base" x1={padL} x2={width - CPAD.r} y1={Math.round(y0) + 0.5} y2={Math.round(y0) + 0.5} />

          {line && <path className="hbt__avg-halo" d={line} />}
          {line && <path className="hbt__avg" d={line} />}
          {end >= 0 && days[end].avg !== null && (
            <circle className="hbt__dot" cx={cx(end)} cy={y(days[end].avg ?? 0)} r="4" />
          )}

          {labelled.map((i) => (
            <text key={`x${days[i].day}`} className="hbt__ax" x={cx(i)} y={CH - 5} textAnchor="middle">
              {dayShort(days[i].day)}
            </text>
          ))}
        </svg>
      )}

      {quiet && <p className="hbt__calm">No human runs in these days.</p>}

      {read && cur !== null && width > 0 && (
        <div
          className="hbt__tip"
          style={tipLeft ? { left: left(cur) + slot + 6 } : { right: width - left(cur) + 6 }}
          aria-live={keyed ? "polite" : undefined}
        >
          <span className="hbt__tipday">{dayWithWeekday(read.day)}{read.today ? " · today, so far" : ""}</span>
          <span><i className="hbt__tk hbt__tk--col" aria-hidden="true" /><b>{n(read.runs)}</b> run{read.runs === 1 ? "" : "s"}</span>
          <span><i className="hbt__tk" aria-hidden="true" /><b>{n(read.people)}</b> {read.people === 1 ? "person" : "people"}</span>
          {read.avg !== null && (
            <span><i className="hbt__tk hbt__tk--avg" aria-hidden="true" /><b>{perDay(read.avg)}</b> a day, {AVG_DAYS}-day average</span>
          )}
        </div>
      )}

      <table className="vh">
        <caption>Agent runs by people, a day at a time, {dayShort(first.day)} to {dayShort(last.day)}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Runs</th>
            <th scope="col">People</th>
            <th scope="col">{AVG_DAYS}-day average</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <th scope="row">{dayWithWeekday(d.day)}{d.today ? " (today, so far)" : ""}</th>
              <td>{n(d.runs)}</td>
              <td>{n(d.people)}</td>
              <td>{d.avg === null ? "—" : perDay(d.avg)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------- the specialists module -- */

function GuideModule({
  agents, selected, onSelect, onBrief, onOpen,
}: {
  agents: HubAgent[];
  selected: string;
  onSelect: (id: string) => void;
  onBrief: (agentId: string) => void;
  onOpen: (agentId: string, section?: string) => void;
}) {
  const agent = agents.find((a) => a.id === selected) || agents[0];
  const guide = GUIDES[agent.id];
  const jobs = JOBS[agent.id] || [];

  return (
    <div className="hgm">
      <nav className="hgm__list" aria-label="Specialists">
        {agents.map((a) => (
          <button
            type="button"
            key={a.id}
            className={`hgm__row${a.id === agent.id ? " is-on" : ""}`}
            aria-current={a.id === agent.id ? "true" : undefined}
            onClick={() => onSelect(a.id)}
          >
            <span className="hgm__ic" data-a={a.id} aria-hidden="true"><Ic name={a.id} /></span>
            <span className="hgm__who">
              <b>{a.name}</b>
              <em>{a.role}</em>
            </span>
          </button>
        ))}
      </nav>

      <article className="hgm__detail" key={agent.id}>
        <header className="hgm__head">
          <span className="hgm__badge" data-a={agent.id} aria-hidden="true"><Ic name={agent.id} /></span>
          <div className="hgm__id">
            <b>{agent.name}</b>
            <em>{agent.desc}</em>
          </div>
          <span className="hgm__acts">
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => onOpen(agent.id)}>
              Open workspace
            </button>
          </span>
        </header>

        {guide && (
          <div className="hg__manual">
            <p className="hg__when">
              <b>Reach for it when:</b> {guide.when}
            </p>

            <ol className="hg__steps">
              {guide.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>

            <p className="hg__gets">
              <b>You get:</b> {guide.gets}
            </p>

            {guide.tip && (
              <p className="hg__tip">
                <b>Worth knowing:</b> {guide.tip}
              </p>
            )}

            {jobs.length > 0 && (
              <div className="hg__jobs" aria-label={`Ready-made jobs for ${agent.name}`}>
                {jobs.map((j) => (
                  <button
                    type="button"
                    key={j.label}
                    className="hg__job"
                    title={j.brief || `Opens ${agent.name} at ${j.label}`}
                    onClick={() => (j.brief ? onBrief(agent.id) : onOpen(agent.id, j.section))}
                  >
                    <b>{j.label}</b>
                    <span>{j.spec}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </article>
    </div>
  );
}

/* ------------------------------------------------------------------- FAQ -- */

/** One open at a time: reading two answers at once is never the goal, and a
 *  page of all-open accordions is just a long document with extra chrome. */
function Faqs() {
  const [open, setOpen] = useState<number | null>(null);

  return (
    <div className="hgfaq">
      {FAQS.map((f, i) => (
        <details
          key={f.q}
          open={open === i}
          onToggle={(e) => {
            if ((e.target as HTMLDetailsElement).open) setOpen(i);
            else if (open === i) setOpen(null);
          }}
        >
          <summary>
            {f.q}
            <Ic name="plus" />
          </summary>
          <p>{f.a}</p>
        </details>
      ))}
    </div>
  );
}
