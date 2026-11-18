import { describe, expect, it } from "vitest";
import type { Lease } from "./broker.ts";
import { Engine } from "./engine.ts";
import type { Sampler } from "./sampler.ts";
import { Store } from "./store.ts";
import type { SpawnClass } from "./spawn.ts";
import {
  capAt,
  checkStartCap,
  expectedRate,
  START_CAP_DEFAULT,
  START_CAP_WAIT_START,
  startCapConflict,
  startCapLine,
  startCapOf,
  startCapSum,
  unseenRate,
  type StartCapFacts,
} from "./start-cap.ts";

const MINUTE = 60_000;

function lease(id: string, fields: Partial<Lease> = {}): Lease {
  return {
    id, holder: "shop", job: "pnpm test", amounts: {}, priority: 0, pid: null, ttlMs: 300_000, state: "waiting",
    requestedAt: 0, grantedAt: null, endedAt: null, heartbeatAt: 0, reason: null, peakMb: null, ...fields,
  };
}

function spawn(source: SpawnClass["source"], perMinute: number | null, runs = perMinute === null ? 0 : 5): SpawnClass {
  return { heavy: perMinute !== null && perMinute >= 600, source, perMinute, runs };
}

/** The facts after the slow start: a cap of 3,500, a prior of 160 and the window of 2 minutes. */
function facts(fields: Partial<StartCapFacts> = {}): StartCapFacts {
  return {
    now: 10 * MINUTE, machine: 2_000, sinceBootMs: 2 * 60 * MINUTE, cap: START_CAP_DEFAULT, prior: 160, heavyLimit: 600,
    windowMs: 2 * MINUTE, progressMs: 10 * MINUTE, ...fields,
  };
}

describe("the steps of the start cap (H197)", () => {
  it("gives the value of the last step that started", () => {
    const cap = [{ afterMs: 0, perMinute: 1000 }, { afterMs: 30 * MINUTE, perMinute: 2000 }, { afterMs: 60 * MINUTE, perMinute: 3000 }];
    expect(capAt(cap, 0)).toBe(1000);
    expect(capAt(cap, 30 * MINUTE - 1)).toBe(1000);
    expect(capAt(cap, 30 * MINUTE)).toBe(2000);
    expect(capAt(cap, 59 * MINUTE)).toBe(2000);
    expect(capAt(cap, 24 * 60 * MINUTE)).toBe(3000);
  });

  it("gives the first step for a time before the boot, and null for the cap off", () => {
    expect(capAt(START_CAP_DEFAULT, -5_000)).toBe(1822);
    expect(capAt([], 0)).toBeNull();
    expect(capAt([], 10 * MINUTE)).toBeNull();
  });

  it("has a slow start of 1,822 for one hour and 3,500 after it by default", () => {
    expect(START_CAP_DEFAULT).toEqual([{ afterMs: 0, perMinute: 1822 }, { afterMs: 60 * MINUTE, perMinute: 3500 }]);
  });
});

describe("the check of a start cap (H197)", () => {
  it("gives a correct cap back as plain steps, and the empty cap as off", () => {
    expect(checkStartCap([{ afterMs: 0, perMinute: 2000, extra: 1 }, { afterMs: 1000, perMinute: 3000 }])).toEqual([
      { afterMs: 0, perMinute: 2000 },
      { afterMs: 1000, perMinute: 3000 },
    ]);
    expect(checkStartCap([])).toEqual([]);
  });

  it("refuses each wrong cap with a RangeError that names the step", () => {
    expect(() => checkStartCap({ afterMs: 0, perMinute: 1 })).toThrow(/must be a list of steps/);
    expect(() => checkStartCap(Array.from({ length: 13 }, (_, index) => ({ afterMs: index, perMinute: 1 })))).toThrow(/at most 12 steps/);
    expect(() => checkStartCap([{ afterMs: 5, perMinute: 1000 }])).toThrow(/first step .* must start at 0/);
    expect(() => checkStartCap([{ afterMs: 0, perMinute: 1000 }, { afterMs: 0, perMinute: 2000 }])).toThrow(/Step 2 .* must start after step 1/);
    expect(() => checkStartCap([{ afterMs: 0, perMinute: 0 }])).toThrow(/Step 1 .* perMinute must be a whole number above 0/);
    expect(() => checkStartCap([{ afterMs: 0, perMinute: 1.5 }])).toThrow(RangeError);
    expect(() => checkStartCap([{ afterMs: -1, perMinute: 1000 }])).toThrow(/afterMs must be a whole number of ms/);
    expect(() => checkStartCap([null])).toThrow(/Step 1/);
  });

  it("reads a stored cap, and gives the default for no value or a wrong value", () => {
    expect(startCapOf(undefined)).toBe(START_CAP_DEFAULT);
    expect(startCapOf("[]")).toEqual([]);
    expect(startCapOf('[{"afterMs":0,"perMinute":2500}]')).toEqual([{ afterMs: 0, perMinute: 2500 }]);
    expect(startCapOf("not json")).toBe(START_CAP_DEFAULT);
    expect(startCapOf('[{"afterMs":7,"perMinute":2500}]')).toBe(START_CAP_DEFAULT);
  });
});

