import { describe, expect, it } from "vitest";
import type { BwBrand, BwRunSummary } from "@/lib/api";
import {
  TEAMMATE_RUNS_READ_ONLY, authorLabel, canEditRun, defaultBrand, draftsFor, isRunId,
  parseView, readRoute, rowStatus, sectionOf, shouldAutoResume, viewSegment,
} from "./blog";

/* The workspace's route is the truth, so these pin the reading of it: which
 * brand a link lands on (old run links included), the order a brand's drafts
 * list in, and whose draft opens read-only or picks its research back up. */

const ME = "u-me";
const MATE = "u-mate";

const brand = (id: string, name = id): BwBrand => ({ id, name, domain: `${id}.com`, inventory: null, voice: null });
const BRANDS = [brand("acme", "Acme"), brand("globex", "Globex"), brand("initech", "Initech")];

const run = (over: Partial<BwRunSummary> & { id: string }): BwRunSummary => ({
  brand_id: "acme",
  brand_name: "Acme",
  topic: `topic of ${over.id}`,
  created: "2026-10-01T10:00:00Z",
  status: "saturated",
  user_id: ME,
  ...over,
});

/* ------------------------------------------------------------- the view -- */

describe("parseView", () => {
  it("defaults to the drafts list for an empty or unknown section", () => {
    expect(parseView("")).toEqual({ kind: "drafts" });
    expect(parseView("drafts")).toEqual({ kind: "drafts" });
    expect(parseView("research")).toEqual({ kind: "drafts" });
    expect(parseView("draft")).toEqual({ kind: "drafts" });
  });

  it("reads write, and any bw- segment as a run id", () => {
    expect(parseView("write")).toEqual({ kind: "write" });
    expect(parseView("bw-cost-of-a-receptionist-a1b2c3")).toEqual({ kind: "run", runId: "bw-cost-of-a-receptionist-a1b2c3" });
  });

  it("writes a view back as the segment it was read from", () => {
    for (const s of ["drafts", "write", "bw-x-123abc"]) expect(viewSegment(parseView(s))).toBe(s);
  });

  it("lights Drafts in the rail while a run is open", () => {
    expect(sectionOf({ kind: "run", runId: "bw-x" })).toBe("drafts");
    expect(sectionOf({ kind: "write" })).toBe("write");
  });

  it("knows a run id from a brand id", () => {
    expect(isRunId("bw-abc-123456")).toBe(true);
    expect(isRunId("acme")).toBe(false);
    expect(isRunId("")).toBe(false);
  });
});

/* -------------------------------------------------------- default brand -- */

describe("defaultBrand", () => {
  it("is the brand of the viewer's newest run", () => {
    const runs = [
      run({ id: "bw-a", brand_id: "acme", created: "2026-10-01T00:00:00Z" }),
      run({ id: "bw-b", brand_id: "globex", created: "2026-10-09T00:00:00Z" }),
    ];
    expect(defaultBrand(BRANDS, runs, ME)).toBe("globex");
  });

  it("ignores a teammate's newer run", () => {
    const runs = [
      run({ id: "bw-mate", brand_id: "initech", created: "2026-10-12T00:00:00Z", user_id: MATE }),
      run({ id: "bw-mine", brand_id: "globex", created: "2026-10-02T00:00:00Z" }),
    ];
    expect(defaultBrand(BRANDS, runs, ME)).toBe("globex");
  });

  it("falls back to the first brand when the viewer has no runs", () => {
    expect(defaultBrand(BRANDS, [], ME)).toBe("acme");
    expect(defaultBrand(BRANDS, [run({ id: "bw-m", brand_id: "initech", user_id: MATE })], ME)).toBe("acme");
  });

  it("skips a run whose brand is no longer listed", () => {
    const runs = [
      run({ id: "bw-gone", brand_id: "retired", created: "2026-10-12T00:00:00Z" }),
      run({ id: "bw-ok", brand_id: "initech", created: "2026-10-01T00:00:00Z" }),
    ];
    expect(defaultBrand(BRANDS, runs, ME)).toBe("initech");
  });

  it("is empty when there are no brands at all", () => {
    expect(defaultBrand([], [run({ id: "bw-a" })], ME)).toBe("");
  });

  it("never treats an unstamped legacy run as the viewer's", () => {
    const runs = [run({ id: "bw-legacy", brand_id: "initech", user_id: "" })];
    expect(defaultBrand(BRANDS, runs, "")).toBe("acme");
  });
});

/* ------------------------------------------------------------ the route -- */

