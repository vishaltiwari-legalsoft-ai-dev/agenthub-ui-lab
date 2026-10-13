"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { Sidebar, StatsBar } from "@/components/console/Chrome";
import { HomeView, AgentsView, TeamsView, SettingsView } from "@/components/console/Views";
import { IntegrationsView } from "@/components/console/IntegrationsView";
import { isAgentLive, LIVE_AGENTS } from "@/lib/console-data";
import { GraphicsStudioV2 } from "@/components/console/gd2/GraphicsStudioV2";
import { MarketingResearch } from "@/components/console/mr/MarketingResearch";
import { SeoAgent } from "@/components/console/seo/SeoAgent";
import { GeoAgent } from "@/components/console/geo/GeoAgent";
import { LibraryView } from "@/components/console/LibraryView";
import { AdminView } from "@/components/console/AdminView";
import { DatabaseView } from "@/components/console/DatabaseView";
import { ImageLibraryView } from "@/components/console/ImageLibraryView";
import { AgentConfigView } from "@/components/console/AgentConfigView";
import { Icon } from "@/lib/kit-ui";
import { WorkProvider, useIsWorking } from "@/lib/work";

function WorkBar() {
  const working = useIsWorking();
  return (
    <div className={`cworkbar${working ? " cworkbar--on" : ""}`} role="status" aria-live="polite" aria-hidden={!working}>
      <Icon name="loader-circle" size={15} className="cworkbar__spin" />
      <span>Working…</span>
    </div>
  );
}

// Views that can be reflected in the URL so a reload restores the current page.
const NAV_VIEWS = [
  "home",
  "agents",
  "teams",
  "studio",
  "marketing",
  "seo",
  "blog",
  "geo",
  "library",
  "imagelib",
  "admin",
  "database",
  "agentcfg",
  "settings",
  "integrations",
] as const;

type NavView = (typeof NAV_VIEWS)[number];

function isNavView(value: string): value is NavView {
  return (NAV_VIEWS as readonly string[]).includes(value);
}

// Some views are permission-gated; don't restore one the user can't access.
function canAccess(view: NavView, user: { is_admin?: boolean; is_creator?: boolean }): boolean {
  if (view === "admin" || view === "database" || view === "imagelib") return !!user.is_admin;
  if (view === "agentcfg") return !!user.is_creator;
  return true;
}

