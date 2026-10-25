import { describe, expect, it } from "vitest";
import type { Lease } from "./broker.ts";
import { findJobs, jobState } from "./job-state.ts";
import { Store } from "./store.ts";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 24, 18, 0);

function lease(id: string, fields: Partial<Lease> = {}): Lease {
  return {
    id,
    holder: "graph",
    job: "graph-e2e",
    amounts: { browser: 1 },
    priority: 0,
    pid: 42,
    ttlMs: 300_000,
    state: "released",
    requestedAt: NOW - 2 * HOUR,
    grantedAt: NOW - 2 * HOUR + 12 * 60_000,
    endedAt: NOW - 2 * HOUR + 18 * 60_000,
    heartbeatAt: NOW - 2 * HOUR,
    reason: "the job ended with code 1, peak 1.8 GB",
    peakMb: 1843.4,
    ...fields,
  };
}

function storeOf(leases: readonly Lease[]): Store {
  const store = new Store(":memory:");
  for (const each of leases) store.saveLease(each);
  return store;
}

describe("jobState", () => {
  it("gives the state of an exited job with its exit code, its times and its log", () => {
    const state = jobState(lease("3f2a9c1e-0000-4000-8000-000000000001", { exitCode: 1, log: "D:\\logs\\e2e.log", processes: 9800 }), NOW);
    expect(state).toEqual({
      id: "3f2a9c1e-0000-4000-8000-000000000001",
      job: "graph-e2e",
      holder: "graph",
      state: "exited",
      exitCode: 1,
      signal: null,
      reason: "the job ended with code 1, peak 1.8 GB",
      queuedAt: "2026-10-24T16:00:00.000Z",
      startedAt: "2026-10-24T16:12:00.000Z",
      endedAt: "2026-10-24T16:18:00.000Z",
      waitedMs: 12 * 60_000,
      ranMs: 6 * 60_000,
      peakMb: 1843,
      // H29: the processes that the job started, from its job object.
      processes: 9800,
      // H47: no peak from a lease of an older version, and the average over the 6 minutes of the run.
      peakStartsPerMin: null,
      averageStartsPerMin: 1633,
      spawn: null,
      log: "D:\\logs\\e2e.log",
      // H31: a job with no conditions.
      conditions: null,
      unmet: null,
      peakCores: null,
      cpuCap: null,
    });
  });

  it("gives queued and running jobs with the time so far, and no exit code for a lease that ended without a job exit", () => {
    const queued = jobState(lease("q", { state: "waiting", grantedAt: null, endedAt: null, peakMb: null, reason: "waits for browser: needs 1, 0 free" }), NOW);
    expect(queued).toMatchObject({ state: "queued", exitCode: null, startedAt: null, endedAt: null, waitedMs: 2 * HOUR, ranMs: null, peakMb: null, processes: null, log: null });
    const running = jobState(lease("r", { state: "granted", endedAt: null, peakMb: null, reason: null }), NOW);
    expect(running).toMatchObject({ state: "running", exitCode: null, waitedMs: 12 * 60_000, ranMs: 2 * HOUR - 12 * 60_000 });
    const expired = jobState(lease("e", { state: "expired", peakMb: null, reason: "the process exited" }), NOW);
    expect(expired).toMatchObject({ state: "exited", exitCode: null, signal: null, reason: "the process exited" });
    const cancelled = jobState(lease("c", { state: "cancelled", grantedAt: null, peakMb: null, reason: "the wait ended" }), NOW);
    expect(cancelled).toMatchObject({ state: "exited", exitCode: null, waitedMs: 18 * 60_000, ranMs: null });
  });
});

describe("findJobs", () => {
  const leases = [
    lease("3f2a9c1e-aaaa-4000-8000-000000000001", { exitCode: 1 }),
    lease("3f2a9c1e-bbbb-4000-8000-000000000002", { requestedAt: NOW - HOUR, holder: "vex", exitCode: 0 }),
    lease("7c00ffee-cccc-4000-8000-000000000003", { requestedAt: NOW - 30 * 60_000, state: "granted", endedAt: null, exitCode: undefined }),
    lease("9d9d9d9d-dddd-4000-8000-000000000004", { requestedAt: NOW - 30 * HOUR, endedAt: NOW - 29 * HOUR, exitCode: 2 }),
    lease("5e5e5e5e-eeee-4000-8000-000000000005", { job: "pnpm test", exitCode: 0 }),
  ];

  it("finds a job by its full id and by a unique prefix of 8 or more characters", () => {
    const store = storeOf(leases);
    expect(findJobs(store, { query: "3f2a9c1e-aaaa-4000-8000-000000000001" }, NOW).map((job) => job.exitCode)).toEqual([1]);
    expect(findJobs(store, { query: "7c00ffee" }, NOW).map((job) => job.state)).toEqual(["running"]);
    expect(findJobs(store, { query: "3f2a9c1e-b" }, NOW).map((job) => job.holder)).toEqual(["vex"]);
    // A prefix of less than 8 characters is not an id, and a prefix of two ids is not unique.
    expect(findJobs(store, { query: "7c00ff" }, NOW)).toEqual([]);
    expect(findJobs(store, { query: "3f2a9c1e" }, NOW)).toEqual([]);
    store.close();
  });

  it("finds the latest job of a name, optionally of one holder, and each match of 24 hours with all", () => {
    const store = storeOf(leases);
    expect(findJobs(store, { query: "graph-e2e" }, NOW).map((job) => job.id.slice(0, 8))).toEqual(["7c00ffee"]);
    expect(findJobs(store, { query: "graph-e2e", holder: "vex" }, NOW).map((job) => job.exitCode)).toEqual([0]);
    expect(findJobs(store, { query: "pnpm test" }, NOW).map((job) => job.job)).toEqual(["pnpm test"]);
    const all = findJobs(store, { query: "graph-e2e", all: true }, NOW).map((job) => job.id.slice(0, 13));
    expect(all).toEqual(["7c00ffee-cccc", "3f2a9c1e-bbbb", "3f2a9c1e-aaaa"]);
    expect(findJobs(store, { query: "graph-e2e", holder: "graph", all: true }, NOW)).toHaveLength(2);
    store.close();
  });

  it("gives no job for a query with no match, also for an id of another holder", () => {
    const store = storeOf(leases);
    expect(findJobs(store, { query: "no-such-job" }, NOW)).toEqual([]);
    expect(findJobs(store, { query: "7c00ffee", holder: "vex" }, NOW)).toEqual([]);
    expect(findJobs(store, { query: "graph-e2e", holder: "nobody", all: true }, NOW)).toEqual([]);
    store.close();
  });
});
