import { findJobs, Store, type JobQuery, type Lease } from "@headroom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Connection } from "./client.ts";
import { jobCommand, jobLine, NO_JOB, span, type JobOutput } from "./job-cli.ts";

const NOW = new Date(2026, 9, 24, 18, 0).getTime();
const MINUTE = 60_000;

const BASE: Lease = {
  id: "3f2a9c1e-0000-4000-8000-000000000001",
  holder: "graph",
  job: "graph-e2e",
  amounts: { browser: 1 },
  priority: 0,
  pid: 42,
  ttlMs: 300_000,
  state: "released",
  requestedAt: NOW - 30 * MINUTE,
  grantedAt: NOW - 18 * MINUTE,
  endedAt: NOW - 12 * MINUTE,
  heartbeatAt: NOW - 30 * MINUTE,
  reason: "the job ended with code 1, peak 1.8 GB",
  peakMb: 1843,
  exitCode: 1,
  log: "D:\\logs\\e2e.log",
};

describe("headroom job", () => {
  let store: Store;
  let calls: { path: readonly string[]; input: unknown }[];
  let lines: string[];
  let errors: string[];
  let connection: Connection;
  const io = (): JobOutput => ({ out: (text) => lines.push(text), err: (text) => errors.push(text), now: () => NOW });

  beforeEach(() => {
    store = new Store(":memory:");
    store.saveLease(BASE);
    calls = [];
    lines = [];
    errors = [];
    connection = {
      endpoint: "http://127.0.0.1:0",
      call: async <T>(path: readonly string[], input: unknown): Promise<T> => {
        calls.push({ path, input });
        return findJobs(store, input as JobQuery, NOW) as T;
      },
    };
  });
  afterEach(() => store.close());

  it("writes the state of the job as JSON with exactly the fields of the fleet wait", async () => {
    expect(await jobCommand(["graph-e2e", "--json"], connection, io())).toBe(0);
    expect(calls).toEqual([{ path: ["resources", "job"], input: { query: "graph-e2e", all: false } }]);
    const state = JSON.parse(lines.join("\n")) as Record<string, unknown>;
    expect(Object.keys(state)).toEqual([
      "id", "job", "holder", "state", "exitCode", "signal", "reason", "queuedAt", "startedAt", "endedAt", "waitedMs", "ranMs", "peakMb", "log",
    ]);
    expect(state).toMatchObject({
      id: BASE.id,
      state: "exited",
      exitCode: 1,
      signal: null,
      queuedAt: new Date(BASE.requestedAt).toISOString(),
      waitedMs: 12 * MINUTE,
      ranMs: 6 * MINUTE,
      peakMb: 1843,
      log: "D:\\logs\\e2e.log",
    });
  });

  it("writes a list with --all, and passes the holder", async () => {
    store.saveLease({ ...BASE, id: "7c00ffee-0000-4000-8000-000000000002", requestedAt: NOW - 5 * MINUTE, state: "granted", endedAt: null, exitCode: undefined });
    expect(await jobCommand(["graph-e2e", "--all", "--holder", "graph", "--json"], connection, io())).toBe(0);
    expect(calls[0]?.input).toEqual({ query: "graph-e2e", all: true, holder: "graph" });
    const states = JSON.parse(lines.join("\n")) as { state: string }[];
    expect(states.map((each) => each.state)).toEqual(["running", "exited"]);
  });

  it("gives exit code 3 and an error object when no job matches", async () => {
    expect(await jobCommand(["no-such-job", "--json"], connection, io())).toBe(NO_JOB);
    expect(JSON.parse(lines.join("\n"))).toEqual({ error: "no job", query: "no-such-job" });
    expect(await jobCommand(["no-such-job"], connection, io())).toBe(3);
    expect(errors.at(-1)).toContain('no job matches "no-such-job"');
  });

  it("writes one line for a person, and refuses a wrong use", async () => {
    expect(await jobCommand(["3f2a9c1e"], connection, io())).toBe(0);
    expect(lines).toEqual(["graph-e2e (3f2a9c1e) of graph: exited with code 1 at 17:48, waited 12 min, ran 6 min, peak 1.8 GB. Log: D:\\logs\\e2e.log"]);
    expect(await jobCommand([], connection, io())).toBe(2);
    expect(await jobCommand(["graph-e2e"], null, io())).toBe(1);
  });
});

describe("jobLine", () => {
  const state = {
    id: "3f2a9c1e-0000", job: "e2e", holder: "graph", exitCode: null, signal: null, log: null, peakMb: null,
    queuedAt: new Date(NOW - 20 * MINUTE).toISOString(), startedAt: null, endedAt: null,
  } as const;

  it("names a queued, a running and a stopped job", () => {
    expect(jobLine({ ...state, state: "queued", reason: "waits for browser: needs 1, 0 free", waitedMs: 20 * MINUTE, ranMs: null }, NOW)).toBe(
      "e2e (3f2a9c1e) of graph: queued since 17:40, waited 20 min (waits for browser: needs 1, 0 free).",
    );
    const startedAt = new Date(NOW - 5 * MINUTE).toISOString();
    expect(jobLine({ ...state, state: "running", reason: null, startedAt, waitedMs: 15 * MINUTE, ranMs: 5 * MINUTE }, NOW)).toBe(
      "e2e (3f2a9c1e) of graph: running since 17:55, waited 15 min, ran 5 min so far.",
    );
    const endedAt = new Date(NOW - 26 * 3_600_000).toISOString();
    expect(jobLine({ ...state, state: "exited", reason: "the process exited", startedAt, endedAt, waitedMs: 40_000, ranMs: 125 * MINUTE }, NOW)).toBe(
      "e2e (3f2a9c1e) of graph: ended at 2026-10-23 16:00 with no exit code (the process exited), waited 40 s, ran 2 h 5 min.",
    );
    expect(jobLine({ ...state, state: "exited", reason: null, signal: "SIGTERM", waitedMs: 0, ranMs: null }, NOW)).toBe(
      "e2e (3f2a9c1e) of graph: exited with signal SIGTERM, waited 0 s, did not start.",
    );
    expect(span(59_400)).toBe("59 s");
  });
});
