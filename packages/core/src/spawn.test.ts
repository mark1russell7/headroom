import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Broker, type Capacity, type Lease, type LeaseRequest } from "./broker.ts";
import { Engine } from "./engine.ts";
import type { Sampler } from "./sampler.ts";
import {
  averageRate,
  isSpawnWait,
  learnSpawn,
  leaseRate,
  percentile90,
  promote,
  spawnClassText,
  spawnConflict,
  spawnLine,
  startsSumConflict,
  SUM_WAIT_START,
  windowRate,
  type SpawnClass,
} from "./spawn.ts";
import { Store } from "./store.ts";

const HEAVY: SpawnClass = { heavy: true, source: "history", perMinute: 1870, runs: 4 };
/** The rule of the plugin hook: it counts only the leases that wait for memory. */
const MEMORY_WAIT = /^waits for memory\b/;

function lease(id: string, fields: Partial<Lease> = {}): Lease {
  return {
    id, holder: "graph", job: "pnpm e2e", amounts: {}, priority: 0, pid: null, ttlMs: 300_000, state: "granted",
    requestedAt: 0, grantedAt: 0, endedAt: null, heartbeatAt: 0, reason: null, peakMb: null, ...fields,
  };
}

describe("spawn rates (H47)", () => {
  it("gives the 90th percentile of --mem auto: the highest value up to 10 values", () => {
    expect(percentile90([])).toBeNull();
    expect(percentile90([400, 1870, 120])).toBe(1870);
    expect(percentile90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 1000])).toBe(11);
  });

  it("measures the starts over a window of 30 seconds from the counts of the heartbeats", () => {
    expect(windowRate([])).toBeNull();
    expect(windowRate([[0, 0]])).toBeNull();
    // The first heartbeat comes after 3 seconds: a short window counts as 30 seconds, so a burst at the start is no false peak.
    expect(windowRate([[0, 0], [3000, 40]])).toBe(80);
    expect(windowRate([[0, 0], [3000, 40], [33_000, 1000]])).toBe(1920);
    // Heartbeats every 5 seconds: the window still covers 30 seconds.
    const often: [number, number][] = [[0, 0], [5000, 100], [10_000, 200], [15_000, 300], [20_000, 400], [25_000, 500], [30_000, 600], [35_000, 700]];
    expect(windowRate(often)).toBe(1200);
  });

  it("gives the average of a run, with at least 30 seconds", () => {
    expect(averageRate(300, 10_000)).toBe(600);
    expect(averageRate(1800, 60_000)).toBe(1800);
  });
});

describe("spawn learning (H47)", () => {
  it("classes a job name from the peaks of its past runs and the limit", () => {
    expect(learnSpawn([], 600)).toEqual({ heavy: false, source: "history", perMinute: null, runs: 0 });
    expect(learnSpawn([120, 300], 600)).toEqual({ heavy: false, source: "history", perMinute: 300, runs: 2 });
    expect(learnSpawn([1870.4, 400], 600)).toEqual({ heavy: true, source: "history", perMinute: 1870, runs: 2 });
    expect(learnSpawn([1870, 400], 2000).heavy).toBe(false);
    expect(learnSpawn([600], 600).heavy).toBe(false);
  });

  it("takes the options of the run: --spawn-heavy and --no-spawn-heavy", () => {
    expect(learnSpawn([], 600, true)).toEqual({ heavy: true, source: "declared", perMinute: null, runs: 0 });
    expect(learnSpawn([1870], 600, false)).toEqual({ heavy: false, source: "opted-out", perMinute: 1870, runs: 1 });
  });

  it("promotes a normal job when its own peak goes above the limit, but not a job with --no-spawn-heavy", () => {
    const normal: SpawnClass = { heavy: false, source: "history", perMinute: null, runs: 0 };
    expect(promote(normal, 500, 600)).toBe(normal);
    expect(promote(normal, 912.6, 600)).toEqual({ heavy: true, source: "live", perMinute: 913, runs: 0 });
    expect(promote(undefined, 912, 600)).toEqual({ heavy: true, source: "live", perMinute: 912, runs: 0 });
    expect(promote(HEAVY, 5000, 600)).toBe(HEAVY);
    const opted: SpawnClass = { heavy: false, source: "opted-out", perMinute: 1870, runs: 3 };
    expect(promote(opted, 5000, 600)).toBe(opted);
  });

  it("writes the class of a job", () => {
    expect(spawnClassText(HEAVY)).toBe("spawn-heavy (about 1,870 a minute in past runs)");
    expect(spawnClassText({ heavy: false, source: "history", perMinute: null, runs: 0 })).toBe("normal (no past runs)");
    expect(spawnClassText({ heavy: false, source: "history", perMinute: 120, runs: 5 })).toBe("normal (about 120 a minute in past runs)");
  });
});

