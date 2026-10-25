import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_RULES, detect, type AlertInput } from "./alerts.ts";
import type { Lease } from "./broker.ts";
import { COOL_MS, checksOf, conditionWait, localClock, nextUnmet, type ConditionFacts } from "./conditions.ts";
import { Engine } from "./engine.ts";
import type { Sampler } from "./sampler.ts";
import { Store } from "./store.ts";
import {
  heatHolds,
  heatOwners,
  parseThermal,
  speedOf,
  thermalLine,
  thermalLines,
  ThermalTracker,
  THROTTLE_HOLD_MS,
  type ThermalCounters,
  type ThermalRead,
  type ThermalState,
  type ThermalStatus,
} from "./thermal.ts";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const SECOND = 1000;
const MINUTE = 60_000;
/** The reads of this laptop on 2026-10-25: no limit, 2.0 GHz nominal, a boost to 204%, and one zone at 99.9 °C. */
const LAPTOP: ThermalCounters = {
  performanceLimit: 100,
  performance: 204.44,
  frequency: 2000,
  temperature: [{ name: "\\_TZ.THM0", value: 373 }],
  passiveLimit: [{ name: "\\_TZ.THM0", value: 100 }],
  throttleReasons: [{ name: "\\_TZ.THM0", value: 0 }],
};
const clock = (at: number): string => new Date(at).toISOString().slice(11, 16);

/** This function gives a read of the laptop with a performance limit and a passive limit. */
function read(limit: number | null, passive: number | null = 100, celsius = 85): ThermalRead {
  return {
    performanceLimit: limit,
    performance: 150,
    nominalMhz: 2000,
    zones: [{ name: "\\_TZ.THM0", celsius, passiveLimit: passive, throttleReasons: 0 }],
  };
}

/** This function adds one read each 10 seconds from `from` to `to`, as the read of the processes does. */
function feed(tracker: ThermalTracker, from: number, to: number, each: ThermalRead | null): void {
  for (let at = from; at <= to; at += 10 * SECOND) tracker.add(at, each);
}

describe("the counters of the speed and the heat (H35)", () => {
  it("reads the counters of this laptop, in °C, with the zones by name", () => {
    expect(parseThermal(LAPTOP)).toEqual({
      performanceLimit: 100,
      performance: 204.4,
      nominalMhz: 2000,
      zones: [{ name: "\\_TZ.THM0", celsius: 99.9, passiveLimit: 100, throttleReasons: 0 }],
    });
  });

  it("gives null for a missing counter, and no read with no counter", () => {
    const partial = parseThermal({ ...LAPTOP, performance: null, temperature: null, throttleReasons: [] });
    expect(partial).toEqual({ performanceLimit: 100, performance: null, nominalMhz: 2000, zones: [{ name: "\\_TZ.THM0", celsius: null, passiveLimit: 100, throttleReasons: null }] });
    expect(parseThermal({ performanceLimit: null, performance: null, frequency: null, temperature: null, passiveLimit: null, throttleReasons: null })).toBeNull();
    expect(parseThermal({ ...LAPTOP, performanceLimit: Number.NaN, temperature: [{ name: "\\_TZ.X", value: 0 }] })?.zones[0]?.celsius).toBeNull();
  });

  it("gives the speed that the limits permit: the lower of the performance limit and the passive limits", () => {
    expect(speedOf(read(62))).toBe(62);
    expect(speedOf(read(100, 80))).toBe(80);
    expect(speedOf(read(null, null))).toBeNull();
  });
});

