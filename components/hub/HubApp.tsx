"use client";

/** The AgentHub shell: the rail, the header, and whatever panel the hash names.
 *
 *  This is the prototype's `index.html` plus its `shell wiring` section, with
 *  three things that a prototype does not need and a console does:
 *
 *  1. **Panels are gated.** Models is creator-only and Admin is admin-only, and
 *     the gate is applied in one place — `panelsFor` — so a panel cannot be
 *     reachable from the rail but refused by the API, or the reverse.
 *  2. **Failure has a tone.** The prototype's toast said one thing in one voice
 *     because nothing in it could fail. Here a failed 90-second run must not
 *     read like a success that cleared itself, so `error` stays until dismissed.
 *  3. **Every figure is fetched.** The rail's counts and the header's spend come
 *     from the API and are simply absent until they arrive, rather than
 *     rendering a placeholder number that could be mistaken for a real one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { Sprite } from "./Sprite";
import {
  HOME, PANELS,
  agentBySlug, agentsFor, canOpen, canOpenWorkspace, panelsFor,
  routeFromHash, routeToHash,
  type PanelId, type Route,
} from "./model";
import TopNav from "./TopNav";
import { HubProvider, type Headline, type HubContextValue, type ToastFn, type WorkNav } from "./context";
import { HubToasts, useToasts } from "./Toasts";
import { HubPalette } from "./Palette";
import { BriefDialog } from "./BriefDialog";
import { RequestDialog } from "./RequestDialog";
import { PanelSwitch } from "./PanelSwitch";
import { WorkBar } from "./WorkBar";
import { useShellStats } from "./useShellStats";

/* ------------------------------------------------------------------- theme -- */

/** Written by the inline script in `app/layout.tsx` before first paint, and by
 *  the appearance button here. One key, so a reload never flashes the theme the
 *  reader did not pick. */
const THEME_KEY = "app-theme";

function readTheme(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.theme === "dark";
}

function writeTheme(dark: boolean): void {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  try {
    localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
  } catch {
    /* storage off — the class on <html> is still correct for this session */
  }
}

/* --------------------------------------------------------------------- app -- */