describe("spawn conflicts (H47)", () => {
  const browser = lease("b", { holder: "graph", job: "pnpm e2e", amounts: { browser: 1 } });
  const churn = lease("s", { holder: "server-stack", job: "test-churn", spawn: HEAVY });

  it("gives a reason in each order, with a prefix that the hook does not count as a memory wait", () => {
    const heavyWaits = spawnConflict(churn, browser);
    expect(heavyWaits).toBe(
      "waits for the browser tests of graph (pnpm e2e) to end: this job starts many processes (about 1,870 a minute in past runs), and browsers can fail to start beside it",
    );
    const browserWaits = spawnConflict(browser, churn);
    expect(browserWaits).toBe("waits for test-churn of server-stack to end: it starts many processes (about 1,870 a minute), and browsers can fail to start beside it");
    for (const reason of [heavyWaits, browserWaits]) {
      expect(reason).not.toMatch(MEMORY_WAIT);
      expect(isSpawnWait(reason)).toBe(true);
    }
    expect(isSpawnWait("waits for browser: needs 1, 0 free")).toBe(false);
    expect(isSpawnWait(null)).toBe(false);
    // A job whose name starts with "memory" does not give the prefix of a memory wait.
    expect(spawnConflict(browser, { ...churn, job: "memory-bench" })).toMatch(/^waits for the job memory-bench of server-stack to end/);
  });

  it("names a lease that waits first, and lets two spawn-heavy jobs or two browser tests run together", () => {
    expect(spawnConflict(browser, { ...churn, state: "waiting" })).toMatch(/^waits for test-churn of server-stack to run first and end:/);
    expect(spawnConflict(churn, { ...churn, id: "s2" })).toBeNull();
    expect(spawnConflict(browser, { ...browser, id: "b2" })).toBeNull();
    expect(spawnConflict(churn, churn)).toBeNull();
    expect(spawnConflict({ ...churn, spawn: { heavy: true, source: "declared", perMinute: null, runs: 0 } }, browser)).toContain("(declared with --spawn-heavy)");
  });

  it("gives the line of the status for the running spawn-heavy jobs", () => {
    expect(spawnLine([browser])).toBeNull();
    expect(spawnLine([{ ...churn, state: "waiting" }])).toBeNull();
    expect(spawnLine([browser, churn])).toBe("Spawn-heavy now: test-churn (server-stack), 1,870 a minute. Browser tests wait until it ends.");
  });
});