describe("the throttle rule (H35)", () => {
  it("counts a limit over 10% or a passive limit under 100 as a throttle after 30 seconds", () => {
    const at = (limit: number | null, passive: number | null): boolean => {
      const tracker = new ThermalTracker();
      feed(tracker, NOW, NOW + THROTTLE_HOLD_MS, read(limit, passive));
      return tracker.state(NOW + THROTTLE_HOLD_MS)?.throttled ?? false;
    };
    expect(at(89, 100)).toBe(true);
    expect(at(90, 100)).toBe(false);
    expect(at(100, 99)).toBe(true);
    expect(at(100, 100)).toBe(false);
    expect(at(null, null)).toBe(false);
  });

  it("holds the limit for 30 seconds before the throttle, and a short break starts the hold again", () => {
    const tracker = new ThermalTracker();
    feed(tracker, NOW, NOW + 20 * SECOND, read(62));
    expect(tracker.state(NOW + 20 * SECOND)).toMatchObject({ limited: true, throttled: false, since: NOW, speed: 62, cause: "a power or heat limit" });
    tracker.add(NOW + 30 * SECOND, read(62));
    expect(tracker.state(NOW + 30 * SECOND)).toMatchObject({ throttled: true, since: NOW, cool: false });
    tracker.add(NOW + 40 * SECOND, read(100));
    feed(tracker, NOW + 50 * SECOND, NOW + 70 * SECOND, read(62));
    expect(tracker.state(NOW + 70 * SECOND)).toMatchObject({ limited: true, throttled: false, since: NOW + 50 * SECOND });
  });

  it("names a passive limit as a heat limit of its zone, and a hot zone as hot", () => {
    const tracker = new ThermalTracker();
    tracker.add(NOW, read(100, 95, 99));
    expect(tracker.state(NOW)).toMatchObject({ cause: "a heat limit of the thermal zone \\_TZ.THM0", hot: true, speed: 95 });
    tracker.add(NOW + 10 * SECOND, read(100, 100, 98));
    expect(tracker.state(NOW + 10 * SECOND)).toMatchObject({ cause: null, hot: true, limited: false });
    tracker.add(NOW + 20 * SECOND, read(100, 100, 97.9));
    expect(tracker.state(NOW + 20 * SECOND)?.hot).toBe(false);
  });

  it("is cool after 2 minutes with no throttle, and a short limit does not stop it", () => {
    const tracker = new ThermalTracker();
    feed(tracker, NOW, NOW + MINUTE, read(62));
    const end = NOW + MINUTE;
    feed(tracker, end + 10 * SECOND, end + COOL_MS, read(100));
    expect(tracker.state(end + COOL_MS - SECOND)).toMatchObject({ throttled: false, cool: false, lastThrottledAt: end });
    expect(tracker.state(end + COOL_MS)).toMatchObject({ cool: true, lastThrottledAt: end });
    // A limit of 20 seconds is no throttle.
    feed(tracker, end + COOL_MS + 10 * SECOND, end + COOL_MS + 30 * SECOND, read(70));
    expect(tracker.state(end + COOL_MS + 30 * SECOND)).toMatchObject({ limited: true, throttled: false, cool: true });
  });

  it("keeps the trail for 11 minutes, empties it at a sleep, and gives no state without a read in the last minute", () => {
    const tracker = new ThermalTracker();
    feed(tracker, NOW, NOW + 15 * MINUTE, read(62));
    expect(tracker.trail.length).toBe(66);
    // A long throttle keeps its start past the trail.
    expect(tracker.state(NOW + 15 * MINUTE)?.since).toBe(NOW);
    tracker.gap();
    expect(tracker.trail).toEqual([]);
    tracker.add(NOW + 16 * MINUTE, read(62));
    expect(tracker.state(NOW + 16 * MINUTE)).toMatchObject({ throttled: false, since: NOW + 16 * MINUTE });
    // A failed read adds no point, and the state ends one minute after the last read.
    tracker.add(NOW + 16 * MINUTE + 10 * SECOND, null);
    expect(tracker.trail.length).toBe(1);
    expect(tracker.state(NOW + 17 * MINUTE + SECOND)).toBeNull();
    expect(new ThermalTracker().state(NOW)).toBeNull();
  });
});

const cores = [
  { owner: "session:graph", kind: "session" as const, cores: 6.1 },
  { owner: "session:vex", kind: "session" as const, cores: 2 },
  { owner: "docker", kind: "docker" as const, cores: 1 },
  { owner: "mcp:vex", kind: "mcp" as const, cores: 0.5 },
];
const vitest: Lease = {
  id: "l1", holder: "graph", job: "vitest", amounts: { cpu: 4 }, priority: 0, pid: 40, ttlMs: 0, state: "granted",
  requestedAt: 0, grantedAt: 0, endedAt: null, heartbeatAt: 0, reason: null, peakMb: null,
};

