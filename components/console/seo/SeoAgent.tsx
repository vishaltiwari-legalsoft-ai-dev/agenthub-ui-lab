"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  seoAnalyzeSite, seoBrandDetail, seoDeleteBrand, seoOauthDisconnect, seoOauthStart,
  seoPages, seoPagesRefresh, seoRunBrand, seoSaveBrand, seoSetTodoStatus,
  type SeoBrand, type SeoGa, type SeoGscStatus, type SeoOverview, type SeoPagesDoc, type SeoPlanItem,
  type SeoRun, type SeoSiteReview, type SeoTodoStatus,
} from "@/lib/api";
import type { ToastFn } from "@/components/console/ConsoleApp";
import { useAuth } from "@/lib/auth";
import { Icon } from "@/lib/kit-ui";
import { useLoadSession } from "@/lib/load";
import { AskView, AuditView, BriefsView, CompetitorsView, KeywordsView, UpdatePlanButton } from "./labs";
import { loadSeoOverview } from "./overview";
import {
  gscFailure, gscSlot, notShownLine, plainFailure, plainMessage, plainNotes, readGsc, todoCategoryLabel, todoPage,
  type NoteContext,
} from "./seo";
import { HiddenSuggestions, PageRow, PlanStrip, ReviewDropped, TodoPages, TopicRow, type SeeFix } from "./rows";

type SeoTool = "ask" | "keywords" | "briefs" | "audit";

const TOOL_LABELS: Record<SeoTool, string> = {
  ask: "Ask the analyst",
  keywords: "Keyword lab",
  briefs: "Content briefs",
  audit: "Site audit",
};

/** SEO agent (a2) — per-brand insights, traffic-estimated to-dos, blog topic lab. */

const fmt = (n: number) => n.toLocaleString("en-US");

function shortPage(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? u.hostname : u.pathname;
  } catch {
    return url;
  }
}

function Delta({ now, prev }: { now: number; prev: number }) {
  const diff = now - prev;
  if (!prev && !now) return null;
  const dir = diff >= 0 ? "up" : "down";
  return (
    <span className={`seo-delta seo-delta--${dir}`}>
      <Icon name={diff >= 0 ? "trending-up" : "trending-down"} size={13} />
      {fmt(Math.abs(diff))}
    </span>
  );
}

/** What this run could not reach, as plain sentences — never the exception
 *  text the backend recorded (`seo.ts`, `plainNotes`). */
function DegradedNotes({ notes, ctx }: { notes: readonly unknown[]; ctx: NoteContext }) {
  const friendly = plainNotes(notes, ctx);
  if (!friendly.length) return null;
  return (
    <div className="seo-degraded">
      <Icon name="alert-triangle" size={14} />
      <div>{friendly.map((n, i) => <div key={i}>{n}</div>)}</div>
    </div>
  );
}

function PagesView({ doc, busy, error, onRefresh, noteCtx, todos, onSeeFix }: {
  doc: SeoPagesDoc | null; busy: boolean; error: string | null; onRefresh: () => void; noteCtx: NoteContext;
  /** The run's Fix list, for the links from advice that moved there. */
  todos: SeoRun["todos"]; onSeeFix: SeeFix;
}) {
  if (!doc) {
    return (
      <div className="mr-section">
        {error ? (
          // A failed load used to render as "run the site analysis first",
          // which reads as "there is nothing here" and sends the user into an
          // action that was never the problem.
          <div className="seo-degraded">
            <Icon name="alert-triangle" size={14} />
            <div>
              <div><strong>Couldn&apos;t load the pages for this brand.</strong></div>
              <div>{error}</div>
            </div>
          </div>
        ) : (
          <div className="seo-empty">Run the site analysis first — then refresh this tab.</div>
        )}
        <button className="seo-btn seo-btn--primary" disabled={busy} onClick={onRefresh}>
          <Icon name="refresh-cw" size={13} /> {error ? "Try again" : "Refresh"}
        </button>
      </div>
    );
  }
  return (
    <div className="mr-section">
      <div className="seo-lab__head">
        <h3 className="mr-section__title">Pages — {fmt(doc.pages.length)} tracked · {doc.at}</h3>
        <button className="seo-btn seo-btn--primary" disabled={busy} onClick={onRefresh}>
          <Icon name="refresh-cw" size={13} /> Refresh
        </button>
      </div>
      {/* the pages doc forwards the run's Search Console / Analytics failures */}
      <DegradedNotes notes={doc.notes} ctx={noteCtx} />
      <HiddenSuggestions grounding={doc.grounding} fixItems={doc.fix_items} todos={todos} onSeeFix={onSeeFix} />
      {doc.pages.length === 0 && (
        <div className="seo-empty">No pages found — run the site analysis, then refresh this tab.</div>
      )}
      {doc.pages.map((p) => <PageRow key={p.path} p={p} />)}
    </div>
  );
}

function pctPhrase(now: number, prev: number): string {
  if (!prev) return "";
  const d = Math.round(((now - prev) / prev) * 100);
  if (d === 0) return "steady vs the month before";
  return d > 0 ? `up ${d}% vs the month before` : `down ${Math.abs(d)}% vs the month before`;
}