describe("Broker spawn rule (H47)", () => {
  function setup() {
    let now = 1_000_000;
    let next = 0;
    const broker = new Broker({ now: () => now, newId: () => `l${++next}`, isAlive: () => true, reserveMb: 1000, conflict: spawnConflict });
    const ask = (request: Omit<LeaseRequest, "amounts"> & { amounts?: LeaseRequest["amounts"] }, spawn?: SpawnClass): Lease =>
      broker.request({ amounts: {}, ...request }, spawn);
    return { broker, ask, advance: (ms: number) => (now += ms) };
  }
  const cap = (pools: Record<string, number> = {}): Capacity => ({ totalMb: 16_000, availableMb: 12_000, pools });

  it("holds a spawn-heavy job while a browser test runs, and grants it after the end", () => {
    const { broker, ask, advance } = setup();
    const e2e = ask({ holder: "graph", job: "pnpm e2e", amounts: { browser: 1 } });
    broker.tick(cap());
    advance(1000);
    const churn = ask({ holder: "server-stack", job: "test-churn" }, HEAVY);
    broker.tick(cap());
    expect(broker.get(churn.id)).toMatchObject({ state: "waiting", reason: expect.stringMatching(/^waits for the browser tests of graph \(pnpm e2e\) to end:/) });
    broker.release(e2e.id);
    broker.tick(cap());
    expect(broker.get(churn.id)).toMatchObject({ state: "granted", reason: null });
  });

  it("holds a browser test while a spawn-heavy job runs", () => {
    const { broker, ask } = setup();
    const churn = ask({ holder: "server-stack", job: "test-churn" }, HEAVY);
    broker.tick(cap());
    const e2e = ask({ holder: "graph", job: "pnpm e2e", amounts: { browser: 1 } });
    broker.tick(cap());
    expect(broker.get(e2e.id)?.state).toBe("waiting");
    expect(broker.get(e2e.id)?.reason).toMatch(/^waits for test-churn of server-stack to end: it starts many processes \(about 1,870 a minute\)/);
    expect(broker.get(e2e.id)?.reason).not.toMatch(MEMORY_WAIT);
    broker.release(churn.id);
    broker.tick(cap());
    expect(broker.get(e2e.id)?.state).toBe("granted");
  });

  it("keeps the queue order: a later browser test does not go before a spawn-heavy job that waits", () => {
    const { broker, ask, advance } = setup();
    const pools = { browser: 2 };
    const first = ask({ holder: "graph", job: "pnpm e2e", amounts: { browser: 1 } });
    broker.tick(cap(pools));
    advance(1000);
    const churn = ask({ holder: "server-stack", job: "test-churn" }, HEAVY);
    broker.tick(cap(pools));
    advance(1000);
    // The slot has room for a second browser test, but the spawn-heavy job waits first.
    const second = ask({ holder: "site", job: "playwright test" , amounts: { browser: 1 } });
    broker.tick(cap(pools));
    expect(broker.get(second.id)).toMatchObject({ state: "waiting", reason: expect.stringMatching(/^waits for test-churn of server-stack to run first and end:/) });
    broker.release(first.id);
    broker.tick(cap(pools));
    expect(broker.get(churn.id)?.state).toBe("granted");
    expect(broker.get(second.id)?.reason).toMatch(/^waits for test-churn of server-stack to end:/);
    broker.release(churn.id);
    broker.tick(cap(pools));
    expect(broker.get(second.id)?.state).toBe("granted");
  });

  it("keeps the queue order in the other direction: a later spawn-heavy job waits behind a browser test that waits", () => {
    const { broker, ask, advance } = setup();
    const running = ask({ holder: "graph", job: "pnpm e2e", amounts: { browser: 1 } });
    broker.tick(cap());
    advance(1000);
    const queued = ask({ holder: "site", job: "playwright test", amounts: { browser: 1 } });
    broker.tick(cap());
    expect(broker.get(queued.id)?.reason).toBe("waits for browser: needs 1, 0 free");
    advance(1000);
    const churn = ask({ holder: "server-stack", job: "test-churn" }, HEAVY);
    broker.tick(cap());
    broker.release(running.id);
    broker.tick(cap());
    expect(broker.get(queued.id)?.state).toBe("granted");
    expect(broker.get(churn.id)).toMatchObject({ state: "waiting", reason: expect.stringMatching(/^waits for the browser tests of site \(playwright test\) to end:/) });
  });

  it("runs two spawn-heavy jobs together, and two browser tests by the capacity of the slot", () => {
    const { broker, ask } = setup();
    const a = ask({ holder: "server-stack", job: "test-churn" }, HEAVY);
    const b = ask({ holder: "organizer", job: "site-audit-gates" }, HEAVY);
    broker.tick(cap());
    expect([broker.get(a.id)?.state, broker.get(b.id)?.state]).toEqual(["granted", "granted"]);
    broker.release(a.id);
    broker.release(b.id);
    const c = ask({ holder: "graph", job: "pnpm e2e", amounts: { browser: 1 } });
    const d = ask({ holder: "site", job: "playwright test", amounts: { browser: 1 } });
    broker.tick(cap());
    expect(broker.get(d.id)?.reason).toBe("waits for browser: needs 1, 0 free");
    broker.tick(cap({ browser: 2 }));
    expect([broker.get(c.id)?.state, broker.get(d.id)?.state]).toEqual(["granted", "granted"]);
  });

  it("takes the options of a request without a class from the engine", () => {
    const { broker, ask } = setup();
    ask({ holder: "graph", job: "pnpm e2e", amounts: { browser: 1 } });
    const opted = ask({ holder: "server-stack", job: "test-churn", spawnHeavy: false });
    const declared = ask({ holder: "organizer", job: "new-gates", spawnHeavy: true });
    broker.tick(cap());
    expect(broker.get(opted.id)).toMatchObject({ state: "granted", spawn: { heavy: false, source: "opted-out" } });
    expect(broker.get(declared.id)).toMatchObject({ state: "waiting", spawn: { heavy: true, source: "declared" } });
    expect(broker.get(declared.id)?.reason).toContain("(declared with --spawn-heavy)");
  });
});