/** This function gives the state after a throttle of `minutes` at 62%, read each 10 seconds up to `now`. */
function throttled(minutes: number): { readonly tracker: ThermalTracker; readonly now: number } {
  const tracker = new ThermalTracker();
  const now = NOW + minutes * MINUTE;
  feed(tracker, NOW, now, read(62));
  return { tracker, now };
}

describe("the owners of the heat (H35)", () => {
  it("names the 3 owners with the most cores, their power as an estimate and their leased jobs", () => {
    const owners = heatOwners(cores, 12, [vitest, { ...vitest, id: "l2", job: "waits", state: "waiting" }], new Map([[40, "session:graph"]]));
    expect(owners).toEqual([
      { owner: "session:graph", kind: "session", cores: 6.1, watts: 7.6, jobs: ["vitest"] },
      { owner: "session:vex", kind: "session", cores: 2, watts: 2.5, jobs: [] },
      { owner: "docker", kind: "docker", cores: 1, watts: 1.3, jobs: [] },
    ]);
    expect(heatOwners(cores, null, [], new Map())[0]).toMatchObject({ watts: null });
    expect(heatOwners(undefined, 12, [], new Map())).toEqual([]);
  });
});

describe("the heat alert (H35)", () => {
  const limits = DEFAULT_ALERT_RULES;
  const alertInput = (state: ThermalState | null, now: number, extra: Partial<AlertInput> = {}): AlertInput => ({
    memory: { totalMb: 28_000, availableMb: 8000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 },
    processes: [],
    ownerOf: new Map([[40, "session:graph"]]),
    kindOf: new Map(),
    leases: [vitest],
    at: now,
    thermal: state ?? undefined,
    cores,
    meters: { "system power": 30, "cpu power": 12 },
    ...extra,
  });

  it("warns after 5 minutes of throttle, and names the speed, the cause and the owners", () => {
    const short = throttled(4.5);
    expect(detect(alertInput(short.tracker.state(short.now), short.now))).toEqual([]);
    const long = throttled(5);
    const alerts = detect(alertInput(long.tracker.state(long.now), long.now));
    expect(alerts.map((alert) => [alert.id, alert.kind, alert.severity])).toEqual([["heat", "heat", "warning"]]);
    expect(alerts[0]?.message).toBe(
      "The CPU runs at 62% of its speed for 5 min: a power or heat limit. The zone \\_TZ.THM0 is at 85.0 °C. Most CPU: session:graph 6.1 cores, 7.6 W (leased: vitest)," +
        " session:vex 2.0 cores, 2.5 W, docker 1.0 core, 1.3 W. The power is an estimate. Timing numbers are wrong on a slow CPU, so jobs with --timing wait.",
    );
  });

  it("ends after 2 minutes with no throttle, and a short break does not end it", () => {
    const { tracker, now } = throttled(6);
    const active = [{ id: "heat", severity: "warning" as const }];
    feed(tracker, now + 10 * SECOND, now + 90 * SECOND, read(100));
    const kept = detect(alertInput(tracker.state(now + 90 * SECOND), now + 90 * SECOND, { active }));
    expect(kept.map((alert) => alert.id)).toEqual(["heat"]);
    expect(kept[0]?.message).toBe(`The throttle of the CPU stopped at ${localClock(now)}. The alert ends after 2 min with no throttle.`);
    feed(tracker, now + 100 * SECOND, now + 2 * MINUTE, read(100));
    expect(detect(alertInput(tracker.state(now + 2 * MINUTE), now + 2 * MINUTE, { active }))).toEqual([]);
    // Without the active alert, the same break gives no alert.
    expect(detect(alertInput(tracker.state(now + 90 * SECOND), now + 90 * SECOND))).toEqual([]);
  });

  it("holds by the rule of heatHolds, and gives no alert without the counters", () => {
    const { tracker, now } = throttled(5);
    const state = tracker.state(now) ?? undefined;
    expect(heatHolds(state, now, false, limits)).toBe(true);
    expect(heatHolds(state, now, false, { heatForMs: 6 * MINUTE, heatClearMs: limits.heatClearMs })).toBe(false);
    expect(heatHolds(undefined, now, true, limits)).toBe(false);
    expect(detect(alertInput(null, now))).toEqual([]);
  });
});

