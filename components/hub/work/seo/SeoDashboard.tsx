"use client";

/** The per-brand SEO dashboard — drawn fresh for the revamp.
 *
 *  One screen that answers the brand's four questions at a glance: how
 *  healthy is search (the dial), which way are clicks going (the trend),
 *  how much is still on the table (the share ring), and what should somebody
 *  do today (the queue and the opportunity bars). Every mark follows the
 *  house chart rules: one hue for magnitude, status colours only for state,
 *  text in ink tokens, thin marks with rounded ends, a hover layer on the
 *  trend, and no second y-axis anywhere.
 *
 *  Every figure here is one the backend measured. The backend keeps no click
 *  history — only the last 28 days and the 28 before — so the trend is drawn
 *  as exactly those two periods, never as an invented weekly line. A brand
 *  without Search Console (rank-tracking mode, or a run that could not reach
 *  it) has no click or impression figures, and the page says so instead of
 *  scoring zeros as if they were measurements.
 */

import { useEffect, useState } from "react";
import { seoBrandDetail, type SeoBrandCard, type SeoRun, type SeoTodo } from "@/lib/api";
import { loadPending, useLoadSession, type Load } from "@/lib/load";
import { GSC_CONNECT_UNAVAILABLE, gscNotice, plainNotes, readGsc } from "@/components/console/seo/seo";
import { useHub } from "../../context";
import { n } from "../../model";
import { Blank, Oops, Wait } from "../../ui";

/* ------------------------------------------------------------ derivation -- */

/** What the run actually measured. Clicks and impressions exist only with a
 *  Search Console grant; `avg_position` is 0 from the backend when nothing
 *  was ranked, which is "unknown", not "first". */
function measured(run: SeoRun): { traffic: boolean; position: boolean } {
  const s = run.summary;
  return {
    traffic: s.mode !== "rank-tracking" && s.impressions_28d > 0,
    position: s.avg_position > 0,
  };
}

/** 0–100, from the figures on screen: position carries half, trend a third,
 *  the open queue the rest. Stated here so the dial is checkable, not vibes.
 *  Only called when the position is known; without traffic the trend term
 *  sits at its neutral middle rather than reading a 0→0 as "no change". */
function healthScore(run: SeoRun): number {
  const pos = Math.max(0, Math.min(50, ((30 - Math.min(30, run.summary.avg_position)) / 29) * 50));
  const delta = run.summary.clicks_28d - run.summary.clicks_prev_28d;
  const trend = Math.max(0, Math.min(30, 15 + (delta / Math.max(1, run.summary.clicks_prev_28d)) * 100));
  const open = run.todos.filter((t) => t.status !== "done").length;
  const queue = Math.max(0, 20 - open * 2);
  return Math.round(pos + trend + queue);
}

/* ------------------------------------------------------------------ dial -- */

