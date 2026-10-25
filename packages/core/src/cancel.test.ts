import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NO_REJOIN_REASON } from "./broker.ts";
import { Engine } from "./engine.ts";
import type { Sampler } from "./sampler.ts";
import { Store } from "./store.ts";

const MINUTE = 60_000;
/** A process ID that does not exist: a dead client. */
const DEAD = 2_000_000_011;

const sampler: Sampler = {
  memory: () => ({ totalMb: 28_000, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
  processes: () => [],
  close: () => undefined,
};

describe("Engine cancel (headroom cancel)", () => {
  const setup = () => {
    const clock = { now: 1_000_000 };
    let next = 0;
    const store = new Store(":memory:");
    const engine = new Engine({ sampler, store, now: () => clock.now, sessionsDir: "/nowhere" });
    // The slot docker is a lock of 1: the first lease runs, and the others wait. This process holds each lease.
    const ask = (holder: string, job: string) => {
      clock.now += 1000;
      next += 1;
      return engine.request({ holder, job, amounts: { docker: 1 }, pid: process.pid, priority: -next });
    };
    return { clock, store, engine, ask };
  };

  it("cancels a waiting lease by its id or its first 8 characters, records who, and ends the wait of its client", async () => {
    const { store, engine, ask } = setup();
    const runs = ask("graph", "docker build");
    const first = ask("jarvis", "pnpm test");
    const second = ask("jarvis", "pnpm lint");
    expect([runs.state, first.state, second.state]).toEqual(["granted", "waiting", "waiting"]);
    const wait = engine.waitFor(first.id, { timeoutMs: 60_000 });
    const result = engine.cancel({ id: first.id, by: "jarvis" });
    expect(result.cancelled.map((lease) => lease.id)).toEqual([first.id]);
    expect(await wait).toMatchObject({ state: "cancelled", cancelledBy: "jarvis", reason: "cancelled by jarvis (headroom cancel)" });
    expect(store.lease(first.id)).toMatchObject({ state: "cancelled", cancelledBy: "jarvis" });
    const prefix = engine.cancel({ id: second.id.slice(0, 8), by: "cli" });
    expect(prefix.cancelled).toMatchObject([{ id: second.id, cancelledBy: "cli" }]);
    expect(engine.get(runs.id)?.state).toBe("granted");
    engine.close();
  });

  it("cancels by job: one match, more than one with or without all, and the jobs of one holder", () => {
    const { engine, ask } = setup();
    ask("graph", "docker build");
    const a = ask("jarvis", "pnpm test");
    const b = ask("vex", "pnpm test");
    const c = ask("vex", "pnpm lint");
    expect(engine.cancel({ job: "pnpm lint", by: "vex" }).cancelled.map((lease) => lease.id)).toEqual([c.id]);
    // Two waiting matches: none is cancelled, and the result lists both.
    const both = engine.cancel({ job: "pnpm test", by: "cli" });
    expect(both.cancelled).toEqual([]);
    expect(both.matches.map((lease) => lease.id).sort()).toEqual([a.id, b.id].sort());
    expect(engine.get(a.id)?.state).toBe("waiting");
    // A holder keeps one match.
    expect(engine.cancel({ job: "pnpm test", holder: "vex", by: "vex" }).cancelled.map((lease) => lease.id)).toEqual([b.id]);
    const d = ask("vex", "pnpm test");
    expect(engine.cancel({ job: "pnpm test", all: true, by: "organizer" }).cancelled.map((lease) => lease.id).sort()).toEqual([a.id, d.id].sort());
    engine.close();
  });

  it("does not cancel a granted lease, gives an ended lease for its id, and refuses a wrong query", () => {
    const { engine, ask } = setup();
    const runs = ask("graph", "docker build");
    const result = engine.cancel({ job: "docker build", by: "cli" });
    expect(result.cancelled).toEqual([]);
    expect(result.matches).toMatchObject([{ id: runs.id, state: "granted" }]);
    engine.release(runs.id);
    expect(engine.cancel({ id: runs.id, by: "cli" }).matches).toMatchObject([{ id: runs.id, state: "released" }]);
    expect(engine.cancel({ id: "ffffffff-none", by: "cli" })).toEqual({ cancelled: [], matches: [] });
    expect(() => engine.cancel({ id: runs.id.slice(0, 7), by: "cli" })).toThrow(RangeError);
    expect(() => engine.cancel({ by: "cli" })).toThrow(RangeError);
    expect(() => engine.cancel({ id: runs.id, job: "docker build", by: "cli" })).toThrow(RangeError);
    engine.close();
  });
});

describe("Engine waiting leases of a dead client", () => {
  it("ends the waiting lease of a dead client of headroom run at the next tick, by its process", () => {
    let now = 1_000_000;
    const engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, sessionsDir: "/nowhere" });
    engine.request({ holder: "graph", job: "docker build", amounts: { docker: 1 }, pid: process.pid });
    const dead = engine.request({ holder: "jarvis", job: "pnpm test", amounts: { docker: 1 }, pid: DEAD });
    expect(engine.get(dead.id)).toMatchObject({ state: "expired", reason: "the process exited" });
    now += 2000;
    engine.tick();
    expect(engine.get(dead.id)?.state).toBe("expired");
    engine.close();
  });

  it("keeps a waiting lease with no process while its client waits, and ends it after its limit with no call", async () => {
    let now = 1_000_000;
    const engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, sessionsDir: "/nowhere" });
    engine.request({ holder: "graph", job: "docker build", amounts: { docker: 1 }, pid: process.pid });
    const waits = engine.request({ holder: "jarvis", job: "gate", amounts: { docker: 1 }, ttlMs: MINUTE });
    // Each call of resources.wait counts as a heartbeat.
    for (let step = 0; step < 5; step += 1) {
      now += 50_000;
      await engine.waitFor(waits.id, { timeoutMs: 1 });
      engine.tick();
    }
    expect(engine.get(waits.id)?.state).toBe("waiting");
    now += MINUTE + 1;
    engine.tick();
    expect(engine.get(waits.id)).toMatchObject({ state: "expired", reason: "no heartbeat" });
    engine.close();
  });

  it("gives the waiting leases of the store a new limit after a restart, and ends each one whose client does not come back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-rejoin-"));
    try {
      const path = join(dir, "headroom.db");
      let now = 1_000_000;
      const options = () => ({ sampler, store: new Store(path), now: () => now, sessionsDir: "/nowhere" });
      const first = new Engine(options());
      const runs = first.request({ holder: "graph", job: "docker build", amounts: { docker: 1 }, pid: process.pid });
      // This process stands in for two clients: one comes back after the restart, and one does not (its process ID went to another process).
      const back = first.request({ holder: "jarvis", job: "pnpm test", amounts: { docker: 1 }, pid: process.pid });
      const gone = first.request({ holder: "vex", job: "pnpm lint", amounts: { docker: 1 }, pid: process.pid });
      const quiet = first.request({ holder: "mcp", job: "tsc", amounts: { docker: 1 }, ttlMs: 2 * MINUTE });
      first.close();
      // A client that stopped while the daemon was stopped: its process does not run any more.
      const dead = { ...back, id: "dead-client", holder: "loom", job: "vitest", pid: DEAD };
      const store = new Store(path);
      store.saveLease(dead);
      store.close();
      // The daemon stays stopped for an hour: longer than each heartbeat limit.
      now += 60 * MINUTE;
      const second = new Engine(options());
      second.tick();
      expect(second.get(dead.id)).toMatchObject({ state: "expired", reason: "the process exited" });
      expect([back, gone, quiet].map((lease) => second.get(lease.id)?.state)).toEqual(["waiting", "waiting", "waiting"]);
      now += MINUTE;
      await second.waitFor(back.id, { timeoutMs: 1 });
      now += 2 * MINUTE + 1;
      second.tick();
      expect(second.get(quiet.id)).toMatchObject({ state: "expired", reason: NO_REJOIN_REASON });
      expect(second.get(gone.id)?.state).toBe("waiting");
      now += 3 * MINUTE;
      second.tick();
      expect(second.get(gone.id)).toMatchObject({ state: "expired", reason: NO_REJOIN_REASON });
      expect(second.get(back.id)?.state).toBe("waiting");
      expect(second.get(runs.id)?.state).toBe("granted");
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
