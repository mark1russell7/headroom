import { describe, expect, it } from "vitest";
import { LEGACY_RULE, type JobKey } from "./predict.ts";
import { chooseRule, holdsGates, holdsOver, measureRows, replayLeases, type AmountMeasures, type ReplayRow } from "./replay.ts";
import type { KeyedLease } from "./store.ts";

/** A lease of a replay: its request at `at`, its end one second later. */
function lease(id: string, job: string, at: number, peakMb: number, kind: JobKey["kind"] | null = null, holder = "shop"): KeyedLease {
  const keyed =
    kind === null
      ? null
      : { key: { kind, repo: "shop", lock: null, filter: ".", warm: true, packages: null, command: job }, predictedMb: null, rung: "none" as const, runs: 0, predictedMs: null, runFrom: null };
  return { id, holder, job, state: "released", memoryMb: 512, peakMb, requestedAt: at, grantedAt: at, endedAt: at + 1000, exitCode: 0, keyed };
}

const keyOf = (each: KeyedLease): JobKey | null => each.keyed?.key ?? null;

describe("replayLeases (H78)", () => {
  it("sees only the runs that ended before each request", () => {
    // b starts before a ends, so b has no run of its job. c starts after both ended.
    const leases = [lease("a", "pnpm test", 0, 400), lease("b", "pnpm test", 500, 600), lease("c", "pnpm test", 5000, 500)];
    const rows = replayLeases(leases, { rule: LEGACY_RULE, ladder: false, defaultMb: 1024, since: 0, keyOf });
    expect(rows.map((row) => [row.id, row.rung, row.runs, row.requestMb])).toEqual([
      ["a", "none", 0, 1024],
      ["b", "none", 0, 1024],
      // The 90th percentile of 400 and 600 is 600. 25% more is 750, rounded up to 768.
      ["c", "job", 2, 768],
    ]);
  });

  it("gives the rows of the window only, with the runs before it", () => {
    const leases = [lease("a", "pnpm test", 0, 400), lease("b", "pnpm test", 5000, 500)];
    const rows = replayLeases(leases, { rule: LEGACY_RULE, ladder: false, defaultMb: 1024, since: 4000, keyOf });
    expect(rows.map((row) => [row.id, row.rung])).toEqual([["b", "job"]]);
  });

  it("falls to the key and the kind with the ladder, and to the default without it", () => {
    const leases = [lease("a", "h1-test", 0, 400, "test"), lease("b", "h2-test", 5000, 500, "test"), lease("c", "h3-lint", 9000, 100, "lint", "vex")];
    const ladder = replayLeases(leases, { rule: LEGACY_RULE, ladder: true, defaultMb: 1024, since: 0, keyOf });
    expect(ladder.map((row) => [row.id, row.rung, row.kind])).toEqual([
      ["a", "none", "test"],
      ["b", "key", "test"],
      ["c", "none", "lint"],
    ]);
    const base = replayLeases(leases, { rule: LEGACY_RULE, ladder: false, defaultMb: 1024, since: 0, keyOf });
    expect(base.map((row) => row.rung)).toEqual(["none", "none", "none"]);
  });
});

describe("measureRows and chooseRule (H78)", () => {
  const row = (rung: ReplayRow["rung"], requestMb: number, peakMb: number): ReplayRow => ({ id: "x", kind: "test", rung, runs: 1, requestMb, peakMb });

  it("gives the shares, the ratio of the sums and the over share with its Wilson bound", () => {
    const measures = measureRows([row("job", 1000, 500), row("kind", 600, 700), row("none", 1024, 512), row("fit", 400, 400)]);
    expect(measures).toMatchObject({ leases: 4, defaultShare: 0.25, measuredShare: 0.5, kindShare: 0.25, overShare: 0.25 });
    expect(measures?.ratio).toBeCloseTo(3024 / 2112, 6);
    expect(measures?.overHigh).toBeGreaterThan(0.25);
    expect(measureRows([])).toBeNull();
  });

  it("chooses the lowest ratio that holds both gates, else the lowest ratio that holds the over gate", () => {
    const measures = (ratio: number, overShare: number, overHigh: number): AmountMeasures => ({
      leases: 1000,
      defaultShare: 0,
      measuredShare: 1,
      kindShare: 0,
      ratio,
      overShare,
      overHigh,
      ratioP90: ratio,
    });
    const both = { name: "both", rule: LEGACY_RULE, measures: measures(1.4, 0.03, 0.04) };
    const tight = { name: "tight", rule: LEGACY_RULE, measures: measures(1.2, 0.045, 0.058) };
    const loose = { name: "loose", rule: LEGACY_RULE, measures: measures(1.9, 0.02, 0.03) };
    const looser = { name: "looser", rule: LEGACY_RULE, measures: measures(2.4, 0.01, 0.02) };
    expect(holdsGates(both.measures)).toBe(true);
    expect(holdsOver(tight.measures)).toBe(false);
    expect(chooseRule([tight, loose, both])).toMatchObject({ name: "both", holds: "both" });
    expect(chooseRule([tight, looser, loose])).toMatchObject({ name: "loose", holds: "over" });
    expect(chooseRule([tight])).toBeNull();
  });
});
