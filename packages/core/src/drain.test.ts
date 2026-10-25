import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localClock } from "./conditions.ts";
import { Engine, type EngineOptions } from "./engine.ts";
import { REBOOT_KEYS, type KeyState } from "./reboot.ts";
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
