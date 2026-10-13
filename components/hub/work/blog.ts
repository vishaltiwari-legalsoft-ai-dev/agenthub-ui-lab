/** Blog Writer — the decisions behind the workspace, with no React in them.
 *
 *  The route is the truth: `#/w/blog/<brandId>/<view>`, where the view is
 *  `drafts` (the default), `write`, or a run id. Which brand a bare link lands
 *  on, which drafts a brand lists and in what order, and whose draft may be
 *  changed all follow from the route and the runs list alone, so they live
 *  here, provable in `blog.test.ts`, and `BlogWorkspace.tsx` only wires them.
 *
 *  Two things are load-bearing:
 *
 *  1. **Old links keep opening.** Before this route existed the brief dialog
 *     sent people to `#/w/blog/<runId>/research`. A subject that starts with
 *     `bw-` is therefore a run id, never a brand, and its brand is read from
 *     the runs list.
 *  2. **A teammate's draft is not yours to spend on.** An admin's list carries
 *     everyone's runs. Opening one must not restart its research (that costs
 *     money), and by default it is view and export only.
 */

import type { BwBrand, BwRunSummary } from "@/lib/api";

/** Whether a teammate's draft opens read-only (view and export). The one line
 *  to flip if the owner decides admins may research, redraft and revise other
 *  people's drafts. Auto-resume stays own-runs-only either way. */
export const TEAMMATE_RUNS_READ_ONLY = true;

export type BlogView =
  | { kind: "drafts" }
  | { kind: "write" }
  | { kind: "run"; runId: string };

/** Run ids are minted as `bw-<slug>-<hex6>` (backend `research.new_run`). */
export const isRunId = (s: string): boolean => s.startsWith("bw-");

export function parseView(section: string): BlogView {
  if (section === "write") return { kind: "write" };
  if (isRunId(section)) return { kind: "run", runId: section };
  return { kind: "drafts" };
}

/** The route segment a view is written back as. */
export function viewSegment(view: BlogView): string {
  return view.kind === "run" ? view.runId : view.kind;
}

/** Which workspace section the rail lights: a run is one of the drafts. */
export const sectionOf = (view: BlogView): "drafts" | "write" =>
  view.kind === "write" ? "write" : "drafts";

const byNewest = (a: BwRunSummary, b: BwRunSummary): number =>
  (b.created || "").localeCompare(a.created || "");

export const isOwnRun = (run: { user_id?: string }, meId: string): boolean =>
  !!meId && !!run.user_id && run.user_id === meId;

/** The brand a bare `#/w/blog` opens on: the brand of the viewer's newest
 *  run, else the first brand. A run on a brand no longer listed is skipped —
 *  landing on a brand the work bar does not list would mark nothing. */
export function defaultBrand(brands: BwBrand[], runs: BwRunSummary[], meId: string): string {
  const listed = new Set(brands.map((b) => b.id));
  const mine = runs.filter((r) => isOwnRun(r, meId) && listed.has(r.brand_id)).sort(byNewest);
  return mine[0]?.brand_id || brands[0]?.id || "";
}

/** Read the route's two segments into a brand and a view. An open run sits
 *  under its own brand whatever the link says, so the work bar never marks a
 *  brand the draft does not belong to. */
export function readRoute(
  subject: string,
  section: string,
  brands: BwBrand[],
  runs: BwRunSummary[],
  meId: string,
): { brandId: string; view: BlogView } {
  const listed = (id: string | undefined): id is string => !!id && brands.some((b) => b.id === id);
  // The old `#/w/blog/<runId>/research` shape: the subject is the run.
  const view: BlogView = isRunId(subject) ? { kind: "run", runId: subject } : parseView(section);
  const owner = view.kind === "run" ? runs.find((r) => r.id === view.runId)?.brand_id : undefined;
  const brandId = listed(owner) ? owner : listed(subject) ? subject : defaultBrand(brands, runs, meId);
  return { brandId, view };
}

/** One brand's drafts, every one of them: the viewer's first, then
 *  teammates', newest first inside each. */
export function draftsFor(runs: BwRunSummary[], brandId: string, meId: string): BwRunSummary[] {
  const ofBrand = runs.filter((r) => r.brand_id === brandId);
  const mine = ofBrand.filter((r) => isOwnRun(r, meId)).sort(byNewest);
  const theirs = ofBrand.filter((r) => !isOwnRun(r, meId)).sort(byNewest);
  return [...mine, ...theirs];
}

/** How many drafts each brand has — the same rows `draftsFor` lists, so the
 *  brand picker's figure and the Drafts section's count always agree. */
export function draftCounts(runs: BwRunSummary[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of runs) counts.set(r.brand_id, (counts.get(r.brand_id) || 0) + 1);
  return counts;
}

/** The brand picker's muted figure: "No drafts", "1 draft", "12 drafts". */
export function draftCountLabel(count: number): string {
  if (!count || count < 0) return "No drafts";
  return `${count.toLocaleString("en-US")} draft${count === 1 ? "" : "s"}`;
}

/** Who a draft belongs to, in the row's words. `by` is the backend's name for
 *  the author on an admin's list; older rows and other readers' lists lack it. */
export function authorLabel(run: BwRunSummary, meId: string): string {
  if (isOwnRun(run, meId)) return "You";
  return (run.by ?? "").trim() || "Teammate";
}

/** Whether this viewer may research, redraft, revise or plan visuals on a run. */
export const canEditRun = (run: { user_id?: string }, meId: string): boolean =>
  !TEAMMATE_RUNS_READ_ONLY || isOwnRun(run, meId);

/** Opening a run mid-research picks the loop back up — but only on the
 *  viewer's own run, because every round is paid search and model calls. */
export const shouldAutoResume = (run: { user_id?: string; status: string }, meId: string): boolean =>
  run.status === "research" && isOwnRun(run, meId);

/** A run row's state, in plain words. "Open to continue" is only said where
 *  opening actually does continue it. */
export function rowStatus(run: BwRunSummary, meId: string): string {
  if (run.status === "research") {
    return shouldAutoResume(run, meId) ? "Research paused — open to continue" : "Research paused";
  }
  if (run.status === "saturated" || run.status === "capped") return "Research done";
  return run.status;
}
