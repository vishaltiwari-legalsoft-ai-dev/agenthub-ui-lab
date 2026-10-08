import { describe, expect, it, vi } from "vitest";
import { runAutoPilot, type AutoAccept, type AutoPilotApi, type AutoStage } from "./autoPilot";
import type { GdAttempt, GdPlan, GdRun } from "@/lib/api";
import { isAbortError } from "../../../lib/requestPolicy";
import {
  STILL_GENERATING,
  isStageStillRunning,
  stageCapMessage,
  stageMark,
  stageResultFrom,
  watchStageGenerate,
} from "./stageWatch";

const PLAN = {
  version: 1, brief: "b", concept: "c",
  gradient: { cid: "A", reason: "" },
  element: { cid: "B", reason: "" },
  text: { headline: "H", highlight: "H", subline: "s", cta: "Go", reason: "" },
  logo: { logo_id: "combined-solid", reason: "" },
} satisfies GdPlan;

const ALL: AutoAccept = { gradient: true, element: true, text: true, logo: true };

function api(ran: AutoStage[], paused: AutoStage[], failAt?: AutoStage): AutoPilotApi {
  return {
    runStage: async (stage) => {
      if (stage === failAt) throw new Error("boom");
      ran.push(stage);
    },
    pause: (stage) => paused.push(stage),
  };
}

describe("runAutoPilot", () => {
  it("runs stages 1-3 then lands on the mandatory logo gate", async () => {
    const ran: AutoStage[] = [];
    const paused: AutoStage[] = [];
    const out = await runAutoPilot(PLAN, ALL, 1, api(ran, paused), () => false);
    expect(out).toEqual({ status: "gated", stage: 4 });
    expect(ran).toEqual([1, 2, 3]); // stage 4 is never auto-run
    expect(paused).toEqual([4]);
  });

  it("pauses at the first rejected stage without running it", async () => {
    const ran: AutoStage[] = [];
    const paused: AutoStage[] = [];
    const out = await runAutoPilot(PLAN, { ...ALL, element: false }, 1, api(ran, paused), () => false);
    expect(out).toEqual({ status: "paused", stage: 2 });
    expect(ran).toEqual([1]);
    expect(paused).toEqual([2]);
  });

  it("resumes from a later stage and still gates at the logo", async () => {
    const ran: AutoStage[] = [];
    const paused: AutoStage[] = [];
    const out = await runAutoPilot(PLAN, { ...ALL, element: false }, 3, api(ran, paused), () => false);
    expect(out).toEqual({ status: "gated", stage: 4 });
    expect(ran).toEqual([3]);
    expect(paused).toEqual([4]);
  });

  it("stage 4 always gates before running", async () => {
    const ran: AutoStage[] = [];
    const paused: AutoStage[] = [];
    const out = await runAutoPilot(PLAN, ALL, 4, api(ran, paused), () => false);
    expect(out).toEqual({ status: "gated", stage: 4 });
    expect(ran).toEqual([]); // never auto-composites
    expect(paused).toEqual([4]);
  });

  it("a runStage returning 'gate' pauses after the stage work", async () => {
    const paused: AutoStage[] = [];
    const out = await runAutoPilot(
      PLAN, ALL, 3,
      { runStage: async (s) => (s === 3 ? "gate" : undefined), pause: (s) => paused.push(s) },
      () => false,
    );
    expect(out).toEqual({ status: "gated", stage: 3 });
    expect(paused).toEqual([3]);
  });

  it("'continue' outcome keeps walking to the stage-4 gate", async () => {
    const ran: AutoStage[] = [];
    const out = await runAutoPilot(
      PLAN, ALL, 3,
      { runStage: async (s) => { ran.push(s); return "continue"; }, pause: () => {} },
      () => false,
    );
    expect(ran).toEqual([3]);
    expect(out).toEqual({ status: "gated", stage: 4 });
  });

  it("stops when asked and reports where", async () => {
    const ran: AutoStage[] = [];
    let calls = 0;
    const out = await runAutoPilot(PLAN, ALL, 1, api(ran, []), () => ++calls > 2);
    expect(out.status).toBe("stopped");
    expect(ran.length).toBeLessThan(4);
  });

  it("surfaces a stage error and never skips past it", async () => {
    const ran: AutoStage[] = [];
    const out = await runAutoPilot(PLAN, ALL, 1, api(ran, [], 3), () => false);
    expect(out.status).toBe("error");
    if (out.status === "error") expect(out.stage).toBe(3);
    expect(ran).toEqual([1, 2]);
  });
});