/** The panel speaks first: what happened, in sentences a busy owner can read in 5 seconds. */
function Story({ run }: { run: SeoRun | null }) {
  if (!run) {
    return (
      <div className="seo-story">
        <p>No analysis yet. Hit <strong>Refresh data</strong> and this page will tell you exactly what to do next.</p>
      </div>
    );
  }
  const ga = run.ga;
  if (ga) {
    const lead = ga.key_events.find((e) => e.event === "generate_lead");
    const organic = ga.channels.find((c) => c.channel === "Organic Search");
    const organicRank = organic ? ga.channels.filter((c) => c.sessions > organic.sessions).length + 1 : 0;
    const trend = pctPhrase(ga.totals.sessions, ga.prev_totals.sessions);
    return (
      <div className="seo-story">
        <p>
          <strong>{fmt(ga.totals.sessions)} people</strong> visited your site in the last 28 days
          {trend ? ` — ${trend}` : ""}.
        </p>
        <p>
          {lead && <><strong>{fmt(lead.count)}</strong> became leads. </>}
          {organic && (
            <>Google search brought <strong>{fmt(organic.sessions)}</strong> of them
              {organicRank > 0 ? ` — your #${organicRank} traffic source` : ""}.</>
          )}
        </p>
      </div>
    );
  }
  if (run.summary.mode === "rank-tracking") {
    return (
      <div className="seo-story">
        <p>
          <strong>{run.summary.top10 ?? 0} of {run.summary.tracked ?? 0}</strong> keywords we track are on
          page 1 of Google. The plan below is the fastest way to add more.
        </p>
      </div>
    );
  }
  const trend = pctPhrase(run.summary.clicks_28d, run.summary.clicks_prev_28d);
  return (
    <div className="seo-story">
      <p>
        <strong>{fmt(run.summary.clicks_28d)} visits came from Google</strong> in the last 28 days
        {trend ? ` — ${trend}` : ""}.
      </p>
    </div>
  );
}

/** A quiet, collapsed section: the headline carries the takeaway, the body carries the detail.
 *  `open` + `onToggle` make it controlled — the Fix list opens itself when a
 *  "See Fix list #n" link points into it. */
function Fold({ title, hint, count, defaultOpen = false, open: controlled, onToggle, children }: {
  title: string; hint?: string; count?: number; defaultOpen?: boolean;
  open?: boolean; onToggle?: (open: boolean) => void; children: ReactNode;
}) {
  const [own, setOwn] = useState(defaultOpen);
  const open = controlled ?? own;
  const toggle = () => (onToggle ? onToggle(!open) : setOwn((v) => !v));
  return (
    <div className="seo-fold">
      <button className="seo-fold__head" onClick={toggle} aria-expanded={open}>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
        <span className="seo-fold__title">{title}</span>
        {count != null && count > 0 && <span className="seo-fold__count">{fmt(count)}</span>}
        {hint && !open && <span className="seo-fold__hint">{hint}</span>}
      </button>
      {open && <div className="seo-fold__body">{children}</div>}
    </div>
  );
}