const learned = (perMinute: number | null): SpawnClass => ({ heavy: false, source: "history", perMinute, runs: perMinute === null ? 0 : 3 });

describe("the sum of the start rates (H47)", () => {
  const rate = (each: Lease): number => leaseRate(each, null);
  const e2e = lease("e", { amounts: { browser: 1 } });
  const tsc = lease("t", { holder: "client", job: "tsc --noEmit", spawn: learned(400) });
  const vitest = lease("v", { holder: "vex", job: "vitest run", spawn: learned(300) });

  it("gives the rate of a lease: its own rate of the last 30 seconds, else its learned rate", () => {
    expect(leaseRate(lease("a"), null)).toBe(0);
    expect(leaseRate(lease("a", { spawn: learned(null) }), null)).toBe(0);
    expect(leaseRate(lease("a", { spawn: learned(400) }), null)).toBe(400);
    // A first run counts its live rate when it has two counts.
    expect(leaseRate(lease("a", { spawn: learned(null) }), 235.4)).toBe(235);
    expect(leaseRate(lease("a", { spawn: learned(400) }), 120)).toBe(120);
    // --no-spawn-heavy: the past runs do not count, but the live rate does.
    const optedOut: SpawnClass = { heavy: false, source: "opted-out", perMinute: 1870, runs: 3 };
    expect(leaseRate(lease("a", { spawn: optedOut }), null)).toBe(0);
    expect(leaseRate(lease("a", { spawn: optedOut }), 300)).toBe(300);
  });

  it("holds a browser test while the other leases together start more than the limit, and names them", () => {
    const reason = startsSumConflict(lease("e", { state: "waiting", amounts: { browser: 1 } }), [tsc, vitest], [], rate, 600);
    expect(reason).toBe(`${SUM_WAIT_START}: tsc --noEmit (client) 400 and vitest run (vex) 300 start 700 a minute together, above the limit of 600, and browsers can fail to start beside it`);
    expect(isSpawnWait(reason)).toBe(true);
    expect(reason).not.toMatch(MEMORY_WAIT);
    expect(startsSumConflict(lease("e", { state: "waiting", amounts: { browser: 1 } }), [tsc, vitest], [], rate, 700)).toBeNull();
    // Another browser test does not count in the sum.
    expect(startsSumConflict(lease("f", { state: "waiting", amounts: { browser: 1 } }), [e2e, tsc], [], rate, 300)).toBe(
      `${SUM_WAIT_START}: tsc --noEmit (client) starts 400 a minute, above the limit of 300, and browsers can fail to start beside it`,
    );
  });

  it("holds another lease that pushes the sum above the limit beside a browser test", () => {
    const next = lease("v", { state: "waiting", holder: "vex", job: "vitest run", spawn: learned(300) });
    const reason = startsSumConflict(next, [e2e, tsc], [], rate, 600);
    expect(reason).toBe(
      "waits for the browser tests of graph (pnpm e2e) to end: this job 300 and tsc --noEmit (client) 400 start 700 a minute together, above the limit of 600, and browsers can fail to start beside it",
    );
    expect(isSpawnWait(reason)).toBe(true);
    expect(startsSumConflict(next, [tsc], [], rate, 600)).toBeNull();
    expect(startsSumConflict(next, [e2e, tsc], [], rate, 700)).toBeNull();
    // A browser test that waits first counts as a browser test that runs.
    expect(startsSumConflict(next, [tsc], [lease("e", { state: "waiting", amounts: { browser: 1 } })], rate, 600)).toMatch(
      /^waits for the browser tests of graph \(pnpm e2e\) to run first and end: this job 300 and tsc --noEmit \(client\) 400/,
    );
    // A lease with no rate also waits while the sum is above the limit.
    expect(startsSumConflict(lease("n", { state: "waiting" }), [e2e, tsc, vitest], [], rate, 600)).toMatch(
      /: tsc --noEmit \(client\) 400 and vitest run \(vex\) 300 start 700 a minute together,/,
    );
  });
});

