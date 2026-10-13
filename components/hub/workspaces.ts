/** The five workspaces, and the sections each one offers.
 *
 *  Only the shape lives here — which sections exist, what they are called, and
 *  which icon each carries. What is *in* a section, and which subjects a
 *  workspace has to offer, is fetched by the workspace itself: those are facts
 *  about the account, and this file is not allowed to have an opinion on them.
 */

export interface SectionDef {
  id: string;
  label: string;
  icon: string;
}

export interface WorkspaceDef {
  slug: string;
  agentId: string;
  /** What one row in the subject list is, in the reader's words. Used for the
   *  empty state, so it can say "no brands yet" rather than "no subjects". */
  subjectNoun: string;
  subjectPlural: string;
  sections: SectionDef[];
}

export const WORKSPACES: WorkspaceDef[] = [
  {
    slug: "seo",
    agentId: "a2",
    subjectNoun: "brand",
    subjectPlural: "brands",
    sections: [
      { id: "fixes", label: "Fix list", icon: "fix" },
      { id: "plan", label: "Blog plan", icon: "plan" },
      { id: "pages", label: "Pages", icon: "pages" },
      { id: "rivals", label: "Competitors", icon: "competitors" },
      { id: "keywords", label: "Keywords", icon: "keywords" },
      { id: "health", label: "Site health", icon: "health" },
      { id: "ask", label: "Ask", icon: "ask" },
    ],
  },
  {
    slug: "geo",
    agentId: "a10",
    subjectNoun: "brand",
    subjectPlural: "brands",
    sections: [
      { id: "overview", label: "Overview", icon: "overview" },
      { id: "trend", label: "Trend", icon: "trend" },
      { id: "questions", label: "Questions", icon: "ask" },
      { id: "answers", label: "Answers", icon: "reports" },
      { id: "sources", label: "Sources", icon: "sources" },
      { id: "competitors", label: "Competitors", icon: "competitors" },
      { id: "plan", label: "Plan", icon: "plan" },
      { id: "optimizer", label: "Page check", icon: "optimizer" },
      // Which brands exist at all, and whether each is checked on a schedule.
      // Last because it is the only section that is not about the brand you
      // have open — it is about the shared list every one of them comes from.
      { id: "brands", label: "Brands", icon: "globe" },
      { id: "faq", label: "FAQ", icon: "research" },
    ],
  },
  {
    slug: "mr",
    agentId: "a6",
    subjectNoun: "workspace",
    subjectPlural: "workspaces",
    sections: [
      { id: "desk", label: "Desk", icon: "desk" },
      { id: "vendors", label: "Vendors", icon: "vendors" },
      { id: "leads", label: "Leads", icon: "leads" },
      { id: "lines", label: "Lines", icon: "lines" },
      { id: "ask", label: "Ask", icon: "ask" },
      { id: "reports", label: "Reports", icon: "reports" },
      { id: "data", label: "Data", icon: "data" },
    ],
  },
  {
    // The subject is a brand — its chips are the brand switcher. An open
    // draft rides the Drafts section as `#/w/blog/<brandId>/<runId>`.
    slug: "blog",
    agentId: "a9",
    subjectNoun: "brand",
    subjectPlural: "brands",
    sections: [
      { id: "drafts", label: "Drafts", icon: "reports" },
      { id: "write", label: "Write", icon: "draft" },
    ],
  },
  {
    slug: "art",
    agentId: "a1",
    subjectNoun: "creative",
    subjectPlural: "creatives",
    sections: [
      { id: "studio", label: "Studio", icon: "layers" },
      { id: "tries", label: "Tries", icon: "tries" },
      { id: "kit", label: "Brand kit", icon: "kit" },
    ],
  },
  {
    // One section, and no subjects: the workspace is one account's Gmail and
    // one sheet, so there is nothing to pick between. The section still goes
    // in the rail, because the rail's workspace group is also the way out and
    // the chip that says where you are — its one link just has nowhere else
    // to go.
    slug: "inbox",
    agentId: "a12",
    subjectNoun: "inbox",
    subjectPlural: "inboxes",
    sections: [
      { id: "inbox", label: "Inbox", icon: "bell" },
    ],
  },
];

export const workspaceBySlug = (slug: string): WorkspaceDef | undefined =>
  WORKSPACES.find((w) => w.slug === slug);

export const workspaceByAgent = (agentId: string): WorkspaceDef | undefined =>
  WORKSPACES.find((w) => w.agentId === agentId);

/** One subject inside a workspace, as the rail needs it: an id to route by, a
 *  two-letter stamp, a name, and whether something is running on it now. */
export interface Subject {
  id: string;
  ab: string;
  name: string;
  busy?: boolean;
}