describe("the expected start rate of a lease (H197)", () => {
  it("uses the learned peak of the past runs, also for a job with an option", () => {
    expect(expectedRate(lease("a", { spawn: spawn("history", 240) }), 160, 600)).toBe(240);
    expect(expectedRate(lease("a", { spawn: spawn("opted-out", 90) }), 160, 600)).toBe(90);
    expect(expectedRate(lease("a", { spawn: spawn("live", 1_400, 0) }), 160, 600)).toBe(1_400);
  });

  it("without a learned peak, counts an opted-out job as 0, a declared job as the limit and each other job as the prior", () => {
    expect(expectedRate(lease("a", { spawn: spawn("opted-out", null) }), 160, 600)).toBe(0);
    expect(expectedRate(lease("a", { spawn: spawn("declared", null) }), 160, 600)).toBe(600);
    expect(expectedRate(lease("a", { spawn: spawn("history", null) }), 160, 600)).toBe(160);
    expect(expectedRate(lease("a"), 160, 600)).toBe(160);
  });
});

describe("the unseen part of the new leases (H197)", () => {
  it("adds the rate of each lease of the window in proportion to the part of the window that is still to come", () => {
    const now = 10 * MINUTE;
    const granted = [
      lease("new", { state: "granted", grantedAt: now }),
      lease("half", { state: "granted", grantedAt: now - MINUTE }),
      lease("old", { state: "granted", grantedAt: now - 2 * MINUTE }),
      lease("waiting"),
    ];
    expect(unseenRate(granted, now, 2 * MINUTE, () => 400)).toBe(400 + 200);
  });

  it("counts a grant from a clock that went back as new", () => {
    expect(unseenRate([lease("a", { grantedAt: 11 * MINUTE })], 10 * MINUTE, 2 * MINUTE, () => 300)).toBe(300);
  });
});

describe("the sum of the start cap at a grant (H197)", () => {
  const heavy = lease("heavy", { requestedAt: 9 * MINUTE, spawn: spawn("history", 1_200) });
  const fresh = lease("fresh", { state: "granted", requestedAt: 9 * MINUTE, grantedAt: 9 * MINUTE, spawn: spawn("history", 800) });

  it("adds the computer, the unseen part of the new leases and the own rate", () => {
    expect(startCapSum(heavy, [fresh], facts())).toEqual({ cap: 3500, machine: 2_000, unseen: 400, own: 1_200, total: 3_600, slowStart: false });
    expect(startCapConflict(heavy, [fresh], facts())).toBe(
      `${START_CAP_WAIT_START}: the computer starts 2,000 a minute, new jobs add 400 and this job adds 1,200. The sum of 3,600 is above the cap of 3,500.`,
    );
  });

  it("lets the lease start at or under the cap", () => {
    expect(startCapConflict(heavy, [], facts())).toBeNull();
    expect(startCapConflict(heavy, [fresh], facts({ machine: 1_900 }))).toBeNull();
  });

  it("does not count the lease itself in the unseen part", () => {
    expect(startCapSum(fresh, [fresh], facts())?.unseen).toBe(0);
  });

  it("lets a light job start: at most 1 % of the cap", () => {
    const light = lease("light", { spawn: spawn("history", 35) });
    expect(startCapSum(light, [], facts({ machine: 5_000 }))).toBeNull();
    expect(startCapConflict(lease("just", { spawn: spawn("history", 36) }), [], facts({ machine: 5_000 }))).toMatch(/this job adds 36\./);
  });

  it("lets each lease start without a read of the computer or with the cap off", () => {
    expect(startCapSum(heavy, [fresh], facts({ machine: null }))).toBeNull();
    expect(startCapSum(heavy, [fresh], facts({ machine: 9_000, cap: [] }))).toBeNull();
  });

  it("counts the own rate at most at the cap, so a job above the cap starts when the computer is quiet", () => {
    const huge = lease("huge", { requestedAt: 9 * MINUTE, spawn: spawn("history", 6_400) });
    expect(startCapSum(huge, [], facts({ machine: 0 }))?.own).toBe(3_500);
    expect(startCapConflict(huge, [], facts({ machine: 0 }))).toBeNull();
    expect(startCapConflict(huge, [], facts({ machine: 1 }))).not.toBeNull();
  });

  it("stops the own rate after the head wait, so no lease waits for ever", () => {
    const old = lease("old", { requestedAt: 0, spawn: spawn("history", 1_200) });
    expect(startCapSum(old, [], facts({ now: 10 * MINUTE + 1, machine: 3_000 }))?.own).toBe(0);
    expect(startCapConflict(old, [], facts({ now: 10 * MINUTE + 1, machine: 3_000 }))).toBeNull();
    expect(startCapConflict(old, [], facts({ now: 10 * MINUTE + 1, machine: 3_600 }))).toBe(
      `${START_CAP_WAIT_START}: the computer starts 3,600 a minute and this job waited past the head wait and counts as 0. The sum of 3,600 is above the cap of 3,500.`,
    );
    expect(startCapSum(old, [], facts({ now: 10 * MINUTE, machine: 3_000 }))?.own).toBe(1_200);
  });

  it("uses the cap of the slow start after a boot, and tells it", () => {
    const sum = startCapSum(heavy, [], facts({ sinceBootMs: 27 * MINUTE + 30_000, machine: 700 }));
    expect(sum).toMatchObject({ cap: 1822, total: 1_900, slowStart: true });
    expect(startCapConflict(heavy, [], facts({ sinceBootMs: 27 * MINUTE + 30_000, machine: 700 }))).toBe(
      `${START_CAP_WAIT_START}: the computer starts 700 a minute and this job adds 1,200. The sum of 1,900 is above the cap of 1,822 in the slow start, 27 minutes after the boot.`,
    );
  });

  it("counts an unknown job at the prior", () => {
    const unknown = lease("unknown", { requestedAt: 9 * MINUTE, spawn: spawn("history", null) });
    expect(startCapSum(unknown, [], facts({ machine: 3_400 }))).toMatchObject({ own: 160, total: 3_560 });
  });
});