describe("Broker sum of the start rates (H47)", () => {
  function setup() {
    let now = 1_000_000;
    let next = 0;
    const broker = new Broker({
      now: () => now,
      newId: () => `l${++next}`,
      isAlive: () => true,
      reserveMb: 1000,
      conflict: spawnConflict,
      groupConflict: (each, granted, before) => startsSumConflict(each, granted, before, (one) => leaseRate(one, null), 600),
    });
    const ask = (request: Omit<LeaseRequest, "amounts"> & { amounts?: LeaseRequest["amounts"] }, spawn?: SpawnClass): Lease => {
      const asked = broker.request({ amounts: {}, ...request }, spawn);
      now += 1000;
      return asked;
    };
    return { broker, ask };
  }
  const cap = (availableMb = 12_000): Capacity => ({ totalMb: 16_000, availableMb, pools: {} });

  it("holds a browser test while moderate jobs together pass the limit, and grants it when the sum drops", () => {
    const { broker, ask } = setup();
    ask({ holder: "client", job: "tsc" }, learned(400));
    const vitest = ask({ holder: "vex", job: "vitest" }, learned(300));
    broker.tick(cap());
    const e2e = ask({ holder: "graph", job: "pnpm e2e", amounts: { browser: 1 } });
    broker.tick(cap());
    expect(broker.get(e2e.id)).toMatchObject({
      state: "waiting",
      reason: `${SUM_WAIT_START}: tsc (client) 400 and vitest (vex) 300 start 700 a minute together, above the limit of 600, and browsers can fail to start beside it`,
    });
    broker.release(vitest.id);
    broker.tick(cap());
    expect(broker.get(e2e.id)).toMatchObject({ state: "granted", reason: null });
  });

  it("holds a new job that pushes the sum above the limit while a browser test runs, and a later job does not go before it", () => {
    const { broker, ask } = setup();
    const e2e = ask({ holder: "graph", job: "pnpm e2e", amounts: { browser: 1 } });
    const tsc = ask({ holder: "client", job: "tsc" }, learned(400));
    broker.tick(cap());
    expect(broker.get(tsc.id)?.state).toBe("granted");
    const vitest = ask({ holder: "vex", job: "vitest" }, learned(300));
    broker.tick(cap());
    expect(broker.get(vitest.id)).toMatchObject({
      state: "waiting",
      reason: "waits for the browser tests of graph (pnpm e2e) to end: this job 300 and tsc (client) 400 start 700 a minute together, above the limit of 600, and browsers can fail to start beside it",
    });
    // 400 and 100 fit in the limit, but the earlier job that waits gets its part first.
    const small = ask({ holder: "site", job: "lint" }, learned(100));
    broker.tick(cap());
    expect(broker.get(small.id)).toMatchObject({
      state: "waiting",
      reason: "waits for the browser tests of graph (pnpm e2e) to end: this job 100, tsc (client) 400 and vitest (vex, queued) 300 start 800 a minute together, above the limit of 600, and browsers can fail to start beside it",
    });
    broker.release(e2e.id);
    broker.tick(cap());
    expect(broker.get(vitest.id)?.state).toBe("granted");
    expect(broker.get(small.id)?.state).toBe("granted");
  });

  it("does not let a later browser test go before an earlier job that waits for memory and needs the part", () => {
    const { broker, ask } = setup();
    const tsc = ask({ holder: "client", job: "tsc" }, learned(300));
    broker.tick(cap());
    const build = ask({ holder: "server-stack", job: "build", amounts: { memory: 12_000 } }, learned(400));
    broker.tick(cap());
    expect(broker.get(build.id)?.reason).toBe("waits for memory: needs 12000, 11000 free");
    const e2e = ask({ holder: "graph", job: "pnpm e2e", amounts: { browser: 1 } });
    broker.tick(cap());
    expect(broker.get(e2e.id)).toMatchObject({ state: "waiting", reason: expect.stringContaining(": build (server-stack, queued) 400 and tsc (client) 300 start 700 a minute together,") });
    // The earlier job gets its memory and runs. The sum is 700, so the browser test still waits.
    broker.tick(cap(14_000));
    expect(broker.get(build.id)?.state).toBe("granted");
    expect(broker.get(e2e.id)?.reason).toMatch(/: build \(server-stack\) 400 and tsc \(client\) 300 start 700/);
    broker.release(tsc.id);
    broker.tick(cap(14_000));
    expect(broker.get(e2e.id)?.state).toBe("granted");
  });
});

