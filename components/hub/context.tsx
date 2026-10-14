"use client";

/** What every panel in AgentHub is allowed to reach for.
 *
 *  The prototype could call `render("runs")` from anywhere because it was one
 *  closure. Here the same powers — go somewhere, open a workspace, say
 *  something, know who is looking — are handed down explicitly, so a panel's
 *  dependencies are visible in its signature instead of implied by scope.
 */

import { createContext, useContext, useEffect } from "react";
import type { User } from "@/lib/api";
import type { PanelId, Route, WorkRoute } from "./model";

export type ToastTone = "ok" | "warn" | "error";
export type ToastFn = (msg: string, tone?: ToastTone) => void;

/** The two lines in the header. `title` is optional because a console panel's
 *  title is fixed by the catalogue — only a workspace, whose title is the
 *  section you are in, has to name its own. */
export interface Headline {
  title?: string;
  sub: string;
}

/** One thing a workspace works on: a brand, a site, a draft. */
export interface WorkSubject {
  id: string;
  /** Two condensed capitals for the rail's chip. */
  ab: string;
  name: string;
  /** Something is running on it right now. */
  busy?: boolean;
  /** A muted figure beside the name in the subject picker ("3 drafts").
   *  Absent until known — a blank says less than a guessed zero. */
  note?: string;
}

/** One section of a workspace, as the rail needs it. `count` of `null` means
 *  the figure is not known yet — the rail then shows nothing rather than a
 *  zero, which would be a claim. */
export interface WorkSection {
  id: string;
  label: string;
  icon: string;
  count?: number | null;
}

/** What a workspace puts in the rail while it is open.
 *
 *  The prototype's rail did this from one closure. Here the workspace declares
 *  it and the shell draws it, so there is still exactly one navigation system
 *  in the product and no workspace grows a second tab bar of its own.
 */
export interface WorkNav {
  agentId: string;
  subjects: WorkSubject[];
  /** What one subject is called in the picker's label and search — "Brand"
   *  unless the workspace says otherwise. */
  subjectNoun?: string;
  subject: string;
  sections: WorkSection[];
  section: string;
  onSubject: (id: string) => void;
  onSection: (id: string) => void;
}

export interface HubContextValue {
  user: User;
  route: Route;
  /** Declared by the open workspace; cleared when it unmounts. */
  setWorkNav: (nav: WorkNav | null) => void;
  /** Move to a console panel. */
  go: (panel: PanelId) => void;
  /** Open a specialist workspace, optionally at a named subject and section. */
  openWork: (slug: string, subject?: string, section?: string) => void;
  /** Leave the workspace and return to the panel underneath it. */
  closeWork: () => void;
  toast: ToastFn;
  setHead: (head: Headline) => void;
  /** Open the brief dialog, optionally pre-aimed at one specialist. */
  openBrief: (agentId?: string) => void;
  /** Something the whole console counts — a run queued, a brand added — has
   *  happened. Panels reading `revision` refetch. */
  bumpRevision: () => void;
  revision: number;
}

const HubContext = createContext<HubContextValue | null>(null);

export const HubProvider = HubContext.Provider;

export function useHub(): HubContextValue {
  const ctx = useContext(HubContext);
  if (!ctx) throw new Error("useHub must be used inside HubProvider");
  return ctx;
}

/** The lines above the panel. They belong to the panel — only the panel knows
 *  how many rows it ended up with — but they render in the header, which the
 *  panel does not own. Declared as an effect so it follows mounting: leave a
 *  panel and its sentence leaves with it.
 */
export function useHeadline(sub: string, title?: string): void {
  const { setHead, route } = useHub();
  // `route` is a dependency on purpose. Every route change blanks the header
  // in the same update (`applyRoute` in HubApp), so a panel that stays
  // mounted across it — a workspace moving between its sections or brands —
  // has to say its line again even when the line came out the same as before
  // the move; keyed on the text alone, the header stayed blank.
  useEffect(() => {
    setHead({ sub, title });
  }, [sub, title, setHead, route]);
}


/** A workspace's rail entry, tied to that workspace's lifetime. Declaring it as
 *  an effect means leaving the workspace takes its sections out of the rail
 *  without the workspace having to remember to. */
export function useWorkNav(nav: WorkNav | null): void {
  const { setWorkNav } = useHub();
  const key = nav
    ? JSON.stringify([nav.agentId, nav.subject, nav.section, nav.subjectNoun ?? null,
        nav.subjects.map((s) => [s.id, s.ab, s.name, !!s.busy, s.note ?? null]),
        nav.sections.map((s) => [s.id, s.label, s.icon, s.count ?? null])])
    : null;
  useEffect(() => {
    setWorkNav(nav);
    return () => setWorkNav(null);
    // The callbacks are rebuilt on every render of the workspace; only the data
    // they carry decides whether the rail actually has to change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setWorkNav]);
}

export type { Route, WorkRoute, PanelId };
