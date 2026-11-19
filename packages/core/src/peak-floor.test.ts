import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Engine } from "./engine.ts";
import { belowPeakReason, decideFloor, floorRefusalText, PEAK_FLOOR_CODE, peakFloor, PeakFloorError, signatureText, type MeasuredRun } from "./peak-floor.ts";
import type { JobKey } from "./predict.ts";
import { replayFloor } from "./replay.ts";
import type { Sampler } from "./sampler.ts";
import { keyedLeases, Store } from "./store.ts";

/** The run of the case of H215: a bundle build that used 803 MB. */
const RUN: MeasuredRun = { id: "abcdef0123456789", job: "visuals bundle", holder: "visuals", peakMb: 803, endedAt: Date.UTC(2026, 10, 19, 2, 41) };

const key = (fields: Partial<JobKey> = {}): JobKey => ({
  kind: "build",
  repo: "visuals",
  lock: "0123456789abcdef",
  filter: ".",
  warm: true,
  packages: 400,
  command: "pnpm -s build",
  ...fields,
});

const sampler: Sampler = {
  memory: () => ({ totalMb: 28_000, availableMb: 20_000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
  processes: () => [],
  close: () => undefined,
};

/** This function gives an engine on a store file, with a clock that each run moves, and a read of the keyed leases. */
function setup(): {
  engine: Engine;
  store: Store;
  run: (job: string, memoryMb: number, peakMb: number, each?: JobKey) => string;
  keyed: () => ReturnType<typeof keyedLeases>;
} {
  let now = 1_000_000;
  const file = join(mkdtempSync(join(tmpdir(), "headroom-floor-")), "floor.db");
  const store = new Store(file);
  const keyed = (): ReturnType<typeof keyedLeases> => {
    const read = new DatabaseSync(file, { readOnly: true });
    try {
      return keyedLeases(read, 0);
    } finally {
      read.close();
    }
  };
  const engine = new Engine({ sampler, store, sessionsDir: "/nowhere", now: () => now });
  const run = (job: string, memoryMb: number, peakMb: number, each: JobKey = key()): string => {
    const lease = engine.request({ holder: "visuals", job, amounts: { memory: memoryMb }, ttlMs: 600_000, key: each });
    now += 10_000;
    engine.release(lease.id, "the job ended", peakMb, undefined, { code: 0, signal: null });
    now += 1000;
    return lease.id;
  };
  return { engine, store, run, keyed };
}

describe("The floor of a command (H215)", () => {
  it("is the peak of the last run times 1.1, rounded up, with no float error at a whole number", () => {
    expect(peakFloor(RUN)?.floorMb).toBe(884);
    // 1000 × 1.1 is 1100.0000000000002 in floats: the floor is 1100, not 1101.
    expect(peakFloor({ ...RUN, peakMb: 1000 })?.floorMb).toBe(1100);
    expect(peakFloor(null)).toBeNull();
    expect(peakFloor({ ...RUN, peakMb: 0 })).toBeNull();
    expect(peakFloor({ ...RUN, peakMb: Number.NaN })).toBeNull();
  });

  it("refuses a stated amount below the floor, and passes the floor, no amount and no floor", () => {
    const floor = peakFloor(RUN);
    expect(decideFloor(500, floor, undefined)).toMatchObject({ kind: "refuse", statedMb: 500 });
    expect(decideFloor(883, floor, undefined).kind).toBe("refuse");
    expect(decideFloor(884, floor, undefined).kind).toBe("pass");
    expect(decideFloor(undefined, floor, undefined).kind).toBe("pass");
    expect(decideFloor(500, null, undefined).kind).toBe("pass");
    expect(decideFloor(500, floor, "  a smaller input  ")).toMatchObject({ kind: "below", reason: "a smaller input" });
    // A reason of only spaces is no reason.
    expect(decideFloor(500, floor, "   ").kind).toBe("refuse");
    expect(belowPeakReason("x".repeat(600))).toHaveLength(500);
  });

  it("names the amount, the floor, the peak, the run and the two ways to start", () => {
    const text = floorRefusalText(500, peakFloor(RUN) as NonNullable<ReturnType<typeof peakFloor>>);
    expect(text).toBe(
      "The lease of 500 MB is below the floor of 884 MB for this command. The last run of the same command used 803 MB at its peak " +
        "(job visuals bundle of visuals, lease abcdef01, ended 2026-11-19 02:41Z). The floor is that peak times 1.1. " +
        'Start it with --mem auto, or with --mem 884m or more. To start it below the floor, give the reason: --below-peak "<reason>".',
    );
  });

  it("gives one signature for two keys of one command, and ignores the lockfile and the package count", () => {
    expect(signatureText(key())).toBe(signatureText(key({ lock: "fedcba9876543210", packages: 900 })));
    expect(signatureText(key())).not.toBe(signatureText(key({ filter: "packages/core" })));
    expect(signatureText(key())).not.toBe(signatureText(key({ warm: false })));
  });
});

describe("Engine floor (H215)", () => {
  it("refuses a lease of 500 MB after a run of 803 MB of the same command under a new job name, with no lease", () => {
    const { engine, store, run, keyed } = setup();
    const first = run("visuals bundle", 900, 803);
    let caught: unknown = null;
    try {
      engine.request({ holder: "visuals", job: "visuals bundle retry", amounts: { memory: 500 }, ttlMs: 600_000, key: key({ lock: "fedcba9876543210" }) });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PeakFloorError);
    const error = caught as PeakFloorError;
    expect(error.code).toBe(PEAK_FLOOR_CODE);
    expect(error.floor).toMatchObject({ floorMb: 884, run: { id: first, peakMb: 803, job: "visuals bundle" } });
    expect(error.message).toContain("used 803 MB at its peak");
    expect(error.message).toContain("the floor of 884 MB");
    // The refusal makes no lease: the store has the first lease only.
    expect(keyed().map((lease) => lease.id)).toEqual([first]);
    expect(store.activeLeases()).toHaveLength(0);
    engine.close();
  });

  it("starts a lease at the floor, a lease with no amount, and a lease of a command with no run", () => {
    const { engine, store, run } = setup();
    run("visuals bundle", 900, 803);
    const atFloor = run("visuals bundle", 884, 700);
    expect(store.leaseKeyRow(atFloor)).toMatchObject({ floorMb: 884, belowPeak: null });
    // The floor comes from the newest run: 700 × 1.1 = 770.
    expect(engine.floorOf(key())?.floorMb).toBe(770);
    const none = engine.request({ holder: "visuals", job: "visuals bundle", amounts: {}, ttlMs: 600_000, key: key() });
    expect(none.state).toBe("granted");
    const other = run("visuals lint", 200, 150, key({ kind: "lint", command: "pnpm -s lint" }));
    expect(store.leaseKeyRow(other)).toMatchObject({ floorMb: null, belowPeak: null });
    // A request with no key has no floor.
    expect(engine.request({ holder: "visuals", job: "visuals bundle", amounts: { memory: 100 }, ttlMs: 600_000 }).state).toBe("granted");
    engine.close();
  });

  it("starts a lease below the floor with a reason, and keeps the reason and the floor in the key row", () => {
    const { engine, store, run } = setup();
    run("visuals bundle", 900, 803);
    const lease = engine.request({ holder: "visuals", job: "visuals bundle", amounts: { memory: 500 }, ttlMs: 600_000, key: key(), belowPeak: " a half input " });
    expect(lease.state).toBe("granted");
    expect(store.leaseKeyRow(lease.id)).toMatchObject({ floorMb: 884, belowPeak: "a half input" });
    engine.close();
  });

  it("raises the amount of --mem auto to the floor when the ladder gives less", () => {
    const { engine, run } = setup();
    // 19 runs of 100 MB and a newest run of 2000 MB: the 90th percentile of the 20 peaks is 100 MB.
    for (let index = 0; index < 19; index += 1) run(`visuals bundle ${index}`, 512, 100);
    run("visuals bundle 19", 512, 2000);
    const ladder = engine.predictMemory("visuals bundle 20", "visuals", key());
    expect(ladder.mb).not.toBeNull();
    expect(ladder.mb ?? 0).toBeLessThan(2200);
    const suggestion = engine.suggest("visuals bundle 20", "visuals", key());
    expect(suggestion.memoryMb).toBe(2200);
    expect(suggestion.floor).toMatchObject({ floorMb: 2200, run: { peakMb: 2000, job: "visuals bundle 19" } });
    // With no key, no floor.
    expect(engine.suggest("visuals bundle 20", "visuals").floor).toBeUndefined();
    engine.close();
  });
});

describe("Store lastCommandRun (H215)", () => {
  it("gives the newest ended run of the signature with a peak, and matches a null filter and a null warm state", () => {
    const { engine, store, run } = setup();
    expect(store.lastCommandRun(key())).toBeNull();
    run("a", 900, 803);
    const newest = run("b", 900, 600, key({ lock: "fedcba9876543210" }));
    run("c", 900, 999, key({ repo: "shop" }));
    expect(store.lastCommandRun(key())).toMatchObject({ id: newest, peakMb: 600, job: "b", holder: "visuals" });
    const loose = key({ filter: null, warm: null });
    const id = run("d", 900, 300, loose);
    expect(store.lastCommandRun(loose)).toMatchObject({ id, peakMb: 300 });
    expect(store.lastCommandRun(key())?.id).toBe(newest);
    engine.close();
  });
});

describe("replayFloor (H215)", () => {
  it("counts the leases that the rule refuses, the leases of --mem auto that it raises, and the leases with a reason", () => {
    const { engine, run, keyed } = setup();
    run("visuals bundle", 900, 803);
    // A lease below the floor needs a reason in the engine. The replay reads it as a lease with a reason.
    const below = engine.request({ holder: "visuals", job: "visuals retry", amounts: { memory: 500 }, ttlMs: 600_000, key: key(), belowPeak: "the case" });
    engine.release(below.id, "the job ended", 790, undefined, { code: 0, signal: null });
    const leases = keyed();
    const replay = replayFloor(leases, 0);
    expect(replay).toMatchObject({ leases: 2, withFloor: 1, refused: [], raised: [] });
    expect(replay.below).toEqual([
      { id: below.id, job: "visuals retry", holder: "visuals", memoryMb: 500, floorMb: 884, peakMb: 790, auto: false, reason: "the case" },
    ]);
    // The same leases with no reason: the rule refuses the second one. Its peak is above its amount.
    const plain = leases.map((lease) => (lease.keyed === null ? lease : { ...lease, keyed: { ...lease.keyed, belowPeak: null } }));
    expect(replayFloor(plain, 0).refused).toMatchObject([{ id: below.id, memoryMb: 500, floorMb: 884, peakMb: 790 }]);
    // A lease of --mem auto: its amount is the prediction at its request. The rule raises it.
    const auto = plain.map((lease) => (lease.id === below.id && lease.keyed !== null ? { ...lease, keyed: { ...lease.keyed, predictedMb: 500 } } : lease));
    expect(replayFloor(auto, 0)).toMatchObject({ refused: [], raised: [{ id: below.id, auto: true }] });
    // The window starts after the first lease: the first run gives the floor, and only the second lease counts.
    expect(replayFloor(plain, (leases[1]?.requestedAt ?? 0) - 1)).toMatchObject({ leases: 1, withFloor: 1 });
    engine.close();
  });
});