export default function HubApp() {
  const { user, logout } = useAuth();
  const [route, setRoute] = useState<Route>(HOME);
  const [head, setHeadState] = useState<Headline>({ sub: "" });
  const [dark, setDark] = useState(false);
  const [revision, setRevision] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [briefFor, setBriefFor] = useState<string | null>(null);
  const [agentAsk, setAgentAsk] = useState(false);
  const [workNav, setWorkNav] = useState<WorkNav | null>(null);
  const { toasts, fire, dismiss } = useToasts();

  const viewer = useMemo(
    () => ({
      is_admin: user?.is_admin,
      is_creator: user?.is_creator,
      is_geo_only: user?.is_geo_only,
    }),
    [user?.is_admin, user?.is_creator, user?.is_geo_only],
  );

  /** The specialists this reader may open or brief. For everyone but a scoped
   *  account this is the whole live roster. */
  const agents = useMemo(() => agentsFor(viewer), [viewer]);

  // The headline is a panel's voice: it resets whenever the route moves, so a
  // panel that has not spoken yet never wears the last one's sub-line. The
  // reset rides the same state update as the route — doing it in an effect on
  // `route` instead would run *after* the new panel's own `useHeadline` effect
  // (child effects fire before the parent's) and wipe what it just said.
  const applyRoute = useCallback((next: Route) => {
    setHeadState({ sub: "" });
    setRoute(next);
  }, []);

  // The hash is the address bar's copy of `route`; `route` is the truth. Writing
  // it with pushState means Back returns to the previous panel instead of
  // leaving the console — the one thing Back must never do.
  useEffect(() => {
    if (!user) return;
    applyRoute(routeFromHash(window.location.hash, viewer));
    const onPop = () => applyRoute(routeFromHash(window.location.hash, viewer));
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onPop);
    };
  }, [user, viewer, applyRoute]);

  useEffect(() => setDark(readTheme()), []);

  const navigate = useCallback((next: Route) => {
    applyRoute(next);
    const hash = routeToHash(next);
    if (typeof window !== "undefined" && window.location.hash !== hash) {
      window.history.pushState(null, "", hash);
    }
  }, [applyRoute]);

  const go = useCallback((panel: PanelId) => navigate({ panel, work: null }), [navigate]);

  // A workspace is layered over the panel you came from, not instead of it, so
  // the way out returns you to where you were rather than always to Agents.
  //
  // It is also the one door every workspace link goes through — a card, a
  // palette entry, an issue's fix button, a run row — so the scope wall is
  // enforced here as well as at each of those call sites. A link that survives
  // a stale render then says one plain line rather than landing on a 403.
  const openWork = useCallback(
    (slug: string, subject = "", section = "") => {
      if (!agentBySlug(slug)) return;
      if (!canOpenWorkspace(slug, viewer)) {
        fire(`${agentBySlug(slug)?.name} is not open to your account.`, "warn");
        return;
      }
      navigate({ panel: route.panel, work: { slug, subject, section } });
    },
    [navigate, route.panel, viewer, fire],
  );

  const closeWork = useCallback(() => {
    navigate({ panel: route.panel, work: null });
  }, [navigate, route.panel]);

  const setHead = useCallback((h: Headline) => setHeadState(h), []);
  const setWorkNavStable = useCallback((nav: WorkNav | null) => setWorkNav(nav), []);
  const bumpRevision = useCallback(() => setRevision((r) => r + 1), []);
  // The dialog only ever opens on a specialist this reader may actually reach:
  // the header's bare "New work" has no agent in mind, and a button aimed at
  // one outside the allowance must not open a form whose first read 403s.
  const openBrief = useCallback((agentId?: string) => {
    if (!agents.length) return;
    const wanted = agentId && agents.some((a) => a.id === agentId) ? agentId : agents[0].id;
    setBriefFor(wanted);
  }, [agents]);

  const toggleTheme = useCallback(() => {
    setDark((d) => {
      writeTheme(!d);
      return !d;
    });
  }, []);

  // Ctrl/Cmd-K anywhere but inside a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const stats = useShellStats(!!user, revision, agents.length, !!user?.is_admin);

  const ctx: HubContextValue | null = useMemo(
    () => (user ? {
      user, route, go, openWork, closeWork,
      toast: fire as ToastFn,
      setHead, setWorkNav: setWorkNavStable, openBrief, bumpRevision, revision,
    } : null),
    [user, route, go, openWork, closeWork, fire, setHead, setWorkNavStable, openBrief, bumpRevision, revision],
  );

  if (!user || !ctx) return null;

  const panels = panelsFor(viewer);
  const activePanel = PANELS.find((p) => p.id === route.panel && canOpen(p, viewer)) || PANELS[0];
  const title = head.title || (route.work ? agentBySlug(route.work.slug)?.name || "Workspace" : activePanel.title);

  return (
    <HubProvider value={ctx}>
      <Sprite />
      {/* One shell for everything: panels and workspaces share the white
          top-nav stage. A workspace adds the work bar — the way back, the
          specialist's identity, its subjects and sections — where the old
          dark rail used to stand. */}
      <div className="app2">
        <TopNav
          route={route}
          panels={panels}
          counts={stats.counts}
          onGo={go}
          onOpenPalette={() => setPaletteOpen(true)}
          dark={dark}
          onTheme={toggleTheme}
          user={user}
          onLogout={logout}
          hasNews={stats.hasNews}
          onBell={() => go("settings")}
          onNewWork={() => setAgentAsk(true)}
          usage={{ runs: stats.counts.runs, live: agents.length }}
        />
        <div className="app2__stage">
          {route.work && (
            <WorkBar
              agent={agentBySlug(route.work.slug)}
              nav={workNav}
              backLabel={activePanel.label}
              onBack={closeWork}
            />
          )}
          <header className="app2__head">
            <div>
              <h1>{title}</h1>
              <p>{head.sub}</p>
            </div>
            <div className="spend" aria-label="OpenRouter account">
              {stats.spend.map((s) => (
                <div key={s.label}>
                  <b>{s.value}</b>
                  <span>{s.label}</span>
                </div>
              ))}
            </div>
          </header>
          <main className="canvas" id="canvas" tabIndex={-1}>
            <PanelSwitch route={route} />
          </main>
        </div>
      </div>

      <HubPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        panels={panels}
        agents={agents}
        onGo={go}
        onOpenWork={openWork}
        onBrief={openBrief}
      />

      <BriefDialog
        agentId={briefFor}
        agents={agents}
        onClose={() => setBriefFor(null)}
        onToast={fire}
        onOpenWork={openWork}
        onQueued={bumpRevision}
      />

      <RequestDialog
        kind="agent"
        open={agentAsk}
        onClose={() => setAgentAsk(false)}
        onToast={fire}
      />

      <HubToasts toasts={toasts} onDismiss={dismiss} />
    </HubProvider>
  );
}
