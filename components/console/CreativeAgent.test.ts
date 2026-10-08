/** The Creative Agent's decisions, proved without a DOM — `creativeRun.ts` is
 *  the component's logic layer and this is its safety net beside `tsc`.
 *
 *  Two promises: a file the image model did not fully make is never shown or
 *  announced as AI output; and a long run the relay cut at 300 s is followed to
 *  its real end — done, failed in the backend's own words, or an honest "we
 *  stopped waiting" — instead of being abandoned at the 504.
 */

import { describe, expect, it, vi } from "vitest";
import type { CreativeArtifact, CreativeDecision } from "@/lib/api";
import { RequestTimeoutError, SLOW_TIMEOUT_MS } from "../../lib/requestPolicy";
import {
  STAND_IN_LABEL,
  WATCH_BASE_MS,
  WATCH_CAP_MS,
  WATCH_MAX_MS,
  capMessage,
  finishedNote,
  nextDelay,
  runFailureMessage,
  runPhase,
  standIn,
  standInCount,
  watchRun,
  type WatchedRun,
} from "./creativeRun";

/* ------------------------------------------------------------- fixtures -- */

const art = (name: string, over: Partial<CreativeArtifact> = {}): CreativeArtifact => ({
  name,
  mime: name.endsWith(".zip") ? "application/zip" : "image/png",
  ref: `generated/creative/r1/${name}`,
  bytes: 1024,
  url: `/api/creative/runs/r1/artifact/${name}`,
  ...over,
});

const decision = (step: string, text: string, rationale = ""): CreativeDecision => ({
  step, decision: text, rationale, source: "agent", timestamp: "2026-10-09T00:00:00Z",
});

const run = (over: Partial<WatchedRun> = {}): WatchedRun => ({
  state: "OUTPUT",
  progress: { done: 0, total: 6, state: "generating" },
  artifacts: [],
  decision_log: [],
  ...over,
});

const relay504 = () => Object.assign(new Error("Request failed (504)"), { status: 504 });
const apiError = (status: number, message: string) => Object.assign(new Error(message), { status });

/** A promise the test settles by hand — the long generate call. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fake clock the watch's sleeps advance. Each sleep yields one macrotask,
 *  so a long call that has already settled always wins the race against it —
 *  the same order a real timer gives. */
function fakeTime() {
  const clock = { t: 0, slept: [] as number[] };
  return {
    clock,
    now: () => clock.t,
    sleep: (ms: number) => {
      clock.t += ms;
      clock.slept.push(ms);
      return new Promise<void>((r) => setTimeout(r, 0));
    },
  };
}

/** Reads answered from a script, one per call; the last entry repeats. */
function scriptedReads(steps: (WatchedRun | Error | (() => WatchedRun))[]) {
  let i = 0;
  return vi.fn(async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step() : step;
  });
}

/* ----------------------------------------------------------- provenance -- */

