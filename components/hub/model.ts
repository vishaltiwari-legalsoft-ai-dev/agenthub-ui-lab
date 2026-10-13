/** AgentHub — the console's own vocabulary.
 *
 *  The prototype at `agenst ui revamp/agenthub` carried one hand-written object
 *  that was both the catalogue and the data. Here the catalogue survives and the
 *  data does not: every figure this console shows is fetched, so a number on a
 *  panel is always a number the backend stood behind. What is left in this file
 *  is only what the backend has no opinion about — an agent's two-letter stamp,
 *  the sentence describing what it hands back, and which panels exist.
 */

/* ------------------------------------------------------------------ agents -- */

export interface HubAgent {
  id: string;
  /** The monogram stamp — two condensed capitals, the console's own object. */
  mono: string;
  name: string;
  role: string;
  /** Wired to a live backend. Everything else is catalogue only. */
  live: boolean;
  desc: string;
  /** What one run hands back, in the agent's own terms. */
  makes: string;
}

export const AGENTS: HubAgent[] = [
  {
    id: "a1", mono: "GD", name: "Graphic Designer", role: "Brand & visual assets", live: true,
    desc: "Produces on-brand graphics, social creatives, and ad variants from a written brief.",
    makes: "A finished PNG, through four stages you approve one at a time.",
  },
  {
    id: "a2", mono: "SE", name: "SEO Analyst", role: "Search & rankings", live: true,
    desc: "Audits pages, finds keyword gaps, and writes optimization briefs.",
    makes: "A ranked fix list and a blog plan, per brand.",
  },
  {
    id: "a6", mono: "MR", name: "Marketing Research", role: "Campaigns, competitors & funnel", live: true,
    desc: "Aggregates campaign performance, tracks competitors, analyzes the lead funnel, and surfaces media opportunities.",
    makes: "One of ten report kinds, as a document and a PDF.",
  },
  {
    id: "a9", mono: "BW", name: "Blog Writer", role: "Deep-research blog drafts", live: true,
    desc: "Researches a topic in depth and drafts evidence-backed, citation-rich posts for each brand.",
    makes: "A cited draft and its evidence ledger, as Markdown or HTML.",
  },
  {
    id: "a10", mono: "GE", name: "GEO", role: "AI answer visibility", live: true,
    desc: "Measures how often AI engines name and cite your brand, and finds the gaps to fix.",
    makes: "Five engines' answers to your buyer questions, scored.",
  },
  {
    // `IN`, not `IT`: two capitals drawn alone on a chip, and `IT` beside five
    // other monograms reads as the department rather than the specialist.
    id: "a12", mono: "IN", name: "Inbox Triage", role: "Gmail to a sheet, read-only", live: true,
    desc: "Reads your Gmail inbox and writes one row per message to a Google Sheet you own — sender, subject, category, summary, deadline and link — with an Upcoming tab of deadlines nearest first.",
    makes: "A row per message in your own sheet, every five minutes. It never sends, labels, deletes or marks mail — it only reads.",
  },
  {
    id: "a3", mono: "CW", name: "Copywriter", role: "Words that convert", live: false,
    desc: "Drafts landing copy, emails, and posts in your brand voice.",
    makes: "Landing copy and email bodies.",
  },
  {
    id: "a4", mono: "SS", name: "Social Scheduler", role: "Posts & calendars", live: false,
    desc: "Plans and queues content across channels at the best times.",
    makes: "A dated posting calendar.",
  },
  {
    id: "a5", mono: "AO", name: "Ads Optimizer", role: "Paid performance", live: false,
    desc: "Tunes budgets, bids, and creatives to hit your CPA target.",
    makes: "Budget and bid changes, with the reason for each.",
  },
  {
    id: "a7", mono: "EM", name: "Email Marketer", role: "Lifecycle & nurture", live: false,
    desc: "Builds sequences and writes nurture flows that re-engage leads.",
    makes: "A sequence, step by step.",
  },
  {
    id: "a8", mono: "BS", name: "Brand Strategist", role: "Positioning & messaging", live: false,
    desc: "Shapes positioning, tone, and messaging pillars for campaigns.",
    makes: "Positioning and messaging pillars.",
  },
];

export const LIVE_AGENTS = AGENTS.filter((a) => a.live);
export const agentById = (id: string): HubAgent | undefined => AGENTS.find((a) => a.id === id);

/** Agent id to workspace slug, for the six that have a workspace behind them. */
export const WORKSPACE_SLUG: Record<string, string> = {
  a1: "art",
  a2: "seo",
  a6: "mr",
  a9: "blog",
  a10: "geo",
  a12: "inbox",
};

export const agentBySlug = (slug: string): HubAgent | undefined =>
  AGENTS.find((a) => WORKSPACE_SLUG[a.id] === slug);

/* ------------------------------------------------------------------ panels -- */

