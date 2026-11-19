import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type KeyedLease, type Lease } from "@headroom/core";
import { afterEach, describe, expect, it } from "vitest";
import { leaseReport, leaseReportLines, readLeaseReport, replayKey, ruleName, RULE_GRID } from "./lease-report.ts";

const MINUTE = 60_000;
const DAY = 86_400_000;
const START = Date.UTC(2026, 10, 10);

/** A lease of a job of before H78, with no key: its request at `at`, a wait of half a minute and a run of 20 seconds. */
function lease(id: string, job: string, at: number, memoryMb: number | null, peakMb: number | null): KeyedLease {
  return { id, holder: "shop", job, state: "released", memoryMb, peakMb, requestedAt: at, grantedAt: at + MINUTE / 2, endedAt: at + MINUTE, exitCode: 0, keyed: null };
}

describe("leaseReport (H78)", () => {
  it("gives the leases as they ran, the base, the ladder and the rule that the gates choose", () => {
    const leases = [
      // 20 runs of one job: the first asks the default, the others ask 512 MB.
      ...Array.from({ length: 20 }, (_, at) => lease(`t${at}`, "pnpm test", START + at * 2 * MINUTE, at === 0 ? 1024 : 512, 400 + (at % 5) * 10)),
      // New job names of the kind lint: the base has no run of each name, the ladder has the runs of the kind.
      ...Array.from({ length: 10 }, (_, at) => lease(`l${at}`, `h${at}-lint`, START + (60 + at * 2) * MINUTE, 1024, 200)),
      // A lease with no memory request counts in the leases, not in the measures.
      lease("n0", "git fetch", START + 100 * MINUTE, null, 30),
    ];
    const report = leaseReport(leases, 7, START + DAY);
    expect(report.ran.all).toMatchObject({ leases: 31, measured: 30, keyedShare: 0, keyedMeasuredShare: null });
    expect(report.ran.all.defaultShare).toBeCloseTo(11 / 30, 6);
    expect(report.ran.all.waitP90Min).toBe(0.5);
    expect(Object.keys(report.ran.byKind)).toEqual(["test", "lint", "other"]);
    // The base: the first run of each name asks the default.
    expect(report.base.measures).toMatchObject({ leases: 30, defaultShare: 11 / 30, kindShare: 0 });
    // The ladder: only the first run of each kind asks the default.
    expect(report.current.measures).toMatchObject({ leases: 30, defaultShare: 2 / 30, measuredShare: 19 / 30, kindShare: 9 / 30 });
    expect(Object.keys(report.byRung)).toEqual(["job", "kind", "none"]);
    expect(Object.keys(report.byKind)).toEqual(["test", "lint"]);
    expect(report.grid).toHaveLength(RULE_GRID.length);
    // 30 leases are too few for the over gate: the upper end of the 95% interval of 0 of 30 is 11%.
    expect(report.chosen).toBeNull();
  });

  it("gives the text of the report, with no read for the empty measures", () => {
    const lines = leaseReportLines(leaseReport([lease("a", "pnpm install", START, 1024, 600)], 1, START + DAY));
    expect(lines[0]).toBe("headroom report leases: the 1 day from 2026-11-10 00:00 to 2026-11-11 00:00 UTC, 1 lease, 1 with a memory request and a peak, 0.0% with a key.");
    expect(lines.some((line) => line.startsWith("  base: rung job, p90×1.25"))).toBe(true);
    expect(lines).toContain("  install wait p90 as the leases ran: 0.50 min");
  });

  it("names the rules of the grid, and takes the kind of a lease of before H78 from its job text", () => {
    expect(ruleName({ quantile: 0.9, factor: 1.1, spread: 0, addMb: 128, floorMb: 256, stepMb: 64 })).toBe("p90×1.1+128MB");
    expect(ruleName({ quantile: 1, factor: 1, spread: 1, addMb: 0, floorMb: 128, stepMb: 64 })).toBe("max+1sd floor128");
    expect(replayKey(lease("a", "pnpm --filter x typecheck", 0, 512, 300))).toEqual({
      kind: "typecheck",
      repo: null,
      lock: null,
      filter: "x",
      warm: null,
      packages: null,
      command: "pnpm --filter x typecheck",
    });
  });
});

describe("readLeaseReport (H78)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads a store read-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-report-"));
    dirs.push(dir);
    const path = join(dir, "headroom.db");
    const store = new Store(path);
    const saved: Lease = {
      id: "a",
      holder: "shop",
      job: "pnpm test",
      amounts: { memory: 512 },
      priority: 0,
      pid: null,
      ttlMs: MINUTE,
      state: "released",
      requestedAt: START,
      grantedAt: START,
      endedAt: START + MINUTE,
      heartbeatAt: 0,
      reason: null,
      peakMb: 400,
      exitCode: 0,
    };
    store.saveLease(saved);
    store.close();
    expect(readLeaseReport(path, 7, START + DAY).ran.all).toMatchObject({ leases: 1, measured: 1, ratio: 512 / 400 });
  });
});

describe("The floor section of the report (H215)", () => {
  const key = { kind: "build" as const, repo: "visuals", lock: "0123456789abcdef", filter: ".", warm: true, packages: 400, command: "pnpm -s build" };
  /** A keyed lease of the bundle build: its request at `at`, a run of half a minute. */
  const keyed = (id: string, at: number, memoryMb: number, peakMb: number, more: { predictedMb?: number; belowPeak?: string } = {}): KeyedLease => ({
    ...lease(id, "visuals bundle", at, memoryMb, peakMb),
    holder: "visuals",
    keyed: { key, predictedMb: more.predictedMb ?? null, rung: "key", runs: 1, predictedMs: null, runFrom: null, floorMb: null, belowPeak: more.belowPeak ?? null },
  });

  it("counts the leases below the floor of the last run of the same command, and their peak over their amount", () => {
    const leases = [
      keyed("a", START, 900, 803),
      // The case of H215: 500 MB after a run of 803 MB, and a peak of 790 MB.
      keyed("b", START + 10 * MINUTE, 500, 790),
      // At the floor of the run b: 790 × 1.1 = 869.
      keyed("c", START + 20 * MINUTE, 869, 700),
      // --mem auto below the floor of the run c (770): the rule raises it.
      keyed("d", START + 30 * MINUTE, 600, 650, { predictedMb: 600 }),
      // A reason to start below the floor of the run d (715).
      keyed("e", START + 40 * MINUTE, 300, 280, { belowPeak: "a half input" }),
    ];
    const report = leaseReport(leases, 7, START + DAY);
    expect(report.floor).toMatchObject({ leases: 5, withFloor: 4 });
    expect(report.floor?.refused.map((row) => [row.id, row.memoryMb, row.floorMb, row.peakMb])).toEqual([["b", 500, 884, 790]]);
    expect(report.floor?.raised.map((row) => [row.id, row.floorMb])).toEqual([["d", 770]]);
    expect(report.floor?.below.map((row) => [row.id, row.floorMb, row.reason])).toEqual([["e", 715, "a half input"]]);
    const lines = leaseReportLines(report);
    expect(lines).toContain("The floor of a command (H215): the peak of its last run times 1.1. A stated amount below the floor gets a refusal.");
    expect(lines).toContain("  5 keyed leases with a memory amount, 4 with a floor at the request.");
    expect(lines).toContain("  The rule refuses 1. Of those with a peak, 1 of 1 used more than the amount (median peak/amount 1.58×).");
    expect(lines).toContain("  1 lease started below the floor with a reason (--below-peak).");
    expect(lines).toContain("  visuals bundle (visuals): 300 MB, floor 715 MB. Reason: a half input");
  });
});
