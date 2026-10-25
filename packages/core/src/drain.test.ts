import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isConditionWait, localClock } from "./conditions.ts";
import { Engine, type EngineOptions } from "./engine.ts";
import { REBOOT_KEYS, rebootLines, type KeyState } from "./reboot.ts";
import type { Sampler } from "./sampler.ts";
import { Store } from "./store.ts";

const HOUR = 3_600_000;
const START = Date.UTC(2026, 9, 25, 1, 0);

/** A computer with a large non-paged pool, a start 3 days ago, and a fake registry with a waiting update. */
function sampler(bootedAt: number, keys: Record<string, KeyState>, reads: { count: number }): Sampler {
  return {
    memory: () => ({ totalMb: 28_000, availableMb: 12_000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 1200, kernelNonpagedMb: 4710 }),
    processes: () => [],
    bootedAt: () => bootedAt,
    registryKey: (path) => {
      reads.count += 1;
      return keys[path] ?? "absent";
    },
    close: () => undefined,
  };
}

describe("Engine drain for a reboot (H34)", () => {
  it("holds new leases, lets --during-drain start, survives a restart, gives the ready alert, and cancels", () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-drain-"));
    try {
      const path = join(dir, "headroom.db");
      let now = START;
      let started = 0;
      const reads = { count: 0 };
      const keys = { [REBOOT_KEYS[0]?.path ?? ""]: "present" as KeyState };
      const options = (): EngineOptions => ({
        sampler: sampler(START - 3 * 24 * HOUR, keys, reads),
        store: new Store(path),
        now: () => now,
        sessionsDir: "/nowhere",
        onDrainStart: () => (started += 1),
        resumePlan: () => ({ path: "resume-plan.md", at: START - HOUR }),
      });
      const first = new Engine(options());
      const ask = (engine: Engine, holder: string, job: string, duringDrain = false) =>
        engine.request({ holder, job, amounts: {}, ttlMs: 24 * HOUR, ...(duringDrain ? { duringDrain } : {}) });
      const a = ask(first, "graph", "pnpm test");
      expect(a.state).toBe("granted");
      const at = START + 10 * 60_000;
      const planned = first.setDrain(at, START + 4 * HOUR);
      expect(planned).toMatchObject({ state: "planned", at, until: START + 4 * HOUR });
      // Before the time of the drain, a new lease starts.
      expect(ask(first, "vex", "vitest").state).toBe("granted");
      expect(started).toBe(0);
      const status = first.status();
      expect(status.reboot).toMatchObject({ advice: { level: "overdue" }, windows: { pending: true, sources: ["Windows Update"] }, uptimeMinutes: 3 * 24 * 60 });
      expect(status.reboot.pools.map((pool) => [pool.id, pool.usedMb, pool.alertMb])).toEqual([["pool:nonpaged", 4710, 3072], ["pool:paged", 1200, 4096]]);
      expect(status.reboot.resumePlan).toEqual({ path: "resume-plan.md", at: START - HOUR });
      // The registry read stays for 5 minutes.
      const count = reads.count;
      first.status();
      expect(reads.count).toBe(count);

      now = at;
      first.tick();
      expect(started).toBe(1);
      const drainAlert = first.alerts().active.find((alert) => alert.id === "drain");
      expect(drainAlert).toMatchObject({ kind: "drain", since: at });
      expect(drainAlert?.message).toContain("2 jobs still run: pnpm test (graph), vitest (vex).");
      const held = ask(first, "client", "tsc");
      expect(held).toMatchObject({ state: "waiting", reason: `waits for the planned reboot at ${localClock(at)} (headroom drain)` });
      const quick = ask(first, "organizer", "git status", true);
      expect(quick.state).toBe("granted");
      expect(first.drain()).toMatchObject({ state: "active", waiting: 1 });
      first.close();

      // A restart of the daemon keeps the drain, the waiting lease and the start: the resume plan is not written again.
      now += 60_000;
      const second = new Engine(options());
      second.tick();
      expect(started).toBe(1);
      expect(second.get(held.id)).toMatchObject({ state: "waiting", reason: `waits for the planned reboot at ${localClock(at)} (headroom drain)` });
      expect(second.alerts().active.find((alert) => alert.id === "drain")?.since).toBe(at);
      for (const lease of [a.id, quick.id]) second.release(lease, "the job ended");
      second.tick();
      expect(second.alerts().active.some((alert) => alert.id === "drain:ready")).toBe(false);
      const last = second.status().leases.find((lease) => lease.state === "granted");
      now += 60_000;
      second.release(last?.id ?? "", "the job ended");
      second.tick();
      const ready = second.alerts().active.find((alert) => alert.id === "drain:ready");
      expect(ready).toMatchObject({ kind: "drain", since: now });
      expect(ready?.message).toContain("Ready for the reboot: no job runs.");
      expect(second.drain()).toMatchObject({ state: "active", running: [], readyAt: now });
      // The check of the alerts keeps the alerts of the drain.
      now += 11_000;
      second.tick();
      expect(second.alerts().active.map((alert) => alert.id)).toEqual(expect.arrayContaining(["drain", "drain:ready"]));

      expect(second.cancelDrain()).toMatchObject({ state: "active" });
      expect(second.drain()).toBeNull();
      expect(second.get(held.id)?.state).toBe("granted");
      expect(second.alerts().active.some((alert) => alert.kind === "drain")).toBe(false);
      expect(second.alerts().ended.map((alert) => alert.id)).toEqual(expect.arrayContaining(["drain", "drain:ready"]));
      expect(second.cancelDrain()).toBeNull();
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ends the drain by itself at the time of --until", () => {
    let now = START;
    const engine = new Engine({ sampler: sampler(0, {}, { count: 0 }), store: new Store(":memory:"), now: () => now, sessionsDir: "/nowhere" });
    engine.setDrain(now, now + 30 * 60_000);
    const held = engine.request({ holder: "client", job: "tsc", amounts: {}, ttlMs: 24 * HOUR });
    expect(held.state).toBe("waiting");
    expect(() => engine.setDrain(now + HOUR, now + HOUR)).toThrow(RangeError);
    now += 30 * 60_000;
    engine.tick();
    expect(engine.drain()).toBeNull();
    expect(engine.get(held.id)?.state).toBe("granted");
    const ended = engine.alerts().active.find((alert) => alert.id === "drain:ended");
    expect(ended?.message).toBe(`The drain for the reboot at ${localClock(START)} ended at ${localClock(now)} with no reboot. New jobs start again.`);
    engine.close();
  });

  it("ends the drain when the computer started after it, because the reboot came", () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-drain-"));
    try {
      const path = join(dir, "headroom.db");
      const store = new Store(path);
      store.setDrain({ at: START, until: null, setAt: START - 60_000, startedAt: START, readyAt: START });
      store.close();
      const engine = new Engine({ sampler: sampler(START + HOUR, {}, { count: 0 }), store: new Store(path), now: () => START + 2 * HOUR, sessionsDir: "/nowhere" });
      expect(engine.drain()).toBeNull();
      expect(engine.alerts().active.find((alert) => alert.id === "drain:ended")?.message).toContain("The reboot came");
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const MINUTE = 60_000;

/** A computer whose kernel pools the test changes, in MB. */
function poolSampler(pools: { nonpaged: number; paged: number }, bootedAt = 0): Sampler {
  return {
    memory: () => ({ totalMb: 28_000, availableMb: 12_000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: pools.paged, kernelNonpagedMb: pools.nonpaged }),
    processes: () => [],
    bootedAt: () => bootedAt,
    close: () => undefined,
  };
}

/** The pools at 6200 MB (6.1 GB), at or above the default level of 6144 MB. */
const HIGH = { nonpaged: 4500, paged: 1700 };

describe("Engine automatic drain (H34)", () => {
  const clock = { now: START };
  /** This function moves the clock in steps, with a tick at each step. */
  const pass = (engine: Engine, ms: number, step = 30_000): void => {
    for (let spent = 0; spent < ms; spent += step) {
      clock.now += Math.min(step, ms - spent);
      engine.tick();
    }
  };
  const engineOf = (pools: { nonpaged: number; paged: number }, extra: Partial<EngineOptions> = {}): Engine =>
    new Engine({ sampler: poolSampler(pools), store: new Store(":memory:"), now: () => clock.now, sessionsDir: "/nowhere", ...extra });
  const ask = (engine: Engine, job: string, duringDrain = false) =>
    engine.request({ holder: "client", job, amounts: {}, ttlMs: 24 * HOUR, ...(duringDrain ? { duringDrain } : {}) });

  it("starts after 2 minutes at the level, with no end time, its reason and its alert", () => {
    clock.now = START;
    let started = 0;
    const pools = { ...HIGH };
    const engine = engineOf(pools, { onDrainStart: () => (started += 1) });
    const running = ask(engine, "pnpm test");
    engine.tick();
    pass(engine, 2 * MINUTE - 1000);
    expect(engine.drain()).toBeNull();
    pass(engine, 1000);
    const at = clock.now;
    expect(engine.drain()).toMatchObject({ state: "active", at, until: null, auto: { levelMb: 6144, poolsMb: 6200 }, running: [{ id: running.id }] });
    expect(started).toBe(1);
    const alert = engine.alerts().active.find((each) => each.id === "drain");
    expect(alert).toMatchObject({ kind: "drain", since: at });
    expect(alert?.message).toBe(
      `The kernel pools reached 6.1 GB and stayed at or above 6.0 GB for 2 minutes. An automatic drain started at ${localClock(at)}: new jobs wait for a reboot. ` +
        "1 job still runs: pnpm test (client). A reboot or `headroom drain --cancel` ends it. It also ends after 10 minutes with the pools under 5.7 GB.",
    );
    // The reason gives the current pools.
    pools.nonpaged = 4600;
    engine.tick();
    const held = ask(engine, "tsc");
    expect(held).toMatchObject({ state: "waiting", reason: "waits for a reboot: the kernel pools are at 6.2 GB (headroom drain, automatic)" });
    expect(isConditionWait(held.reason)).toBe(true);
    expect(ask(engine, "git status", true).state).toBe("granted");
    // The drain has no end time: an hour at the level changes nothing.
    pass(engine, HOUR, 5 * MINUTE);
    expect(engine.drain()).toMatchObject({ at, until: null, waiting: 1 });
    expect(engine.status().reboot.drain?.auto).toEqual({ levelMb: 6144, poolsMb: 6200 });
    engine.close();
  });

  it("starts no drain under the level, and a dip under it starts the 2 minutes again", () => {
    clock.now = START;
    const pools = { nonpaged: 4400, paged: 1700 };
    const engine = engineOf(pools);
    pass(engine, 30 * MINUTE);
    expect(engine.drain()).toBeNull();
    pools.nonpaged = 4500;
    pass(engine, 90_000);
    pools.nonpaged = 4400;
    pass(engine, 10_000);
    pools.nonpaged = 4500;
    pass(engine, 120_000, 10_000);
    expect(engine.drain()).toBeNull();
    pass(engine, 10_000);
    expect(engine.drain()?.auto).toMatchObject({ levelMb: 6144 });
    engine.close();
  });

  it("does not start over a drain of headroom drain, and does not change it", () => {
    clock.now = START;
    const pools = { ...HIGH };
    const engine = engineOf(pools);
    const at = START + HOUR;
    engine.setDrain(at);
    pass(engine, 10 * MINUTE);
    expect(engine.drain()).toMatchObject({ state: "planned", at, until: null });
    expect(engine.drain()?.auto ?? null).toBeNull();
    pass(engine, at - clock.now);
    expect(engine.drain()).toMatchObject({ state: "active", at });
    // Low pools do not end a drain of headroom drain.
    pools.nonpaged = 1000;
    pools.paged = 1000;
    pass(engine, 30 * MINUTE);
    expect(engine.drain()).toMatchObject({ state: "active", at });
    expect(engine.drain()?.auto ?? null).toBeNull();
    engine.close();
  });

  it("ends an automatic drain after 10 minutes under the level less 300 MB", () => {
    clock.now = START;
    const pools = { ...HIGH };
    const engine = engineOf(pools);
    engine.tick();
    pass(engine, 2 * MINUTE);
    expect(engine.drain()?.auto).toBeTruthy();
    const held = ask(engine, "tsc");
    expect(held.state).toBe("waiting");
    // 5900 MB is under the level, but not under the end level of 5844 MB.
    pools.nonpaged = 4200;
    pass(engine, 20 * MINUTE);
    expect(engine.drain()?.auto).toBeTruthy();
    // 5800 MB for 9 minutes, then a step above the end level: the 10 minutes start again.
    pools.nonpaged = 4100;
    pass(engine, 9 * MINUTE);
    pools.nonpaged = 4200;
    pass(engine, 30_000);
    pools.nonpaged = 4100;
    pass(engine, 10 * MINUTE);
    expect(engine.drain()?.auto).toBeTruthy();
    expect(engine.get(held.id)?.state).toBe("waiting");
    pass(engine, 30_000);
    expect(engine.drain()).toBeNull();
    expect(engine.get(held.id)?.state).toBe("granted");
    const ended = engine.alerts().active.find((each) => each.id === "drain:ended");
    expect(ended?.message).toBe("The kernel pools stayed under 5.7 GB for 10 minutes, so the automatic drain ended. New jobs start again.");
    expect(engine.alerts().active.some((each) => each.id === "drain")).toBe(false);
    engine.close();
  });

  it("turns off with 0, and refuses a level that is not valid", () => {
    clock.now = START;
    const engine = engineOf({ ...HIGH });
    expect(engine.setConfig({ autoDrainMb: 0 }).autoDrainMb).toBe(0);
    pass(engine, 30 * MINUTE);
    expect(engine.drain()).toBeNull();
    expect(engine.status().reboot.autoDrain).toEqual({ levelMb: 0, poolsMb: 6200, forecast: null });
    expect(rebootLines(engine.status().reboot)).toContain("Automatic drain: off. `headroom config auto-drain 6GB` turns it on.");
    for (const bad of [500, 6144.5, -1, 2_000_000]) expect(() => engine.setConfig({ autoDrainMb: bad })).toThrow(RangeError);
    expect(engine.config().autoDrainMb).toBe(0);
    expect(engine.setConfig({ autoDrainMb: 6000 }).autoDrainMb).toBe(6000);
    engine.tick();
    pass(engine, 2 * MINUTE);
    expect(engine.drain()?.auto).toMatchObject({ levelMb: 6000 });
    expect(engine.setConfig({ autoDrainMb: null }).autoDrainMb).toBe(6144);
    engine.close();
  });

  it("holds the rule after a cancel until the pools fall or a reboot, also after a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-auto-drain-"));
    try {
      const path = join(dir, "headroom.db");
      clock.now = START;
      const pools = { ...HIGH };
      const options = (bootedAt = 0): EngineOptions => ({ sampler: poolSampler(pools, bootedAt), store: new Store(path), now: () => clock.now, sessionsDir: "/nowhere" });
      const first = new Engine(options());
      first.tick();
      pass(first, 2 * MINUTE);
      expect(first.cancelDrain()?.auto).toBeTruthy();
      pass(first, 10 * MINUTE);
      expect(first.drain()).toBeNull();
      first.close();

      // A restart keeps the hold.
      const second = new Engine(options());
      pass(second, 10 * MINUTE);
      expect(second.drain()).toBeNull();
      // The pools fall under the end level: the hold ends, and the rule starts again.
      pools.nonpaged = 4100;
      pass(second, 30_000);
      pools.nonpaged = 4500;
      pass(second, 2 * MINUTE + 30_000);
      expect(second.drain()?.auto).toBeTruthy();
      expect(second.cancelDrain()).not.toBeNull();
      second.close();

      // A reboot ends the hold too.
      const third = new Engine(options(clock.now + 1000));
      clock.now += 2000;
      third.tick();
      pass(third, 2 * MINUTE);
      const at = third.drain()?.at ?? 0;
      expect(third.drain()?.auto).toBeTruthy();
      third.close();

      // A reboot ends an automatic drain, with its own message.
      const fourth = new Engine(options(clock.now + 1000));
      expect(fourth.drain()).toBeNull();
      expect(fourth.alerts().active.find((each) => each.id === "drain:ended")?.message).toBe(
        `The reboot came, so the automatic drain of ${localClock(at)} ended. New jobs start again.`,
      );
      fourth.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives the level and the forecast to it in the reboot budget", () => {
    clock.now = START;
    const pools = { nonpaged: 2000, paged: 2000 };
    const engine = engineOf(pools);
    for (let minute = 0; minute <= 40; minute += 1) {
      pools.paged = 2000 + 20 * minute;
      engine.tick();
      clock.now += MINUTE;
    }
    const auto = engine.status().reboot.autoDrain;
    expect(auto).toMatchObject({ levelMb: 6144, poolsMb: 4800 });
    expect(auto?.forecast?.minutes).toBeGreaterThanOrEqual(60);
    expect(auto?.forecast?.minutes).toBeLessThanOrEqual(75);
    const line = rebootLines(engine.status().reboot).find((each) => each.startsWith("Automatic drain:"));
    expect(line).toMatch(/^Automatic drain: at 6\.0 GB of the kernel pools together, now 4\.7 GB\. The forecast reaches it at \d+ \w+ \d\d:\d\d, in 1 h \d+ min\.$/);
    engine.close();
  });
});