describe("the condition cool and --timing (H35)", () => {
  const base: ConditionFacts = { now: NOW, ac: true, percent: 90, usage: { state: "missing", path: "u.json" }, starts: 10, presence: null };
  const lease = (fields: Partial<Lease>): Lease => ({ ...vitest, id: "t", job: "pnpm bench", pid: null, state: "waiting", ...fields });

  it("waits while the CPU is throttled, and names the limit", () => {
    const { tracker, now } = throttled(1);
    const facts = { ...base, now, thermal: tracker.state(now) };
    expect(conditionWait(lease({ conditions: { when: ["cool"] } }), facts, null)).toBe("waits until the CPU runs at full speed (now 62%, a power or heat limit)");
    expect(conditionWait(lease({ conditions: { when: [], timing: true } }), facts, null)).toBe(
      "waits until the CPU runs at full speed (now 62%, a power or heat limit) (--timing): timing numbers on battery or on a throttled CPU are wrong, so run timing tests in CI",
    );
    expect(checksOf(lease({ conditions: { when: [], timing: true } }), null).map((check) => check.spec.text)).toEqual(["ac", "cool"]);
  });

  it("waits 2 minutes after a throttle, and holds with no read of the counters", () => {
    const { tracker, now } = throttled(1);
    feed(tracker, now + 10 * SECOND, now + MINUTE, read(100));
    const wait = conditionWait(lease({ conditions: { when: ["cool"] } }), { ...base, now: now + MINUTE, thermal: tracker.state(now + MINUTE) }, null);
    expect(wait).toMatch(/^waits until the CPU runs at full speed for 2 minutes \(the last throttle was at \d\d:\d\d\)$/);
    feed(tracker, now + 70 * SECOND, now + COOL_MS, read(100));
    expect(conditionWait(lease({ conditions: { when: ["cool"] } }), { ...base, now: now + COOL_MS, thermal: tracker.state(now + COOL_MS) }, null)).toBeNull();
    expect(conditionWait(lease({ conditions: { when: ["cool"] } }), { ...base, thermal: null }, null)).toBeNull();
    expect(conditionWait(lease({ conditions: { when: ["cool"] } }), base, null)).toBeNull();
  });

  it("records a granted lease that runs on a throttled CPU", () => {
    const { tracker, now } = throttled(1);
    const unmet = nextUnmet(lease({ state: "granted", conditions: { when: [], timing: true } }), { ...base, now, thermal: tracker.state(now) });
    expect(unmet).toEqual({ condition: "cool", state: "the CPU at 62% of its speed: a power or heat limit", since: now, until: null });
  });
});

describe("the lines of the heat (H35)", () => {
  const status = (state: ThermalState | null, owners: ThermalStatus["owners"] = []): ThermalStatus | null => (state === null ? null : { ...state, owners });

  it("adds a status line only when the CPU is throttled or hot", () => {
    const cool = new ThermalTracker();
    cool.add(NOW, read(100, 100, 85));
    expect(thermalLine(status(cool.state(NOW)), clock)).toBeNull();
    expect(thermalLine(null)).toBeNull();
    expect(thermalLine(undefined)).toBeNull();
    const hot = new ThermalTracker();
    hot.add(NOW, read(100, 100, 99.4));
    expect(thermalLine(status(hot.state(NOW)), clock)).toBe("Heat: 99.4 °C in the zone \\_TZ.THM0. The CPU runs at full speed (3.0 GHz).");
    const { tracker, now } = throttled(5);
    const owners = heatOwners(cores, 12, [vitest], new Map([[40, "session:graph"]]), 1);
    expect(thermalLine(status(tracker.state(now), owners), clock)).toBe(
      "Heat: the CPU runs at 62% of its speed since 12:00: a power or heat limit. 85.0 °C in the zone \\_TZ.THM0. Most CPU: session:graph 6.1 cores, 7.6 W (leased: vitest). Jobs with --timing or --when cool wait.",
    );
  });

  it("prints the reads of headroom thermal, and a missing counter", () => {
    const tracker = new ThermalTracker();
    tracker.add(NOW, parseThermal(LAPTOP));
    expect(thermalLines(status(tracker.state(NOW)), clock)).toEqual([
      "Read at 12:00.",
      "Speed limit: 100% of the nominal speed (no limit).",
      "Speed: 204.4% of the nominal speed, 4.1 GHz (nominal 2.0 GHz).",
      "Zone \\_TZ.THM0: 99.9 °C, passive limit 100%, throttle reasons 0.",
      "State: hot, at full speed.",
      "Cool: yes, no throttle in the last 2 minutes.",
    ]);
    const bare = new ThermalTracker();
    bare.add(NOW, parseThermal({ performanceLimit: 70, performance: null, frequency: null, temperature: null, passiveLimit: null, throttleReasons: null }));
    expect(thermalLines(status(bare.state(NOW)), clock)).toEqual([
      "Read at 12:00.",
      "Speed limit: 70% of the nominal speed.",
      "Speed: no counter.",
      "Thermal zones: none.",
      "State: a limit since 12:00: a power or heat limit. It is a throttle after 30 seconds.",
      "Cool: yes, no throttle in the last 2 minutes.",
    ]);
    expect(thermalLines(null)).toEqual(["No counter of the speed or the heat of the CPU on this computer, or no read in the last minute."]);
  });
});