function readNavFromHash(): NavView | null {
  if (typeof window === "undefined") return null;
  const raw = window.location.hash.replace(/^#\/?/, "");
  return isNavView(raw) ? raw : null;
}

/* ---------------------------------------------------------------- Toasts --
   A toast is the only notification this app gives. Rendering a failed 90s run
   as a purple ✓ that vanishes in 2.6s means the user never learns it died, so
   tone is part of the API: `ok` reassures and clears itself, `warn` lingers,
   `error` stays on screen until it is dismissed and stacks instead of being
   overwritten by the next thing that happens. */

export type ToastTone = "ok" | "warn" | "error";
/** Stable signature for every `onToast` prop in the console. */
export type ToastFn = (msg: string, tone?: ToastTone) => void;

interface ToastItem {
  id: number;
  msg: string;
  tone: ToastTone;
}

// `alert-circle` is not registered in lib/icons.tsx, so the error badge is an
// ✕ carrying the danger colour — unmistakably not a success check.
const TOAST_ICON: Record<ToastTone, string> = {
  ok: "check",
  warn: "alert-triangle",
  error: "x",
};

/** 0 = never auto-dismiss. An error the user did not see is an error they act on. */
const TOAST_TTL_MS: Record<ToastTone, number> = { ok: 2600, warn: 6000, error: 0 };

/** Errors stack, but not without limit — a failing loop must not paper the screen. */
const MAX_TOASTS = 4;

function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="ctoasts">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`ctoast ctoast--${t.tone}`}
          role={t.tone === "error" ? "alert" : "status"}
          aria-live={t.tone === "error" ? "assertive" : "polite"}
        >
          <span className="ctoast__ic">
            <Icon name={TOAST_ICON[t.tone]} />
          </span>
          <span className="ctoast__msg">{t.msg}</span>
          {t.tone === "error" && (
            <button type="button" className="ctoast__dismiss" onClick={() => onDismiss(t.id)}>
              Dismiss
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export default function ConsoleApp() {
  const { user, logout } = useAuth();
  const [nav, setNav] = useState("home");
  const [added, setAdded] = useState<Record<string, boolean>>({});
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toastTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const toastSeq = useRef(0);
  // ok/warn are transient status: the newest replaces the previous one. Errors
  // are not status, so they are tracked separately and only leave on dismiss.
  const transientToast = useRef<number | null>(null);

  // Restore the view from the URL hash on first load (so a reload keeps you in
  // place instead of bouncing to home), and follow browser back/forward.
  useEffect(() => {
    if (!user) return;
    const sync = () => {
      const fromHash = readNavFromHash();
      if (fromHash && canAccess(fromHash, user)) setNav(fromHash);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.is_admin, user?.is_creator]);

  // Keep the URL hash in sync with the current view. replaceState avoids
  // piling up history entries while still surviving a reload. Never write
  // before auth resolves: on a reload nav is still "home" while the restore
  // effect waits for the user, and writing then would clobber the saved hash.
  useEffect(() => {
    if (typeof window === "undefined" || !user) return;
    const target = `#/${nav}`;
    if (window.location.hash !== target) {
      window.history.replaceState(null, "", target);
    }
  }, [nav, user]);

  const dismissToast = useCallback((id: number) => {
    const timer = toastTimers.current.get(id);
    if (timer) clearTimeout(timer);
    toastTimers.current.delete(id);
    if (transientToast.current === id) transientToast.current = null;
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const fire = useCallback<ToastFn>((msg, tone = "ok") => {
    const id = (toastSeq.current += 1);
    if (tone !== "error") {
      const prev = transientToast.current;
      if (prev !== null) {
        const timer = toastTimers.current.get(prev);
        if (timer) clearTimeout(timer);
        toastTimers.current.delete(prev);
      }
      transientToast.current = id;
    }
    setToasts((list) => {
      const kept = tone === "error" ? list : list.filter((t) => t.tone === "error");
      return [...kept, { id, msg, tone }].slice(-MAX_TOASTS);
    });
    const ttl = TOAST_TTL_MS[tone];
    if (ttl > 0) {
      toastTimers.current.set(id, setTimeout(() => dismissToast(id), ttl));
    }
  }, [dismissToast]);

  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  if (!user) return null;

  const onAdd = (id: string) => {
    setAdded((p) => ({ ...p, [id]: !p[id] }));
    fire(added[id] ? "Removed from team" : "Added to team");
  };

  const onOpenAgent = (id: string) => {
    if (!isAgentLive(id)) {
      fire("This agent is coming soon.", "warn");
      return;
    }
    setNav(LIVE_AGENTS[id]);
  };

  return (
    <WorkProvider>
    <div className="capp">
      <Sidebar nav={nav} setNav={setNav} user={user} isAdmin={user.is_admin} isCreator={user.is_creator} onLogout={logout} />
      <div className="cmain">
        <WorkBar />
        {nav !== "studio" && <StatsBar />}
        <div className="cscroll" style={nav === "studio" ? { overflow: "hidden" } : undefined}>
          {nav === "home" && (
            <HomeView
              onOpenAgents={() => setNav("agents")}
              onOpenAgent={onOpenAgent}
              onAdd={onAdd}
              added={added}
              userName={user.name || user.email}
            />
          )}
          {nav === "agents" && <AgentsView onOpenAgent={onOpenAgent} />}
          {nav === "teams" && <TeamsView />}
          {nav === "studio" && <GraphicsStudioV2 onToast={fire} onBack={() => setNav("agents")} />}
          {nav === "marketing" && <MarketingResearch onToast={fire} onBack={() => setNav("agents")} />}
          {nav === "seo" && <SeoAgent onToast={fire} onBack={() => setNav("agents")} />}
          {nav === "geo" && <GeoAgent onToast={fire} onBack={() => setNav("agents")} />}
          {nav === "library" && <LibraryView onBack={() => setNav("home")} />}
          {nav === "imagelib" && user.is_admin && <ImageLibraryView onBack={() => setNav("home")} />}
          {nav === "admin" && user.is_admin && <AdminView onBack={() => setNav("home")} />}
          {nav === "database" && user.is_admin && <DatabaseView onBack={() => setNav("home")} />}
          {nav === "agentcfg" && user.is_creator && <AgentConfigView onBack={() => setNav("home")} />}
          {nav === "settings" && <SettingsView userName={user.name || user.email} userEmail={user.email} />}
          {nav === "integrations" && <IntegrationsView onToast={fire} />}
        </div>
      </div>
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
    </WorkProvider>
  );
}