describe("the status line of the start cap (H197)", () => {
  it("gives the cap, the rate of the computer and the waiting leases", () => {
    expect(startCapLine(START_CAP_DEFAULT, 2 * 60 * MINUTE, 2_246, 2)).toBe("Start cap: 3,500 a minute. The computer starts 2,246 a minute. 2 leases wait for it.");
    expect(startCapLine(START_CAP_DEFAULT, 2 * 60 * MINUTE, 2_246, 1)).toBe("Start cap: 3,500 a minute. The computer starts 2,246 a minute. 1 lease waits for it.");
  });

  it("tells the slow start and a missing read", () => {
    expect(startCapLine(START_CAP_DEFAULT, 10 * MINUTE, null, 0)).toBe(
      "Start cap: 1,822 a minute in the slow start, 3,500 from 60 minutes after the boot. The computer has no read of its starts yet.",
    );
  });

  it("gives no line for the cap off", () => {
    expect(startCapLine([], 0, 100, 0)).toBeNull();
  });
});

describe("the first runs in the store (H197)", () => {
  it("gives the real peaks of the runs with no past runs at the request, the newest first, with no option of the run", () => {
    const store = new Store(":memory:");
    const ended = (id: string, endedAt: number, fields: Partial<Lease>): void =>
      store.saveLease(lease(id, { state: "released", grantedAt: endedAt - 60_000, endedAt, ...fields }));
    ended("first", 100_000, { processes: 50, peakStartsPerMin: 40, spawn: spawn("history", null) });
    // A first run that went above the limit has the class live at its end.
    ended("burst", 200_000, { processes: 3000, peakStartsPerMin: 2400, spawn: spawn("live", 2400, 0) });
    // A first run with no peak gives its average: 120 processes in one minute.
    ended("average", 300_000, { processes: 120, spawn: spawn("history", null) });
    ended("known", 400_000, { processes: 10, peakStartsPerMin: 9, spawn: spawn("history", 12, 3) });
    ended("declared", 500_000, { processes: 900, peakStartsPerMin: 900, spawn: spawn("declared", null) });
    ended("opted", 600_000, { processes: 5, peakStartsPerMin: 5, spawn: spawn("opted-out", null) });
    ended("no-count", 700_000, { spawn: spawn("history", null) });
    store.saveLease(lease("waiting", { spawn: spawn("history", null) }));
    expect(store.firstRunPeaks()).toEqual([120, 2400, 40]);
    expect(store.firstRunPeaks(2)).toEqual([120, 2400]);
    store.close();
  });
});

