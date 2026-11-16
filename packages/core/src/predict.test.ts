import { random } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { amountOf, FIT_MIN_RUNS, fitPackages, LEGACY_RULE, PEAK_RULE, predictMemory, predictRunMs, type JobKey, type PeakReads, type SizedPeak } from "./predict.ts";

const KEY: JobKey = { kind: "install", repo: "shop", lock: "0123456789abcdef", filter: ".", warm: false, packages: 900, command: "pnpm install" };

/** The reads of a ladder from lists. Each read that the predictor calls goes to `called`. */
function reads(lists: Partial<Record<keyof PeakReads, readonly number[] | readonly SizedPeak[]>>, called: string[] = []): PeakReads {
  const read =
    <T>(name: keyof PeakReads) =>
    (): readonly T[] => {
      called.push(name);
      return (lists[name] ?? []) as readonly T[];
    };
  return { own: read("own"), job: read("job"), key: read("key"), repo: read("repo"), sized: read("sized"), kind: read("kind") };
}

/** Runs of a law `peak = e^a × packages^b` with log-normal noise, from a seed. */
function lawRuns(seed: string, count: number, a: number, b: number, noise: number): SizedPeak[] {
  const draw = random(seed);
  return Array.from({ length: count }, () => {
    const packages = Math.round(Math.exp(draw.range(Math.log(50), Math.log(3000))));
    return { packages, peakMb: Math.exp(a + b * Math.log(packages) + draw.normal(0, noise)) };
  });
}

describe("amountOf (H78)", () => {
  it("gives the rule of before H78 with LEGACY_RULE: the 90th percentile, 25% more, up to 64 MB, at least 256 MB", () => {
    expect(amountOf([], LEGACY_RULE)).toBeNull();
    expect(amountOf([400, 420, 900, 410], LEGACY_RULE)).toBe(1152);
    expect(amountOf([100], LEGACY_RULE)).toBe(256);
    expect(amountOf([1800], LEGACY_RULE)).toBe(2304);
  });

  it("adds 10% and 128 MB to the 90th percentile with PEAK_RULE", () => {
    // 900 × 1.1 + 128 = 1118, rounded up to 1152. 1800 × 1.1 + 128 = 2108, rounded up to 2112.
    expect(amountOf([400, 420, 900, 410], PEAK_RULE)).toBe(1152);
    expect(amountOf([1800], PEAK_RULE)).toBe(2112);
    expect(amountOf([4000], PEAK_RULE)).toBe(4544);
    expect(amountOf([50], PEAK_RULE)).toBe(256);
  });

  it("adds the spread term only with two peaks or more", () => {
    const rule = { ...LEGACY_RULE, factor: 1, spread: 1 };
    expect(amountOf([1000], rule)).toBe(1024);
    // The sample standard deviation of 1000 and 2000 is 707.1: 2000 + 707.1, rounded up to 2752.
    expect(amountOf([1000, 2000], rule)).toBe(2752);
  });
});