describe("the engine with the heat (H35)", () => {
  function setup() {
    let now = NOW;
    let current: ThermalRead | null = read(100);
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 20_000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
      processes: () => [],
      thermal: () => current,
      close: () => undefined,
    };
    const engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, sessionsDir: "/nowhere" });
    engine.tick();
    /** This function moves the clock in steps of 10 seconds, with one read of the processes at each step. */
    const run = (ms: number, each: ThermalRead | null): void => {
      current = each;
      for (let step = 0; step < ms; step += 10 * SECOND) {
        now += 10 * SECOND;
        engine.tick();
      }
    };
    return { engine, run, now: () => now };
  }

  it("gives the kind thermal in the status, holds a --timing job on a throttled CPU, and starts it 2 minutes after", () => {
    const { engine, run, now } = setup();
    expect(engine.status().resources.find((each) => each.id === "thermal")).toMatchObject({ kind: "thermal", unit: "%", capacity: 100, used: 0, free: 100 });
    expect(engine.status().thermal).toMatchObject({ throttled: false, cool: true, owners: [] });
    run(MINUTE, read(62));
    expect(engine.status().thermal).toMatchObject({ throttled: true, cool: false, speed: 62 });
    expect(engine.status().resources.find((each) => each.id === "thermal")).toMatchObject({ used: 38, free: 62 });
    const bench = engine.request({ holder: "graph", job: "pnpm bench", amounts: {}, ttlMs: 3_600_000, timing: true });
    expect(bench).toMatchObject({ state: "waiting" });
    expect(bench.reason).toMatch(/^waits until the CPU runs at full speed \(now 62%, a power or heat limit\) \(--timing\)/);
    run(MINUTE, read(100));
    expect(engine.get(bench.id)?.reason).toMatch(/^waits until the CPU runs at full speed for 2 minutes/);
    run(MINUTE, read(100));
    expect(engine.get(bench.id)).toMatchObject({ state: "granted", conditionsMetAt: now() });
    engine.close();
  });

  it("starts the heat alert after 5 minutes of throttle, ends it after 2 minutes, and gives no state without counters", () => {
    const { engine, run } = setup();
    run(5 * MINUTE + 10 * SECOND, read(62));
    expect(engine.alerts().active.map((alert) => alert.id)).toEqual(["heat"]);
    run(MINUTE, read(100));
    expect(engine.alerts().active.map((alert) => alert.id)).toEqual(["heat"]);
    run(MINUTE, read(100));
    expect(engine.alerts().active).toEqual([]);
    expect(engine.alerts().ended.map((alert) => alert.id)).toEqual(["heat"]);
    run(2 * MINUTE, null);
    expect(engine.status().thermal).toBeNull();
    expect(engine.status().resources.some((each) => each.id === "thermal")).toBe(false);
    engine.close();
  });
});
