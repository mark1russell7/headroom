import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Broker, type Capacity, type Lease } from "./broker.ts";
import {
  checksOf,
  ConditionError,
  conditionsText,
  conditionWait,
  CONDITIONS,
  heavyWhy,
  isConditionWait,
  knownConditionsText,
  leaseConditions,
  localClock,
  nextUnmet,
  parseCondition,
  parseUsage,
  parseWhen,
  readUsage,
  unmetCheck,
  unmetText,
  UsageReader,
  waitsForRoom,
  type ConditionFacts,
  type UsageFacts,
} from "./conditions.ts";
import { Engine } from "./engine.ts";
import type { Sampler } from "./sampler.ts";
import { spawnConflict, type SpawnClass } from "./spawn.ts";
import { Store } from "./store.ts";
import type { BatteryRead } from "./types.ts";

/** The rule of the plugin hook: it counts only the leases that wait for memory. */
const MEMORY_WAIT = /^waits for memory\b/;
const NOW = Date.parse("2026-10-25T01:20:00Z");
const MINUTE = 60_000;
const HEAVY: SpawnClass = { heavy: true, source: "history", perMinute: 1870, runs: 4 };
const OK_USAGE: UsageFacts = { state: "ok", path: "D:\\usage.json", ratio: 0.91, resetsAt: NOW + 50 * MINUTE, updatedAt: NOW - 10 * MINUTE };

function facts(fields: Partial<ConditionFacts> = {}): ConditionFacts {
  return { now: NOW, ac: true, percent: 92, usage: OK_USAGE, starts: 320, presence: "present", ...fields };
}

function lease(id: string, fields: Partial<Lease> = {}): Lease {
  return {
    id, holder: "graph", job: "pnpm bench", amounts: {}, priority: 0, pid: null, ttlMs: 300_000, state: "waiting",
    requestedAt: 0, grantedAt: null, endedAt: null, heartbeatAt: 0, reason: null, peakMb: null, ...fields,
  };
}

describe("the registry of the conditions (H31)", () => {
  it("knows ac, battery>=N, usage<N, starts<N and away, each with a reason in STE", () => {
    expect(CONDITIONS.map((each) => each.name)).toEqual(["ac", "battery", "usage", "starts", "away", "cool"]);
    expect(parseCondition("Away")).toEqual({ name: "away", value: null, text: "away" });
    expect(parseCondition("starts < 700")).toEqual({ name: "starts", value: 700, text: "starts<700" });
    expect(parseCondition("ac")).toEqual({ name: "ac", value: null, text: "ac" });
    expect(parseCondition(" Battery >= 50 ")).toEqual({ name: "battery", value: 50, text: "battery>=50" });
    expect(parseCondition("usage<80")).toEqual({ name: "usage", value: 80, text: "usage<80" });
    expect(knownConditionsText()).toBe(
      "The known conditions: ac (the laptop is plugged in), battery>=N (the battery is at N% or more, or the laptop is plugged in), usage<N (the five-hour usage window of Claude is under N%), starts<N (the computer starts fewer than N processes a minute), away (Mark is away from the laptop), cool (the CPU runs at full speed, with no power or heat limit for 2 minutes). Planned: unmetered (H39), night (H42).",
    );
  });

  it("refuses an unknown name with the list of the known conditions", () => {
    expect(() => parseCondition("plugged")).toThrow(ConditionError);
    expect(() => parseCondition("plugged")).toThrow(/^"plugged" is not a known condition\. The known conditions: ac \(the laptop is plugged in\)/);
    expect(() => parseCondition("ac!")).toThrow(/^"ac!" is not a condition\. The known conditions:/);
  });

  it("names the item that adds a planned condition", () => {
    expect(() => parseCondition("unmetered")).toThrow(/^"unmetered" is a planned condition: H39 adds it\. The known conditions:/);
    expect(() => parseCondition("night")).toThrow(/H42 adds it/);
  });

  it("refuses a wrong value", () => {
    expect(() => parseCondition("battery")).toThrow("battery needs a value, for example battery>=50");
    expect(() => parseCondition("battery<50")).toThrow("battery takes >=, for example battery>=50");
    expect(() => parseCondition("battery>=150")).toThrow("battery>=150: the value must be a whole number from 0 to 100, for example battery>=50");
    expect(() => parseCondition("usage<x")).toThrow(/usage<x: the value must be a whole number from 1 to 100/);
    expect(() => parseCondition("usage<0")).toThrow(/from 1 to 100/);
    expect(() => parseCondition("ac>=1")).toThrow("ac takes no value: write ac");
    expect(() => parseCondition("starts>=700")).toThrow("starts takes <, for example starts<700");
    expect(() => parseCondition("starts<0")).toThrow(/from 1 to 100000/);
  });
});