/* ------------------------------------------------- past the relay's cut -- */

/* A stage generate the relay cut at 300 s still finishes and saves on the
   backend. The studio reads the run back until the NEW attempt for that stage
   is there — judged against the mark taken before the call, never "any
   attempt exists" — instead of showing an error for work that succeeded. */

const att = (n: number, over: Partial<GdAttempt> = {}): GdAttempt => ({
  attempt: n,
  variant: "T",
  artifact: `stage-3/T-${n}.png`,
  url: `/api/gd/runs/r1/artifact/stage-3/T-${n}.png`,
  created_at: "2026-10-09T00:00:00Z",
  ...over,
});

const gdRun = (stage: number, attempts: GdAttempt[], updated = "t0"): GdRun =>
  ({
    id: "r1",
    state: `STAGE${stage}_REVIEW`,
    updated_at: updated,
    stages: { [String(stage)]: { variant: "T", attempts, approved: null } },
  }) as unknown as GdRun;

const relay504 = () => Object.assign(new Error("Request failed (504)"), { status: 504 });

/** Each sleep advances a fake clock and yields one macrotask. */
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

describe("the new attempt for a stage", () => {
  it("marks the highest attempt number the stage already has", () => {
    expect(stageMark(gdRun(3, [att(1), att(4), att(2)]), 3)).toBe(4);
    expect(stageMark(gdRun(3, []), 3)).toBe(0);
    expect(stageMark(gdRun(1, [att(2)]), 3)).toBe(0); // another stage's attempts don't count
    expect(stageMark(null, 2)).toBe(0);
  });

  it("is nothing while only earlier attempts exist — any attempt is not a new one", () => {
    expect(stageResultFrom(gdRun(1, [att(1), att(2)]), 1, 2)).toBeNull();
  });

  it("is the one attempt past the mark on a Stage 1/2/4 generate", () => {
    const run = gdRun(2, [att(1), att(2, { variant: "B" })]);
    expect(stageResultFrom(run, 2, 1)).toEqual({ attempt: att(2, { variant: "B" }), run });
  });

  it("rebuilds a Stage-3 styled set whole, picking the first QA-passed style as the backend does", () => {
    const set = [
      att(6, { set_id: "s2", style: "brand_strict", qa: "skipped" }),
      att(5, { set_id: "s2", style: "sharp_minimal", qa: "failed" }), // out of order on purpose
      att(7, { set_id: "s2", style: "highlighted", qa: "passed" }),
    ];
    const run = gdRun(3, [att(1, { set_id: "s1" }), att(2, { set_id: "s1" }), att(3, { set_id: "s1" }), att(4), ...set]);
    const result = stageResultFrom(run, 3, 4);
    expect(result?.attempts?.map((a) => a.attempt)).toEqual([5, 6, 7]);
    expect(result?.attempt.attempt).toBe(7);
    // Nothing passed QA: the first of the new set, never an earlier set's attempt.
    const unpassed = gdRun(3, [att(1), att(2, { set_id: "s9", qa: "skipped" }), att(3, { set_id: "s9", qa: "skipped" })]);
    expect(stageResultFrom(unpassed, 3, 1)?.attempt.attempt).toBe(2);
  });
});

