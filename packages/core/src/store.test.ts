import { describe, expect, it } from "vitest";
import { Broker } from "./broker.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseBootTime, parseMeminfo, parseStat } from "./linux.ts";
import { DEFAULT_HEALTH } from "./services.ts";
import { START_CAP_DEFAULT } from "./start-cap.ts";
import { Store } from "./store.ts";

/** The presence settings of H33 by default. */
const PRESENCE_SETTINGS = { presence: true, awayAfterMs: 300_000, busyWaitMs: 1_200_000, presentReserve: 2 };

describe("Store", () => {
  it("keeps the process of a lease that first had none, so a restart of the daemon still sees its client (H64)", () => {
    const store = new Store(":memory:");
    const broker = new Broker({ now: () => 5000, newId: () => "l1" });
    const lease = broker.request({ holder: "shop", job: "build", amounts: { memory: 100 } });
    store.saveLease(lease);
    expect(store.activeLeases()[0]?.pid).toBeNull();
    store.saveLease({ ...lease, pid: 42 });
    expect(store.activeLeases()[0]?.pid).toBe(42);
  });

  it("keeps the leases, the pools and the samples", () => {
    const store = new Store(":memory:");
    const broker = new Broker({ now: () => 5000, newId: () => "l1" });
    const lease = broker.request({ holder: "shop", job: "build", amounts: { memory: 2000, docker: 1 }, pid: 42 });
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
    expect(store.config()).toEqual({ jobTemp: null, health: DEFAULT_HEALTH, spawnHeavy: 600, batteryFloor: 25, usageFile: null, rolesFile: null, memoryReserveMb: 1024, cpuReserve: 2, ...PRESENCE_SETTINGS, autoDrainMb: 6144, worktreeAutoClean: false, reapAuto: false, startTrace: ["session", "mcp", "service", "docker"], startTraceHold: ["session"], startCap: START_CAP_DEFAULT, alerts: {} });
    store.setConfig("jobTemp", "D:\\headroom\\tmp");
    expect(store.config()).toEqual({ jobTemp: "D:\\headroom\\tmp", health: DEFAULT_HEALTH, spawnHeavy: 600, batteryFloor: 25, usageFile: null, rolesFile: null, memoryReserveMb: 1024, cpuReserve: 2, ...PRESENCE_SETTINGS, autoDrainMb: 6144, worktreeAutoClean: false, reapAuto: false, startTrace: ["session", "mcp", "service", "docker"], startTraceHold: ["session"], startCap: START_CAP_DEFAULT, alerts: {} });
    store.setConfig("jobTemp", null);
    expect(store.config()).toEqual({ jobTemp: null, health: DEFAULT_HEALTH, spawnHeavy: 600, batteryFloor: 25, usageFile: null, rolesFile: null, memoryReserveMb: 1024, cpuReserve: 2, ...PRESENCE_SETTINGS, autoDrainMb: 6144, worktreeAutoClean: false, reapAuto: false, startTrace: ["session", "mcp", "service", "docker"], startTraceHold: ["session"], startCap: START_CAP_DEFAULT, alerts: {} });

    // H27: the setting health. Without it, the list is empty, so the monitor checks no URL (H57).
    store.setConfig("health", JSON.stringify({ "local-site": "http://127.0.0.1:4731/", mongo: "http://127.0.0.1:8081/" }));
    expect(store.config().health).toEqual({ "local-site": "http://127.0.0.1:4731/", mongo: "http://127.0.0.1:8081/" });
    store.setConfig("health", "{}");
    expect(store.config().health).toEqual({});
    store.setConfig("health", "not json");
    expect(store.config().health).toEqual(DEFAULT_HEALTH);
    store.setConfig("health", null);
    // H179: the setting alerts is the JSON text of the limits that differ. A bad text gives no differences.
    store.setConfig("alerts", JSON.stringify({ availableMb: 3072, availableCriticalMb: 2048 }));
    expect(store.config().alerts).toEqual({ availableMb: 3072, availableCriticalMb: 2048 });
    store.setConfig("alerts", "not json");
    expect(store.config().alerts).toEqual({});
    store.setConfig("alerts", null);
    expect(store.config()).toEqual({ jobTemp: null, health: DEFAULT_HEALTH, spawnHeavy: 600, batteryFloor: 25, usageFile: null, rolesFile: null, memoryReserveMb: 1024, cpuReserve: 2, ...PRESENCE_SETTINGS, autoDrainMb: 6144, worktreeAutoClean: false, reapAuto: false, startTrace: ["session", "mcp", "service", "docker"], startTraceHold: ["session"], startCap: START_CAP_DEFAULT, alerts: {} });
    // H47: the limit of a spawn-heavy job. A value that is not a number above 0 gives the default.
    store.setConfig("spawnHeavy", "1200");
    expect(store.config().spawnHeavy).toBe(1200);
    store.setConfig("spawnHeavy", "-3");
    expect(store.config().spawnHeavy).toBe(600);
    store.setConfig("spawnHeavy", null);
    expect(store.config().spawnHeavy).toBe(600);
    // H34: the level of the automatic drain. 0 turns it off. A value under 1 GB or not a whole number gives the default.
    store.setConfig("autoDrainMb", "5120");
    expect(store.config().autoDrainMb).toBe(5120);
    store.setConfig("autoDrainMb", "0");
    expect(store.config().autoDrainMb).toBe(0);
    for (const bad of ["500", "6144.5", "x", ""]) {
      store.setConfig("autoDrainMb", bad);
      expect(store.config().autoDrainMb).toBe(6144);
    }
    store.setConfig("autoDrainMb", null);
    // The hold of the automatic drain after a cancel.
    expect(store.autoDrainHold()).toBeNull();
    store.setAutoDrainHold(12_345);
    expect(store.autoDrainHold()).toBe(12_345);
    store.setAutoDrainHold(null);
    expect(store.autoDrainHold()).toBeNull();

    const broker = new Broker({ now: () => 5000, newId: () => "l1" });
    const lease = broker.request({ holder: "shop", job: "test", amounts: { "disk:D:": 5120 } });
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
    const lease = broker.request({ holder: "shop", job: "e2e", amounts: {}, pid: 42, log: "D:\\logs\\e2e.log" });
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

  it("adopts a file of a version before the migrations once: user_version 7, and a second open changes nothing", () => {
    const path = join(mkdtempSync(join(tmpdir(), "headroom-adopt-")), "old.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE owners (at INTEGER NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL, private_mb INTEGER, working_mb INTEGER, processes INTEGER, PRIMARY KEY (at, owner))`);
    old.close();
    new Store(path).close();
    const read = new DatabaseSync(path);
    expect(read.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
    const owners = read.prepare("PRAGMA table_info(owners)").all().map((row) => String(row["name"]));
    expect(owners).toEqual(expect.arrayContaining(["write_mb", "read_mb"]));
    const leases = read.prepare("PRAGMA table_info(leases)").all().map((row) => String(row["name"]));
    expect(leases).toEqual(expect.arrayContaining(["peak_mb", "usage", "exit_code", "processes", "conditions", "cpu_cap", "peak_gpu_mb", "cancelled_by", "folder"]));
    expect(read.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'leases_job'").get()).toEqual({ name: "leases_job" });
    // H183: step 3 makes the tables of the shadow log and of the reap log.
    expect(read.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'reap_%' ORDER BY name").all()).toEqual([{ name: "reap_log" }, { name: "reap_shadow" }]);
    // H78: step 4 makes the table of the keys and its index for the ladder.
    expect(read.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'lease_keys%' ORDER BY name").all()).toEqual([{ name: "lease_keys" }, { name: "lease_keys_ladder" }]);
    // H203: step 6 makes the log of the refusals of long native paths and its index.
    expect(read.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'native_refusals%' ORDER BY name").all()).toEqual([{ name: "native_refusals" }, { name: "native_refusals_at" }]);
    expect(read.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    read.close();
    new Store(path).close();
    const again = new DatabaseSync(path);
    expect(again.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
    again.close();
  });

  it("refuses a file of a newer version of headroom", () => {
    const path = join(mkdtempSync(join(tmpdir(), "headroom-newer-")), "new.db");
    const newer = new DatabaseSync(path);
    newer.exec("PRAGMA user_version = 99");
    newer.close();
    expect(() => new Store(path)).toThrow(/headroom/);
  });

  it("makes the folder of a new file, and a store in memory has the same schema", () => {
    const path = join(mkdtempSync(join(tmpdir(), "headroom-folder-")), "a", "b", "headroom.db");
    const store = new Store(path);
    store.saveLease(new Broker({ now: () => 1000, newId: () => "l1", isAlive: () => true }).request({ holder: "shop", job: "build", amounts: {} }));
    expect(store.lease("l1")).toMatchObject({ id: "l1", job: "build" });
    store.close();
    const memory = new Store(":memory:");
    memory.saveLease(new Broker({ now: () => 1000, newId: () => "l2", isAlive: () => true }).request({ holder: "shop", job: "test", amounts: {} }));
    expect(memory.lease("l2")).toMatchObject({ id: "l2", job: "test" });
    memory.close();
  });

  it("adds the columns of the exit and the log to an older table of leases, and keeps its rows", () => {
    const path = join(mkdtempSync(join(tmpdir(), "headroom-leases-")), "old.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE leases (
      id TEXT PRIMARY KEY, holder TEXT NOT NULL, job TEXT NOT NULL, amounts TEXT NOT NULL,
      priority INTEGER NOT NULL, pid INTEGER, ttl_ms INTEGER NOT NULL, state TEXT NOT NULL,
      requested_at INTEGER NOT NULL, granted_at INTEGER, ended_at INTEGER, heartbeat_at INTEGER NOT NULL, reason TEXT)`);
    old.exec(`INSERT INTO leases VALUES ('old1', 'shop', 'build', '{"memory":512}', 0, 42, 300000, 'released', 1000, 1500, 9000, 9000, 'released')`);
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

  it("adds the column of the processes of a job to a table of H26, and keeps the count of each heartbeat and of the release (H29)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "headroom-processes-")), "h26.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE leases (
      id TEXT PRIMARY KEY, holder TEXT NOT NULL, job TEXT NOT NULL, amounts TEXT NOT NULL,
      priority INTEGER NOT NULL, pid INTEGER, ttl_ms INTEGER NOT NULL, state TEXT NOT NULL,
      requested_at INTEGER NOT NULL, granted_at INTEGER, ended_at INTEGER, heartbeat_at INTEGER NOT NULL, reason TEXT,
      peak_mb REAL, usage TEXT, exit_code INTEGER, signal TEXT, log TEXT)`);
    old.exec(`INSERT INTO leases VALUES ('old1', 'client', 'coeval-063', '{}', 0, 42, 300000, 'released', 1000, 1500, 9000, 9000, 'released',
      NULL, NULL, 0, NULL, NULL)`);
    old.close();
    const store = new Store(path);
    expect(store.lease("old1")?.processes).toBeUndefined();
    let now = 20_000;
    const broker = new Broker({ now: () => now, newId: () => "l1", isAlive: () => true });
    store.saveLease(broker.request({ holder: "client", job: "coeval-063", amounts: {}, pid: 42 }));
    broker.tick({ totalMb: 1000, availableMb: 1000, pools: {} });
    now = 50_000;
    const renewed = broker.renew("l1", 4100);
    if (renewed) store.saveLease(renewed);
    expect(store.lease("l1")).toMatchObject({ state: "granted", processes: 4100, heartbeatAt: 50_000 });
    // A smaller count does not lower the count of the lease.
    expect(broker.renew("l1", 12)?.processes).toBe(4100);
    now = 80_000;
    const ended = broker.release("l1", "the job ended with code 0", null, undefined, { code: 0, signal: null }, 9800);
    if (ended) store.saveLease(ended);
    expect(store.lease("l1")).toMatchObject({ state: "released", processes: 9800, exitCode: 0 });
    expect(store.lease("old1")).toMatchObject({ id: "old1", exitCode: 0 });
    store.close();
  });

  it("finds the leases by an id prefix and by the job, and keeps the ended leases for their own time", () => {
    const store = new Store(":memory:");
    const base = { holder: "shop", job: "e2e", amounts: {}, priority: 0, pid: null, ttlMs: 300_000, grantedAt: null, heartbeatAt: 0, reason: null, peakMb: null };
    store.saveLease({ ...base, id: "aaaa1111-1", state: "released", requestedAt: 1000, endedAt: 2000 });
    store.saveLease({ ...base, id: "aaaa1111-2", state: "released", requestedAt: 3000, endedAt: 4000, holder: "vex" });
    store.saveLease({ ...base, id: "bbbb2222-1", state: "waiting", requestedAt: 5000, endedAt: null });
    expect(store.leasesByPrefix("aaaa1111").map((lease) => lease.id)).toEqual(["aaaa1111-2", "aaaa1111-1"]);
    expect(store.leasesByPrefix("aaaa1111-1").map((lease) => lease.id)).toEqual(["aaaa1111-1"]);
    expect(store.leasesByPrefix("a%")).toEqual([]);
    expect(store.leasesOfJob("e2e").map((lease) => lease.id)).toEqual(["bbbb2222-1", "aaaa1111-2", "aaaa1111-1"]);
    expect(store.leasesOfJob("e2e", { holder: "shop", limit: 1 }).map((lease) => lease.id)).toEqual(["bbbb2222-1"]);
    expect(store.leasesOfJob("e2e", { since: 3500 }).map((lease) => lease.id)).toEqual(["bbbb2222-1", "aaaa1111-2"]);
    store.prune(10_000, 3000);
    expect(store.leasesOfJob("e2e").map((lease) => lease.id)).toEqual(["bbbb2222-1", "aaaa1111-2"]);
    store.close();
  });
});

describe("Store reap tables (H183)", () => {
  /** A match of the shadow log: a made-up grep.exe of the session kestrel. */
  const match = (pid: number, aboveSince: number) =>
    ({ pid, created: 1000, name: "grep.exe", privateMb: 600, ageMs: 0, owner: "session:kestrel", session: "kestrel", sessionId: null, command: null, aboveSince, stdout: "pipe" }) as const;
  /** A row of the reap log. */
  const entry = (at: number, action: "stopped" | "asked" | "needs-owner") =>
    ({ at, pid: 7, created: 1000, name: "grep.exe", session: "kestrel", sessionId: null, by: "otter", byId: null, action, privateMb: 600, command: null, result: "the text" }) as const;

  it("gives the requests of the reap log at or after a time, the newest first", () => {
    const store = new Store(":memory:");
    store.saveReap(entry(1000, "asked"));
    store.saveReap(entry(2000, "stopped"));
    store.saveReap(entry(3000, "needs-owner"));
    expect(store.reapRequests(0).map((row) => [row.at, row.action])).toEqual([[3000, "needs-owner"], [1000, "asked"]]);
    expect(store.reapRequests(1001).map((row) => row.at)).toEqual([3000]);
    store.close();
  });

  it("starts a new period above the line when a match has a new start of the period", () => {
    const store = new Store(":memory:");
    store.saveShadow(5000, [match(1, 1000)]);
    store.saveShadow(9000, [match(1, 7000)]);
    expect(store.reapShadow()).toMatchObject([{ pid: 1, firstAt: 5000, lastAt: 9000, aboveSince: 7000, samples: 2 }]);
    store.close();
  });

  it("removes the rows of the shadow log and of the reap log before the third time, by default the time of the leases", () => {
    const store = new Store(":memory:");
    store.saveShadow(1000, [match(1, 1000)]);
    store.saveShadow(5000, [match(2, 5000)]);
    store.saveReap(entry(1000, "asked"));
    store.saveReap(entry(5000, "asked"));
    // The samples go before 9000. The leases and, by default, the reap rows go before 3000.
    store.prune(9000, 3000);
    expect(store.reapShadow().map((row) => row.pid)).toEqual([2]);
    expect(store.reapLog().map((row) => row.at)).toEqual([5000]);
    // The third time decides for the reap tables.
    store.prune(0, 0, 6000);
    expect(store.reapShadow()).toEqual([]);
    expect(store.reapLog()).toEqual([]);
    store.close();
  });
});

describe("Store log of the refusals of long native paths (H203)", () => {
  /** A refusal of the hook: a worktree in the scratchpad gives a binding path of 288 characters. */
  const refusal = (at: number, session: string | null, source: "hook" | "run" = "hook", folder = "C:\\Temp\\scratchpad\\wt-a", ntLength = 288) =>
    ({ at, source, session, sessionId: session === null ? "0b3c" : `id-${session}`, folder, ntLength, limit: 240, basis: "main checkout" }) as const;

  it("counts the refusals of each session and source in a range, the session with the most first", () => {
    const store = new Store(":memory:");
    store.saveNativeRefusal(refusal(1000, "kestrel"));
    store.saveNativeRefusal(refusal(2000, "kestrel", "hook", "C:\\Temp\\scratchpad\\wt-b", 301));
    store.saveNativeRefusal(refusal(3000, "kestrel", "run"));
    store.saveNativeRefusal(refusal(4000, "otter"));
    store.saveNativeRefusal(refusal(5000, null));
    store.saveNativeRefusal(refusal(9000, "otter"));
    expect(store.nativeRefusalCounts(0, 9000)).toEqual([
      { session: "kestrel", source: "hook", refusals: 2, folders: 2, longest: 301, firstAt: 1000, lastAt: 2000 },
      { session: null, source: "hook", refusals: 1, folders: 1, longest: 288, firstAt: 5000, lastAt: 5000 },
      { session: "kestrel", source: "run", refusals: 1, folders: 1, longest: 288, firstAt: 3000, lastAt: 3000 },
      { session: "otter", source: "hook", refusals: 1, folders: 1, longest: 288, firstAt: 4000, lastAt: 4000 },
    ]);
    // The start of the range counts, the end does not.
    expect(store.nativeRefusalCounts(4000, 9001).map((row) => [row.session, row.refusals])).toEqual([["otter", 2], [null, 1]]);
    expect(store.nativeRefusalCounts(9001, 20_000)).toEqual([]);
    store.close();
  });

  it("removes the refusals before the third time of the prune, with the reap log", () => {
    const store = new Store(":memory:");
    store.saveNativeRefusal(refusal(1000, "kestrel"));
    store.saveNativeRefusal(refusal(5000, "kestrel"));
    store.prune(9000, 9000, 3000);
    expect(store.nativeRefusalCounts(0, 10_000)).toMatchObject([{ session: "kestrel", refusals: 1, firstAt: 5000 }]);
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

    store.prune(3000);
    expect(store.poolTagsSince(0).map((snapshot) => snapshot.at)).toEqual([]);
    store.close();
  });

  it("keeps each snapshot for 48 hours, the first of each hour for 7 days, and the first after the boot for longer", () => {
    const minutes = 60_000;
    const base = 100 * 3_600_000;
    const bootedAt = base + 40 * minutes;
    const store = new Store(":memory:");
    const row = [{ tag: "File", nonPagedMb: 10, pagedMb: 0 }];
    const ages = (): number[] => store.poolTagsSince(0).map((snapshot) => (snapshot.at - base) / minutes);
    const last = 48 * 60 + 340;
    for (let at = 10; at <= last; at += 30) store.savePoolTags(base + at * minutes, row, bootedAt);
    // The cut is at 340 minutes. 40 is the first after the boot. 10, 70, 130, 190, 250 and 310 are the first of their hours.
    const window = Array.from({ length: (last - 340) / 30 + 1 }, (_, index) => 340 + index * 30);
    expect(ages()).toEqual([10, 40, 70, 130, 190, 250, 310, ...window]);

    // Ten days after the first snapshot, each snapshot is older than the 7 days of the hourly ones.
    const later = 10 * 24 * 60;
    store.savePoolTags(base + later * minutes, row, bootedAt);
    expect(ages()).toEqual([40, later]);
    store.close();
  });

  it("keeps the first snapshot after a boot that follows the last snapshot of the store", () => {
    const hour = 3_600_000;
    const store = new Store(":memory:");
    const row = [{ tag: "File", nonPagedMb: 10, pagedMb: 0 }];
    store.savePoolTags(10 * hour, row, 0);
    store.savePoolTags(10 * hour + 1000, row, 10 * hour + 500);
    store.savePoolTags(13 * hour, row, 10 * hour + 500);
    expect(store.poolTagsSince(0).map((snapshot) => snapshot.at)).toEqual([10 * hour, 10 * hour + 1000, 13 * hour]);
    store.close();
  });

  it("reads the times, one snapshot at a time, and the rows of some tags only (H53)", () => {
    const store = new Store(":memory:");
    store.savePoolTags(1000, [
      { tag: "DAL3", nonPagedMb: 270, pagedMb: 0 },
      { tag: "FMfn", nonPagedMb: 0, pagedMb: 470 },
    ]);
    store.savePoolTags(2000, [{ tag: "File", nonPagedMb: 40, pagedMb: 2 }]);
    store.savePoolTags(3000, [
      { tag: "DAL3", nonPagedMb: 300, pagedMb: 0 },
      { tag: "FMfn", nonPagedMb: 0, pagedMb: 520 },
    ]);
    expect(store.poolTagTimes(0)).toEqual([1000, 2000, 3000]);
    expect(store.poolTagTimes(1500)).toEqual([2000, 3000]);
    expect(store.poolTagsAt(3000)).toEqual({ at: 3000, tags: new Map([["DAL3", 300], ["FMfn", 0]]), paged: new Map([["DAL3", 0], ["FMfn", 520]]) });
    expect(store.poolTagsAt(2500)).toBeUndefined();
    // A snapshot without a row of the tags is absent: the snapshot of 2000 holds only File.
    expect(store.poolTagsSince(0, ["FMfn"])).toEqual([
      { at: 1000, tags: new Map([["FMfn", 0]]), paged: new Map([["FMfn", 470]]) },
      { at: 3000, tags: new Map([["FMfn", 0]]), paged: new Map([["FMfn", 520]]) },
    ]);
    expect(store.poolTagsSince(0, [])).toEqual([]);
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
    const owners = [{ owner: "session:shop", kind: "session" as const, privateMb: 800, workingMb: 700, processes: 4 }];
    const writes = new Map([["session:shop", { kind: "session" as const, mb: 512.25 }], ["mcp:vex", { kind: "mcp" as const, mb: 3 }]]);
    store.saveSample(61_000, memory, owners, undefined, [], writes);
    expect(store.ownersSince(0)).toEqual([
      { at: 1000, owner: "docker", kind: "docker", privateMb: 900, workingMb: 900, processes: 3 },
      { at: 61_000, owner: "session:shop", kind: "session", privateMb: 800, workingMb: 700, processes: 4, writeMb: 512.25 },
      { at: 61_000, owner: "mcp:vex", kind: "mcp", privateMb: 0, workingMb: 0, processes: 0, writeMb: 3 },
    ]);
    expect(store.writesSince(0)).toEqual([
      { at: 61_000, owner: "mcp:vex", kind: "mcp", amount: 3 },
      { at: 61_000, owner: "session:shop", kind: "session", amount: 512.25 },
    ]);
    store.close();
  });

  it("keeps the reads of each owner and the processes that read much (H66), and prune removes them", () => {
    const store = new Store(":memory:");
    const memory = { totalMb: 28000, availableMb: 9000, commitMb: 30000, commitLimitMb: 80000, kernelPagedMb: 900, kernelNonpagedMb: 1000 };
    const owners = [{ owner: "session:shop", kind: "session" as const, privateMb: 800, workingMb: 700, processes: 4 }];
    const writes = new Map([["session:shop", { kind: "session" as const, mb: 5 }]]);
    const reads = new Map([["session:shop", { kind: "session" as const, mb: 7 }], ["other", { kind: "other" as const, mb: 2600 }]]);
    const readers = [{ pid: 9, name: "scan.exe", owner: "other", mb: 2600 }, { pid: 4, name: "git.exe", owner: "session:shop", mb: 60 }];
    store.saveSample(61_000, memory, owners, undefined, [], writes, reads, readers);
    expect(store.ownersSince(0)).toEqual([
      { at: 61_000, owner: "session:shop", kind: "session", privateMb: 800, workingMb: 700, processes: 4, writeMb: 5, readMb: 7 },
      { at: 61_000, owner: "other", kind: "other", privateMb: 0, workingMb: 0, processes: 0, readMb: 2600 },
    ]);
    expect(store.readsSince(0)).toEqual([
      { at: 61_000, owner: "other", kind: "other", amount: 2600 },
      { at: 61_000, owner: "session:shop", kind: "session", amount: 7 },
    ]);
    expect(store.readersSince(0)).toEqual([
      { at: 61_000, pid: 9, name: "scan.exe", owner: "other", mb: 2600 },
      { at: 61_000, pid: 4, name: "git.exe", owner: "session:shop", mb: 60 },
    ]);
    expect(store.readersSince(61_001)).toEqual([]);
    store.prune(62_000);
    expect(store.readersSince(0)).toEqual([]);
    store.close();
  });
});