describe("--when (H31)", () => {
  it("reads lists with commas and repeated options, and removes a condition that comes twice", () => {
    expect(parseWhen(["ac,usage<80", "battery>=50", "AC", " "]).map((spec) => spec.text)).toEqual(["ac", "usage<80", "battery>=50"]);
    expect(parseWhen([])).toEqual([]);
    expect(() => parseWhen(["ac,night"])).toThrow(/H42/);
    expect(parseWhen(["ac,cool"]).map((spec) => spec.text)).toEqual(["ac", "cool"]);
    expect(parseWhen(["ac,away"]).map((spec) => spec.text)).toEqual(["ac", "away"]);
  });

  it("gives the conditions of a new lease, or none", () => {
    expect(leaseConditions(undefined, undefined, undefined)).toBeUndefined();
    expect(leaseConditions(["ac", "usage < 80"], false, false)).toEqual({ when: ["ac", "usage<80"] });
    expect(leaseConditions([], true, true)).toEqual({ when: [], timing: true, batteryOk: true });
    expect(() => leaseConditions(["night"], false, false)).toThrow(ConditionError);
    // H34: --during-drain alone gives conditions too.
    expect(leaseConditions(undefined, false, false, true)).toEqual({ when: [], duringDrain: true });
    expect(conditionsText({ when: ["ac"], duringDrain: true })).toBe("when ac, --during-drain");
  });
});

