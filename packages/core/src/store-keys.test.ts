import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Lease } from "./broker.ts";
import type { JobKey, MemoryPrediction, RunEstimate } from "./predict.ts";
import { keyedLeases, Store } from "./store.ts";

const key = (fields: Partial<JobKey> = {}): JobKey => ({
  kind: "test",
  repo: "shop",
  lock: "0123456789abcdef",
  filter: ".",
  warm: true,
  packages: 800,
  command: "pnpm test",
  ...fields,
});
const MEMORY: MemoryPrediction = { mb: 512, rung: "kind", runs: 3, peakMb: 400 };
const RUN: RunEstimate = { ms: 30_000, from: "all", runs: 2 };

/** This function writes a lease that ended at `endedAt` after a run of 900 ms, with an exit code. */
function ended(store: Store, id: string, job: string, peakMb: number, endedAt: number): void {
  const lease: Lease = {
    id,
    holder: "shop",
    job,
    amounts: { memory: 512 },
    priority: 0,
    pid: null,
    ttlMs: 60_000,
    state: "released",
    requestedAt: endedAt - 1000,
    grantedAt: endedAt - 900,
    endedAt,
    heartbeatAt: 0,
    reason: null,
    peakMb,
    exitCode: 0,
  };
  store.saveLease(lease);
}

