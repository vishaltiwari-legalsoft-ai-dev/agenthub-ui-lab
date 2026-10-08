/* GD Studio's stage generate, followed past the relay's 300 s cut.

   A Stage-3 polish took 148 s for one user on staging and can pass 300 s under
   load; Stage 1/2 image calls and the Stage-4 composite are the same shape.
   When the relay cuts the request, the backend still finishes and saves the
   attempt, and the run is readable from any instance — so a cut means "read
   the run until the NEW attempt for this stage is there", not "it failed".

   "New" is decided against a mark taken before the call: the highest attempt
   number the stage already had. Attempt numbers only grow (the backend gives
   each the stage's length + 1), so anything past the mark was made after the
   call went out — "any attempt exists" would hand back the previous one.

   The loop is `lib/longCall.ts`; what lives here is GD's reading of a run.
   Pure, every effect injected — proved in autoPilot.test.ts. Runtime imports
   are relative; `@/` is type-only, because vitest does not resolve the alias. */

import type { GdAttempt, GdRun } from "@/lib/api";
import { STILL_GENERATING, WATCH_CAP_MS, watchLongCall } from "../../../lib/longCall";

export { STILL_GENERATING };

/** What a stage generate answers: `/generate` and `/stage4` alike. A Stage-3
 *  Text Optimizer set also carries every styled sibling in `attempts`. */
export interface GdStageResult {
  attempt: GdAttempt;
  attempts?: GdAttempt[];
  run: GdRun;
}

/** The line a new attempt must cross: the highest attempt number `stage` has
 *  now (0 when it has none). */
export function stageMark(run: Pick<GdRun, "stages"> | null | undefined, stage: number): number {
  const attempts = run?.stages?.[String(stage)]?.attempts ?? [];
  return attempts.reduce((m, a) => Math.max(m, a.attempt), 0);
}

/** The generate answer rebuilt from a stored run, or null while the new
 *  attempt is not there yet. Mirrors the backend's own reply: a Text Optimizer
 *  set (siblings sharing a `set_id`, saved together in one write) comes back
 *  whole, its `attempt` the first QA-passed style — else the first, the same
 *  pick `pipeline._generate_stage3` makes; any other stage is the one new
 *  attempt. */
export function stageResultFrom(run: GdRun, stage: number, mark: number): GdStageResult | null {
  const fresh = (run.stages?.[String(stage)]?.attempts ?? [])
    .filter((a) => a.attempt > mark)
    .sort((a, b) => a.attempt - b.attempt);
  const first = fresh[0];
  if (!first) return null;
  if (first.set_id) {
    const set = fresh.filter((a) => a.set_id === first.set_id);
    const passed = set.find((a) => a.qa === "passed");
    return { attempt: passed ?? set[0], attempts: set, run };
  }
  return { attempt: first, run };
}

/** What changed between two reads of the run. */
export function stageFingerprint(run: GdRun, stage: number): string {
  return [run.state, run.updated_at, run.stages?.[String(stage)]?.attempts?.length ?? 0].join("|");
}

export function stageCapMessage(stage: number, capMs: number = WATCH_CAP_MS): string {
  const minutes = Math.round(capMs / 60_000);
  return (
    `Stopped waiting after ${minutes} minute${minutes === 1 ? "" : "s"} — Stage ${stage} still hasn't come back. ` +
    `It may yet finish on the server; generating again now would bill a second time.`
  );
}

/** The cap passed with the stage still going. Not a failure — the studio says
 *  it in the warning tone, not the error one. */
export class StageStillRunning extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageStillRunning";
  }
}

export const isStageStillRunning = (e: unknown): boolean =>
  e instanceof Error && e.name === "StageStillRunning";

/** A watch the view walked away from. Named `AbortError` so the studio's
 *  failure path treats it as the supersession it is and says nothing. */
const superseded = () => Object.assign(new Error("The stage watch was superseded."), { name: "AbortError" });

export interface StageWatchDeps {
  stage: number;
  /** `stageMark` of the freshest run the studio held when the call went out. */
  mark: number;
  /** The stage generate itself. */
  fire: () => Promise<GdStageResult>;
  /** One read of the run by id (`GET /api/gd/runs/{id}`). */
  read: () => Promise<GdRun>;
  current: () => boolean;
  /** Once, when the call came back unanswered and the studio keeps waiting. */
  onCut?: () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  capMs?: number;
}

/** Run one stage generate to its answer — the call's own, or the new attempt
 *  read back after a cut. Resolves like the call it replaces, so call sites
 *  keep their shape; rejects with the backend's refusal, `StageStillRunning`
 *  at the cap, or an `AbortError` when the studio moved on.
 *
 *  Nothing is read while the call is open: a stage has no progress to show,
 *  and the run is large — reads start only after a cut. There is no stored
 *  "failed" marker for a stage, so after a cut only a refused read (404, an
 *  expired session) or the cap can end the wait short of the new attempt. */
export async function watchStageGenerate(deps: StageWatchDeps): Promise<GdStageResult> {
  const out = await watchLongCall<GdRun, GdStageResult>({
    fire: deps.fire,
    read: deps.read,
    current: deps.current,
    onCut: deps.onCut,
    readWhileOpen: false,
    sleep: deps.sleep,
    now: deps.now,
    capMs: deps.capMs,
    settle: (run) => {
      const result = stageResultFrom(run, deps.stage, deps.mark);
      return result ? { kind: "done", value: result } : null;
    },
    fingerprint: (run) => stageFingerprint(run, deps.stage),
  });
  if (out.kind === "done") return out.value;
  if (out.kind === "failed") throw out.error;
  if (out.kind === "capped") throw new StageStillRunning(stageCapMessage(deps.stage, out.capMs));
  throw superseded();
}
