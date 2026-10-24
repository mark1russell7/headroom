import { describe, expect, it } from "vitest";
import { Broker } from "./broker.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseBootTime, parseMeminfo, parseStat } from "./linux.ts";
import { Store } from "./store.ts";

describe("Store", () => {
  it("keeps the leases, the pools and the samples", () => {
    const store = new Store(":memory:");
    const broker = new Broker({ now: () => 5000, newId: () => "l1" });
    const lease = broker.request({ holder: "graph", job: "build", amounts: { memory: 2000, docker: 1 }, pid: 42 });
    store.saveLease(lease);
    expect(store.activeLeases()).toEqual([lease]);
    store.saveLease({ ...lease, state: "released", endedAt: 6000, reason: "released" });
    expect(store.activeLeases()).toEqual([]);
    expect(store.endedLeases(0)[0]?.state).toBe("released");

    store.setPool("cpu", 8);
    store.setPool("docker", 1);
    store.setPool("docker", -1);
    expect(store.pools()).toEqual({ cpu: 8 });

    const memory = { totalMb: 28000, availableMb: 700, commitMb: 66000, commitLimitMb: 77000, kernelPagedMb: 2400, kernelNonpagedMb: 5000 };
    store.saveSample(1000, memory, [{ owner: "kernel", kind: "kernel", privateMb: 7400, workingMb: 7400, processes: 0 }]);
    expect(store.memorySince(0)).toEqual([{ at: 1000, ...memory, processes: null, userObjects: null, gdiObjects: null }]);
    expect(store.ownersSince(0)[0]?.owner).toBe("kernel");
    store.prune(2000);
    expect(store.memorySince(0)).toEqual([]);
    store.close();
  });

  it("keeps the settings, and the usage of an ended lease", () => {
    const store = new Store(":memory:");
    expect(store.config()).toEqual({ jobTemp: null });
    store.setConfig("jobTemp", "D:\\headroom\\tmp");
    expect(store.config()).toEqual({ jobTemp: "D:\\headroom\\tmp" });
    store.setConfig("jobTemp", null);
    expect(store.config()).toEqual({ jobTemp: null });

    const broker = new Broker({ now: () => 5000, newId: () => "l1" });
    const lease = broker.request({ holder: "graph", job: "test", amounts: { "disk:D:": 5120 } });
    store.saveLease(lease);
    expect(store.lease("l1")).toEqual(lease);
    expect(store.lease("l1")?.usage).toBeUndefined();
    store.saveLease({ ...lease, state: "released", endedAt: 6000, usage: { peakMb: 300, tempMb: 42.5 } });
    expect(store.lease("l1")?.usage).toEqual({ peakMb: 300, tempMb: 42.5 });
    expect(store.lease("l2")).toBeNull();
    store.close();
  });

  it("keeps the exit code, the signal and the log of a job (H26)", () => {
    const store = new Store(":memory:");
    let now = 5000;
    const broker = new Broker({ now: () => now, newId: () => "l1", isAlive: () => true });
    const lease = broker.request({ holder: "graph", job: "e2e", amounts: {}, pid: 42, log: "D:\\logs\\e2e.log" });
    store.saveLease(lease);
    expect(store.lease("l1")?.log).toBe("D:\\logs\\e2e.log");
    expect(store.lease("l1")?.exitCode).toBeUndefined();
    broker.tick({ totalMb: 1000, availableMb: 1000, pools: {} });
    now = 9000;
    const ended = broker.release("l1", "the job ended with code 1", 300, undefined, { code: 1, signal: null });
    if (ended) store.saveLease(ended);
    expect(store.lease("l1")).toEqual(ended);
    expect(store.lease("l1")).toMatchObject({ state: "released", exitCode: 1, log: "D:\\logs\\e2e.log" });
    expect(store.lease("l1")?.signal).toBeUndefined();
    const stopped = { ...lease, id: "l2", state: "released" as const, endedAt: 9000, signal: "SIGTERM" };
    store.saveLease(stopped);
    expect(store.lease("l2")).toEqual(stopped);
    store.close();
  });

  it("adds the columns of the exit and the log to an older table of leases, and keeps its rows", () => {
    const path = join(mkdtempSync(join(tmpdir(), "headroom-leases-")), "old.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE leases (
      id TEXT PRIMARY KEY, holder TEXT NOT NULL, job TEXT NOT NULL, amounts TEXT NOT NULL,
      priority INTEGER NOT NULL, pid INTEGER, ttl_ms INTEGER NOT NULL, state TEXT NOT NULL,
      requested_at INTEGER NOT NULL, granted_at INTEGER, ended_at INTEGER, heartbeat_at INTEGER NOT NULL, reason TEXT)`);
    old.exec(`INSERT INTO leases VALUES ('old1', 'graph', 'build', '{"memory":512}', 0, 42, 300000, 'released', 1000, 1500, 9000, 9000, 'released')`);
    old.close();
    const store = new Store(path);
    const kept = store.lease("old1");
    expect(kept).toMatchObject({ id: "old1", job: "build", state: "released", peakMb: null, endedAt: 9000 });
    expect(kept?.exitCode).toBeUndefined();
    expect(kept?.log).toBeUndefined();
    if (kept) store.saveLease({ ...kept, exitCode: 0, log: "D:\\logs\\build.log" });
    expect(store.lease("old1")).toMatchObject({ exitCode: 0, log: "D:\\logs\\build.log" });
    store.close();
  });

  it("finds the leases by an id prefix and by the job, and keeps the ended leases for their own time", () => {
    const store = new Store(":memory:");
    const base = { holder: "graph", job: "e2e", amounts: {}, priority: 0, pid: null, ttlMs: 300_000, grantedAt: null, heartbeatAt: 0, reason: null, peakMb: null };
    store.saveLease({ ...base, id: "aaaa1111-1", state: "released", requestedAt: 1000, endedAt: 2000 });
    store.saveLease({ ...base, id: "aaaa1111-2", state: "released", requestedAt: 3000, endedAt: 4000, holder: "vex" });
    store.saveLease({ ...base, id: "bbbb2222-1", state: "waiting", requestedAt: 5000, endedAt: null });
    expect(store.leasesByPrefix("aaaa1111").map((lease) => lease.id)).toEqual(["aaaa1111-2", "aaaa1111-1"]);
    expect(store.leasesByPrefix("aaaa1111-1").map((lease) => lease.id)).toEqual(["aaaa1111-1"]);
    expect(store.leasesByPrefix("a%")).toEqual([]);
    expect(store.leasesOfJob("e2e").map((lease) => lease.id)).toEqual(["bbbb2222-1", "aaaa1111-2", "aaaa1111-1"]);
    expect(store.leasesOfJob("e2e", { holder: "graph", limit: 1 }).map((lease) => lease.id)).toEqual(["bbbb2222-1"]);
    expect(store.leasesOfJob("e2e", { since: 3500 }).map((lease) => lease.id)).toEqual(["bbbb2222-1", "aaaa1111-2"]);
    store.prune(10_000, 3000);
    expect(store.leasesOfJob("e2e").map((lease) => lease.id)).toEqual(["bbbb2222-1", "aaaa1111-2"]);
    store.close();
  });
});

describe("Store pool tags", () => {
  it("keeps the snapshots of the tags of 1 MB or more, grouped by time", () => {
    const store = new Store(":memory:");
    store.savePoolTags(1000, [
      { tag: "DAL3", nonPagedMb: 270, pagedMb: 0 },
      { tag: "FMfn", nonPagedMb: 0, pagedMb: 470 },
      { tag: "Tiny", nonPagedMb: 0.4, pagedMb: 0.5 },
    ]);
    store.savePoolTags(2000, [
      { tag: "DAL3", nonPagedMb: 300, pagedMb: 0 },
      { tag: "Tiny", nonPagedMb: 0.6, pagedMb: 0.5 },
    ]);
    expect(store.poolTagsSince(0)).toEqual([
      { at: 1000, tags: new Map([["DAL3", 270], ["FMfn", 0]]), paged: new Map([["DAL3", 0], ["FMfn", 470]]) },
      { at: 2000, tags: new Map([["DAL3", 300], ["Tiny", 0.6]]), paged: new Map([["DAL3", 0], ["Tiny", 0.5]]) },
    ]);
    expect(store.poolTagsSince(1500).map((snapshot) => snapshot.at)).toEqual([2000]);

    // A snapshot removes the snapshots that are older than 2 hours.
    store.savePoolTags(1000 + 2 * 3_600_000 + 1, [{ tag: "DAL3", nonPagedMb: 310, pagedMb: 0 }]);
    expect(store.poolTagsSince(0).map((snapshot) => snapshot.at)).toEqual([2000, 1000 + 2 * 3_600_000 + 1]);
    store.prune(3000);
    expect(store.poolTagsSince(0).map((snapshot) => snapshot.at)).toEqual([1000 + 2 * 3_600_000 + 1]);
    store.close();
  });
});

describe("Store history with a step", () => {
  it("averages the samples of each step", () => {
    const store = new Store(":memory:");
    const memory = (availableMb: number) => ({ totalMb: 100, availableMb, commitMb: 50, commitLimitMb: 200, kernelPagedMb: 1, kernelNonpagedMb: 2 });
    const owner = (privateMb: number) => [{ owner: "session:a", kind: "session" as const, privateMb, workingMb: privateMb, processes: 3 }];
    // Four samples one minute apart: two in the first 2-minute step, two in the second.
    for (const [index, mb] of [10, 20, 30, 50].entries()) store.saveSample(index * 60_000, memory(mb), owner(mb));
    expect(store.memorySince(0, 120_000).map((row) => [row.at, row.availableMb])).toEqual([
      [0, 15],
      [120_000, 40],
    ]);
    expect(store.ownersSince(0, 120_000).map((row) => [row.at, row.owner, row.privateMb])).toEqual([
      [0, "session:a", 15],
      [120_000, "session:a", 40],
    ]);
    expect(store.memorySince(0)).toHaveLength(4);
    store.close();
  });

  it("averages the resource samples of each instance in each step", () => {
    const store = new Store(":memory:");
    const memory = { totalMb: 100, availableMb: 50, commitMb: 50, commitLimitMb: 200, kernelPagedMb: 1, kernelNonpagedMb: 2 };
    for (const [index, free] of [100, 80, 60, 20].entries()) {
      store.saveSample(index * 60_000, memory, [], undefined, [
        { id: "disk:D:", capacity: 200, used: 200 - free, free },
        { id: "cpu", capacity: 16, used: null, free: null },
      ]);
    }
    expect(store.resourcesSince(0, 120_000).map((row) => [row.at, row.id, row.used, row.free])).toEqual([
      [0, "cpu", null, null],
      [0, "disk:D:", 110, 90],
      [120_000, "cpu", null, null],
      [120_000, "disk:D:", 160, 40],
    ]);
    expect(store.resourcesSince(0)).toHaveLength(8);
    store.close();
  });
});

describe("the Linux parsers", () => {
  it("reads /proc/meminfo", () => {
    const text = "MemTotal:       16384000 kB\nMemAvailable:    2048000 kB\nCommitted_AS:   20480000 kB\nCommitLimit:    24576000 kB\nSReclaimable:    102400 kB\nSUnreclaim:      51200 kB\nKernelStack:     10240 kB\nPageTables:      40960 kB\n";
    expect(parseMeminfo(text)).toEqual({ totalMb: 16000, availableMb: 2000, commitMb: 20000, commitLimitMb: 24000, kernelPagedMb: 100, kernelNonpagedMb: 100 });
  });

  it("reads a stat line whose name has spaces and parentheses", () => {
    expect(parseStat("1234 (my (odd) name) S 99 1234 1234 0 -1")).toEqual({ ppid: 99, name: "my (odd) name" });
    expect(parseStat("garbage")).toBeNull();
  });

  it("reads the processor time and the start of a stat line, and the start of the computer", () => {
    const line = "77 (node) S 1 77 77 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 11 0 360000 1000000 5000";
    expect(parseStat(line)).toEqual({ ppid: 1, name: "node", cpuTicks: 300, startTicks: 360_000 });
    expect(parseBootTime("cpu  1 2 3\nbtime 1761300000\nprocesses 99\n")).toBe(1_761_300_000_000);
    expect(parseBootTime("cpu  1 2 3\n")).toBeUndefined();
  });
});

describe("Store writes of the owners", () => {
  it("keeps the MB that each owner wrote each minute, also for an owner with no process, and adds the column to an older database", () => {
    const path = join(mkdtempSync(join(tmpdir(), "headroom-writes-")), "old.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE owners (
      at INTEGER NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL,
      private_mb INTEGER, working_mb INTEGER, processes INTEGER, PRIMARY KEY (at, owner))`);
    old.exec("INSERT INTO owners VALUES (1000, 'docker', 'docker', 900, 900, 3)");
    old.close();
    const store = new Store(path);
    const memory = { totalMb: 28000, availableMb: 9000, commitMb: 30000, commitLimitMb: 80000, kernelPagedMb: 900, kernelNonpagedMb: 1000 };
    const owners = [{ owner: "session:graph", kind: "session" as const, privateMb: 800, workingMb: 700, processes: 4 }];
    const writes = new Map([["session:graph", { kind: "session" as const, mb: 512.25 }], ["mcp:vex", { kind: "mcp" as const, mb: 3 }]]);
    store.saveSample(61_000, memory, owners, undefined, [], writes);
    expect(store.ownersSince(0)).toEqual([
      { at: 1000, owner: "docker", kind: "docker", privateMb: 900, workingMb: 900, processes: 3 },
      { at: 61_000, owner: "session:graph", kind: "session", privateMb: 800, workingMb: 700, processes: 4, writeMb: 512.25 },
      { at: 61_000, owner: "mcp:vex", kind: "mcp", privateMb: 0, workingMb: 0, processes: 0, writeMb: 3 },
    ]);
    expect(store.writesSince(0)).toEqual([
      { at: 61_000, owner: "mcp:vex", kind: "mcp", amount: 3 },
      { at: 61_000, owner: "session:graph", kind: "session", amount: 512.25 },
    ]);
    store.close();
  });
});