function GaSection({ ga }: { ga: SeoGa }) {
  const t = ga.totals;
  const p = ga.prev_totals;
  return (
    <div className="mr-section">
      <h3 className="mr-section__title">
        Website analytics · 28d
        <span className="seo-ga__src">{ga.property_name || "Google Analytics"}</span>
      </h3>
      <div className="seo-summary">
        <div className="seo-stat">
          <span className="seo-stat__label">Sessions</span>
          <span className="seo-stat__num">{fmt(t.sessions)}<Delta now={t.sessions} prev={p.sessions} /></span>
        </div>
        <div className="seo-stat">
          <span className="seo-stat__label">Visitors</span>
          <span className="seo-stat__num">{fmt(t.users)}<Delta now={t.users} prev={p.users} /></span>
        </div>
        <div className="seo-stat">
          <span className="seo-stat__label">New visitors</span>
          <span className="seo-stat__num">{fmt(t.new_users)}</span>
        </div>
        <div className="seo-stat">
          <span className="seo-stat__label">Engagement</span>
          <span className="seo-stat__num">{Math.round(t.engagement_rate * 100)}%</span>
        </div>
        <div className="seo-stat">
          <span className="seo-stat__label">Pageviews</span>
          <span className="seo-stat__num">{fmt(t.pageviews)}<Delta now={t.pageviews} prev={p.pageviews} /></span>
        </div>
      </div>
      {(ga.top_pages.length > 0 || ga.channels.length > 0) && (
        <div className="seo-ga__cols">
          {ga.top_pages.length > 0 && (
            <div>
              <div className="seo-lab__meta">Most visited pages</div>
              <ul className="seo-ga__list">
                {ga.top_pages.map((pg) => (
                  <li key={pg.path}>
                    <span className="seo-ga__name" title={pg.path}>{pg.path}</span>
                    <span className="seo-ga__num">{fmt(pg.views)} views</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {ga.channels.length > 0 && (
            <div>
              <div className="seo-lab__meta">Where traffic comes from</div>
              <ul className="seo-ga__list">
                {ga.channels.map((c) => (
                  <li key={c.channel}>
                    <span className="seo-ga__name">{c.channel}</span>
                    <span className="seo-ga__num">
                      {fmt(c.sessions)}
                      <Delta now={c.sessions} prev={c.prev_sessions} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {ga.key_events.length > 0 && (
        <>
          <div className="seo-lab__meta">Key events (conversions)</div>
          <div className="seo-cluster__kws">
            {ga.key_events.map((e) => (
              <span key={e.event} className="seo-chip seo-chip--on">{e.event} · {fmt(e.count)}</span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function AddBrandForm({ onSaved, onToast }: { onSaved: () => void; onToast: ToastFn }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [seeds, setSeeds] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await seoSaveBrand({
        name,
        domain,
        seeds: seeds.split(",").map((s) => s.trim()).filter(Boolean),
      });
      onToast(`${name} added — run its first analysis`);
      setOpen(false);
      setName(""); setDomain(""); setSeeds("");
      onSaved();
    } catch (e) {
      onToast(plainFailure(e, "Could not save brand"), "error");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="seo-card seo-card--add" onClick={() => setOpen(true)}>
        <Icon name="plus" size={18} />
        <span>Add a brand site</span>
      </button>
    );
  }
  return (
    <div className="seo-card seo-card--form">
      <input className="seo-input" placeholder="Brand name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="seo-input" placeholder="Site domain, e.g. brand.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
      <input className="seo-input" placeholder="Seed keywords, comma separated" value={seeds} onChange={(e) => setSeeds(e.target.value)} />
      <div className="seo-form__row">
        <button className="seo-btn seo-btn--primary" disabled={busy || !name || !domain} onClick={() => void save()}>
          Save brand
        </button>
        <button className="seo-btn" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

export function SeoAgent({ onToast, onBack, focusBrand, onFocused, onBrandChange }: {
  onToast: ToastFn;
  onBack: () => void;
  /** A brand to open on arrival — set by the workspace when Google sends the
   *  reader back from Connect Search Console, or when the dashboard sends
   *  them here for one brand, so they land on it rather than the list. */
  focusBrand?: string;
  /** Called once `focusBrand` is being opened, so the workspace can let go of
   *  it and a later visit to the console starts at the brand list again. */
  onFocused?: () => void;
  /** The brand the console is opening or showing — null for the list — so
   *  the workspace's header and brand switcher follow it. */
  onBrandChange?: (id: string | null) => void;
}) {
  const { user } = useAuth();
  const [overview, setOverview] = useState<SeoOverview | null>(null);
  const [brand, setBrand] = useState<SeoBrand | null>(null);
  const [run, setRun] = useState<SeoRun | null>(null);
  const [gsc, setGsc] = useState<SeoGscStatus | null>(null);
  const [plan, setPlan] = useState<SeoPlanItem[]>([]);
  const [siteReview, setSiteReview] = useState<SeoSiteReview | null>(null);
  const [siteBusy, setSiteBusy] = useState(false);
  const [pagesDoc, setPagesDoc] = useState<SeoPagesDoc | null>(null);
  const [pagesBusy, setPagesBusy] = useState(false);
  const [pagesError, setPagesError] = useState<string | null>(null);
  /** The brand whose detail is being fetched right now, for the card's cue. */
  const [opening, setOpening] = useState<string | null>(null);
  const [tool, setTool] = useState<SeoTool | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAllTodos, setShowAllTodos] = useState(false);
  const [showAvoided, setShowAvoided] = useState(false);
  /** Set from the click until the browser leaves for Google. */
  const [connecting, setConnecting] = useState(false);
  /** The Fix list's fold, and the item a "See Fix list #n" link points at. */
  const [fixOpen, setFixOpen] = useState(false);
  const [fixFocus, setFixFocus] = useState<string | null>(null);

  const session = useLoadSession();

  /** `fresh` after a write that changes the brands; the first read joins the
   *  workspace's, so a page load asks the backend once (`overview.ts`). */
  const refreshOverview = useCallback(async (fresh = true) => {
    const attempt = session.begin("overview");
    try {
      const next = await loadSeoOverview({ signal: attempt.signal, fresh });
      if (attempt.current()) setOverview(next);
    } catch (e) {
      const message = attempt.failure(e, "Couldn't load the SEO overview");
      if (message) onToast(plainMessage(message, "Couldn't load the SEO overview"), "error");
    }
  }, [onToast, session]);

  useEffect(() => { void refreshOverview(false); }, [refreshOverview]);

  /** The brand actually on screen. A ref, not the `brand` state: these handlers
   *  resume after an await and their captured `brand` is whatever it was when
   *  the click happened, which is exactly the value that must not be trusted. */
  const shownBrandId = useRef<string | null>(null);
  useEffect(() => { shownBrandId.current = brand?.id ?? null; }, [brand]);

  /** Two chained requests write into seven pieces of shared state, so without a
   *  ticket a slower brand A lands after the user has opened brand B and every
   *  panel below B's name is A's data. This was one of only three modules that
   *  got that right by hand; the slot is the same discipline, minus the
   *  `RequestSequence` ref and the unmount cleanup it needed. */
  /** Open the Fix list at one item: past the top ten if it must, scrolled
   *  into view, focused for the keyboard, and briefly highlighted. */
  const seeFix = useCallback<SeeFix>((todoId) => {
    const at = run?.todos.findIndex((t) => t.id === todoId) ?? -1;
    if (at < 0) return;
    setFixOpen(true);
    if (at >= 10) setShowAllTodos(true);
    setFixFocus(todoId);
  }, [run]);
  useEffect(() => {
    if (!fixFocus) return;
    const frame = requestAnimationFrame(() => {
      const el = document.getElementById(`seo-fix-${fixFocus}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.focus({ preventScroll: true });
    });
    const done = setTimeout(() => setFixFocus(null), 2400);
    return () => { cancelAnimationFrame(frame); clearTimeout(done); };
  }, [fixFocus]);

  /** Back to the brand list. */
  function closeBrand() {
    setBrand(null);
    setRun(null);
    onBrandChange?.(null);
  }

  async function openBrand(id: string) {
    const attempt = session.begin("brand");
    setOpening(id);
    onBrandChange?.(id);
    try {
      const detail = await seoBrandDetail(id, { signal: attempt.signal });
      if (!attempt.current()) return; // a newer brand owns the screen
      setBrand(detail.brand);
      setRun(detail.run);
      setGsc(detail.gsc ?? null);
      setPlan(detail.plan ?? []);
      setSiteReview(detail.site_review ?? null);
      setTool(null);
      setShowAllTodos(false);
      setPagesDoc(null);
      setPagesError(null);
      try {
        const pagesRes = await seoPages(id, { signal: attempt.signal });
        if (!attempt.current()) return;
        setPagesDoc(pagesRes.pages);
      } catch (e) {
        const failed = attempt.failure(e, "Could not load pages");
        if (!failed) return;
        const msg = plainMessage(failed, "Could not load pages");
        setPagesDoc(null);
        setPagesError(msg);
        onToast(msg, "error");
      }
    } catch (e) {
      // the brand did not open: the header goes back to what is on screen
      if (attempt.current()) onBrandChange?.(shownBrandId.current);
      const msg = attempt.failure(e, "Failed to load brand");
      if (msg) onToast(plainMessage(msg, "Failed to load brand"), "error");
    } finally {
      if (attempt.current()) setOpening(null);
    }
  }

  async function refreshPages(id: string) {
    setPagesBusy(true);
    try {
      const doc = await seoPagesRefresh(id);
      if (shownBrandId.current !== id) return; // user moved on mid-refresh
      setPagesDoc(doc);
      setPagesError(null);
      onToast(`Pages refreshed — ${fmt(doc.pages.length)} page(s)`);
    } catch (e) {
      if (shownBrandId.current !== id) return;
      const msg = plainFailure(e, "Could not refresh pages");
      setPagesError(msg);
      onToast(msg, "error");
    } finally {
      setPagesBusy(false);
    }
  }

  async function runBrand(id: string) {
    setBusy(true);
    onToast("Analyzing — pulling Search Console and topic data…");
    try {
      await seoRunBrand(id);
      const detail = await seoBrandDetail(id);
      // `brand` captured in this closure is the brand at click time; the ref is
      // the one on screen now.
      if (shownBrandId.current === id) {
        setBrand(detail.brand);
        setRun(detail.run);
        setGsc(detail.gsc ?? null);
        setPlan(detail.plan ?? []);
        setSiteReview(detail.site_review ?? null);
      }
      await refreshOverview();
      const summary = detail.run?.summary;
      if (summary?.mode === "rank-tracking") {
        onToast(`Done — ${summary.top10 ?? 0}/${summary.tracked ?? 0} tracked keywords on page 1 (live rankings)`);
      } else if (summary?.est_potential_clicks) {
        onToast(`Done — est. +${fmt(summary.est_potential_clicks)} clicks/month on the table`);
      } else {
        onToast("Done — see the brand card for data status");
      }
    } catch (e) {
      onToast(plainFailure(e, "Analysis failed"), "error");
    } finally {
      setBusy(false);
    }
  }

  async function analyzeSite(id: string) {
    setSiteBusy(true);
    onToast("Reading the website — crawling pages and running the expert review (takes a minute or two)…");
    try {
      const review = await seoAnalyzeSite(id);
      const detail = await seoBrandDetail(id);
      // A crawl takes minutes — long enough for the user to open another brand,
      // whose fix list must not be replaced by this one's.
      if (shownBrandId.current !== id) return;
      setSiteReview(review);
      setRun(detail.run);
      setPlan(detail.plan ?? []);
      onToast(`Site review done — ${review.issues.length} finding(s) added to the fix list`);
    } catch (e) {
      onToast(plainFailure(e, "Site analysis failed"), "error");
    } finally {
      setSiteBusy(false);
    }
  }

  // Opened on arrival from the Google return. Keyed on the id, so clearing it
  // (or the reader going back to the brand list) never re-opens anything.
  useEffect(() => {
    if (!focusBrand) return;
    void openBrand(focusBrand);
    onFocused?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusBrand]);

  /** Same tab, not a popup: `window.open` after an `await` is no longer a
   *  user gesture, and Safari's blocker ate it. Google returns to
   *  `/oauth/google`, which brings the reader back to this brand. */
  async function connectGsc(id: string) {
    setConnecting(true);
    try {
      const { url } = await seoOauthStart(id);
      window.location.assign(url);
    } catch (e) {
      onToast(gscFailure(e, "Couldn't start the Google sign-in — try again."), "error");
      setConnecting(false);
    }
  }

  async function disconnectGsc(id: string) {
    if (!window.confirm("Disconnect Search Console? The brand falls back to live rank tracking.")) return;
    try {
      await seoOauthDisconnect(id);
      setGsc({ connected: false, property: null });
      onToast("Search Console disconnected");
      await refreshOverview();
    } catch (e) {
      onToast(plainFailure(e, "Disconnect failed"), "error");
    }
  }

  async function removeBrand(b: SeoBrand) {
    if (!window.confirm(`Remove ${b.name}? Its insights and to-dos disappear from the dashboard.`)) return;
    try {
      await seoDeleteBrand(b.id);
      onToast(`${b.name} removed`);
      closeBrand();
      await refreshOverview();
    } catch (e) {
      onToast(plainFailure(e, "Remove failed"), "error");
    }
  }

  async function setStatus(todoId: string, status: SeoTodoStatus) {
    if (!brand || !run) return;
    setRun({ ...run, todos: run.todos.map((t) => (t.id === todoId ? { ...t, status } : t)) });
    try {
      await seoSetTodoStatus(brand.id, todoId, status);
    } catch (e) {
      onToast(plainFailure(e, "Could not save status"), "error");
    }
  }

  const sources = overview?.sources;
  const gscView = readGsc(gsc);
  const slot = gscSlot(gscView, sources);
  const noteCtx: NoteContext = {
    site: brand?.domain ?? "this site",
    gsc: gscView.connected ? "connected" : slot.mode === "connect" ? "connectable" : "unavailable",
  };

  return (
    <div className="mr-app seo-app">
      <header className="mr-top">
        <button className="mr-top__back" onClick={() => (brand ? closeBrand() : onBack())} aria-label="Back">
          <Icon name="arrow-left" size={18} />
        </button>
        <div className="mr-top__id">
          <span className="mr-top__name">SEO Analyst{brand ? ` · ${brand.name}` : ""}</span>
          <span className="mr-top__sub">Search insights, prioritized fixes & blog topics — per brand</span>
        </div>
        {sources && (
          <div className="seo-sources">
            <span className={`seo-chip ${sources.gsc ? "seo-chip--on" : "seo-chip--off"}`}>Search Console</span>
            <span className={`seo-chip ${sources.serp ? "seo-chip--on" : "seo-chip--off"}`}>Google SERP</span>
          </div>
        )}
      </header>

      <div className="mr-body">
        {!brand && (
          <div className="mr-panel">
            <div className="mr-panel__head">
              <h2 className="mr-panel__title">Brands</h2>
              <span className="mr-panel__sub">Every site we watch — open one for its fix list and blog topics.</span>
            </div>
            <div className="seo-grid">
              {(overview?.brands ?? []).map(({ brand: b, last_run, gsc_connected, gsc: gscCard, headline }) => (
                <div key={b.id} className="seo-card" role="button" tabIndex={0}
                     aria-busy={opening === b.id}
                     onClick={() => void openBrand(b.id)}
                     onKeyDown={(e) => e.key === "Enter" && void openBrand(b.id)}>
                  <div className="seo-card__head">
                    <span className="seo-card__name">
                      {b.name}
                      {readGsc(gscCard, gsc_connected).connected && (
                        <span className="seo-chip seo-chip--on seo-card__gsc">GSC ✓</span>
                      )}
                      {opening === b.id && <span className="seo-chip">Opening…</span>}
                    </span>
                    <span className="seo-card__domain">{b.domain}</span>
                  </div>
                  {headline && <div className="seo-card__headline">{headline}</div>}
                  {last_run ? (
                    <>
                      <div className="seo-card__stats">
                        {last_run.summary.mode === "rank-tracking" ? (
                          <>
                            <div className="seo-stat">
                              <span className="seo-stat__label">Page 1</span>
                              <span className="seo-stat__num">
                                {last_run.summary.top10 ?? 0}/{last_run.summary.tracked ?? 0}
                              </span>
                            </div>
                            <div className="seo-stat">
                              <span className="seo-stat__label">Not ranking</span>
                              <span className="seo-stat__num">{last_run.summary.unranked ?? 0}</span>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="seo-stat">
                              <span className="seo-stat__label">Clicks · 28d</span>
                              <span className="seo-stat__num">
                                {fmt(last_run.summary.clicks_28d)}
                                <Delta now={last_run.summary.clicks_28d} prev={last_run.summary.clicks_prev_28d} />
                              </span>
                            </div>
                            <div className="seo-stat">
                              <span className="seo-stat__label">Est. upside</span>
                              <span className="seo-stat__num seo-stat__num--good">
                                +{fmt(last_run.summary.est_potential_clicks)}/mo
                              </span>
                            </div>
                          </>
                        )}
                      </div>
                      <div className="seo-card__meta">
                        <span>{last_run.todo_count} fixes</span>
                        <span>{last_run.topic_count} topics</span>
                        <span>run {last_run.at}</span>
                        {last_run.degraded.length > 0 && <Icon name="alert-triangle" size={13} />}
                      </div>
                    </>
                  ) : (
                    <div className="seo-card__empty">No analysis yet</div>
                  )}
                  <button className="seo-btn seo-btn--primary" disabled={busy}
                          onClick={(e) => { e.stopPropagation(); void runBrand(b.id); }}>
                    <Icon name="refresh-cw" size={13} /> {last_run ? "Refresh" : "Run first analysis"}
                  </button>
                </div>
              ))}
              {user?.is_creator && <AddBrandForm onSaved={() => void refreshOverview()} onToast={onToast} />}
            </div>
          </div>
        )}

        {brand && (
          <div className="mr-panel">
            <div className="seo-detail__bar">
              <div className="mr-panel__head">
                <h2 className="mr-panel__title">{brand.name}</h2>
                <span className="mr-panel__sub">{brand.domain}{run ? ` · analyzed ${run.at}` : ""}</span>
              </div>
              <div className="seo-detail__actions">
                {slot.mode === "connected" && (
                  <span className="seo-chip seo-chip--on" title={gscView.property ?? undefined}>
                    Search Console ✓
                    {user?.is_creator && (
                      <button className="seo-chip__x" aria-label="Disconnect Search Console"
                              onClick={() => void disconnectGsc(brand.id)}>×</button>
                    )}
                  </span>
                )}
                {slot.mode === "connect" && (
                  <button className="seo-btn" disabled={connecting} aria-describedby="seo-gsc-line"
                          onClick={() => void connectGsc(brand.id)}>
                    <Icon name="link" size={13} /> {connecting ? "Opening Google…" : "Connect Search Console"}
                  </button>
                )}
                <button className="seo-btn" disabled={siteBusy} onClick={() => void analyzeSite(brand.id)}>
                  <Icon name="search" size={13} /> {siteReview ? "Re-analyze website" : "Analyze website"}
                </button>
                <button className="seo-btn seo-btn--primary" disabled={busy} onClick={() => void runBrand(brand.id)}>
                  <Icon name="refresh-cw" size={13} /> Refresh data
                </button>
                {user?.is_creator && (
                  <button className="seo-btn" onClick={() => void removeBrand(brand)}>Remove</button>
                )}
              </div>
            </div>

            {slot.line && <p id="seo-gsc-line" className="seo-gsc">{slot.line}</p>}

            <Story run={run} />

            <PlanStrip plan={plan} todos={run?.todos ?? []} onSeeFix={seeFix} />

            {run && <DegradedNotes notes={run.degraded} ctx={noteCtx} />}

            {siteReview && (
              <Fold title="Website health"
                    hint={`${siteReview.issues.length} finding(s) · ${siteReview.page_count} pages read`}>
              <div className="mr-section">
                <h3 className="mr-section__title">What the expert review found · {siteReview.at}</h3>
                {siteReview.positioning && <div className="seo-poa__action">{siteReview.positioning}</div>}
                {siteReview.scorecard && Object.keys(siteReview.scorecard).length > 0 && (
                  <div className="seo-cluster__kws">
                    {Object.entries(siteReview.scorecard).map(([key, cell]) => {
                      const label = {
                        intent: "Intent", content_depth: "Content depth", architecture: "Architecture",
                        trust: "Trust", conversion: "Conversion", ai_search: "AI search",
                      }[key] ?? key;
                      const cls = cell.grade >= 4 ? "seo-chip--on" : "";
                      return (
                        <span key={key} className={`seo-chip ${cls}`} title={cell.note}>
                          {label} {cell.grade}/5
                        </span>
                      );
                    })}
                  </div>
                )}
                {siteReview.strengths.length > 0 && (
                  <div className="seo-cluster__kws">
                    {siteReview.strengths.map((s) => (
                      <span key={s} className="seo-chip seo-chip--on">{s}</span>
                    ))}
                  </div>
                )}
                {siteReview.missing_topics.length > 0 && (
                  <>
                    <div className="seo-lab__meta">Topics the site doesn't cover yet — blog fuel:</div>
                    <div className="seo-cluster__kws">
                      {siteReview.missing_topics.map((t) => (
                        <span key={t} className="seo-chip seo-chip--cov-gap">{t}</span>
                      ))}
                    </div>
                  </>
                )}
                <div className="seo-lab__meta">
                  Findings are in the Fix list with everything else — nothing to read twice.
                </div>
                <ReviewDropped grounding={siteReview.grounding} />
              </div>
              </Fold>
            )}

            {run && (
              <Fold title="Traffic & rankings"
                    hint={run.ga
                      ? `${fmt(run.ga.totals.sessions)} visits · ${fmt(run.ga.key_events.find((e) => e.event === "generate_lead")?.count ?? 0)} leads`
                      : run.summary.mode === "rank-tracking"
                        ? `${run.summary.top10 ?? 0}/${run.summary.tracked ?? 0} keywords on page 1`
                        : `${fmt(run.summary.clicks_28d)} clicks from Google`}>
                {run.summary.mode === "rank-tracking" ? (
                  <div className="seo-summary">
                    <div className="seo-stat">
                      <span className="seo-stat__label">Tracked keywords</span>
                      <span className="seo-stat__num">{run.summary.tracked ?? 0}</span>
                    </div>
                    <div className="seo-stat">
                      <span className="seo-stat__label">Top 3</span>
                      <span className="seo-stat__num seo-stat__num--good">{run.summary.top3 ?? 0}</span>
                    </div>
                    <div className="seo-stat">
                      <span className="seo-stat__label">Page 1</span>
                      <span className="seo-stat__num">{run.summary.top10 ?? 0}</span>
                    </div>
                    <div className="seo-stat">
                      <span className="seo-stat__label">Not ranking</span>
                      <span className="seo-stat__num">{run.summary.unranked ?? 0}</span>
                    </div>
                    <div className="seo-stat">
                      <span className="seo-stat__label">Since last check</span>
                      <span className="seo-stat__num">
                        {(run.summary.moved_up ?? 0) > 0 && (
                          <span className="seo-delta seo-delta--up">
                            <Icon name="trending-up" size={13} />{run.summary.moved_up}
                          </span>
                        )}
                        {(run.summary.moved_down ?? 0) > 0 && (
                          <span className="seo-delta seo-delta--down">
                            <Icon name="trending-down" size={13} />{run.summary.moved_down}
                          </span>
                        )}
                        {!(run.summary.moved_up || run.summary.moved_down) && "steady"}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="seo-summary">
                    <div className="seo-stat">
                      <span className="seo-stat__label">Clicks · 28d</span>
                      <span className="seo-stat__num">
                        {fmt(run.summary.clicks_28d)}
                        <Delta now={run.summary.clicks_28d} prev={run.summary.clicks_prev_28d} />
                      </span>
                    </div>
                    <div className="seo-stat">
                      <span className="seo-stat__label">Impressions · 28d</span>
                      <span className="seo-stat__num">{fmt(run.summary.impressions_28d)}</span>
                    </div>
                    <div className="seo-stat">
                      <span className="seo-stat__label">Avg. position</span>
                      <span className="seo-stat__num">{run.summary.avg_position || "—"}</span>
                    </div>
                    <div className="seo-stat">
                      <span className="seo-stat__label">Est. upside if fixed</span>
                      <span className="seo-stat__num seo-stat__num--good">+{fmt(run.summary.est_potential_clicks)}/mo</span>
                    </div>
                  </div>
                )}

                {run.ga && <GaSection ga={run.ga} />}

                {run.insights.length > 0 && (
                  <div className="mr-section">
                    <h3 className="mr-section__title">What changed</h3>
                    <ul className="seo-insights">
                      {run.insights.map((line, i) => <li key={i}>{line}</li>)}
                    </ul>
                  </div>
                )}
              </Fold>
            )}

            <Fold title="Pages" count={pagesDoc?.pages.length} hint="traffic + health, page by page">
              <PagesView doc={pagesDoc} busy={pagesBusy} error={pagesError} noteCtx={noteCtx}
                todos={run?.todos ?? []} onSeeFix={seeFix}
                onRefresh={() => void refreshPages(brand.id)} />
            </Fold>

            <Fold title="Competitors" hint="top 5 — and what they publish">
              <CompetitorsView brandId={brand.id} isCreator={!!user?.is_creator} onToast={onToast} noteCtx={noteCtx} />
            </Fold>

            <Fold title="More tools" hint="ask · keyword lab · briefs · audit">
              <div className="seo-cluster__kws">
                {(Object.keys(TOOL_LABELS) as SeoTool[]).map((t) => (
                  <button key={t} className={`seo-chip${tool === t ? " seo-chip--on" : ""}`}
                          onClick={() => setTool(tool === t ? null : t)}>
                    {TOOL_LABELS[t]}
                  </button>
                ))}
              </div>
              {tool === "ask" && <AskView brandId={brand.id} brandName={brand.name} />}
              {tool === "keywords" && <KeywordsView brandId={brand.id} onToast={onToast} noteCtx={noteCtx} />}
              {tool === "briefs" && <BriefsView brandId={brand.id} onToast={onToast} noteCtx={noteCtx} />}
              {tool === "audit" && <AuditView brandId={brand.id} brandName={brand.name} onToast={onToast} />}
            </Fold>

            {run && (
              <>
                <Fold title="Fix list" count={run.todos.length} hint="every fix, biggest win first"
                      open={fixOpen} onToggle={setFixOpen}>
                {(
                  <div className="mr-section">
                    <h3 className="mr-section__title">
                      {run.summary.mode === "rank-tracking"
                        ? "Top 10 actions — from live rankings (drops first)"
                        : "Top 10 actions — biggest estimated gain first"}
                    </h3>
                    {run.todos.length === 0 && <div className="seo-empty">Nothing above the impact threshold — refresh after the next content push.</div>}
                    {(showAllTodos ? run.todos : run.todos.slice(0, 10)).map((t, i) => (
                      <div key={t.id} id={`seo-fix-${t.id}`} tabIndex={-1}
                           className={`seo-todo${t.status === "done" ? " seo-todo--done" : ""}${fixFocus === t.id ? " seo-todo--focus" : ""}`}>
                        <span className="seo-todo__rank">{i + 1}</span>
                        {t.est_monthly_clicks != null ? (
                          <div className="seo-todo__gain">+{fmt(t.est_monthly_clicks)}<small>est. clicks/mo</small></div>
                        ) : (
                          <div className="seo-todo__gain seo-todo__gain--pos">
                            {t.position > 0 ? `#${t.position}` : "—"}
                            <small>{t.position > 0 ? "current pos" : t.kind === "site" ? "site fix" : "not ranked"}</small>
                          </div>
                        )}
                        <div className="seo-todo__body">
                          <div className="seo-todo__action">{t.action}</div>
                          <div className="seo-todo__why">{t.why}</div>
                          <div className="seo-todo__meta">
                            {t.kind === "site" && todoCategoryLabel(t.category) && (
                              <span className="seo-chip seo-chip--src">{todoCategoryLabel(t.category)}</span>
                            )}
                            {(() => {
                              // Site to-dos cite the page's URL; an older review
                              // stored its evidence sentence here instead.
                              const pg = t.kind === "site" ? todoPage(t.page) : null;
                              if (pg) {
                                return pg.href
                                  ? <a href={pg.href} target="_blank" rel="noreferrer">{pg.text}</a>
                                  : <span>{pg.text}</span>;
                              }
                              return t.page ? <span>{shortPage(t.page)}</span> : null;
                            })()}
                            {t.est_monthly_clicks != null && t.position > 0 && <span>pos {t.position}</span>}
                            {t.impressions != null && <span>{fmt(t.impressions)} impressions</span>}
                          </div>
                          <TodoPages pages={t.pages} />
                          {t.kind === "decay" && (
                            <UpdatePlanButton brandId={brand.id} page={t.page} onToast={onToast} />
                          )}
                        </div>
                        <select className={`seo-status seo-status--${t.status}`} value={t.status}
                                onChange={(e) => void setStatus(t.id, e.target.value as SeoTodoStatus)}>
                          <option value="todo">To do</option>
                          <option value="assigned">Assigned</option>
                          <option value="done">Done</option>
                        </select>
                      </div>
                    ))}
                    {run.todos.length > 10 && (
                      <button className="seo-btn seo-todo__more" onClick={() => setShowAllTodos((v) => !v)}>
                        {showAllTodos ? "Show top 10 only" : `Show all ${run.todos.length}`}
                      </button>
                    )}
                    {notShownLine(run.todos_not_shown) && (
                      <div className="seo-lab__meta">{notShownLine(run.todos_not_shown)}</div>
                    )}
                  </div>
                )}
                </Fold>

                <Fold title="Blog plan" count={run.topics.filter((t) => !t.avoided).length}
                      hint="the next posts to publish">
                {(() => {
                  const liveTopics = run.topics.filter((t) => !t.avoided);
                  const avoidedTopics = run.topics.filter((t) => t.avoided);
                  return (
                    <div className="mr-section">
                      <h3 className="mr-section__title">Next 10 blogs to publish</h3>
                      {liveTopics.length === 0 && avoidedTopics.length === 0 && (
                        <div className="seo-empty">No topics yet — add seed keywords to this brand and refresh.</div>
                      )}
                      {liveTopics.map((t, i) => <TopicRow key={t.keyword} t={t} index={i + 1} />)}
                      {avoidedTopics.length > 0 && (
                        <div className="seo-avoided">
                          <button className="seo-btn seo-avoided__toggle" onClick={() => setShowAvoided((v) => !v)}>
                            <Icon name={showAvoided ? "chevron-down" : "chevron-right"} size={13} />
                            Avoided (would cannibalize existing pages) · {avoidedTopics.length}
                          </button>
                          {showAvoided && (
                            <div className="seo-avoided__list">
                              {avoidedTopics.map((t) => (
                                <div key={t.keyword} className="seo-avoided__row">
                                  <span className="seo-topic__kw">{t.keyword}</span>
                                  <span className="seo-avoided__reason">{t.avoided_reason ?? "overlaps an existing page"}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}
                </Fold>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default SeoAgent;