/** The radial dial: a 240° arc, track in rule, progress in the one hue. */
function Dial({ value, label, sub }: { value: number; label: string; sub: string }) {
  const r = 84;
  const cx = 110, cy = 104;
  const start = (-210 * Math.PI) / 180;
  const end = (30 * Math.PI) / 180;
  const sweep = end - start;
  const pt = (ang: number) => [cx + r * Math.cos(ang), cy + r * Math.sin(ang)];
  const arc = (from: number, to: number) => {
    const [x1, y1] = pt(from);
    const [x2, y2] = pt(to);
    const large = to - from > Math.PI ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  };
  const prog = start + sweep * (Math.max(0, Math.min(100, value)) / 100);
  return (
    <div className="sdb-dial">
      <svg viewBox="0 0 220 150" role="img" aria-label={`${label}: ${value} of 100`}>
        <path d={arc(start, end)} className="sdb-dial__track" />
        <path d={arc(start, prog)} className="sdb-dial__arc" />
        {[0, 25, 50, 75, 100].map((t) => {
          const a = start + sweep * (t / 100);
          const [x1, y1] = [cx + (r - 7) * Math.cos(a), cy + (r - 7) * Math.sin(a)];
          const [x2, y2] = [cx + (r + 1) * Math.cos(a), cy + (r + 1) * Math.sin(a)];
          return <line key={t} x1={x1} y1={y1} x2={x2} y2={y2} className="sdb-dial__tick" />;
        })}
        <circle cx={pt(prog)[0]} cy={pt(prog)[1]} r="6" className="sdb-dial__dot" />
      </svg>
      <div className="sdb-dial__read">
        <b>{value}</b>
        <span>{label}</span>
        <em>{sub}</em>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- trend -- */

/** The two periods the backend actually has, side by side. Bars scale to the
 *  larger of the two; a pair of zeros draws two empty tracks, never NaN. */
function PeriodBars({ prev, last }: { prev: number; last: number }) {
  const max = Math.max(prev, last, 1);
  const rows: [string, number, boolean][] = [
    ["previous 28 days", prev, false],
    ["last 28 days", last, true],
  ];
  return (
    <div className="sdb-pair" role="img" aria-label={`Clicks: ${n(prev)} in the previous 28 days, ${n(last)} in the last 28`}>
      {rows.map(([label, v, now]) => (
        <div className={`sdb-pair__row${now ? " is-now" : ""}`} key={label}>
          <span className="sdb-pair__label">{label}</span>
          <span className="sdb-pair__bar"><i style={{ width: `${(v / max) * 100}%` }} /></span>
          <b className="sdb-pair__val">{n(v)}</b>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ share ring -- */

function ShareRing({ captured, potential }: { captured: number; potential: number }) {
  const total = captured + potential;
  const pct = total ? captured / total : 0;
  const r = 62, C = 2 * Math.PI * r;
  const gap = 4; // px of breathing room between the two segments, both ends
  const seg1 = Math.max(0, C * pct - gap);
  const seg2 = Math.max(0, C * (1 - pct) - gap);
  return (
    <div className="sdb-ring">
      <svg viewBox="0 0 160 160" role="img" aria-label={`Captured ${Math.round(pct * 100)} percent of estimated monthly clicks`}>
        <g transform="rotate(-90 80 80)">
          <circle cx="80" cy="80" r={r} className="sdb-ring__a" strokeDasharray={`${seg1} ${C - seg1}`} strokeDashoffset={0} />
          <circle cx="80" cy="80" r={r} className="sdb-ring__b" strokeDasharray={`${seg2} ${C - seg2}`} strokeDashoffset={-(seg1 + gap)} />
        </g>
      </svg>
      <div className="sdb-ring__read">
        <b>{Math.round(pct * 100)}%</b>
        <span>captured</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------- position track -- */

/** The linear dial: average position on a 1→30 run, lower is better. */
function PositionTrack({ pos }: { pos: number }) {
  const clamped = Math.max(1, Math.min(30, pos));
  const pct = ((clamped - 1) / 29) * 100;
  return (
    <div className="sdb-track" role="img" aria-label={`Average position ${pos.toFixed(1)} on a 1 to 30 scale`}>
      <div className="sdb-track__bar">
        <i className="sdb-track__zone is-a" /><i className="sdb-track__zone is-b" /><i className="sdb-track__zone is-c" />
        <span className="sdb-track__pin" style={{ left: `${pct}%` }}><b>{pos.toFixed(1)}</b></span>
      </div>
      <div className="sdb-track__scale"><span>1</span><span>10</span><span>20</span><span>30</span></div>
    </div>
  );
}

/* ------------------------------------------------------------- the queue -- */

function FixQueue({ todos }: { todos: SeoTodo[] }) {
  const done = todos.filter((t) => t.status === "done").length;
  const assigned = todos.filter((t) => t.status === "assigned").length;
  const open = todos.length - done - assigned;
  const total = Math.max(1, todos.length);
  const seg = (v: number) => `${(v / total) * 100}%`;
  return (
    <div className="sdb-queue">
      <div className="sdb-queue__bar" role="img" aria-label={`${done} done, ${assigned} assigned, ${open} open`}>
        {done > 0 && <i className="is-done" style={{ width: seg(done) }} />}
        {assigned > 0 && <i className="is-assigned" style={{ width: seg(assigned) }} />}
        {open > 0 && <i className="is-open" style={{ width: seg(open) }} />}
      </div>
      <div className="sdb-queue__legend">
        <span><i className="is-done" />Done <b>{done}</b></span>
        <span><i className="is-assigned" />Assigned <b>{assigned}</b></span>
        <span><i className="is-open" />Open <b>{open}</b></span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- opportunity bars -- */

function OppBars({ todos }: { todos: SeoTodo[] }) {
  const rows = todos
    .filter((t) => t.status !== "done" && t.est_monthly_clicks)
    .sort((a, b) => (b.est_monthly_clicks || 0) - (a.est_monthly_clicks || 0))
    .slice(0, 5);
  const max = Math.max(...rows.map((r) => r.est_monthly_clicks || 0), 1);
  if (!rows.length) return <p className="sdb-calm">Nothing open carries a click estimate.</p>;
  return (
    <div className="sdb-opps">
      {rows.map((t) => (
        <div className="sdb-opp" key={t.id} title={`${t.action} — ${t.why}`}>
          <span className="sdb-opp__name">{t.page}</span>
          <span className="sdb-opp__bar">
            <i style={{ width: `${((t.est_monthly_clicks || 0) / max) * 100}%` }} />
          </span>
          <b className="sdb-opp__val">+{n(t.est_monthly_clicks || 0)}/mo</b>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- the page -- */

export function SeoDashboard({ card, connectReady }: {
  card: SeoBrandCard;
  /** `sources.gsc_connect`: whether the console's Connect button works on
   *  this server. Without it, the notice offers no way in that leads nowhere. */
  connectReady: boolean;
}) {
  const { openWork, revision } = useHub();
  const session = useLoadSession();
  const [detail, setDetail] = useState<Load<{ run: SeoRun | null }>>(loadPending);
  const [beat, setBeat] = useState(0);
  const brandId = card.brand.id;

  useEffect(() => {
    void session.run(
      `seo-detail-${brandId}`,
      (s) => seoBrandDetail(brandId, { signal: s }),
      setDetail,
      "The brand's record could not be read.",
      { keepStale: true },
    );
  }, [session, brandId, revision, beat]);

  const run = detail.data?.run ?? null;

  if (detail.phase === "failed" && !detail.data) {
    return <Oops what="The brand's record could not be read." error={detail.error || ""} onRetry={() => setBeat((b) => b + 1)} />;
  }
  if (detail.phase === "loading" && !detail.data) return <Wait what="Reading the record" rows={4} />;

  if (!run) {
    return (
      <Blank title="No crawl on record for this brand yet.">
        Run the first crawl from the console and this dashboard fills itself — health, trend, the
        fix queue, the lot.
      </Blank>
    );
  }

  const s = run.summary;
  const has = measured(run);
  const delta = s.clicks_28d - s.clicks_prev_28d;
  const deltaPct = s.clicks_prev_28d ? Math.round((delta / s.clicks_prev_28d) * 100) : null;
  const score = has.position ? healthScore(run) : null;
  const openFixes = run.todos.filter((t) => t.status !== "done").length;
  const gsc = readGsc(card.gsc, card.gsc_connected);
  const notice = gscNotice(gsc, s);
  // With the "not connected" line up, the run's own Search Console note would
  // say the same thing twice and point at a button this page does not have.
  const notes = plainNotes(notice === "off"
    ? run.degraded.filter((d) => !(typeof d === "string" && d.startsWith("Search Console")))
    : run.degraded, {
    site: card.brand.domain || "this site",
    gsc: gsc.connected ? "connected" : connectReady ? "connectable" : "unavailable",
  });

  return (
    <div className="sdb">
      {/* what this run could not measure — in plain sentences, never the
          exception text the run recorded */}
      {(notice !== "measured" || notes.length > 0) && (
        <div className="sdb-notice" role="status">
          {notice === "off" && (
            <p>
              <b>Search Console is not connected</b> — positions come from live rank tracking only;
              clicks and impressions are not measured for this brand.
              {connectReady ? (
                <button type="button" className="sdb-link" onClick={() => openWork("seo", brandId, "console")}>
                  Connect it in the console
                </button>
              ) : (
                <> {GSC_CONNECT_UNAVAILABLE}</>
              )}
            </p>
          )}
          {notice === "pending" && (
            <p>
              <b>Search Console is connected</b> — these figures don&apos;t include it yet. Refresh the
              data in the console to pull clicks and impressions.
              <button type="button" className="sdb-link" onClick={() => openWork("seo", brandId, "console")}>
                Open the console
              </button>
            </p>
          )}
          {notes.map((d) => <p key={d}>{d}</p>)}
        </div>
      )}

      {/* the four headline figures */}
      <div className="sdb-tiles">
        <div className="sdb-tile">
          <span>Clicks · 28d</span>
          <b>{has.traffic ? n(s.clicks_28d) : "—"}</b>
          {has.traffic && deltaPct !== null ? (
            <em className={delta >= 0 ? "is-up" : "is-down"}>
              {delta >= 0 ? "▲" : "▼"} {n(Math.abs(delta))} · {deltaPct >= 0 ? "+" : ""}{deltaPct}%
            </em>
          ) : (
            <em>{has.traffic ? "no previous period to compare" : "not measured"}</em>
          )}
        </div>
        <div className="sdb-tile">
          <span>Impressions · 28d</span>
          <b>{has.traffic ? n(s.impressions_28d) : "—"}</b>
          <em>{has.traffic ? `${(s.clicks_28d / s.impressions_28d * 100).toFixed(1)}% click-through` : "not measured"}</em>
        </div>
        <div className="sdb-tile">
          <span>Avg position</span>
          <b>{has.position ? s.avg_position.toFixed(1) : "—"}</b>
          <em>{has.position ? "across ranked queries" : "nothing ranked yet"}</em>
        </div>
        <div className="sdb-tile">
          <span>Still on the table</span>
          <b>+{n(s.est_potential_clicks)}</b>
          <em>est. clicks/mo across the fix list</em>
        </div>
      </div>

      <div className="sdb-grid">
        {/* the dial */}
        <section className="sdb-card sdb-card--dial">
          <header><h3>Search health</h3><p>position + trend + queue, scored</p></header>
          {score !== null ? (
            <Dial
              value={score}
              label="of 100"
              sub={openFixes ? `${openFixes} open fix${openFixes === 1 ? "" : "es"} hold it back` : "nothing holding it back"}
            />
          ) : (
            <p className="sdb-calm">Not scored: no ranked position has been measured for this brand yet.</p>
          )}
        </section>

        {/* the trend: the two periods the backend has, nothing invented between */}
        <section className="sdb-card sdb-card--trend">
          <header>
            <h3>Clicks, period over period</h3>
            <p>the last 28 days against the 28 before — the only two figures the record holds</p>
          </header>
          {has.traffic
            ? <PeriodBars prev={s.clicks_prev_28d} last={s.clicks_28d} />
            : <p className="sdb-calm">No click figures without Search Console.</p>}
        </section>

        {/* the share ring */}
        <section className="sdb-card sdb-card--ring">
          <header><h3>Clicks captured</h3><p>of today's estimated monthly total</p></header>
          {has.traffic ? (
            <>
              {/* both figures on a monthly footing: 28d clicks × (30.4 / 28) ≈ ×1.08 */}
              <ShareRing captured={Math.round(s.clicks_28d * 1.08)} potential={s.est_potential_clicks} />
              <div className="sdb-ring__legend">
                <span><i className="is-a" />Captured <b>{n(Math.round(s.clicks_28d * 1.08))}</b>/mo</span>
                <span><i className="is-b" />Untapped <b>+{n(s.est_potential_clicks)}</b>/mo</span>
              </div>
            </>
          ) : (
            <p className="sdb-calm">No captured-click figure without Search Console.</p>
          )}
        </section>

        {/* the position track */}
        <section className="sdb-card sdb-card--track">
          <header><h3>Average position</h3><p>lower is better; page one ends at 10</p></header>
          {has.position
            ? <PositionTrack pos={s.avg_position} />
            : <p className="sdb-calm">Nothing ranked has been measured yet.</p>}
        </section>

        {/* the queue */}
        <section className="sdb-card sdb-card--queue">
          <header>
            <h3>Fix queue</h3>
            <button type="button" className="sdb-link" onClick={() => openWork("seo", brandId, "console")}>
              Work the list
            </button>
          </header>
          <FixQueue todos={run.todos} />
        </section>

        {/* the opportunities */}
        <section className="sdb-card sdb-card--opps">
          <header>
            <h3>Biggest open opportunities</h3>
            <p>est. monthly clicks each open fix is worth</p>
          </header>
          <OppBars todos={run.todos} />
        </section>
      </div>
    </div>
  );
}