describe("Store lease keys (H78)", () => {
  it("adds the table of the keys to a file of step 3, and keeps its leases", () => {
    const path = join(mkdtempSync(join(tmpdir(), "headroom-keys-")), "step3.db");
    const first = new Store(path);
    ended(first, "old-1", "pnpm test", 300, 5000);
    first.close();
    const old = new DatabaseSync(path);
    // The version of a new file is the count of all the steps. The open of a file of step 3 goes to it.
    const latest = (old.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    old.exec("DROP TABLE lease_keys");
    old.exec("PRAGMA user_version = 3");
    old.close();
    const store = new Store(path);
    expect(store.leaseKey("old-1")).toBeNull();
    expect(store.peaksOf("pnpm test")).toEqual([300]);
    store.saveLeaseKey("old-1", key(), MEMORY, RUN);
    expect(store.leaseKey("old-1")).toEqual(key());
    store.close();
    const read = new DatabaseSync(path);
    expect(read.prepare("PRAGMA user_version").get()).toEqual({ user_version: latest });
    read.close();
  });

  it("writes the key and the predictions of a lease, and reads the runs of each rung, the newest first", () => {
    const store = new Store(":memory:");
    const runs: [string, JobKey | null, number, string][] = [
      ["a", key(), 400, "pnpm test"],
      ["b", key({ lock: "fedcba9876543210" }), 600, "pnpm test"],
      ["c", key({ repo: "vex" }), 900, "pnpm test"],
      ["d", key({ kind: "lint", command: "pnpm lint" }), 100, "pnpm lint"],
      ["e", null, 700, "pnpm test"],
      ["f", key({ warm: null, packages: null }), 50, "h1-test"],
    ];
    runs.forEach(([id, each, peak, job], at) => {
      ended(store, id, job, peak, 1000 * (at + 1));
      if (each !== null) store.saveLeaseKey(id, each, MEMORY, RUN);
    });
    expect(store.leaseKeyRow("a")).toEqual({ key: key(), predictedMb: 512, rung: "kind", runs: 3, predictedMs: 30_000, runFrom: "all" });
    expect(store.leaseKey("e")).toBeNull();
    expect(store.keyedPeaks(key(), "key")).toEqual([400]);
    expect(store.keyedPeaks(key(), "repo")).toEqual([600, 400]);
    expect(store.keyedPeaks(key(), "kind")).toEqual([50, 900, 600, 400]);
    // `IS` matches a null field to a null field only.
    expect(store.keyedPeaks(key({ warm: null }), "repo")).toEqual([50]);
    expect(store.keyedRunTimes(key(), "repo")).toEqual([900, 900]);
    expect(store.sizedPeaks("test", true)).toEqual([
      { packages: 800, peakMb: 900 },
      { packages: 800, peakMb: 600 },
      { packages: 800, peakMb: 400 },
    ]);
    // The rung job leaves out the runs of another repo, and keeps the runs with no key.
    expect(store.peaksOf("pnpm test")).toEqual([700, 900, 600, 400]);
    expect(store.peaksOf("pnpm test", undefined, 20, "shop")).toEqual([700, 600, 400]);
    expect(store.runTimesOf("pnpm test", "shop", 20, "vex")).toEqual([900, 900]);
    // Prune removes the keys of the leases that it removes.
    store.prune(10_000, 2500);
    expect(store.leaseKeyRow("a")).toBeNull();
    expect(store.keyedPeaks(key(), "kind")).toEqual([50, 900]);
    store.close();
  });

  it("reads the leases with their keys from a read-only file, also from a file of step 3", () => {
    const path = join(mkdtempSync(join(tmpdir(), "headroom-keyed-")), "keyed.db");
    const store = new Store(path);
    ended(store, "a", "pnpm test", 400, 1000);
    ended(store, "b", "pnpm lint", 100, 2000);
    store.saveLeaseKey("a", key(), MEMORY, RUN);
    store.close();
    const read = new DatabaseSync(path, { readOnly: true });
    const leases = keyedLeases(read, 0);
    expect(leases.map((lease) => [lease.id, lease.memoryMb, lease.peakMb, lease.keyed?.rung ?? null])).toEqual([
      ["a", 512, 400, "kind"],
      ["b", 512, 100, null],
    ]);
    expect(keyedLeases(read, 500).map((lease) => lease.id)).toEqual(["b"]);
    read.close();
    const old = new DatabaseSync(path);
    old.exec("DROP TABLE lease_keys");
    expect(keyedLeases(old, 0).map((lease) => lease.keyed)).toEqual([null, null]);
    old.close();
  });
});

describe("the synced lease writes (H204)", () => {
  it("syncs a new lease, each change of its state and its key, and not a heartbeat, a reason or a peak", () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "headroom-sync-")), "headroom.db"));
    const lease: Lease = {
      id: "l1", holder: "shop", job: "build", amounts: { memory: 100 }, priority: 0, pid: null, ttlMs: 300_000,
      state: "waiting", requestedAt: 5000, grantedAt: null, endedAt: null, heartbeatAt: 5000, reason: null, peakMb: null,
    };
    store.saveLease(lease);
    store.saveLeaseKey("l1", key(), MEMORY, RUN);
    expect(store.syncs().writes).toBe(2);
    store.saveLease({ ...lease, heartbeatAt: 6000 });
    store.saveLease({ ...lease, heartbeatAt: 7000, reason: "waits for memory" });
    expect(store.syncs().writes).toBe(2);
    const granted: Lease = { ...lease, state: "granted", grantedAt: 8000, heartbeatAt: 8000, reason: null };
    store.saveLease(granted);
    store.saveLease({ ...granted, peakMb: 90 });
    expect(store.syncs().writes).toBe(3);
    store.saveLease({ ...granted, peakMb: 90, state: "released", endedAt: 9000, reason: "released" });
    const syncs = store.syncs();
    expect(syncs.writes).toBe(4);
    expect(syncs.slowestMs).toBeGreaterThanOrEqual(0);
    expect(syncs.totalMs).toBeGreaterThanOrEqual(syncs.slowestMs);
    // Each write is in the file, the synced writes and the others
    expect(store.endedLeases(0)).toEqual([expect.objectContaining({ id: "l1", state: "released", peakMb: 90, endedAt: 9000 })]);
    expect(store.leaseKey("l1")).toEqual(key());
    store.close();
  });

  it("syncs the first write of each lease after a new open of the file, because a restart knows no synced state", () => {
    const path = join(mkdtempSync(join(tmpdir(), "headroom-sync-")), "headroom.db");
    const lease: Lease = {
      id: "l2", holder: "shop", job: "build", amounts: { memory: 100 }, priority: 0, pid: 42, ttlMs: 300_000,
      state: "granted", requestedAt: 5000, grantedAt: 5000, endedAt: null, heartbeatAt: 5000, reason: null, peakMb: null,
    };
    const first = new Store(path);
    first.saveLease(lease);
    first.close();
    const next = new Store(path);
    expect(next.syncs()).toEqual({ writes: 0, totalMs: 0, slowestMs: 0 });
    next.saveLease({ ...lease, heartbeatAt: 6000 });
    next.saveLease({ ...lease, heartbeatAt: 7000 });
    expect(next.syncs().writes).toBe(1);
    expect(next.activeLeases()).toEqual([expect.objectContaining({ id: "l2", heartbeatAt: 7000 })]);
    next.close();
  });
});