describe("the tests of the conditions (H31)", () => {
  const bench = lease("b", { conditions: { when: ["ac"] } });

  it("ac holds on AC power and on a computer with no battery read", () => {
    expect(conditionWait(bench, facts(), null)).toBeNull();
    expect(conditionWait(bench, facts({ ac: null, percent: null }), null)).toBeNull();
    expect(conditionWait(bench, facts({ ac: false, percent: 41 }), null)).toBe("waits until the laptop is plugged in");
  });

  it("battery>=N holds on AC power, or at N% or more", () => {
    const half = lease("h", { conditions: { when: ["battery>=50"] } });
    expect(conditionWait(half, facts({ ac: false, percent: 50 }), null)).toBeNull();
    expect(conditionWait(half, facts({ ac: true, percent: 10 }), null)).toBeNull();
    expect(conditionWait(half, facts({ ac: false, percent: 41 }), null)).toBe("waits until the battery is at 50% or more, or plugged in (now 41%)");
  });

  it("usage<N compares the five-hour window, and names its reset time", () => {
    const usage = lease("u", { conditions: { when: ["usage<80"] } });
    expect(conditionWait(usage, facts({ usage: { ...OK_USAGE, ratio: 0.79 } }), null)).toBeNull();
    expect(conditionWait(usage, facts(), null)).toBe(`waits until the five-hour usage window is under 80% (now 91%, resets at ${localClock(NOW + 50 * MINUTE)})`);
    expect(conditionWait(usage, facts({ usage: { ...OK_USAGE, resetsAt: null } }), null)).toBe("waits until the five-hour usage window is under 80% (now 91%)");
  });

  it("usage<N fails closed when the file is missing, unreadable or stale", () => {
    const usage = lease("u", { conditions: { when: ["usage<80"] } });
    expect(conditionWait(usage, facts({ usage: { state: "missing", path: "D:\\usage.json" } }), null)).toBe("waits for the usage data: D:\\usage.json is missing");
    expect(conditionWait(usage, facts({ usage: { state: "unreadable", path: "D:\\usage.json", error: "is not valid JSON" } }), null)).toBe(
      "waits for the usage data: D:\\usage.json is not valid JSON",
    );
    const stale = facts({ usage: { ...OK_USAGE, ratio: 0.1, updatedAt: NOW - 95 * MINUTE } });
    expect(conditionWait(usage, stale, null)).toBe("waits for fresh usage data: the file is 95 minutes old");
    // 70 minutes is still fresh.
    expect(conditionWait(usage, facts({ usage: { ...OK_USAGE, ratio: 0.1, updatedAt: NOW - 70 * MINUTE } }), null)).toBeNull();
  });

  it("usage<N holds after the reset of the window, because the old ratio no longer applies", () => {
    const usage = lease("u", { conditions: { when: ["usage<80"] } });
    expect(conditionWait(usage, facts({ usage: { ...OK_USAGE, resetsAt: NOW - MINUTE } }), null)).toBeNull();
    expect(conditionWait(usage, facts({ usage: { ...OK_USAGE, resetsAt: NOW } }), null)).toBeNull();
    // Stale data stays closed, also after the reset.
    expect(conditionWait(usage, facts({ usage: { ...OK_USAGE, resetsAt: NOW - MINUTE, updatedAt: NOW - 95 * MINUTE } }), null)).toMatch(/^waits for fresh usage data/);
  });

  it("starts<N compares the process starts of the computer over the last 2 minutes", () => {
    const quiet = lease("q", { conditions: { when: ["starts<700"] } });
    expect(conditionWait(quiet, facts({ starts: 699 }), null)).toBeNull();
    expect(conditionWait(quiet, facts({ starts: 1108 }), null)).toBe("waits until the computer starts fewer than 700 processes a minute (now 1,108)");
    expect(conditionWait(quiet, facts({ starts: 700 }), null)).toBe("waits until the computer starts fewer than 700 processes a minute (now 700)");
    // Before two reads of the processes, the rate is not known: the lease waits.
    expect(conditionWait(quiet, facts({ starts: null }), null)).toBe("waits until the computer starts fewer than 700 processes a minute (no count yet)");
    expect(isConditionWait(conditionWait(quiet, facts({ starts: 1108 }), null))).toBe(true);
    expect(conditionWait(lease("k", { conditions: { when: ["starts<2000"] } }), facts({ starts: 1108 }), null)).toBeNull();
    expect(unmetCheck(lease("r", { state: "granted", conditions: { when: ["starts<700"] } }), facts({ starts: 1108 }))).toEqual({
      condition: "starts<700",
      state: "1,108 process starts a minute",
    });
  });

  it("gives the first condition that does not hold, and a reason that the hook does not count as a memory wait", () => {
    const both = lease("2", { conditions: { when: ["usage<80", "ac"] } });
    const reason = conditionWait(both, facts({ ac: false }), null);
    expect(reason).toMatch(/^waits until the five-hour usage window is under 80%/);
    for (const each of [reason, "waits until the laptop is plugged in", "waits for the usage data: x is missing", "waits for fresh usage data: the file is 95 minutes old"]) {
      expect(each).not.toMatch(MEMORY_WAIT);
      expect(isConditionWait(each)).toBe(true);
    }
    expect(isConditionWait("waits for memory: needs 2048, 100 free")).toBe(false);
    expect(isConditionWait("waits for browser: needs 1, 0 free")).toBe(false);
    expect(isConditionWait(null)).toBe(false);
    expect(waitsForRoom({ state: "waiting", reason: "waits until the laptop is plugged in" })).toBe(false);
    expect(waitsForRoom({ state: "waiting", reason: "waits for memory: needs 2048, 100 free" })).toBe(true);
    expect(waitsForRoom({ state: "granted", reason: null })).toBe(false);
  });
});

