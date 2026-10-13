"use client";

/** What the canvas shows for the current route.
 *
 *  The console is being moved onto the new design one surface at a time, and
 *  this is where the seam sits. All eight console panels are rebuilt. The five
 *  specialist workspaces are not, and render the working screens they have
 *  always had inside `.legacy`, which pins the one design token the two systems
 *  disagree on so nothing shifts underneath them.
 *
 *  The seam is a list rather than a scatter of conditionals, so what is left is
 *  countable and removing the last entry is a deliberate commit.
 */

import { useHub } from "./context";
import type { Route } from "./model";
import { PANELS, agentBySlug, canOpen, canOpenAgent } from "./model";
import { HomeView } from "./panels/HomeView";
import { IssuesView } from "./panels/IssuesView";
import { AgentsView } from "./panels/AgentsView";
import { RunsView } from "./panels/RunsView";
import { BrandsView } from "./panels/BrandsView";
import { ModelsView } from "./panels/ModelsView";
import { IntegrationsView } from "./panels/IntegrationsView";
import { ScheduleView } from "./panels/ScheduleView";
import { SettingsView } from "./panels/SettingsView";
import { AdminView } from "./panels/AdminView";
import { GeoWorkspace } from "./work/GeoWorkspace";
import { MrWorkspace } from "./work/MrWorkspace";
import { InboxWorkspace } from "./work/InboxWorkspace";
import { SeoWorkspace } from "./work/SeoWorkspace";
import { BlogWorkspace } from "./work/BlogWorkspace";

import { GraphicsStudioV2 } from "@/components/console/gd2/GraphicsStudioV2";

/** The surfaces still rendering their pre-revamp markup with no workspace of
 *  their own. (SEO's classic console and the Blog Writer's desk still render
 *  inside `.legacy` too, but behind their workspaces, which own the route,
 *  the brands in the work bar and the sections.) */
export const LEGACY = ["w/art"] as const;

function Legacy({ children }: { children: React.ReactNode }) {
  return <div className="legacy">{children}</div>;
}

export function PanelSwitch({ route }: { route: Route }) {
  const { user, toast, go, closeWork } = useHub();

  if (route.work) {
    const agent = agentBySlug(route.work.slug);
    // Unknown, or refused to this account: either way the canvas must not
    // mount a workspace whose first read the backend answers 403. The header
    // is drawn from the same gate, so the two can never disagree.
    if (!agent || !canOpenAgent(agent.id, user)) {
      go("agents");
      return null;
    }
    // Rebuilt workspaces render straight onto the canvas. The rest still render
    // the screens they have always had, inside the wrapper that pins the one
    // token the two design systems disagree on.
    if (agent.id === "a10") {
      return <GeoWorkspace subject={route.work.subject} section={route.work.section} />;
    }
    if (agent.id === "a6") {
      return <MrWorkspace subject={route.work.subject} section={route.work.section} />;
    }
    if (agent.id === "a2") {
      return <SeoWorkspace subject={route.work.subject} section={route.work.section} />;
    }
    if (agent.id === "a9") {
      return <BlogWorkspace subject={route.work.subject} section={route.work.section} />;
    }
    // One account, one sheet, one section: the route carries nothing it needs.
    if (agent.id === "a12") {
      return <InboxWorkspace />;
    }
    const back = () => closeWork();
    return (
      <Legacy>
        {agent.id === "a1" && <GraphicsStudioV2 onToast={toast} onBack={back} />}
      </Legacy>
    );
  }

  // The shell already draws the header from `canOpen`; drawing the body from
  // anything else would let a gated panel render under the right title.
  const panel = PANELS.find((p) => p.id === route.panel);
  if (panel && !canOpen(panel, user)) return <HomeView />;

  switch (route.panel) {
    case "home": return <HomeView />;
    case "issues": return <IssuesView />;
    case "agents": return <AgentsView />;
    case "runs": return <RunsView />;
    // The Library's slot now carries the Brands panel: who is working for
    // whom, right now. The id stays "library" so stored links keep opening.
    case "library": return <BrandsView />;
    case "models": return <ModelsView />;
    case "integrations": return <IntegrationsView />;
    case "schedule": return <ScheduleView />;
    case "settings": return <SettingsView />;
    case "admin": return <AdminView />;
    default: return <HomeView />;
  }
}