describe("watching a stage generate past the relay's cut", () => {
  it("returns the call's own answer when it comes back in time, without reading", async () => {
    const t = fakeTime();
    const answer = { attempt: att(3), run: gdRun(1, [att(3)]) };
    const read = vi.fn(async () => gdRun(1, []));
    await expect(
      watchStageGenerate({ stage: 1, mark: 2, fire: async () => answer, read, current: () => true, sleep: t.sleep, now: t.now }),
    ).resolves.toBe(answer);
    expect(read).not.toHaveBeenCalled();
  });

  it("after a 504 keeps reading until the new attempt lands, and says it is still generating", async () => {
    const t = fakeTime();
    const before = gdRun(3, [att(1), att(2), att(3)]);
    const landed = gdRun(
      3,
      [att(1), att(2), att(3), att(4, { set_id: "n", qa: "passed" }), att(5, { set_id: "n" }), att(6, { set_id: "n" })],
      "t9",
    );
    const reads = [before, before, landed];
    const read = vi.fn(async () => reads.shift() ?? landed);
    const onCut = vi.fn();

    const result = await watchStageGenerate({
      stage: 3, mark: 3, fire: () => Promise.reject(relay504()), read, current: () => true, onCut,
      sleep: t.sleep, now: t.now,
    });

    expect(onCut).toHaveBeenCalledTimes(1);
    expect(STILL_GENERATING).toBe("Still generating — this one is taking longer than usual.");
    expect(read).toHaveBeenCalledTimes(3);
    expect(result.attempt.attempt).toBe(4);
    expect(result.attempts?.map((a) => a.attempt)).toEqual([4, 5, 6]);
    expect(result.run).toBe(landed);
  });

  it("does not read the (large) run while the call is still open", async () => {
    const t = fakeTime();
    let release!: (v: { attempt: GdAttempt; run: GdRun }) => void;
    const pending = new Promise<{ attempt: GdAttempt; run: GdRun }>((r) => {
      release = r;
    });
    const read = vi.fn(async () => gdRun(2, []));
    const watching = watchStageGenerate({ stage: 2, mark: 0, fire: () => pending, read, current: () => true, sleep: t.sleep, now: t.now });
    await new Promise((r) => setTimeout(r, 5));
    expect(read).not.toHaveBeenCalled();
    release({ attempt: att(1), run: gdRun(2, [att(1)]) });
    await expect(watching).resolves.toMatchObject({ attempt: { attempt: 1 } });
    expect(read).not.toHaveBeenCalled();
  });

  it("stops on the backend's own refusal — a 409, 429 or 503 is an answer", async () => {
    for (const status of [409, 429, 503]) {
      const t = fakeTime();
      const refusal = Object.assign(new Error(`refused ${status}`), { status });
      const read = vi.fn(async () => gdRun(3, []));
      await expect(
        watchStageGenerate({ stage: 3, mark: 0, fire: () => Promise.reject(refusal), read, current: () => true, sleep: t.sleep, now: t.now }),
      ).rejects.toBe(refusal);
      expect(read).not.toHaveBeenCalled();
    }
  });

  it("stops at the 15-minute cap with a warning, not an error, and bounded reads", async () => {
    const t = fakeTime();
    const stuck = gdRun(3, [att(1)]);
    const read = vi.fn(async () => stuck);
    const err = await watchStageGenerate({
      stage: 3, mark: 1, fire: () => Promise.reject(new TypeError("Failed to fetch")), read, current: () => true,
      sleep: t.sleep, now: t.now,
    }).catch((e: unknown) => e);
    expect(isStageStillRunning(err)).toBe(true);
    expect((err as Error).message).toBe(stageCapMessage(3));
    expect(stageCapMessage(3)).toMatch(/^Stopped waiting after 15 minutes — Stage 3 still hasn't come back\./);
    expect(t.clock.t).toBeGreaterThanOrEqual(15 * 60_000);
    expect(Math.max(...t.clock.slept)).toBeLessThanOrEqual(15_000);
    expect(read.mock.calls.length).toBeLessThan(80);
  });

  it("gives up on a read the backend refuses (the run is gone, the session expired)", async () => {
    const t = fakeTime();
    const gone = Object.assign(new Error("Run not found"), { status: 404 });
    await expect(
      watchStageGenerate({
        stage: 1, mark: 0, fire: () => Promise.reject(relay504()), read: () => Promise.reject(gone),
        current: () => true, sleep: t.sleep, now: t.now,
      }),
    ).rejects.toBe(gone);
  });

  it("goes quiet when the studio moves on — an AbortError the toast path ignores", async () => {
    const t = fakeTime();
    let live = true;
    const err = await watchStageGenerate({
      stage: 2, mark: 0, fire: () => Promise.reject(relay504()),
      read: async () => {
        live = false; // a new design was started while this read was out
        return gdRun(2, [att(1)]);
      },
      current: () => live, sleep: t.sleep, now: t.now,
    }).catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
    expect(isStageStillRunning(err)).toBe(false);
  });
});