describe("Store spawn columns (H47)", () => {
  it("adds the columns of the peak starts and the class to a table of H29, and keeps its rows", () => {
    const path = join(mkdtempSync(join(tmpdir(), "headroom-spawn-")), "h29.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE leases (
      id TEXT PRIMARY KEY, holder TEXT NOT NULL, job TEXT NOT NULL, amounts TEXT NOT NULL,
      priority INTEGER NOT NULL, pid INTEGER, ttl_ms INTEGER NOT NULL, state TEXT NOT NULL,
      requested_at INTEGER NOT NULL, granted_at INTEGER, ended_at INTEGER, heartbeat_at INTEGER NOT NULL, reason TEXT,
      peak_mb REAL, usage TEXT, exit_code INTEGER, signal TEXT, log TEXT, processes INTEGER)`);
    // A run of 60 seconds with 1,800 processes, from before H47: its average is 1,800 a minute.
    old.exec(`INSERT INTO leases VALUES ('old1', 'server-stack', 'test-churn', '{}', 0, 42, 300000, 'released', 1000, 1000, 61000, 61000,
      'released', NULL, NULL, 0, NULL, NULL, 1800)`);
    old.close();
    const store = new Store(path);
    expect(store.lease("old1")).toMatchObject({ processes: 1800 });
    expect(store.lease("old1")?.peakStartsPerMin).toBeUndefined();
    expect(store.lease("old1")?.spawn).toBeUndefined();
    expect(store.startPeaksOf("test-churn")).toEqual([1800]);
    store.saveLease(lease("new1", { holder: "graph", job: "test-churn", state: "released", grantedAt: 70_000, endedAt: 90_000, processes: 10, peakStartsPerMin: 20, spawn: HEAVY }));
    expect(store.lease("new1")).toMatchObject({ peakStartsPerMin: 20, spawn: HEAVY });
    // The newest first. A holder gives only its own runs.
    expect(store.startPeaksOf("test-churn")).toEqual([20, 1800]);
    expect(store.startPeaksOf("test-churn", "graph")).toEqual([20]);
    expect(store.startPeaksOf("test-churn", undefined, 1)).toEqual([20]);
    // A lease that did not run, or a run with no count, gives no peak.
    store.saveLease(lease("never", { job: "test-churn", state: "cancelled", grantedAt: null, endedAt: 95_000 }));
    store.saveLease(lease("keep", { job: "test-churn", state: "released", grantedAt: 96_000, endedAt: 99_000 }));
    expect(store.startPeaksOf("test-churn")).toHaveLength(2);
    store.close();
  });
});

describe("Engine spawn rule (H47)", () => {
  const sampler: Sampler = {
    memory: () => ({ totalMb: 28_000, availableMb: 20_000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
    processes: () => [],
    close: () => undefined,
  };
  function setup() {
    let now = 1_000_000;
    const store = new Store(":memory:");
    const engine = new Engine({ sampler, store, now: () => now, sessionsDir: "/nowhere" });
    const past = (id: string, job: string, holder: string, peak: number): void =>
      store.saveLease(lease(id, { job, holder, state: "released", grantedAt: 0, endedAt: 100_000, processes: 1000, peakStartsPerMin: peak }));
    return { engine, store, past, advance: (ms: number) => (now += ms) };
  }
  const ttl = { ttlMs: 3_600_000 };

  it("keeps the peak starts of a lease from the counts of its heartbeats and of its release", () => {
    const { engine, advance } = setup();
    const job = engine.request({ holder: "client", job: "vitest", amounts: {}, ...ttl, spawnHeavy: false });
    advance(3000);
    expect(engine.renew(job.id, 40)?.peakStartsPerMin).toBe(80);
    advance(30_000);
    expect(engine.renew(job.id, 1000)?.peakStartsPerMin).toBe(1920);
    advance(30_000);
    // A slower window does not lower the peak.
    expect(engine.renew(job.id, 1100)?.peakStartsPerMin).toBe(1920);
    advance(7000);
    const ended = engine.release(job.id, "the job ended with code 0", null, undefined, { code: 0, signal: null }, 1150);
    expect(ended).toMatchObject({ state: "released", processes: 1150, peakStartsPerMin: 1920 });
    // --no-spawn-heavy: the job stays normal, also above the limit.
    expect(ended?.spawn).toMatchObject({ heavy: false, source: "opted-out" });
    // The average: 1,150 processes in 70 seconds.
    expect(engine.jobs({ query: job.id })[0]).toMatchObject({ peakStartsPerMin: 1920, averageStartsPerMin: 986, spawn: { heavy: false } });
    // The next run of the job learns the peak, and the option of a run still decides.
    expect(engine.spawnClass("vitest", "client")).toEqual({ heavy: true, source: "history", perMinute: 1920, runs: 1 });
  });

  it("learns a job name from its past runs, the runs of the same holder first, with the limit of the settings", () => {
    const { engine, past } = setup();
    expect(engine.spawnClass("test-churn", "server-stack")).toEqual({ heavy: false, source: "history", perMinute: null, runs: 0 });
    past("a", "test-churn", "server-stack", 1870);
    past("b", "test-churn", "server-stack", 400);
    past("c", "test-churn", "graph", 90);
    expect(engine.spawnClass("test-churn", "server-stack")).toEqual({ heavy: true, source: "history", perMinute: 1870, runs: 2 });
    expect(engine.spawnClass("test-churn", "graph")).toEqual({ heavy: false, source: "history", perMinute: 90, runs: 1 });
    expect(engine.spawnClass("test-churn", "organizer")).toMatchObject({ heavy: true, perMinute: 1870, runs: 3 });
    expect(engine.config().spawnHeavy).toBe(600);
    expect(engine.setConfig({ spawnHeavy: 2000 }).spawnHeavy).toBe(2000);
    expect(engine.spawnClass("test-churn", "server-stack").heavy).toBe(false);
    expect(() => engine.setConfig({ spawnHeavy: 0 })).toThrow(RangeError);
    expect(() => engine.setConfig({ spawnHeavy: 1.5 })).toThrow(RangeError);
    expect(engine.config().spawnHeavy).toBe(2000);
    expect(engine.setConfig({ spawnHeavy: null }).spawnHeavy).toBe(600);
  });

  it("holds a browser test behind a learned spawn-heavy job, and takes the options of the run", () => {
    const { engine, past } = setup();
    past("a", "test-churn", "server-stack", 1870);
    const churn = engine.request({ holder: "server-stack", job: "test-churn", amounts: {}, ...ttl });
    expect(churn).toMatchObject({ state: "granted", spawn: { heavy: true, source: "history", perMinute: 1870, runs: 1 } });
    const e2e = engine.request({ holder: "graph", job: "pnpm e2e", amounts: { browser: 1 }, ...ttl });
    expect(e2e.state).toBe("waiting");
    expect(e2e.reason).toBe("waits for test-churn of server-stack to end: it starts many processes (about 1,870 a minute), and browsers can fail to start beside it");
    engine.release(churn.id);
    expect(engine.get(e2e.id)?.state).toBe("granted");
    // --no-spawn-heavy: the job runs beside the browser test. --spawn-heavy: a new job waits.
    expect(engine.request({ holder: "server-stack", job: "test-churn", amounts: {}, ...ttl, spawnHeavy: false }).state).toBe("granted");
    const declared = engine.request({ holder: "organizer", job: "new-gates", amounts: {}, ...ttl, spawnHeavy: true });
    expect(declared).toMatchObject({ state: "waiting", spawn: { heavy: true, source: "declared" } });
    expect(declared.reason).toMatch(/^waits for the browser tests of graph \(pnpm e2e\) to end: this job starts many processes \(declared with --spawn-heavy\)/);
  });

  it("promotes a first run when its own rate goes above the limit, so a later browser test waits", () => {
    const { engine, advance } = setup();
    const first = engine.request({ holder: "organizer", job: "site-audit-gates", amounts: {}, ...ttl });
    expect(first.spawn).toEqual({ heavy: false, source: "history", perMinute: null, runs: 0 });
    advance(30_000);
    expect(engine.renew(first.id, 200)?.spawn?.heavy).toBe(false);
    // The job is normal: a browser test runs beside it.
    const beside = engine.request({ holder: "graph", job: "pnpm e2e", amounts: { browser: 1 }, ...ttl });
    expect(beside.state).toBe("granted");
    engine.release(beside.id);
    advance(30_000);
    // 462 starts in 30 seconds: 924 a minute, above the limit of 600.
    const promoted = engine.renew(first.id, 662);
    expect(promoted).toMatchObject({ peakStartsPerMin: 924, spawn: { heavy: true, source: "live", perMinute: 924 } });
    const later = engine.request({ holder: "site", job: "playwright test", amounts: { browser: 1 }, ...ttl });
    expect(later.state).toBe("waiting");
    expect(later.reason).toBe("waits for site-audit-gates of organizer to end: it starts many processes (about 924 a minute), and browsers can fail to start beside it");
    expect(engine.status().leases.find((each) => each.id === first.id)?.spawn?.source).toBe("live");
    expect(spawnLine(engine.status().leases)).toBe("Spawn-heavy now: site-audit-gates (organizer), 924 a minute. Browser tests wait until it ends.");
  });

  it("counts the live rate of a first run in the sum of the start rates, in each order", () => {
    const { engine, advance } = setup();
    const e2e = engine.request({ holder: "graph", job: "pnpm e2e", amounts: { browser: 1 }, ...ttl });
    const audit = engine.request({ holder: "organizer", job: "site-audit", amounts: {}, ...ttl });
    const tsc = engine.request({ holder: "client", job: "tsc", amounts: {}, ...ttl });
    // First runs with no past runs count 0, so they run beside the browser test.
    expect([e2e.state, audit.state, tsc.state]).toEqual(["granted", "granted", "granted"]);
    advance(30_000);
    expect(engine.renew(audit.id, 250)?.peakStartsPerMin).toBe(500);
    expect(engine.renew(tsc.id, 100)?.peakStartsPerMin).toBe(200);
    // Each job is below the limit, but together they start 700 a minute: a new job waits.
    const vitest = engine.request({ holder: "vex", job: "vitest", amounts: {}, ...ttl });
    expect(vitest).toMatchObject({
      state: "waiting",
      reason: "waits for the browser tests of graph (pnpm e2e) to end: site-audit (organizer) 500 and tsc (client) 200 start 700 a minute together, above the limit of 600, and browsers can fail to start beside it",
    });
    engine.release(e2e.id);
    expect(engine.get(vitest.id)?.state).toBe("granted");
    // In the other order, a new browser test waits for the sum.
    const later = engine.request({ holder: "site", job: "playwright test", amounts: { browser: 1 }, ...ttl });
    expect(later.reason).toBe(`${SUM_WAIT_START}: site-audit (organizer) 500 and tsc (client) 200 start 700 a minute together, above the limit of 600, and browsers can fail to start beside it`);
    // A higher limit runs the admission at once.
    engine.setConfig({ spawnHeavy: 800 });
    expect(engine.get(later.id)?.state).toBe("granted");
  });
});
