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
