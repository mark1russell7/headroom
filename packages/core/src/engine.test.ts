import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_RULES } from "./alerts.ts";
import { Engine } from "./engine.ts";
import type { Sampler } from "./sampler.ts";
import { Store } from "./store.ts";
import type { PoolTag, ProcessInfo } from "./types.ts";

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

  it("gives the state of a job with its exit code, and keeps an ended lease 7 days with a shorter retention (H26)", () => {
    let now = 1_000_000;
    const day = 24 * 3_600_000;
    const engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, retentionMs: 3_600_000, sessionsDir: "/nowhere" });
    const lease = engine.request({ holder: "graph", job: "graph-e2e", amounts: {}, ttlMs: 60_000, log: "D:\\logs\\e2e.log" });
    expect(engine.jobs({ query: "graph-e2e" })).toMatchObject([{ id: lease.id, state: "running", exitCode: null, log: "D:\\logs\\e2e.log" }]);
    now += 60_000;
    engine.release(lease.id, "the job ended with code 1", 512, undefined, { code: 1, signal: null });
    expect(engine.jobs({ query: lease.id })).toMatchObject([{ state: "exited", exitCode: 1, ranMs: 60_000, peakMb: 512 }]);
    now += 6 * day;
    engine.tick();
    expect(engine.jobs({ query: "graph-e2e" })).toHaveLength(1);
    now += 2 * day;
    engine.tick();
    expect(engine.jobs({ query: "graph-e2e" })).toEqual([]);
    engine.close();
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

describe("Engine pool tags after a restart", () => {
  it("continues the window of the snapshots from the store", () => {
    let now = 1_000_000;
    let tags: PoolTag[] = [{ tag: "DAL3", nonPagedMb: 270, pagedMb: 10 }];
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
      processes: () => [],
      poolTags: () => tags,
      close: () => undefined,
    };
    const path = join(mkdtempSync(join(tmpdir(), "headroom-tags-")), "tags.db");
    const first = new Engine({ sampler, store: new Store(path), now: () => now, sessionsDir: "/nowhere" });
    first.tick();
    expect(first.poolTags().at).toBe(1_000_000);
    first.close();

    now += 60_000;
    const second = new Engine({ sampler, store: new Store(path), now: () => now, sessionsDir: "/nowhere" });
    expect(second.poolTags()).toMatchObject({ at: 1_000_000, sinceAt: 1_000_000 });
    second.tick();
    // The last snapshot is 1 minute old, so the second engine takes no snapshot at once.
    expect(second.poolTags().at).toBe(1_000_000);

    now += 5 * 60_000;
    tags = [{ tag: "DAL3", nonPagedMb: 400, pagedMb: 30 }];
    second.tick();
    expect(second.poolTags()).toMatchObject({
      at: now,
      sinceAt: 1_000_000,
      growing: [{ tag: "DAL3", nonPagedMb: 400, growthMb: 130 }],
      pagedGrowing: [{ tag: "DAL3", pagedMb: 30, growthMb: 20 }],
    });
    second.close();
  });
});

