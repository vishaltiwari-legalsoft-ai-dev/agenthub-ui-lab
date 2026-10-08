/** The Creative Agent's decisions, kept out of the component so they can be
 *  proved without a DOM (see `CreativeAgent.test.ts`). Runtime imports are
 *  relative; `@/` is type-only, because vitest does not resolve the alias.
 *
 *  Two things live here:
 *
 *  1. **Provenance.** Every produced file says whether the image model made
 *     every picture in it (`ai` / `fallback_reason`, the pair GD Stage-3
 *     attempts carry). A locally drawn stand-in is named as one wherever the
 *     file is shown or downloaded — never passed off as AI output.
 *  2. **Watching a long run.** Generate and autonomous hold one request open
 *     for the whole job, and the Vercel relay cuts that request at 300 s while
 *     Cloud Run carries on. The run is readable from any instance, so a cut
 *     means "go and look", not "it failed": the watch keeps reading the run by
 *     id, backs off while nothing moves, and stops only on a terminal run
 *     state, a real failure, or its own overall cap.
 */

import type { CreativeArtifact, CreativeRun } from "@/lib/api";
import {
  STILL_GENERATING,
  WATCH_BASE_MS,
  WATCH_CAP_MS,
  WATCH_MAX_MS,
  nextDelay,
  watchLongCall,
} from "../../lib/longCall";

/* ------------------------------------------------------------ provenance -- */

export const STAND_IN_LABEL = "Includes a stand-in image (not AI)";
/** The short form, for a thumbnail that is itself the stand-in. */
export const STAND_IN_SHORT = "Stand-in (not AI)";

export interface StandIn {
  label: string;
  /** The backend's own sentence, or null when it gave none — never invented. */
  reason: string | null;
  /** What the person reads on hover or expand. */
  detail: string;
}