export type PanelId =
  | "home" | "issues" | "agents" | "runs"
  | "library"
  | "models" | "integrations" | "schedule" | "settings" | "admin";

export interface Panel {
  id: PanelId;
  label: string;
  icon: string;
  group: "Work" | "Assets" | "Setup";
  title: string;
  /** Which role may open it. `null` means everyone signed in. */
  gate: null | "admin" | "creator";
  /** Whether every route this panel reads is inside the allowance of a
   *  GEO-only account (see `Viewer.is_geo_only`). `false` means the panel's own
   *  first read answers 403, so it is never offered to one.
   *
   *  This is traced from the panel's `lib/api` call sites, not guessed — when a
   *  panel gains a read, this flag is part of the change. */
  inGeoScope: boolean;
}

/* The reads behind each `inGeoScope`, so the next person to touch a panel can
 * check the claim instead of trusting it:
 *   home         getIssues · seoOverview · listRuns          — all allowed
 *   issues       getIssues                                   — allowed
 *   agents       listRuns                                    — allowed, and the
 *                only way into the GEO workspace, so it must stay
 *   runs         listRuns                                    — allowed
 *   library      loadLibrary + gdIngestedBrands              — `/api/gd/*` 403s
 *   models       getAgentConfig                              — 403s
 *   integrations mrConnectors + seoOverview + geoConfig      — `/api/mr/*` 403s
 *   schedule     getCronJobs                                 — 403s
 *   settings     nothing — identity, theme and a local list  — cannot 403
 *   admin        the admin reads                             — 403s
 */
export const PANELS: Panel[] = [
  // Since 2026-10-08 a member — a sub-manager or a reportee — gets Home, the
  // specialists and Settings. The workspace-wide views (Issues, Runs, Brands,
  // Integrations) are the admin's: what the team is doing is read on Home by
  // the sub-manager, for their own reportees only. The backend refuses
  // `/api/issues` to a member as well; the other three read only what the
  // caller may see, and are hidden here because they are not the member's job.
  { id: "home", label: "Home", icon: "home", group: "Work", title: "Home", gate: null, inGeoScope: true },
  { id: "issues", label: "Issues", icon: "issues", group: "Work", title: "Issues", gate: "admin", inGeoScope: true },
  { id: "agents", label: "Agents", icon: "agents", group: "Work", title: "Agents", gate: null, inGeoScope: true },
  { id: "runs", label: "Runs", icon: "runs", group: "Work", title: "Runs", gate: "admin", inGeoScope: true },
  { id: "library", label: "Brands", icon: "vendors", group: "Assets", title: "Brands", gate: "admin", inGeoScope: false },
  { id: "models", label: "Models", icon: "models", group: "Setup", title: "Models", gate: "creator", inGeoScope: false },
  { id: "integrations", label: "Integrations", icon: "integrations", group: "Setup", title: "Integrations", gate: "admin", inGeoScope: false },
  { id: "schedule", label: "Schedule", icon: "plan", group: "Setup", title: "Schedule", gate: "creator", inGeoScope: false },
  { id: "settings", label: "Settings", icon: "settings", group: "Setup", title: "Settings", gate: null, inGeoScope: true },
  { id: "admin", label: "Admin", icon: "admin", group: "Setup", title: "Admin", gate: "admin", inGeoScope: false },
];

export interface Viewer {
  is_admin?: boolean;
  is_creator?: boolean;
  /** The backend's scope wall (`User.is_geo_only`): this account is served the
   *  GEO routes and refused the rest with a 403. Absent reads as `false`, so a
   *  session stored before the wall shipped sees exactly what it saw before. */
  is_geo_only?: boolean;
}

export function canOpen(panel: Panel, viewer: Viewer): boolean {
  // The scope wall is the backend's decision and outranks the role gates: a
  // scoped account is refused these routes whatever else it is.
  if (viewer.is_geo_only && !panel.inGeoScope) return false;
  if (panel.gate === "admin") return !!viewer.is_admin;
  if (panel.gate === "creator") return !!viewer.is_creator;
  return true;
}

export const panelsFor = (viewer: Viewer): Panel[] => PANELS.filter((p) => canOpen(p, viewer));

/* ------------------------------------------------------------ scope wall -- */

/** The one specialist a GEO-only account can open. All 25 `/api/geo/*` routes
 *  are inside its allowance; every other workspace 403s on its first read. */
export const GEO_AGENT_ID = "a10";

/** Whether this viewer may open a specialist's workspace at all — the single
 *  question every "Open workspace", "Give it work" and `#/w/<slug>` link has to
 *  ask before it offers itself. */
export function canOpenAgent(agentId: string, viewer: Viewer): boolean {
  if (viewer.is_geo_only) return agentId === GEO_AGENT_ID;
  return true;
}

export function canOpenWorkspace(slug: string, viewer: Viewer): boolean {
  const agent = agentBySlug(slug);
  return !!agent && canOpenAgent(agent.id, viewer);
}

