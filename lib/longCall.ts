/** Following a long call past the relay's 300 s cut — the decision layer, pure.
 *
 *  A model call (a Creative Agent run, a GD stage generate) holds one request
 *  open for the whole job. The Vercel relay cuts that request at 300 s while
 *  Cloud Run carries on, and the result lands on a run that any instance can
 *  read back by id. So a cut — a 504, a dropped connection, our own deadline
 *  (`isUnanswered`) — means "go and look", not "it failed": this keeps reading
 *  the stored copy, backing off while nothing moves, until the caller's
 *  `settle` says it is finished or failed, the backend refuses the read, or
 *  the overall cap passes.
 *
 *  Every effect is injected, so the stop rules are provable without React, a
 *  network or a real clock. The per-rail parts — what "finished" looks like on
 *  the stored copy, and the words — live with each rail: `creativeRun.ts`
 *  (CreativeAgent.test.ts) and `gd2/stageWatch.ts` (autoPilot.test.ts).
 *  Runtime imports are relative so vitest, which does not resolve `@/`, can
 *  load it.
 */

import { isAbortError, isUnanswered } from "./requestPolicy";

/** First gap between reads, and the one a moving run returns to. */
export const WATCH_BASE_MS = 2_000;
/** The longest gap while nothing moves. */
export const WATCH_MAX_MS = 15_000;
/** How long one watch waits overall before it says so and stops. */
export const WATCH_CAP_MS = 15 * 60_000;

export const STILL_GENERATING = "Still generating — this one is taking longer than usual.";

/** Back to the base gap when the run moved; ×1.5 up to the ceiling when not. */
export function nextDelay(prevMs: number, moved: boolean): number {
  if (moved) return WATCH_BASE_MS;
  return Math.min(Math.round(prevMs * 1.5), WATCH_MAX_MS);
}

const statusOf = (e: unknown): number | null => {
  const s = typeof e === "object" && e !== null ? (e as { status?: unknown }).status : undefined;
  return typeof s === "number" ? s : null;
};

/** A rejected long call. Unanswered (relay 504, dropped connection, our own
 *  deadline) → keep watching the stored copy; a caller's abort → say nothing;
 *  anything else is the backend's own answer — a real failure. */
export function fireVerdict(e: unknown): "watch" | "silent" | "fatal" {
  if (isAbortError(e)) return "silent";
  return isUnanswered(e) ? "watch" : "fatal";
}

/** A rejected read. A read is idempotent and cheap, so whatever may pass is
 *  waited out: no answer at all, a 5xx, a 429. A 4xx is the backend's answer
 *  (404 the run is gone), and so is a status-less rejection that is not a lost
 *  connection — the expired session. */
export function readVerdict(e: unknown): "retry" | "silent" | "fatal" {
  if (isAbortError(e)) return "silent";
  if (isUnanswered(e)) return "retry";
  const status = statusOf(e);
  if (status !== null && (status >= 500 || status === 429)) return "retry";
  return "fatal";
}

export type Settled<T> = { kind: "done"; value: T } | { kind: "failed"; error: unknown };

export type LongCallOutcome<T> =
  | Settled<T>
  /** The overall cap passed with the work still going. */
  | { kind: "capped"; capMs: number }
  /** Superseded, unmounted or aborted — say nothing at all. */
  | { kind: "dropped" };

export interface LongCallDeps<R, T> {
  /** The long call. Omitted to watch only (nothing is re-billed). */
  fire?: () => Promise<T>;
  /** One read of the stored copy. */
  read: () => Promise<R>;
  /** What the stored copy says once the call is cut: finished — with the value
   *  the call would have answered — failed, or still going (null). Never
   *  consulted while the call is open: its own answer is the authority then,
   *  so a stale state left by an earlier attempt cannot end this one. */
  settle: (read: R) => Settled<T> | null;
  /** A short mark of a read; any change resets the backoff. */
  fingerprint: (read: R) => string;
  /** False once the view unmounted or a newer watch took over. */
  current: () => boolean;
  /** Every fresh read. */
  onRead?: (read: R) => void;
  /** Once, when the call came back unanswered and the watch carries on. */
  onCut?: () => void;
  /** Read every base gap while the call is still open, to stream progress
   *  (the Creative Agent's slides). Off: wait on the call alone and read only
   *  after a cut — for a rail with nothing to show mid-call. */
  readWhileOpen?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  capMs?: number;
}

type Answer<T> = { ok: true; value: T } | { ok: false; error: unknown };

export async function watchLongCall<R, T>(deps: LongCallDeps<R, T>): Promise<LongCallOutcome<T>> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const capMs = deps.capMs ?? WATCH_CAP_MS;
  const readWhileOpen = deps.readWhileOpen !== false;
  const startedAt = now();

  const firing: Promise<Answer<T>> | null = deps.fire
    ? deps.fire().then(
        (value): Answer<T> => ({ ok: true, value }),
        (error: unknown): Answer<T> => ({ ok: false, error }),
      )
    : null;
  let open = firing !== null;
  let delay = WATCH_BASE_MS;
  let seen: string | null = null;

  for (;;) {
    // Wake early when the call settles: its answer beats any read.
    let answer: Answer<T> | null = null;
    if (open && firing) {
      answer = readWhileOpen
        ? await Promise.race([sleep(delay).then(() => null), firing])
        : await firing;
    } else {
      await sleep(delay);
    }
    if (!deps.current()) return { kind: "dropped" };

    if (answer) {
      open = false;
      if (answer.ok) return { kind: "done", value: answer.value };
      const verdict = fireVerdict(answer.error);
      if (verdict === "silent") return { kind: "dropped" };
      if (verdict === "fatal") return { kind: "failed", error: answer.error };
      deps.onCut?.();
      delay = WATCH_BASE_MS;
      // Straight on to a read: the work may well have finished meanwhile.
    }

    try {
      const read = await deps.read();
      if (!deps.current()) return { kind: "dropped" };
      deps.onRead?.(read);
      if (!open) {
        const settled = deps.settle(read);
        if (settled) return settled;
      }
      const mark = deps.fingerprint(read);
      // While the call is open, the steady base cadence streams progress in;
      // backoff is for the long tail after a cut.
      delay = open ? WATCH_BASE_MS : nextDelay(delay, seen !== null && mark !== seen);
      seen = mark;
    } catch (e) {
      if (!deps.current()) return { kind: "dropped" };
      const verdict = readVerdict(e);
      if (verdict === "silent") return { kind: "dropped" };
      if (verdict === "fatal") return { kind: "failed", error: e };
      delay = open ? WATCH_BASE_MS : nextDelay(delay, false);
    }

    if (now() - startedAt >= capMs) return { kind: "capped", capMs };
  }
}
