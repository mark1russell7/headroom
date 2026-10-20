import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_RULES } from "./alerts.ts";
import { Engine } from "./engine.ts";
import type { Sampler } from "./sampler.ts";
import { Store } from "./store.ts";
import type { PoolTag } from "./types.ts";

describe("Engine stop alerts", () => {
  it("flags clients of headroom run that stop without a release, for 15 minutes", () => {
    let now = 1_000_000;
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
      processes: () => [],
      close: () => undefined,
    };
    const engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, sessionsDir: "/nowhere" });
    // Process IDs that do not exist: the broker ends each lease at once, as after a stop of its client.
    engine.request({ holder: "client", job: "vitest", amounts: {}, pid: 2_000_000_001 });
    expect(engine.alerts().active).toEqual([]);
    engine.request({ holder: "jarvis", job: "tsc", amounts: {}, pid: 2_000_000_003 });
    const [alert] = engine.alerts().active;
    expect(alert).toMatchObject({ id: "stop:clients", kind: "stop" });
    expect(alert?.message).toContain("2 clients of headroom run stopped without a release in 2 minutes (holders: client, jarvis)");
    now += 16 * 60_000;
    engine.tick();
    expect(engine.alerts().active).toEqual([]);
    expect(engine.alerts().ended[0]?.id).toBe("stop:clients");
    engine.close();
  });
});

describe("Engine suggest", () => {
  const sampler: Sampler = {
    memory: () => ({ totalMb: 28_000, availableMb: 20_000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
    processes: () => [],
    close: () => undefined,
  };

  it("sizes a job from the peaks of its last runs, the runs of the same holder first", () => {
    const engine = new Engine({ sampler, store: new Store(":memory:"), sessionsDir: "/nowhere" });
    expect(engine.suggest("pnpm test", "graph")).toEqual({ memoryMb: null, runs: 0, peakMb: null });
    const run = (holder: string, peakMb: number) => {
      const lease = engine.request({ holder, job: "pnpm test", amounts: { memory: 512 }, ttlMs: 60_000 });
      engine.release(lease.id, "the job ended", peakMb);
    };
    for (const peak of [400, 420, 900, 410]) run("graph", peak);
    run("client", 3000);
    // The runs of graph: the 90th percentile is 900 MB, and 25% more is 1125 MB, rounded up to 1152 MB.
    expect(engine.suggest("pnpm test", "graph")).toEqual({ memoryMb: 1152, runs: 4, peakMb: 900 });
    // A holder with no run of its own uses the runs of all holders.
    expect(engine.suggest("pnpm test", "vex")).toMatchObject({ runs: 5, peakMb: 3000 });
    engine.close();
  });

  it("keeps the peak of a lease in the store, and adds the column to an older database", () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-store-"));
    const path = join(dir, "old.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE leases (
      id TEXT PRIMARY KEY, holder TEXT NOT NULL, job TEXT NOT NULL, amounts TEXT NOT NULL,
      priority INTEGER NOT NULL, pid INTEGER, ttl_ms INTEGER NOT NULL, state TEXT NOT NULL,
      requested_at INTEGER NOT NULL, granted_at INTEGER, ended_at INTEGER, heartbeat_at INTEGER NOT NULL, reason TEXT)`);
    old.close();
    const engine = new Engine({ sampler, store: new Store(path), sessionsDir: "/nowhere" });
    const lease = engine.request({ holder: "graph", job: "tsc", amounts: {}, ttlMs: 60_000 });
    engine.release(lease.id, "the job ended", 640);
    engine.close();
    const reopened = new Store(path);
    expect(reopened.peaksOf("tsc")).toEqual([640]);
    reopened.close();
  });
});

describe("Engine pool tags", () => {
  it("names the pool tag that grows in the pool alert", () => {
    let now = 1_000_000;
    let tags: PoolTag[] = [
      { tag: "DAL3", nonPagedMb: 270, pagedMb: 0 },
      { tag: "File", nonPagedMb: 80, pagedMb: 0 },
    ];
    let nonPagedMb = 1000;
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: nonPagedMb }),
      processes: () => [],
      poolTags: () => tags,
      close: () => undefined,
    };
    const engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, sessionsDir: "/nowhere", alertRules: { ...DEFAULT_ALERT_RULES, poolMb: 1200 } });
    engine.tick();
    expect(engine.alerts().active).toEqual([]);

    now += 6 * 60_000;
    tags = [
      { tag: "DAL3", nonPagedMb: 570, pagedMb: 0 },
      { tag: "File", nonPagedMb: 82, pagedMb: 0 },
    ];
    nonPagedMb = 1300;
    engine.tick();
    expect(engine.poolTags().pagedGrowing).toEqual([]);
    expect(engine.poolTags().growing.map((row) => [row.tag, row.growthMb])).toEqual([
      ["DAL3", 300],
      ["File", 2],
    ]);
    const [alert] = engine.alerts().active;
    expect(alert?.kind).toBe("pool");
    expect(alert?.message).toContain("The tags that grow: DAL3 +300 MB, File +2 MB.");
    engine.close();
  });
});

describe("Engine paged pool tags", () => {
  it("names the paged tag that grows in the paged pool alert", () => {
    let now = 1_000_000;
    let tags: PoolTag[] = [{ tag: "FMfn", nonPagedMb: 0, pagedMb: 470 }];
    let pagedMb = 3000;
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: pagedMb, kernelNonpagedMb: 1000 }),
      processes: () => [],
      poolTags: () => tags,
      close: () => undefined,
    };
    const engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, sessionsDir: "/nowhere", alertRules: { ...DEFAULT_ALERT_RULES, pagedMb: 3500 } });
    engine.tick();
    now += 6 * 60_000;
    tags = [{ tag: "FMfn", nonPagedMb: 0, pagedMb: 816 }];
    pagedMb = 3600;
    engine.tick();
    expect(engine.poolTags().pagedGrowing).toEqual([{ tag: "FMfn", pagedMb: 816, growthMb: 346 }]);
    const [alert] = engine.alerts().active;
    expect(alert?.id).toBe("pool:paged");
    expect(alert?.message).toContain("The tags that grow: FMfn +346 MB.");
    engine.close();
  });
});