describe("the battery policy (H31)", () => {
  const onBattery = facts({ ac: false, percent: 18 });

  it("holds a heavy lease on battery below the floor: 2 GB or more, the slot browser, or spawn-heavy", () => {
    expect(heavyWhy(lease("m", { amounts: { memory: 2048 } }))).toBe("it asks for 2.0 GB of memory");
    expect(heavyWhy(lease("b", { amounts: { browser: 1 } }))).toBe("it runs browser tests");
    expect(heavyWhy(lease("s", { spawn: HEAVY }))).toBe("it starts many processes");
    expect(heavyWhy(lease("l", { amounts: { memory: 2047, cpu: 4 } }))).toBeNull();
    const big = lease("m", { amounts: { memory: 4096 } });
    expect(conditionWait(big, onBattery, 25)).toBe(
      "waits until the battery is at 25% or more, or plugged in (now 18%): this job is heavy (it asks for 4.0 GB of memory). --battery-ok starts it on a low battery",
    );
    expect(conditionWait(big, onBattery, 25)).not.toMatch(MEMORY_WAIT);
    // At the floor, on AC power, with no floor, or for a light lease: no wait.
    expect(conditionWait(big, facts({ ac: false, percent: 25 }), 25)).toBeNull();
    expect(conditionWait(big, facts({ ac: true, percent: 5 }), 25)).toBeNull();
    expect(conditionWait(big, onBattery, 0)).toBeNull();
    expect(conditionWait(big, onBattery, null)).toBeNull();
    expect(conditionWait(lease("l", { amounts: { memory: 1024 } }), onBattery, 25)).toBeNull();
  });

  it("starts a heavy lease with --battery-ok", () => {
    const ok = lease("m", { amounts: { memory: 4096 }, conditions: { when: [], batteryOk: true } });
    expect(conditionWait(ok, onBattery, 25)).toBeNull();
    expect(checksOf(ok, 25)).toEqual([]);
  });

  it("makes --timing wait for AC power and a cool CPU, with a reason that points to CI", () => {
    const timing = lease("t", { conditions: { when: [], timing: true } });
    expect(checksOf(timing, 25).map((check) => [check.spec.text, check.source])).toEqual([["ac", "timing"], ["cool", "timing"]]);
    expect(conditionWait(timing, facts({ ac: false, percent: 80 }), 25)).toBe(
      "waits until the laptop is plugged in (--timing): timing numbers on battery or on a throttled CPU are wrong, so run timing tests in CI",
    );
    expect(conditionWait(timing, facts(), 25)).toBeNull();
    // --when ac with --timing gives one check, with the reason of --timing.
    const both = lease("t2", { conditions: { when: ["ac", "usage<80"], timing: true } });
    expect(checksOf(both, null).map((check) => `${check.spec.text}:${check.source}`)).toEqual(["ac:timing", "usage<80:when", "cool:timing"]);
    expect(conditionsText(both.conditions)).toBe("when ac, usage<80, --timing");
    expect(conditionsText(undefined)).toBeNull();
    expect(conditionsText({ when: [] })).toBeNull();
  });
});

describe("the record of a lease that runs without its condition (H31)", () => {
  it("starts a record when a condition stops, keeps it, and closes it when the condition holds again", () => {
    const running = lease("r", { state: "granted", grantedAt: NOW - 30 * MINUTE, conditions: { when: ["ac"] } });
    expect(nextUnmet(running, facts())).toBeUndefined();
    const open = nextUnmet(running, facts({ ac: false, percent: 60 }));
    expect(open).toEqual({ condition: "ac", state: "on battery", since: NOW, until: null });
    const kept = { ...running, unmet: open };
    expect(nextUnmet(kept, facts({ now: NOW + MINUTE, ac: false }))).toBe(open);
    const closed = nextUnmet(kept, facts({ now: NOW + 15 * MINUTE }));
    expect(closed).toEqual({ condition: "ac", state: "on battery", since: NOW, until: NOW + 15 * MINUTE });
    expect(nextUnmet({ ...running, unmet: closed }, facts({ now: NOW + 16 * MINUTE }))).toBe(closed);
    expect(unmetText(open)).toBe(`runs without its condition: on battery since ${localClock(NOW)}`);
    expect(unmetText(closed, (at) => (at === NOW ? "01:20" : "01:35"))).toBe("ran without its condition ac: on battery from 01:20 to 01:35");
    expect(unmetText(undefined)).toBeNull();
  });

  it("does not count the battery floor for a running lease", () => {
    const running = lease("r", { state: "granted", amounts: { memory: 8192 }, conditions: { when: [] } });
    expect(nextUnmet(running, facts({ ac: false, percent: 5 }))).toBeUndefined();
  });
});