describe("the start cap in the engine (H197)", () => {
  const NOW = 50_000_000;
  const ttl = { ttlMs: 3_600_000 };
  function setup(bootedAt = NOW - 3 * 3_600_000) {
    let now = NOW;
    let sequence = 10_000;
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 20_000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
      processes: () => [],
      processSequence: () => sequence,
      bootedAt: () => bootedAt,
      close: () => undefined,
    };
    const store = new Store(":memory:");
    const engine = new Engine({ sampler, store, now: () => now, sessionsDir: "/nowhere" });
    engine.tick();
    /** Reads of 10 seconds, each with this count of starts. */
    const reads = (count: number, starts: number): void => {
      for (let read = 0; read < count; read += 1) {
        now += 10_000;
        sequence += starts;
        engine.tick();
      }
    };
    return { engine, store, reads };
  }

  it("holds a lease while the sum is above the cap, tells it in the status, and grants it when the computer is quieter", () => {
    const { engine, reads } = setup();
    expect(engine.setConfig({ startCap: [{ afterMs: 0, perMinute: 1000 }] }).startCap).toEqual([{ afterMs: 0, perMinute: 1000 }]);
    // 150 starts in each read of 10 seconds: 900 a minute.
    reads(12, 150);
    // A job with no runs and no first runs in the store counts as the spawn-heavy limit.
    const e2e = engine.request({ holder: "shop", job: "pnpm e2e", amounts: {}, ...ttl });
    expect(e2e).toMatchObject({
      state: "waiting",
      reason: `${START_CAP_WAIT_START}: the computer starts 900 a minute and this job adds 600. The sum of 1,500 is above the cap of 1,000.`,
    });
    expect(engine.status().startCap).toEqual({ steps: [{ afterMs: 0, perMinute: 1000 }], sinceBootMs: 3 * 3_600_000 + 120_000, machine: 900, waiting: 1, prior: 600 });
    // The burst stops. Each quiet read takes 75 off the rate of the last 2 minutes.
    reads(6, 0);
    expect(engine.get(e2e.id)?.state).toBe("waiting");
    reads(1, 0);
    expect(engine.get(e2e.id)).toMatchObject({ state: "granted", reason: null });
    // The new lease adds its unseen part: a second job waits for it.
    const next = engine.request({ holder: "shop", job: "pnpm build", amounts: {}, ...ttl });
    expect(next.reason).toBe(`${START_CAP_WAIT_START}: the computer starts 375 a minute, new jobs add 600 and this job adds 600. The sum of 1,575 is above the cap of 1,000.`);
    engine.close();
  });

  it("lets a light job start, and lets a lease start after the head wait when the computer is under the cap", () => {
    const { engine, store, reads } = setup();
    engine.setConfig({ startCap: [{ afterMs: 0, perMinute: 1000 }] });
    store.saveLease(lease("past", { job: "tsc", holder: "shop", state: "released", grantedAt: 0, endedAt: 60_000, processes: 8, peakStartsPerMin: 8 }));
    reads(12, 150);
    expect(engine.request({ holder: "shop", job: "tsc", amounts: {}, ...ttl }).state).toBe("granted");
    const e2e = engine.request({ holder: "shop", job: "pnpm e2e", amounts: {}, ...ttl });
    expect(e2e.state).toBe("waiting");
    // The burst goes on at 900 a minute, under the cap. After 10 minutes, the lease stops counting its own rate.
    reads(60, 150);
    expect(engine.get(e2e.id)?.state).toBe("waiting");
    reads(1, 150);
    expect(engine.get(e2e.id)?.state).toBe("granted");
    engine.close();
  });

  it("uses the slow start after a boot, and the default cap with no setting", () => {
    const { engine, reads } = setup(NOW - 20 * 60_000);
    expect(engine.config().startCap).toEqual(START_CAP_DEFAULT);
    // 225 starts in each read: 1,350 a minute. With 600, the sum is 1,950: above the slow start, under the cap after it.
    reads(12, 225);
    const e2e = engine.request({ holder: "shop", job: "pnpm e2e", amounts: {}, ...ttl });
    expect(e2e.reason).toBe(`${START_CAP_WAIT_START}: the computer starts 1,350 a minute and this job adds 600. The sum of 1,950 is above the cap of 1,822 in the slow start, 22 minutes after the boot.`);
    engine.close();
  });

  it("turns the cap off with an empty list, gives the default back with null, and refuses a wrong cap with no change", () => {
    const { engine, reads } = setup();
    reads(12, 1000);
    expect(engine.setConfig({ startCap: [] }).startCap).toEqual([]);
    expect(engine.request({ holder: "shop", job: "pnpm e2e", amounts: {}, ...ttl }).state).toBe("granted");
    expect(engine.status().startCap?.steps).toEqual([]);
    expect(() => engine.setConfig({ startCap: [{ afterMs: 10, perMinute: 1000 }] })).toThrow(RangeError);
    expect(engine.config().startCap).toEqual([]);
    expect(engine.setConfig({ startCap: null }).startCap).toEqual(START_CAP_DEFAULT);
    engine.close();
  });
});