describe("Engine disks", () => {
  it("gives the loss of free space over the last hour, and names the new large files in a disk alert", () => {
    let now = 1_000_000;
    let freeMb = 300_000;
    let searches = 0;
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
      processes: () => [],
      disks: () => [
        { mount: "C:", freeMb, totalMb: 974_848 },
        { mount: "D:", freeMb: 125_000, totalMb: 200_000 },
      ],
      close: () => undefined,
    };
    const largeFiles = (mounts: readonly string[]) => {
      searches++;
      expect(mounts).toEqual(["C:"]);
      return [
        { path: "C:\\Users\\markt\\pool.etl", mb: 98_304, modifiedAt: now },
        { path: "D:\\big.iso", mb: 4096, modifiedAt: now },
      ];
    };
    const engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, sessionsDir: "/nowhere", largeFiles });
    engine.tick();
    expect(engine.status().disks).toEqual([
      { mount: "C:", freeMb: 300_000, totalMb: 974_848, dropMbPerHour: 0 },
      { mount: "D:", freeMb: 125_000, totalMb: 200_000, dropMbPerHour: 0 },
    ]);

    // 50 000 MB less in 30 minutes is 100 000 MB in one hour.
    now += 30 * 60_000;
    freeMb = 250_000;
    engine.tick();
    expect(engine.status().disks[0]?.dropMbPerHour).toBe(100_000);
    expect(engine.alerts().active).toEqual([]);
    expect(searches).toBe(0);

    now += 30 * 60_000;
    freeMb = 4300;
    engine.tick();
    expect(engine.status().disks[0]?.dropMbPerHour).toBe(295_700);
    const [alert] = engine.alerts().active;
    expect(alert).toMatchObject({ id: "disk:C:", kind: "disk", severity: "critical", mb: 4300 });
    expect(alert?.message).toBe("Drive C: has 4.2 GB free of 952 GB, 289 GB less than one hour ago. New large files: C:\\Users\\markt\\pool.etl (96 GB).");

    // The search for large files runs at most one time in 5 minutes.
    now += 2 * 60_000;
    engine.tick();
    expect(searches).toBe(1);

    // The oldest readings leave the window, and free space that grows is no loss.
    now += 10 * 60_000;
    freeMb = 400_000;
    engine.tick();
    expect(engine.status().disks[0]?.dropMbPerHour).toBe(0);
    expect(engine.alerts().active).toEqual([]);
    expect(engine.alerts().ended[0]?.id).toBe("disk:C:");
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

describe("Engine cpu", () => {
  const sampler: Sampler = {
    memory: () => ({ totalMb: 28_000, availableMb: 20_000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
    processes: () => [],
    close: () => undefined,
  };

  it("grants --cpu 2 with no pool cpu, and a pool cpu of 1 cancels it", () => {
    const engine = new Engine({ sampler, store: new Store(":memory:"), sessionsDir: "/nowhere", processors: 16 });
    const lease = engine.request({ holder: "graph", job: "cpu smoke", amounts: { cpu: 2, memory: 100 }, ttlMs: 60_000 });
    expect(lease.state).toBe("granted");
    expect(engine.status().free).toMatchObject({ cpu: 14, memory: 20_000 - 1024 - 100 });
    engine.release(lease.id);
    engine.setPool("cpu", 1);
    const capped = engine.request({ holder: "graph", job: "cpu smoke", amounts: { cpu: 2 }, ttlMs: 60_000 });
    expect(capped.state).toBe("cancelled");
    expect(capped.reason).toBe("cpu: 2 is more than the capacity of 1");
    engine.close();
  });
});

describe("Engine resources", () => {
  it("gives the level of each resource instance in the status, and keeps it in the store each minute", () => {
    let now = 1_000_000;
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
      processes: () => [],
      gui: () => ({ userObjects: 2000, gdiObjects: 3000 }),
      disks: () => [{ mount: "C:", freeMb: 265_000, totalMb: 774_000 }, { mount: "D:", freeMb: 125_000, totalMb: 200_000 }],
      close: () => undefined,
    };
    const store = new Store(":memory:");
    const engine = new Engine({ sampler, store, now: () => now, sessionsDir: "/nowhere", processors: 16 });
    engine.request({ holder: "graph", job: "browse", amounts: { browser: 1 }, ttlMs: 600_000 });
    engine.tick();
    const status = engine.status();
    expect(status.resources).toEqual([
      { id: "memory", kind: "memory", unit: "MB", capacity: 28_000, used: 19_000, free: 9000, owners: [] },
      { id: "commit", kind: "commit", unit: "MB", capacity: 80_000, used: 30_000, free: 50_000, owners: [] },
      { id: "pool:nonpaged", kind: "pool", unit: "MB", capacity: null, used: 1000, free: null, owners: [] },
      { id: "pool:paged", kind: "pool", unit: "MB", capacity: null, used: 900, free: null, owners: [] },
      { id: "desktop", kind: "desktop", unit: "count", capacity: null, used: 0, free: null, owners: [] },
      { id: "disk:C:", kind: "disk", unit: "MB", capacity: 774_000, used: 509_000, free: 265_000, owners: [] },
      { id: "disk:D:", kind: "disk", unit: "MB", capacity: 200_000, used: 75_000, free: 125_000, owners: [] },
      { id: "cpu", kind: "cpu", unit: "cores", capacity: 16, used: null, free: null, owners: [] },
      { id: "browser", kind: "slot", unit: "count", capacity: 1, used: 1, free: 0, owners: [] },
    ]);
    // The fields of before stay. `free` gets the processors and the drives, less their reserve.
    expect(status.free).toEqual({ browser: 0, cpu: 16, "disk:C:": 265_000 - 5120, "disk:D:": 125_000 - 5120, memory: 9000 - 1024 });
    expect(status.memory.availableMb).toBe(9000);
    expect(status.reserveMb).toBe(1024);
    const rows = store.resourcesSince(0);
    expect(rows.map((row) => row.id)).toEqual(status.resources.map((each) => each.id).sort());
    expect(rows.find((row) => row.id === "cpu")).toEqual({ at: now, id: "cpu", capacity: 16, used: null, free: null });
    now += 30_000;
    engine.tick();
    expect(store.resourcesSince(0)).toHaveLength(rows.length);
    now += 31_000;
    engine.tick();
    expect(store.resourcesSince(now)).toHaveLength(rows.length);
    // The history gives the points of each instance by id. The fields of before stay.
    const history = engine.history(0);
    expect(Object.keys(history.resources).sort()).toEqual(status.resources.map((each) => each.id).sort());
    expect(history.resources["disk:D:"]).toEqual([
      [now - 61_000, 75_000, 125_000],
      [now, 75_000, 125_000],
    ]);
    expect(history.resources["cpu"]?.[0]).toEqual([now - 61_000, null, null]);
    expect(history.memory).toHaveLength(2);
    // With a step, each point is the average of one step.
    expect(engine.history(0, 3_600_000).resources["memory"]).toHaveLength(1);
    engine.close();
  });

  it("adds the table of the resource samples to an older database", () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-resources-"));
    const path = join(dir, "old.db");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE memory (at INTEGER PRIMARY KEY, total_mb INTEGER, available_mb INTEGER, commit_mb INTEGER, commit_limit_mb INTEGER, kernel_paged_mb INTEGER, kernel_nonpaged_mb INTEGER)");
    old.close();
    const store = new Store(path);
    store.saveSample(5, { totalMb: 1, availableMb: 1, commitMb: 1, commitLimitMb: 1, kernelPagedMb: 1, kernelNonpagedMb: 1 }, [], undefined, [{ id: "memory", capacity: 1, used: 0, free: 1 }]);
    expect(store.resourcesSince(0)).toEqual([{ at: 5, id: "memory", capacity: 1, used: 0, free: 1 }]);
    store.prune(6);
    expect(store.resourcesSince(0)).toEqual([]);
    store.close();
  });
});

describe("Engine disk leases and temp folders", () => {
  const sampler: Sampler = {
    memory: () => ({ totalMb: 28_000, availableMb: 20_000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
    processes: () => [],
    disks: () => [{ mount: "D:", freeMb: 20_000, totalMb: 200_000 }],
    close: () => undefined,
  };

  it("admits a disk lease on the measured free space, less the critical limit of the disk alert", () => {
    const alertRules = { ...DEFAULT_ALERT_RULES, diskCriticalMb: 8192 };
    const engine = new Engine({ sampler, store: new Store(":memory:"), sessionsDir: "/nowhere", alertRules });
    engine.tick();
    expect(engine.status().free["disk:D:"]).toBe(11_808);
    const fits = engine.request({ holder: "a", job: "trace", amounts: { "disk:D:": 11_000 }, ttlMs: 60_000 });
    const waits = engine.request({ holder: "b", job: "test", amounts: { "disk:D:": 1000 }, ttlMs: 60_000 });
    const never = engine.request({ holder: "c", job: "image", amounts: { "disk:Q:": 1000 }, ttlMs: 60_000 });
    expect(fits.state).toBe("granted");
    expect(waits.reason).toBe("waits for disk:D:: needs 1000, 808 free");
    expect(never.state).toBe("cancelled");
    engine.close();
  });

  it("removes the temp folders of the ended leases of the store, and keeps each other folder", () => {
    const root = mkdtempSync(join(tmpdir(), "headroom-sweep-"));
    try {
      const engine = new Engine({ sampler, store: new Store(":memory:"), sessionsDir: "/nowhere" });
      expect(() => engine.setConfig("jobTemp", "relative\\tmp")).toThrow(/absolute path/);
      expect(engine.sweepJobTemp()).toEqual([]);
      expect(engine.setConfig("jobTemp", root)).toEqual({ jobTemp: root });
      const ended = engine.request({ holder: "a", job: "test", amounts: {}, ttlMs: 60_000 });
      const active = engine.request({ holder: "b", job: "test", amounts: {}, ttlMs: 60_000 });
      engine.release(ended.id, "the job ended", null, { tempMb: 0 });
      for (const name of [ended.id, active.id, "not-a-lease-of-the-store"]) mkdirSync(join(root, name));
      expect(engine.sweepJobTemp()).toEqual([ended.id]);
      expect(existsSync(join(root, ended.id))).toBe(false);
      expect(existsSync(join(root, active.id))).toBe(true);
      expect(existsSync(join(root, "not-a-lease-of-the-store"))).toBe(true);
      expect(engine.history(0).leases[0]?.usage).toEqual({ tempMb: 0 });
      engine.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Engine writes and processor use of the owners", () => {
  it("names the owners that write most, gives the cores of each owner, and continues the hour after a restart", () => {
    const sessions = mkdtempSync(join(tmpdir(), "headroom-sessions-"));
    writeFileSync(join(sessions, "100.json"), JSON.stringify({ pid: 100, name: "graph", sessionId: "s-graph" }));
    let now = 1_000_000;
    let step = 0;
    const MB = 1024 * 1024;
    const proc = (pid: number, ppid: number, name: string, writeMb: number, cpuMs: number): ProcessInfo => ({
      pid, ppid, name, privateMb: 100, workingMb: 100, startedAt: 1000, cpuMs, writeBytes: writeMb * MB,
    });
    // Each read is 10 seconds later. The test of graph writes 1 GB and uses 2 cores. The MCP server writes 50 MB and uses 0.4 cores.
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
      processes: () => [proc(100, 1, "claude.exe", 0, 0), proc(101, 100, "node.exe", step * 1024, step * 20_000), proc(200, 1, "node.exe", step * 50, step * 4000)],
      disks: () => [{ mount: "C:", freeMb: 4300, totalMb: 974_848 }],
      close: () => undefined,
    };
    const store = new Store(":memory:");
    const options = { sampler, store, now: () => now, sessionsDir: sessions, processors: 16, servers: () => new Map([[200, "vex"]]), largeFiles: () => [] };
    try {
      const engine = new Engine(options);
      engine.tick();
      expect(engine.status().writes).toEqual([]);
      for (step = 1; step <= 6; step++) {
        now += 10_000;
        engine.tick();
      }
      const status = engine.status();
      expect(status.writes).toEqual([
        { owner: "session:graph", kind: "session", mbPerMin: 6144, mbLastHour: 6144 },
        { owner: "mcp:vex", kind: "mcp", mbPerMin: 300, mbLastHour: 300 },
      ]);
      const cpu = status.resources.find((each) => each.id === "cpu");
      expect(cpu).toMatchObject({ capacity: 16, used: 2.4, free: 13.6 });
      expect(cpu?.owners).toEqual([
        { owner: "session:graph", kind: "session", value: 2, unit: "cores" },
        { owner: "mcp:vex", kind: "mcp", value: 0.4, unit: "cores" },
      ]);
      expect(status.resources.find((each) => each.id === "disk:C:")?.owners[0]).toEqual({ owner: "session:graph", kind: "session", value: 6144, unit: "MB/h" });
      expect(status.resources.find((each) => each.id === "memory")?.owners[0]).toMatchObject({ owner: "session:graph", unit: "MB", value: 200 });
      expect(engine.alerts().active[0]?.message).toBe("Drive C: has 4.2 GB free of 952 GB. Most writes in the last hour: session:graph 6 GB, mcp:vex 300 MB.");
      expect(store.writesSince(0)).toEqual([
        { at: 1_060_000, owner: "mcp:vex", kind: "mcp", amount: 300 },
        { at: 1_060_000, owner: "session:graph", kind: "session", amount: 6144 },
      ]);

      // A new engine reads the writes of the last hour from the store.
      now += 5 * 60_000;
      const restarted = new Engine(options);
      expect(restarted.status().writes).toEqual([
        { owner: "session:graph", kind: "session", mbPerMin: 0, mbLastHour: 6144 },
        { owner: "mcp:vex", kind: "mcp", mbPerMin: 0, mbLastHour: 300 },
      ]);
      restarted.close();
    } finally {
      rmSync(sessions, { recursive: true, force: true });
    }
  });
});

describe("Engine network and ports", () => {
  it("measures the network and the dynamic ports, and gives the listening ports with their processes (H24)", () => {
    let now = 1_000_000;
    let bytes = 0;
    const MiB = 1024 * 1024;
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 20_000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
      processes: () => [{ pid: 4242, ppid: 1, name: "node.exe", privateMb: 100, workingMb: 100 }],
      network: () => [{ name: "Wi-Fi", inBytes: (bytes += 10 * MiB), outBytes: bytes / 2, inBitsPerSecond: null, outBitsPerSecond: null }],
      tcp: () => ({
        dynamic: { first: 49_152, count: 16_384 },
        connections: [
          { localPort: 5173, state: "listen", pid: 4242, address: "::1" },
          { localPort: 50_000, state: "time-wait", pid: 0 },
        ],
      }),
      close: () => undefined,
    };
    const engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, sessionsDir: "/nowhere" });
    expect(engine.ports()).toEqual({ at: null, dynamic: null, listening: [] });
    engine.tick();
    now += 10_000;
    engine.tick();
    const status = engine.status();
    const network = status.resources.filter((each) => each.kind === "net" || each.kind === "ports");
    expect(network.map((each) => [each.id, each.unit, each.capacity, each.used])).toEqual([
      ["net:in", "MB/s", null, 1],
      ["net:out", "MB/s", null, 0.5],
      ["ports:tcp", "count", 16_384, 1],
    ]);
    expect(status.tcp).toEqual({ connections: 1, timeWait: 1, listening: 1 });
    expect(engine.ports()).toMatchObject({ at: now, dynamic: { first: 49_152, count: 16_384 }, listening: [{ port: 5173, addresses: ["::1"], pid: 4242, name: "node.exe" }] });
    engine.close();
  });

  it("continues the tick when a read of the network fails", () => {
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 20_000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
      processes: () => [],
      network: () => {
        throw new Error("GetIfTable2 failed");
      },
      tcp: () => {
        throw new Error("GetExtendedTcpTable failed");
      },
      close: () => undefined,
    };
    const engine = new Engine({ sampler, store: new Store(":memory:"), sessionsDir: "/nowhere" });
    engine.tick();
    const status = engine.status();
    expect(status.tcp).toBeNull();
    expect(status.resources.some((each) => each.kind === "net" || each.kind === "ports")).toBe(false);
    engine.close();
  });
});