describe("the usage file (H31)", () => {
  const text = (fields: Record<string, unknown> = {}): string =>
    JSON.stringify({ updatedAt: "2026-10-25T01:10:00Z", limits: { five_hour: { ratio: 0.331, resetsAt: "2026-10-25T08:10:00Z" } }, ...fields });

  it("reads the ratio, the reset time and the time of the data", () => {
    expect(parseUsage(text(), "u.json", 5)).toEqual({
      state: "ok",
      path: "u.json",
      ratio: 0.331,
      resetsAt: Date.parse("2026-10-25T08:10:00Z"),
      updatedAt: Date.parse("2026-10-25T01:10:00Z"),
    });
    // Without updatedAt, the time of the last write of the file counts.
    expect(parseUsage(text({ updatedAt: undefined }), "u.json", 5)).toMatchObject({ updatedAt: 5 });
    expect(parseUsage("{", "u.json", 5)).toEqual({ state: "unreadable", path: "u.json", error: "is not valid JSON" });
    expect(parseUsage(JSON.stringify({ limits: {} }), "u.json", 5)).toEqual({ state: "unreadable", path: "u.json", error: "has no limits.five_hour.ratio" });
  });

  it("reads a temp file, keeps the read for 30 seconds, and gives missing for a file that does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-usage-"));
    const path = join(dir, "current.json");
    expect(readUsage(path)).toEqual({ state: "missing", path });
    writeFileSync(path, text());
    const reader = new UsageReader();
    expect(reader.read(path, NOW)).toMatchObject({ state: "ok", ratio: 0.331 });
    writeFileSync(path, text({ limits: { five_hour: { ratio: 0.95, resetsAt: "2026-10-25T08:10:00Z" } } }));
    expect(reader.read(path, NOW + 29_000)).toMatchObject({ ratio: 0.331 });
    expect(reader.read(path, NOW + 30_000)).toMatchObject({ ratio: 0.95 });
    // A new path reads at once.
    expect(reader.read(join(dir, "other.json"), NOW + 31_000)).toMatchObject({ state: "missing" });
  });
});

describe("Broker conditions (H31)", () => {
  function setup() {
    let now = 1_000_000;
    let next = 0;
    let plugged = false;
    const condition = (each: Lease): string | null => (each.job === "bench" && !plugged ? "waits until the laptop is plugged in" : null);
    const broker = new Broker({ now: () => now, newId: () => `l${++next}`, isAlive: () => true, reserveMb: 1000, headWaitMs: 1000, conflict: spawnConflict, condition });
    return { broker, advance: (ms: number) => (now += ms), plug: () => (plugged = true), now: () => now };
  }
  const cap: Capacity = { totalMb: 16_000, availableMb: 4000, pools: {} };

  it("holds a lease until its condition holds, and keeps the time when it held", () => {
    const { broker, advance, plug, now } = setup();
    const bench = broker.request({ holder: "graph", job: "bench", amounts: { memory: 100 }, when: ["ac"] });
    expect(bench.conditions).toEqual({ when: ["ac"] });
    broker.tick(cap);
    expect(broker.get(bench.id)).toMatchObject({ state: "waiting", reason: "waits until the laptop is plugged in" });
    advance(5000);
    plug();
    broker.tick(cap);
    expect(broker.get(bench.id)).toMatchObject({ state: "granted", reason: null, conditionsMetAt: now() });
  });

  it("refuses an unknown condition at the request", () => {
    const { broker } = setup();
    expect(() => broker.request({ holder: "graph", job: "bench", amounts: {}, when: ["night"] })).toThrow(/H42/);
    expect(broker.leases()).toEqual([]);
  });

  it("does not let a lease that waits for a condition hold the head of the queue or a conflict", () => {
    const { broker, advance } = setup();
    // The bench waits for AC power for a long time, before the other leases.
    const bench = broker.request({ holder: "graph", job: "bench", amounts: { memory: 100 }, when: ["ac"] }, HEAVY);
    broker.tick(cap);
    advance(60_000);
    const e2e = broker.request({ holder: "site", job: "pnpm e2e", amounts: { browser: 1 } });
    const small = broker.request({ holder: "client", job: "vitest", amounts: { memory: 500 } });
    broker.tick(cap);
    expect(broker.get(bench.id)?.state).toBe("waiting");
    // A spawn-heavy lease that waits for a condition does not hold a later browser test.
    expect(broker.get(e2e.id)?.state).toBe("granted");
    expect(broker.get(small.id)?.state).toBe("granted");
  });
});