describe("readRoute", () => {
  const runs = [
    run({ id: "bw-mine-aaaaaa", brand_id: "globex", created: "2026-10-05T00:00:00Z" }),
    run({ id: "bw-mate-bbbbbb", brand_id: "initech", user_id: MATE }),
  ];

  it("reads a brand and a view", () => {
    expect(readRoute("initech", "write", BRANDS, runs, ME)).toEqual({ brandId: "initech", view: { kind: "write" } });
    expect(readRoute("globex", "drafts", BRANDS, runs, ME)).toEqual({ brandId: "globex", view: { kind: "drafts" } });
    expect(readRoute("initech", "bw-mate-bbbbbb", BRANDS, runs, ME)).toEqual({
      brandId: "initech", view: { kind: "run", runId: "bw-mate-bbbbbb" },
    });
  });

  it("lands a bare link on the default brand's drafts", () => {
    expect(readRoute("", "", BRANDS, runs, ME)).toEqual({ brandId: "globex", view: { kind: "drafts" } });
  });

  it("keeps an old #/w/blog/<runId>/research link opening, on the run's own brand", () => {
    expect(readRoute("bw-mate-bbbbbb", "research", BRANDS, runs, ME)).toEqual({
      brandId: "initech", view: { kind: "run", runId: "bw-mate-bbbbbb" },
    });
  });

  it("still opens an old run link the list does not carry, on the default brand", () => {
    expect(readRoute("bw-unlisted-cccccc", "research", BRANDS, runs, ME)).toEqual({
      brandId: "globex", view: { kind: "run", runId: "bw-unlisted-cccccc" },
    });
  });

  it("opens a run under its own brand even when the link names another", () => {
    expect(readRoute("acme", "bw-mate-bbbbbb", BRANDS, runs, ME).brandId).toBe("initech");
    // …and keeps the link's brand when the list cannot say whose the run is.
    expect(readRoute("acme", "bw-unlisted-cccccc", BRANDS, runs, ME).brandId).toBe("acme");
  });

  it("swaps an unknown brand for the default one rather than lighting nothing", () => {
    expect(readRoute("retired", "drafts", BRANDS, runs, ME).brandId).toBe("globex");
  });
});

/* ----------------------------------------------------------- the drafts -- */

describe("draftsFor", () => {
  it("lists every one of the brand's runs — no cap — and nothing from another brand", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      run({ id: `bw-r${i}`, created: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
    const other = run({ id: "bw-other", brand_id: "globex" });
    const list = draftsFor([...many, other], "acme", ME);
    expect(list).toHaveLength(30);
    expect(list.some((r) => r.id === "bw-other")).toBe(false);
  });

  it("puts the viewer's drafts first, then teammates', newest first inside each", () => {
    const runs = [
      run({ id: "bw-mate-new", user_id: MATE, created: "2026-10-12T00:00:00Z" }),
      run({ id: "bw-mine-old", created: "2026-09-01T00:00:00Z" }),
      run({ id: "bw-mate-old", user_id: MATE, created: "2026-09-02T00:00:00Z" }),
      run({ id: "bw-mine-new", created: "2026-10-10T00:00:00Z" }),
      run({ id: "bw-legacy", user_id: "", created: "2026-10-11T00:00:00Z" }),
    ];
    expect(draftsFor(runs, "acme", ME).map((r) => r.id)).toEqual([
      "bw-mine-new", "bw-mine-old", "bw-mate-new", "bw-legacy", "bw-mate-old",
    ]);
  });

  it("is empty for a brand with no drafts", () => {
    expect(draftsFor([run({ id: "bw-a" })], "globex", ME)).toEqual([]);
  });
});

describe("authorLabel", () => {
  it("says You, else the author's name, else Teammate", () => {
    expect(authorLabel(run({ id: "bw-a", by: "Someone Else" }), ME)).toBe("You");
    expect(authorLabel(run({ id: "bw-b", user_id: MATE, by: "Chelsea E" }), ME)).toBe("Chelsea E");
    expect(authorLabel(run({ id: "bw-c", user_id: MATE }), ME)).toBe("Teammate");
    expect(authorLabel(run({ id: "bw-d", user_id: MATE, by: "  " }), ME)).toBe("Teammate");
  });
});

/* ------------------------------------------------------ own vs teammate -- */

describe("own vs teammate", () => {
  it("ships with teammates' drafts read-only", () => {
    expect(TEAMMATE_RUNS_READ_ONLY).toBe(true);
  });

  it("lets the viewer edit only their own run", () => {
    expect(canEditRun({ user_id: ME }, ME)).toBe(true);
    expect(canEditRun({ user_id: MATE }, ME)).toBe(false);
    expect(canEditRun({ user_id: "" }, ME)).toBe(false);
    expect(canEditRun({}, ME)).toBe(false);
  });

  it("auto-resumes research only on the viewer's own run that is still researching", () => {
    expect(shouldAutoResume({ user_id: ME, status: "research" }, ME)).toBe(true);
    expect(shouldAutoResume({ user_id: MATE, status: "research" }, ME)).toBe(false);
    expect(shouldAutoResume({ user_id: ME, status: "saturated" }, ME)).toBe(false);
    expect(shouldAutoResume({ user_id: "", status: "research" }, "")).toBe(false);
  });

  it("says open to continue only where opening continues", () => {
    expect(rowStatus(run({ id: "bw-a", status: "research" }), ME)).toBe("Research paused — open to continue");
    expect(rowStatus(run({ id: "bw-b", status: "research", user_id: MATE }), ME)).toBe("Research paused");
    expect(rowStatus(run({ id: "bw-c", status: "capped" }), ME)).toBe("Research done");
    expect(rowStatus(run({ id: "bw-d", status: "saturated" }), ME)).toBe("Research done");
  });
});