describe("predictMemory (H78)", () => {
  it("takes the first rung with runs, in the order job, key, repo, fit, kind, none", () => {
    const sized = lawRuns("ladder", 30, 2, 0.6, 0.05);
    const full = { own: [], job: [600], key: [700], repo: [800], sized, kind: [900] };
    expect(predictMemory(reads(full), KEY)).toMatchObject({ rung: "job", runs: 1, peakMb: 600 });
    expect(predictMemory(reads({ ...full, job: [] }), KEY)).toMatchObject({ rung: "key", peakMb: 700 });
    expect(predictMemory(reads({ ...full, job: [], key: [] }), KEY)).toMatchObject({ rung: "repo", peakMb: 800 });
    expect(predictMemory(reads({ ...full, job: [], key: [], repo: [] }), KEY)).toMatchObject({ rung: "fit", runs: 30 });
    expect(predictMemory(reads({ ...full, job: [], key: [], repo: [], sized: [] }), KEY)).toMatchObject({ rung: "kind", runs: 1, peakMb: 900 });
    expect(predictMemory(reads({}), KEY)).toEqual({ mb: null, rung: "none", runs: 0, peakMb: null });
  });

  it("uses the runs of the holder before the runs of each holder, at the rung job", () => {
    const called: string[] = [];
    expect(predictMemory(reads({ own: [300], job: [3000] }, called), KEY)).toMatchObject({ rung: "job", runs: 1, peakMb: 300 });
    expect(called).toEqual(["own"]);
  });

  it("calls no read after the rung that has runs", () => {
    const called: string[] = [];
    predictMemory(reads({ repo: [800], kind: [900] }, called), KEY);
    expect(called).toEqual(["own", "job", "key", "repo"]);
  });

  it("without a key, has only the rung job, as before H78", () => {
    const called: string[] = [];
    expect(predictMemory(reads({ key: [700], kind: [900] }, called), null)).toMatchObject({ rung: "none", mb: null });
    expect(called).toEqual(["own", "job"]);
  });

  it("skips the rungs key and repo with no repo, and the fit with no count of packages", () => {
    const called: string[] = [];
    const lists = { key: [700], repo: [800], sized: lawRuns("skip", 30, 2, 0.6, 0.05), kind: [900] };
    expect(predictMemory(reads(lists, called), { ...KEY, repo: null, packages: null })).toMatchObject({ rung: "kind" });
    expect(called).toEqual(["own", "job", "kind"]);
  });

  it("falls from the fit to the kind with fewer than 10 runs of a size, or with one count of packages", () => {
    const few = lawRuns("few", FIT_MIN_RUNS - 1, 2, 0.6, 0.05);
    expect(predictMemory(reads({ sized: few, kind: [900] }), KEY)).toMatchObject({ rung: "kind" });
    const flat = Array.from({ length: 20 }, (_, at) => ({ packages: 500, peakMb: 400 + at }));
    expect(predictMemory(reads({ sized: flat, kind: [900] }), KEY)).toMatchObject({ rung: "kind" });
  });
});

describe("fitPackages (H78)", () => {
  it("recovers a known law from seeded runs, and its amount covers about 90% of new runs", () => {
    const runs = lawRuns("law", 400, 1.5, 0.7, 0.15);
    const fit = fitPackages(runs, 1000, { ...LEGACY_RULE, stepMb: 1, floorMb: 0 });
    expect(fit).not.toBeNull();
    expect(fit?.slope).toBeCloseTo(0.7, 1);
    expect(fit?.intercept).toBeCloseTo(1.5, 0);
    expect(fit?.runs).toBe(400);
    // New runs of the same law: the amount for each count is the line plus the 90th percentile of the residuals.
    const fresh = lawRuns("law-new", 400, 1.5, 0.7, 0.15);
    const covered = fresh.filter((run) => run.peakMb <= (fitPackages(runs, run.packages, { ...LEGACY_RULE, stepMb: 1, floorMb: 0 })?.mb ?? 0)).length / fresh.length;
    expect(covered).toBeGreaterThan(0.85);
    expect(covered).toBeLessThan(0.95);
  });

  it("holds the count of packages in the range of the runs", () => {
    const runs = lawRuns("range", 100, 1.5, 0.7, 0.05);
    const top = Math.max(...runs.map((run) => run.packages));
    expect(fitPackages(runs, 1_000_000)?.mb).toBe(fitPackages(runs, top)?.mb);
  });
});

describe("predictRunMs (H78)", () => {
  it("takes the 90th percentile of the first source with runs: own, job, key, repo, size, all", () => {
    const empty = { own: () => [], job: () => [], key: () => [], repo: () => [], size: () => [], all: () => [] };
    expect(predictRunMs(empty)).toEqual({ ms: null, from: null, runs: 0 });
    expect(predictRunMs({ ...empty, key: () => [10, 20], size: () => [99] })).toEqual({ ms: 20, from: "key", runs: 2 });
    expect(predictRunMs({ ...empty, repo: () => [30], size: () => [99] })).toEqual({ ms: 30, from: "repo", runs: 1 });
    expect(predictRunMs({ ...empty, job: () => [5], key: () => [10] })).toEqual({ ms: 5, from: "job", runs: 1 });
  });
});