describe("Store condition columns (H31)", () => {
  it("adds the columns of the conditions to a table of H47, and keeps its rows", () => {
    const path = join(mkdtempSync(join(tmpdir(), "headroom-conditions-")), "h47.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE leases (
      id TEXT PRIMARY KEY, holder TEXT NOT NULL, job TEXT NOT NULL, amounts TEXT NOT NULL,
      priority INTEGER NOT NULL, pid INTEGER, ttl_ms INTEGER NOT NULL, state TEXT NOT NULL,
      requested_at INTEGER NOT NULL, granted_at INTEGER, ended_at INTEGER, heartbeat_at INTEGER NOT NULL, reason TEXT,
      peak_mb REAL, usage TEXT, exit_code INTEGER, signal TEXT, log TEXT, processes INTEGER, peak_starts_per_min REAL, spawn TEXT)`);
    old.exec(`INSERT INTO leases VALUES ('old1', 'graph', 'bench', '{}', 0, 42, 300000, 'released', 1000, 1000, 61000, 61000,
      'released', NULL, NULL, 0, NULL, NULL, 10, 20, NULL)`);
    old.close();
    const store = new Store(path);
    expect(store.lease("old1")).toMatchObject({ job: "bench", processes: 10 });
    expect(store.lease("old1")?.conditions).toBeUndefined();
    expect(store.lease("old1")?.unmet).toBeUndefined();
    const unmet = { condition: "ac", state: "on battery", since: 70_000, until: null };
    store.saveLease(lease("new1", { state: "granted", grantedAt: 65_000, conditions: { when: ["ac", "usage<80"], timing: true }, conditionsMetAt: 64_000, unmet }));
    expect(store.lease("new1")).toMatchObject({ conditions: { when: ["ac", "usage<80"], timing: true }, conditionsMetAt: 64_000, unmet });
    // A change of the record and the end of the lease keep the conditions.
    store.saveLease({ ...store.lease("new1")!, state: "released", endedAt: 90_000, unmet: { ...unmet, until: 80_000 } });
    expect(store.lease("new1")).toMatchObject({ state: "released", conditions: { when: ["ac", "usage<80"], timing: true }, unmet: { until: 80_000 } });
    store.close();
  });
});

describe("Engine conditions (H31)", () => {
  const PLUGGED: BatteryRead = { ac: true, charging: true, discharging: false, maxMwh: 50_000, remainingMwh: 46_000, rateMw: 15_000, estimatedSeconds: null };
  function setup(readUsage?: (path: string) => UsageFacts) {
    let now = NOW;
    let read: BatteryRead = PLUGGED;
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 20_000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
      processes: () => [],
      battery: () => read,
      close: () => undefined,
    };
    const store = new Store(":memory:");
    const engine = new Engine({ sampler, store, now: () => now, sessionsDir: "/nowhere", readUsage });
    // The first tick reads the battery.
    engine.tick();
    return {
      engine,
      store,
      advance: (ms: number) => (now += ms),
      now: () => now,
      unplug: (percent = 68) => (read = { ...PLUGGED, ac: false, charging: false, discharging: true, remainingMwh: percent * 500, rateMw: -18_000, estimatedSeconds: 7080 }),
      plug: () => (read = PLUGGED),
    };
  }
  const ttl = { ttlMs: 3_600_000 };

  it("holds a lease with --when ac on battery, and grants it at the tick of the power event", () => {
    const { engine, unplug, plug, advance } = setup();
    unplug();
    engine.powerEvent({ type: "source", ac: false });
    engine.tick();
    const bench = engine.request({ holder: "graph", job: "pnpm bench", amounts: { memory: 512 }, ...ttl, when: ["ac"] });
    expect(bench).toMatchObject({ state: "waiting", reason: "waits until the laptop is plugged in", conditions: { when: ["ac"] } });
    // The charger is in, but no event came and no read of the battery is due: the lease still waits.
    plug();
    advance(2000);
    engine.tick();
    expect(engine.get(bench.id)?.state).toBe("waiting");
    // The power event asks for a tick at once, and that tick grants the lease.
    engine.powerEvent({ type: "source", ac: true });
    engine.tick();
    expect(engine.get(bench.id)).toMatchObject({ state: "granted", reason: null });
    expect(engine.jobs({ query: bench.id })[0]).toMatchObject({ state: "running", conditions: { when: ["ac"] }, unmet: null });
  });

  it("holds a lease with --when starts<700 during a burst, and grants it at the tick of the first quiet sample", () => {
    let now = NOW;
    let sequence = 10_000;
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 20_000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
      processes: () => [],
      processSequence: () => sequence,
      close: () => undefined,
    };
    const engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, sessionsDir: "/nowhere" });
    engine.tick();
    const e2e = engine.request({ holder: "graph", job: "pnpm e2e", amounts: {}, ...ttl, when: ["starts<700"] });
    expect(e2e).toMatchObject({ state: "waiting", reason: "waits until the computer starts fewer than 700 processes a minute (no count yet)" });
    // A burst for 2 minutes: 185 starts in each read of 10 seconds, 1,110 a minute.
    for (let read = 0; read < 12; read += 1) {
      now += 10_000;
      sequence += 185;
      engine.tick();
    }
    expect(engine.get(e2e.id)?.reason).toBe("waits until the computer starts fewer than 700 processes a minute (now 1,110)");
    // The burst stops. After 4 quiet reads, the rate of the last 2 minutes is 740 a minute.
    for (let read = 0; read < 4; read += 1) {
      now += 10_000;
      engine.tick();
    }
    expect(engine.get(e2e.id)).toMatchObject({ state: "waiting", reason: "waits until the computer starts fewer than 700 processes a minute (now 740)" });
    // A tick between two reads has no new sample.
    now += 8000;
    engine.tick();
    expect(engine.get(e2e.id)?.state).toBe("waiting");
    // The fifth quiet read gives 648 a minute: the tick of that sample grants the lease.
    now += 2000;
    engine.tick();
    expect(engine.get(e2e.id)).toMatchObject({ state: "granted", reason: null, conditionsMetAt: now });
    engine.close();
  });

  it("refuses an unknown or a planned condition at the request", () => {
    const { engine } = setup();
    expect(() => engine.request({ holder: "graph", job: "x", amounts: {}, ...ttl, when: ["night"] })).toThrow(/"night" is a planned condition: H42 adds it/);
    expect(() => engine.request({ holder: "graph", job: "x", amounts: {}, ...ttl, when: ["plugged"] })).toThrow(/not a known condition/);
    expect(engine.status().leases).toEqual([]);
  });

  it("holds new heavy leases on battery below the floor, and starts them with --battery-ok or a lower floor", () => {
    const { engine, unplug } = setup();
    unplug(18);
    engine.powerEvent({ type: "source", ac: false });
    engine.tick();
    const big = engine.request({ holder: "graph", job: "pnpm build", amounts: { memory: 4096 }, ...ttl });
    expect(big.state).toBe("waiting");
    expect(big.reason).toBe("waits until the battery is at 25% or more, or plugged in (now 18%): this job is heavy (it asks for 4.0 GB of memory). --battery-ok starts it on a low battery");
    const e2e = engine.request({ holder: "site", job: "pnpm e2e", amounts: { browser: 1 }, ...ttl });
    expect(e2e.reason).toMatch(/this job is heavy \(it runs browser tests\)/);
    expect(engine.request({ holder: "client", job: "vitest", amounts: { memory: 1024 }, ...ttl }).state).toBe("granted");
    expect(engine.request({ holder: "graph", job: "pnpm build", amounts: { memory: 4096 }, ...ttl, batteryOk: true }).state).toBe("granted");
    // A floor of 15 lets the waiting leases start at once.
    expect(engine.setConfig({ batteryFloor: 15 }).batteryFloor).toBe(15);
    expect(engine.get(big.id)?.state).toBe("granted");
    expect(engine.get(e2e.id)?.state).toBe("granted");
    expect(() => engine.setConfig({ batteryFloor: 101 })).toThrow(RangeError);
    expect(() => engine.setConfig({ batteryFloor: 2.5 })).toThrow(RangeError);
    expect(engine.setConfig({ batteryFloor: null }).batteryFloor).toBe(25);
  });

  it("holds a --timing job on battery with a reason that points to CI", () => {
    const { engine, unplug } = setup();
    unplug(90);
    engine.powerEvent({ type: "source", ac: false });
    engine.tick();
    const timing = engine.request({ holder: "server-stack", job: "pnpm bench", amounts: {}, ...ttl, timing: true });
    expect(timing).toMatchObject({ state: "waiting", conditions: { when: [], timing: true } });
    expect(timing.reason).toBe("waits until the laptop is plugged in (--timing): timing numbers on battery or on a throttled CPU are wrong, so run timing tests in CI");
  });

  it("records a granted lease that runs without its condition, and closes the record when AC power returns", () => {
    const { engine, unplug, plug, advance, now } = setup();
    const bench = engine.request({ holder: "graph", job: "pnpm bench", amounts: {}, ...ttl, when: ["ac"] });
    expect(bench.state).toBe("granted");
    advance(MINUTE);
    unplug();
    engine.powerEvent({ type: "source", ac: false });
    engine.tick();
    const since = now();
    // The job continues: the lease records the condition.
    expect(engine.get(bench.id)).toMatchObject({ state: "granted", unmet: { condition: "ac", state: "on battery", since, until: null } });
    expect(unmetText(engine.status().leases[0]?.unmet)).toBe(`runs without its condition: on battery since ${localClock(since)}`);
    advance(15 * MINUTE);
    plug();
    engine.powerEvent({ type: "source", ac: true });
    engine.tick();
    expect(engine.get(bench.id)?.unmet).toEqual({ condition: "ac", state: "on battery", since, until: now() });
    engine.release(bench.id, "the job ended with code 0");
    expect(engine.jobs({ query: bench.id })[0]).toMatchObject({ state: "exited", unmet: { condition: "ac", since, until: now() } });
  });

  it("reads the usage file only for a usage condition, and keeps the read for 30 seconds", () => {
    let reads = 0;
    let ratio = 0.91;
    const { engine, advance, now } = setup((path) => {
      reads += 1;
      return { state: "ok", path, ratio, resetsAt: now() + 3 * 3_600_000, updatedAt: now() };
    });
    engine.request({ holder: "client", job: "vitest", amounts: {}, ...ttl });
    engine.tick();
    expect(reads).toBe(0);
    const fanout = engine.request({ holder: "organizer", job: "claude -p", amounts: {}, ...ttl, when: ["usage<80"] });
    expect(fanout.reason).toMatch(/^waits until the five-hour usage window is under 80% \(now 91%, resets at \d\d:\d\d\)$/);
    expect(reads).toBe(1);
    ratio = 0.5;
    advance(10_000);
    engine.tick();
    expect(engine.get(fanout.id)?.state).toBe("waiting");
    expect(reads).toBe(1);
    advance(20_000);
    engine.tick();
    expect(engine.get(fanout.id)?.state).toBe("granted");
    expect(reads).toBe(2);
  });

  it("fails closed when the usage file is missing, with the path of the setting", () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-usage-engine-"));
    const { engine, now } = setup();
    const path = join(dir, "current.json");
    expect(engine.setConfig({ usageFile: path }).usageFile).toBe(path);
    expect(() => engine.setConfig({ usageFile: "relative.json" })).toThrow(RangeError);
    const fanout = engine.request({ holder: "organizer", job: "claude -p", amounts: {}, ...ttl, when: ["usage<80"] });
    expect(fanout.reason).toBe(`waits for the usage data: ${path} is missing`);
    // A new file at a new path starts the lease at once: the change of the setting runs the admission.
    const next = join(dir, "next.json");
    writeFileSync(next, JSON.stringify({ updatedAt: new Date(now()).toISOString(), limits: { five_hour: { ratio: 0.2, resetsAt: new Date(now() + 3_600_000).toISOString() } } }));
    engine.setConfig({ usageFile: next });
    expect(engine.get(fanout.id)?.state).toBe("granted");
  });
});