/** The live specialists this viewer may open or hand work to. Everyone who is
 *  not scoped gets the whole live roster, exactly as before. */
export const agentsFor = (viewer: Viewer): HubAgent[] =>
  LIVE_AGENTS.filter((a) => canOpenAgent(a.id, viewer));

const isPanelId = (v: string): v is PanelId => PANELS.some((p) => p.id === v);

/* ------------------------------------------------------------------- route -- */

/** Where the console is. A workspace is layered *over* a panel rather than
 *  replacing it, exactly as in the prototype: `panel` is what Back returns to. */
export interface Route {
  panel: PanelId;
  work: WorkRoute | null;
}

export interface WorkRoute {
  /** Workspace slug: `seo`, `geo`, `mr`, `blog`, `art`. */
  slug: string;
  /** Which subject inside it — a brand id, a site id, a draft id. */
  subject: string;
  /** Which section of that subject. */
  section: string;
}

export const HOME: Route = { panel: "home", work: null };

export function routeToHash(r: Route): string {
  if (r.work) {
    const { slug, subject, section } = r.work;
    const tail = [slug, subject && encodeURIComponent(subject), section].filter(Boolean).join("/");
    return `#/w/${tail}`;
  }
  return `#/${r.panel}`;
}

/** Parse a hash into a route. Anything unrecognised, or gated away from this
 *  viewer, falls back to Home rather than rendering a panel they cannot have. */
export function routeFromHash(hash: string, viewer: Viewer): Route {
  // A hash may carry a query after the route — `#/w/inbox?connected=1` is how
  // the OAuth return says what happened. The route is everything before it;
  // the workspace reads the rest. A subject is `encodeURIComponent`ed on the
  // way in, so a literal `?` can only ever be this.
  const raw = hash.replace(/^#\/?/, "").split("?")[0];
  if (!raw) return HOME;

  const parts = raw.split("/").filter(Boolean);
  if (parts[0] === "w" && parts.length >= 2) {
    const slug = parts[1];
    if (!agentBySlug(slug)) return HOME;
    // A bookmark or a pasted link is the one way into a workspace that no
    // button guards, so the scope wall is applied here too.
    if (!canOpenWorkspace(slug, viewer)) return HOME;
    return {
      panel: "agents",
      work: {
        slug,
        subject: parts[2] ? decodeURIComponent(parts[2]) : "",
        section: parts[3] || "",
      },
    };
  }

  if (!isPanelId(parts[0])) return HOME;
  const panel = PANELS.find((p) => p.id === parts[0])!;
  if (!canOpen(panel, viewer)) return HOME;
  return { panel: panel.id, work: null };
}

/* ----------------------------------------------------------------- numbers -- */

export const n = (v: number): string => v.toLocaleString("en-US");
export const usd = (v: number): string => `$${v.toFixed(2)}`;
export const usd0 = (v: number): string => `$${Math.round(v).toLocaleString("en-US")}`;

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/** Small counts read as prose in a sentence and as figures in a column; this
 *  console writes sentences under most of its headings, so it needs both. */
export const word = (v: number): string => (v >= 0 && v <= 10 ? WORDS[v] : n(v));
export const Cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** A list inside prose needs its last comma turned into an "and", or the
 *  sentence reads like a column that lost its table. */
export const andList = (a: readonly string[]): string =>
  a.length < 2 ? a[0] || "" : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;

export function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

/** Two condensed capitals for anything the catalogue does not name — a brand,
 *  a site, a person. Same shape as an agent's `mono`. */
export function initials(name: string): string {
  const parts = String(name || "").trim().split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/* ------------------------------------------------------- work-bar subjects -- */

/** Up to this many subjects sit in the work bar as chips; past it they fold
 *  into one picker. Twelve brands as chips wrapped every label and pushed the
 *  row out of its card; five short ones still read at a glance. */
export const SUBJECT_CHIPS_MAX = 5;

export const usesSubjectPicker = (count: number): boolean => count > SUBJECT_CHIPS_MAX;

/** Letters and digits only, lower-cased: "US Immigration AI" and
 *  "usimmigration" are the same search, and so are "legal soft" and
 *  "LegalSoft" — the registry's casing and spacing are not the reader's. */
const squash = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** The picker's search. Every word typed must appear in the name (or be the
 *  initials); names that start with the search come first, and the registry's
 *  order holds inside each group. An empty search is the whole list. */
export function filterSubjects<T extends { name: string; ab?: string }>(items: readonly T[], query: string): T[] {
  const words = query.split(/\s+/).map(squash).filter(Boolean);
  if (!words.length) return [...items];
  const whole = words.join("");
  const hits = items.filter((it) => {
    const name = squash(it.name);
    return words.every((w) => name.includes(w)) || (!!it.ab && squash(it.ab) === whole);
  });
  const lead = hits.filter((it) => squash(it.name).startsWith(whole));
  return [...lead, ...hits.filter((it) => !lead.includes(it))];
}