const asSentence = (s: string) => {
  const t = s[0].toUpperCase() + s.slice(1);
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/** The stand-in disclosure for one file, or null when there is nothing to
 *  disclose. `ai: true` (every image from the model) and an absent `ai` (no
 *  image model involved — the PPTX deck) both say nothing. */
export function standIn(a: Pick<CreativeArtifact, "ai" | "fallback_reason">): StandIn | null {
  if (a.ai !== false) return null;
  const given = typeof a.fallback_reason === "string" ? a.fallback_reason.trim() : "";
  const reason = given || null;
  return {
    label: STAND_IN_LABEL,
    reason,
    detail: reason
      ? asSentence(reason)
      : "The image model did not make every picture in this file — at least one is a stand-in.",
  };
}

/** How many files carry a stand-in. The bundled .zip is left out while any
 *  primary file says so itself: it inherits its members' provenance, and
 *  counting it too would count the same picture twice. */
export function standInCount(artifacts: readonly Pick<CreativeArtifact, "ai" | "mime">[]): number {
  const flagged = artifacts.filter((a) => a.ai === false);
  const primary = flagged.filter((a) => a.mime !== "application/zip");
  return primary.length || flagged.length;
}

/** The toast for a finished run. "Creative generated" over a file the image
 *  model did not fully make would be a success the run did not have, so the
 *  stand-in count rides on it and the tone drops to a calm warning. */
export function finishedNote(
  base: string,
  artifacts: readonly Pick<CreativeArtifact, "ai" | "mime">[],
): { message: string; tone: "ok" | "warn" } {
  const n = standInCount(artifacts);
  if (n === 0) return { message: base, tone: "ok" };
  const files = n === 1 ? "1 file includes" : `${n} files include`;
  return { message: `${base} — ${files} a stand-in image (not AI)`, tone: "warn" };
}

/* ---------------------------------------------------------- the watch -- */
/* The loop itself is `lib/longCall.ts`, shared with GD Studio's stage
   generate; what lives here is what "finished" means for a creative run, and
   the words. */

export { STILL_GENERATING, WATCH_BASE_MS, WATCH_CAP_MS, WATCH_MAX_MS, nextDelay };

export function capMessage(capMs: number = WATCH_CAP_MS): string {
  const minutes = Math.round(capMs / 60_000);
  return (
    `Stopped waiting after ${minutes} minute${minutes === 1 ? "" : "s"} — this run hasn't finished. ` +
    `It may still complete on the server: Check again before starting a new one, which would be billed again.`
  );
}

/** The part of a run the watch reasons about. Structural, so `CreativeRun`
 *  satisfies it and tests can hand in plain objects. */
export type WatchedRun = Pick<CreativeRun, "state" | "progress" | "artifacts" | "decision_log">;

export type RunPhase = "running" | "done" | "failed";

/** `DONE` is the backend's finished state; `progress.state: "failed"` is what
 *  it records when a produced file could not be saved. Anything else is still
 *  going as far as the stored run can say. */
export function runPhase(run: WatchedRun): RunPhase {
  if (run.state === "DONE") return "done";
  if (run.progress?.state === "failed") return "failed";
  return "running";
}

/** The backend's own words for a run it marked failed: the last output
 *  decision it logged ("Could not save the generated files — …"). */
export function runFailureMessage(run: WatchedRun): string {
  const last = [...run.decision_log].reverse().find((d) => d.step === "output");
  if (!last) return "Generation stopped on the server before it finished. Please try again.";
  const why = last.rationale?.trim();
  return why ? `${last.decision} — ${why}` : last.decision;
}

/** What changed between two reads. Any movement resets the backoff, so slides
 *  that stream in are shown as they land. */
export function runFingerprint(run: WatchedRun): string {
  const p = run.progress;
  return [
    run.state, p?.done ?? "", p?.total ?? "", p?.state ?? "",
    run.artifacts.length, run.decision_log.length,
  ].join("|");
}

export type WatchOutcome<R> =
  /** Finished. `run` is the final copy. */
  | { kind: "done"; run: R }
  /** A real failure; `error` goes through the caller's failure wording. */
  | { kind: "failed"; error: unknown }
  /** The overall cap passed with the run still going. */
  | { kind: "capped"; message: string }
  /** Superseded, unmounted or aborted — say nothing at all. */
  | { kind: "dropped" };

export interface WatchDeps<R extends WatchedRun> {
  /** The long call (generate / autonomous). Omitted to watch only. */
  fire?: () => Promise<R>;
  /** One read of the run by id. */
  read: () => Promise<R>;
  /** False once the view unmounted or a newer watch took over. */
  current: () => boolean;
  /** Every fresh copy of the run, from a read or the final answer. */
  onRun: (run: R) => void;
  /** Once, when the long call came back unanswered and the watch carries on. */
  onCut?: () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  capMs?: number;
}

/** Drive one creative run to an outcome: reads every 2 s while the call is
 *  open so slides stream in, and after a cut until the stored run is DONE or
 *  marked failed. */
export async function watchRun<R extends WatchedRun>(deps: WatchDeps<R>): Promise<WatchOutcome<R>> {
  const out = await watchLongCall<R, R>({
    fire: deps.fire,
    read: deps.read,
    current: deps.current,
    onRead: deps.onRun,
    onCut: deps.onCut,
    readWhileOpen: true,
    sleep: deps.sleep,
    now: deps.now,
    capMs: deps.capMs,
    settle: (run) => {
      const phase = runPhase(run);
      if (phase === "done") return { kind: "done", value: run };
      if (phase === "failed") return { kind: "failed", error: new Error(runFailureMessage(run)) };
      return null;
    },
    fingerprint: runFingerprint,
  });
  if (out.kind === "done") {
    deps.onRun(out.value);
    return { kind: "done", run: out.value };
  }
  if (out.kind === "capped") return { kind: "capped", message: capMessage(out.capMs) };
  return out;
}