describe("stand-in disclosure", () => {
  it("says nothing for a file the model fully made, or one no model touched", () => {
    expect(standIn(art("slide-1.png", { ai: true, fallback_reason: null }))).toBeNull();
    // The PPTX deck carries no provenance at all: nothing to disclose.
    expect(standIn(art("deck.pptx"))).toBeNull();
  });

  it("names a stand-in, with the backend's reason as one sentence", () => {
    const note = standIn(art("brochure.pdf", {
      ai: false, fallback_reason: "  1 of 6 page backgrounds is a brand-gradient stand-in (page 3) ",
    }));
    expect(note).toEqual({
      label: STAND_IN_LABEL,
      reason: "1 of 6 page backgrounds is a brand-gradient stand-in (page 3)",
      detail: "1 of 6 page backgrounds is a brand-gradient stand-in (page 3).",
    });
    expect(STAND_IN_LABEL).toBe("Includes a stand-in image (not AI)");
  });

  it("still names it when no reason came, without inventing one", () => {
    for (const fallback_reason of [null, undefined, "   "]) {
      const note = standIn(art("slide-3.png", { ai: false, fallback_reason }));
      expect(note?.label).toBe(STAND_IN_LABEL);
      expect(note?.reason).toBeNull();
      expect(note?.detail).toMatch(/did not make every picture/);
    }
  });

  it("counts each stand-in once — the bundle repeats its members", () => {
    const set = [
      art("slide-1.png", { ai: true }),
      art("slide-3.png", { ai: false, fallback_reason: "x" }),
      art("bundle.zip", { ai: false, fallback_reason: "1 of 2 files…" }),
    ];
    expect(standInCount(set)).toBe(1);
    // A bundle flagged on its own is still a file to disclose.
    expect(standInCount([art("bundle.zip", { ai: false })])).toBe(1);
    expect(standInCount([art("slide-1.png", { ai: true }), art("deck.pptx")])).toBe(0);
  });

  it("never announces a stand-in run as a plain success", () => {
    expect(finishedNote("Creative generated", [art("a.png", { ai: true })]))
      .toEqual({ message: "Creative generated", tone: "ok" });
    expect(finishedNote("Creative generated", [art("a.png", { ai: false })]))
      .toEqual({ message: "Creative generated — 1 file includes a stand-in image (not AI)", tone: "warn" });
    expect(finishedNote("Autonomous run complete", [art("a.png", { ai: false }), art("b.png", { ai: false })]).message)
      .toBe("Autonomous run complete — 2 files include a stand-in image (not AI)");
  });
});

/* ------------------------------------------------------- stored run state -- */

describe("what the stored run says", () => {
  it("reads DONE as done and a failed progress as failed", () => {
    expect(runPhase(run({ state: "DONE", progress: { done: 6, total: 6, state: "done" } }))).toBe("done");
    expect(runPhase(run({ progress: { done: 2, total: 6, state: "failed" } }))).toBe("failed");
    expect(runPhase(run())).toBe("running");
    expect(runPhase(run({ progress: undefined }))).toBe("running");
  });

  it("quotes the backend's last output decision for a failure", () => {
    const failed = run({
      progress: { done: 6, total: 6, state: "failed" },
      decision_log: [
        decision("layout", "Plan approved"),
        decision("output", "Could not save the generated files", "bundle.zip could not be written to file storage."),
      ],
    });
    expect(runFailureMessage(failed))
      .toBe("Could not save the generated files — bundle.zip could not be written to file storage.");
    expect(runFailureMessage(run())).toMatch(/stopped on the server/);
  });

  it("backs off while nothing moves, within the ceiling, and snaps back when it does", () => {
    expect(nextDelay(WATCH_BASE_MS, false)).toBe(3_000);
    expect(nextDelay(12_000, false)).toBe(WATCH_MAX_MS);
    expect(nextDelay(WATCH_MAX_MS, false)).toBe(WATCH_MAX_MS);
    expect(nextDelay(WATCH_MAX_MS, true)).toBe(WATCH_BASE_MS);
  });
});

/* ------------------------------------------------------------ the watch -- */

describe("watching a long creative run", () => {
  it("keeps going after the relay's 504 and finishes when the run is DONE", async () => {
    const t = fakeTime();
    const fire = deferred<WatchedRun>();
    const done = run({ state: "DONE", progress: { done: 6, total: 6, state: "done" }, artifacts: [art("s.png", { ai: true })] });
    const read = scriptedReads([
      () => {
        fire.reject(relay504()); // the relay gives up at 300 s…
        return run({ progress: { done: 2, total: 6, state: "generating" } });
      },
      run({ progress: { done: 4, total: 6, state: "generating" } }), // …the backend does not
      done,
    ]);
    const onCut = vi.fn();
    const onRun = vi.fn();

    const outcome = await watchRun({
      fire: () => fire.promise, read, current: () => true, onRun, onCut, sleep: t.sleep, now: t.now,
    });

    expect(outcome).toEqual({ kind: "done", run: done });
    expect(onCut).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(3);
    expect(onRun).toHaveBeenLastCalledWith(done);
  });

  it("treats a dropped connection and our own deadline the same way", async () => {
    for (const cut of [new TypeError("Failed to fetch"), new RequestTimeoutError(SLOW_TIMEOUT_MS)]) {
      const t = fakeTime();
      const done = run({ state: "DONE" });
      const outcome = await watchRun({
        fire: () => Promise.reject(cut),
        read: scriptedReads([run(), done]),
        current: () => true, onRun: () => {}, sleep: t.sleep, now: t.now,
      });
      expect(outcome).toEqual({ kind: "done", run: done });
    }
  });

  it("finishes on the call's own answer when it comes back in time", async () => {
    const t = fakeTime();
    const final = run({ state: "DONE" });
    const onCut = vi.fn();
    const onRun = vi.fn();
    const outcome = await watchRun({
      fire: () => Promise.resolve(final),
      read: scriptedReads([run()]),
      current: () => true, onRun, onCut, sleep: t.sleep, now: t.now,
    });
    expect(outcome).toEqual({ kind: "done", run: final });
    expect(onRun).toHaveBeenLastCalledWith(final);
    expect(onCut).not.toHaveBeenCalled();
  });

  it("stops on the backend's own refusal — a 400 or a 503 is an answer, not a cut", async () => {
    for (const error of [apiError(400, "Plan must be approved"), apiError(503, "file storage is unavailable")]) {
      const t = fakeTime();
      const read = scriptedReads([run()]);
      const outcome = await watchRun({
        fire: () => Promise.reject(error),
        read, current: () => true, onRun: () => {}, sleep: t.sleep, now: t.now,
      });
      expect(outcome).toEqual({ kind: "failed", error });
      expect(read).not.toHaveBeenCalled();
    }
  });

  it("says nothing when the call was cancelled", async () => {
    const t = fakeTime();
    const outcome = await watchRun({
      fire: () => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      read: scriptedReads([run()]), current: () => true, onRun: () => {}, sleep: t.sleep, now: t.now,
    });
    expect(outcome).toEqual({ kind: "dropped" });
  });

  it("after a cut, ends on a run the backend marked failed, in its words", async () => {
    const t = fakeTime();
    const outcome = await watchRun({
      fire: () => Promise.reject(relay504()),
      read: scriptedReads([run({
        progress: { done: 6, total: 6, state: "failed" },
        decision_log: [decision("output", "Could not save the generated files", "slide-6.png could not be written to file storage.")],
      })]),
      current: () => true, onRun: () => {}, sleep: t.sleep, now: t.now,
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect((outcome.error as Error).message).toContain("Could not save the generated files");
    }
  });

  it("while the call is open, a stale failed/DONE on the stored run cannot end it", async () => {
    const t = fakeTime();
    const fire = deferred<WatchedRun>();
    const final = run({ state: "DONE", progress: { done: 6, total: 6, state: "done" } });
    const outcome = await watchRun({
      fire: () => fire.promise,
      read: scriptedReads([
        run({ progress: { done: 3, total: 6, state: "failed" } }), // left by an earlier attempt
        run({ state: "DONE" }),
        () => {
          fire.resolve(final);
          return run();
        },
      ]),
      current: () => true, onRun: () => {}, sleep: t.sleep, now: t.now,
    });
    expect(outcome).toEqual({ kind: "done", run: final });
  });

  it("reads every 2 s while the call is open, so slides stream in as before", async () => {
    const t = fakeTime();
    const fire = deferred<WatchedRun>();
    let n = 0;
    await watchRun({
      fire: () => fire.promise,
      read: async () => {
        n += 1;
        if (n === 5) fire.resolve(run({ state: "DONE" }));
        return run(); // nothing moves — still no backoff while open
      },
      current: () => true, onRun: () => {}, sleep: t.sleep, now: t.now,
    });
    expect(t.clock.slept.every((ms) => ms === WATCH_BASE_MS)).toBe(true);
  });

  it("stops at the cap and says so plainly, with bounded backoff on the way", async () => {
    const t = fakeTime();
    const read = scriptedReads([run({ progress: { done: 1, total: 6, state: "generating" } })]);
    const outcome = await watchRun({
      fire: () => Promise.reject(relay504()),
      read, current: () => true, onRun: () => {}, sleep: t.sleep, now: t.now,
    });
    expect(outcome).toEqual({ kind: "capped", message: capMessage(WATCH_CAP_MS) });
    expect(capMessage(WATCH_CAP_MS)).toMatch(/^Stopped waiting after 15 minutes — this run hasn't finished\./);
    expect(t.clock.t).toBeGreaterThanOrEqual(WATCH_CAP_MS);
    expect(t.clock.t).toBeLessThan(WATCH_CAP_MS + WATCH_MAX_MS + WATCH_BASE_MS);
    expect(Math.max(...t.clock.slept)).toBe(WATCH_MAX_MS);
    // Bounded, not a hammer: 15 minutes at ≤ 15 s apart is tens of reads, not hundreds.
    expect(read.mock.calls.length).toBeLessThan(80);
  });

  it("snaps back to the base gap when the run moves after a quiet stretch", async () => {
    const t = fakeTime();
    const quiet = run({ progress: { done: 1, total: 6, state: "generating" } });
    await watchRun({
      fire: () => Promise.reject(relay504()),
      read: scriptedReads([quiet, quiet, quiet, quiet, run({ progress: { done: 2, total: 6, state: "generating" } }), run({ state: "DONE" })]),
      current: () => true, onRun: () => {}, sleep: t.sleep, now: t.now,
    });
    // First sleep is the open-call gap; then growth while quiet, then the reset.
    expect(t.clock.slept).toEqual([WATCH_BASE_MS, 3_000, 4_500, 6_750, 10_125, WATCH_BASE_MS]);
  });

  it("waits out a 504, a 5xx or a lost connection on a read, but not a 404 or an expired session", async () => {
    const t = fakeTime();
    const done = run({ state: "DONE" });
    const outcome = await watchRun({
      fire: () => Promise.reject(relay504()),
      read: scriptedReads([relay504(), apiError(500, "boom"), apiError(429, "slow down"), new TypeError("Failed to fetch"), done]),
      current: () => true, onRun: () => {}, sleep: t.sleep, now: t.now,
    });
    expect(outcome).toEqual({ kind: "done", run: done });

    for (const error of [apiError(404, "Run not found"), new Error("Your session expired — please sign in again.")]) {
      const t2 = fakeTime();
      const failed = await watchRun({
        fire: () => Promise.reject(relay504()),
        read: scriptedReads([error]),
        current: () => true, onRun: () => {}, sleep: t2.sleep, now: t2.now,
      });
      expect(failed).toEqual({ kind: "failed", error });
    }
  });

  it("goes quiet the moment the view is left — no more reads, no more writes", async () => {
    const t = fakeTime();
    let live = true;
    const onRun = vi.fn();
    const read = vi.fn(async () => {
      live = false; // the user navigated away while this read was in flight
      return run({ state: "DONE" });
    });
    const outcome = await watchRun({
      fire: () => Promise.reject(relay504()),
      read, current: () => live, onRun, sleep: t.sleep, now: t.now,
    });
    expect(outcome).toEqual({ kind: "dropped" });
    expect(onRun).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("Check again only reads — it never fires a second, billed run", async () => {
    const t = fakeTime();
    const done = run({ state: "DONE" });
    const read = scriptedReads([run(), done]);
    const outcome = await watchRun({ read, current: () => true, onRun: () => {}, sleep: t.sleep, now: t.now });
    expect(outcome).toEqual({ kind: "done", run: done });
    expect(read).toHaveBeenCalledTimes(2);
  });
});
