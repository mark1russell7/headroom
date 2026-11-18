import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Broker, type Lease } from "./broker.ts";
import { Engine } from "./engine.ts";
import { RESOURCES, tracedSourcesText, type Owners, type Readings } from "./resources.ts";
import type { Sampler } from "./sampler.ts";
import { openStartLog, startsOfPid } from "./start-log.ts";
import { NO_STARTS, type ProcessStarts } from "./starts.ts";
import { Store } from "./store.ts";
import {
  COVERS_PER_READ,
  DLL_INIT_FAILED,
  TRACE_HOLD_KINDS,
  TraceBook,
  traceCovers,
  TRACED_KINDS,
  traceKindsOf,
  traceKindsText,
  startLogText,
  traceLines,
  withTrace,
  type StartTrace,
  type StartTraceOptions,
  type TraceCoverOptions,
  type TracedStarts,
  type TraceEvent,
} from "./trace.ts";
import type { OwnerKind, ProcessInfo } from "./types.ts";

const S = 1000;
const MIN = 60 * S;
const p = (pid: number, ppid: number, name: string, startedAt: number | undefined): ProcessInfo => ({ pid, ppid, name, privateMb: 1, workingMb: 1, startedAt });
const start = (key: number, pid: number, ppid: number | null, name: string | null, at: number): TraceEvent => ({ type: "start", key, pid, ppid, name, at });
const exit = (key: number, pid: number, exitCode: number | null, at: number): TraceEvent => ({ type: "exit", key, pid, exitCode, at });
const kinds = new Map<string, OwnerKind>([
  ["session:shop", "session"],
  ["session:client", "session"],
  ["mcp:vex", "mcp"],
  ["browser", "browser"],
]);
const idle = { jobs: 0, failure: null };

/** The lease of `headroom run` (process 30) for the holder `client`. */
function grantedLease(pid = 30, holder = "client"): Lease {
  const broker = new Broker({ now: () => 0, newId: () => "L1", isAlive: () => true });
  broker.request({ holder, job: "pnpm test", amounts: {}, pid });
  broker.tick({ totalMb: 1000, availableMb: 1000, pools: {} });
  const lease = broker.get("L1");
  if (lease === undefined) throw new Error("no lease");
  return lease;
}

describe("the setting startTrace (H188)", () => {
  it("reads off, a list of kinds and the default", () => {
    expect(traceKindsOf(undefined)).toEqual(TRACED_KINDS);
    expect(traceKindsOf("off")).toEqual([]);
    expect(traceKindsOf("mcp,session")).toEqual(["session", "mcp"]);
    // A kind that is not traceable gives the default, so a bad value in the store does not stop the trace.
    expect(traceKindsOf("session,kernel")).toEqual(TRACED_KINDS);
  });

  it("reads the setting startTraceHold with its own default (H191)", () => {
    expect(TRACE_HOLD_KINDS).toEqual(["session"]);
    expect(traceKindsOf(undefined, TRACE_HOLD_KINDS)).toEqual(["session"]);
    expect(traceKindsOf("off", TRACE_HOLD_KINDS)).toEqual([]);
    expect(traceKindsOf("mcp,session", TRACE_HOLD_KINDS)).toEqual(["session", "mcp"]);
    expect(traceKindsOf("session,kernel", TRACE_HOLD_KINDS)).toEqual(["session"]);
  });

  it("writes the kinds in their order, and refuses a kind that is not traceable", () => {
    expect(traceKindsText([])).toBe("off");
    expect(traceKindsText(["docker", "session"])).toBe("session,docker");
    expect(() => traceKindsText(["session", "kernel"])).toThrow(RangeError);
  });
});

describe("TraceBook (H188)", () => {
  it("names each start with its owner, its parent and its program, and counts the failed starts", () => {
    const book = new TraceBook();
    expect(book.summary(0, idle, () => null)).toBeNull();
    book.root(1, { pid: 10, name: "claude.exe", owner: "session:shop", kind: "session", lease: null }, 0);
    const events: TraceEvent[] = [start(1, 10, 1, "claude.exe", 0), start(1, 11, 10, "bash.exe", 1 * S)];
    for (let index = 0; index < 30; index++) events.push(start(1, 100 + index, 11, "git.exe", 2 * S + index), exit(1, 100 + index, 0, 3 * S));
    for (let index = 0; index < 6; index++) events.push(start(1, 200 + index, 11, "gh.exe", 4 * S), exit(1, 200 + index, DLL_INIT_FAILED, 4 * S));
    // A nested job gives a second message for a start that the book has.
    events.push(start(2, 11, 10, "bash.exe", 1 * S));
    book.add(events, { leases: [], kindOf: kinds, processes: [] });
    const traced = book.summary(MIN, { jobs: 1, failure: null }, (spanMs) => (spanMs === MIN ? 74 : null));
    expect(traced).toMatchObject({ perMinute: 37, failedPerMinute: 6, spanMs: MIN, processes: 2, jobs: 1, refused: 0, failure: null });
    // 37 of the 74 starts of the computer.
    expect(traced?.coverage).toBe(0.5);
    expect(traced?.sources).toEqual([
      { owner: "session:shop", kind: "session", parent: "bash.exe", name: "git.exe", perMinute: 30, failedPerMinute: 0 },
      { owner: "session:shop", kind: "session", parent: "bash.exe", name: "gh.exe", perMinute: 6, failedPerMinute: 6 },
    ]);
    expect(traced?.named).toBeCloseTo(36 / 37, 3);
  });

  it("gives the starts under a granted lease to the holder of the lease", () => {
    const book = new TraceBook();
    const lease = grantedLease(30, "client");
    book.root(1, { pid: 30, name: "node.exe", owner: "session:client", kind: "session", lease: lease.id }, 0);
    // The child of `headroom run` and its child: both are in the lease.
    book.add([start(1, 31, 30, "pnpm.exe", S), start(1, 32, 31, "node.exe", 2 * S)], { leases: [lease], kindOf: kinds, processes: [] });
    const traced = book.summary(MIN, idle, () => null);
    expect(traced?.sources.map((each) => [each.owner, each.parent, each.name])).toEqual([
      // The same count: the names decide the order.
      ["session:client", "pnpm.exe", "node.exe"],
      ["session:client", "node.exe", "pnpm.exe"],
    ]);
    expect(traced?.coverage).toBeNull();
  });

  it("keeps the sources to 90 % of the starts, and at most 12", () => {
    const book = new TraceBook();
    book.root(1, { pid: 10, name: "claude.exe", owner: "session:shop", kind: "session", lease: null }, 0);
    const events: TraceEvent[] = [];
    let pid = 1000;
    // 20 programs with 100 starts each, and one with 1000: 3000 starts.
    for (let index = 0; index < 1000; index++) events.push(start(1, pid++, 10, "git.exe", S));
    for (let program = 0; program < 20; program++) for (let index = 0; index < 100; index++) events.push(start(1, pid++, 10, `tool${String(program).padStart(2, "0")}.exe`, S));
    book.add(events, { leases: [], kindOf: kinds, processes: [] });
    const traced = book.summary(MIN, idle, () => null);
    expect(traced?.sources).toHaveLength(12);
    expect(traced?.sources[0]?.name).toBe("git.exe");
    expect(traced?.named).toBeCloseTo(2100 / 3000, 3);
    // With few programs, the list stops at 90 %.
    const small = new TraceBook();
    small.root(1, { pid: 10, name: "claude.exe", owner: "session:shop", kind: "session", lease: null }, 0);
    const few: TraceEvent[] = [];
    for (let index = 0; index < 95; index++) few.push(start(1, 2000 + index, 10, "git.exe", S));
    for (let index = 0; index < 5; index++) few.push(start(1, 3000 + index, 10, "gh.exe", S));
    small.add(few, { leases: [], kindOf: kinds, processes: [] });
    expect(small.summary(MIN, idle, () => null)?.sources.map((each) => each.name)).toEqual(["git.exe"]);
  });

  it("takes the name of a parent out of the trace from the read of the processes", () => {
    const book = new TraceBook();
    book.root(1, { pid: 10, name: "claude.exe", owner: "session:shop", kind: "session", lease: null }, 0);
    // The process 50 started before its job: its name comes from the read.
    book.add([start(1, 51, 50, "git.exe", S), start(1, 52, null, null, S)], { leases: [], kindOf: kinds, processes: [p(50, 10, "bash.exe", -S)] });
    expect(book.summary(MIN, idle, () => null)?.sources.map((each) => [each.parent, each.name])).toEqual([
      ["?", "?"],
      ["bash.exe", "git.exe"],
    ]);
  });

  it("prunes the ended processes, forgets the old counts, and starts the rates again after a sleep", () => {
    const book = new TraceBook(10 * MIN);
    book.root(1, { pid: 10, name: "claude.exe", owner: "session:shop", kind: "session", lease: null }, 0);
    book.add([start(1, 11, 10, "bash.exe", S)], { leases: [], kindOf: kinds, processes: [] });
    book.refuse(70, 5);
    // The read has no process 11 and no process 70: the exit of 11 did not come.
    book.prune([p(10, 1, "claude.exe", -S)], 20 * S);
    expect(book.covers(11)).toBe(false);
    expect(book.covers(10)).toBe(true);
    expect(book.refused(70, 5)).toBe(false);
    book.cpu(0, 0);
    book.cpu(MIN, 30);
    expect(book.summary(MIN, idle, () => null)).toMatchObject({ perMinute: 1, cpuMsPerMinute: 30 });
    book.gap(5 * MIN);
    expect(book.summary(6 * MIN, idle, () => null)).toMatchObject({ perMinute: 0, spanMs: MIN, cpuMsPerMinute: 0 });
  });

  it("gives the failure of the trace before the first root", () => {
    const book = new TraceBook();
    const traced = book.summary(MIN, { jobs: 0, failure: "the trace did not start: no port" }, () => null);
    expect(traced).toMatchObject({ spanMs: 0, failure: "the trace did not start: no port" });
    expect(traceLines(traced)).toEqual(["Traced starts: none. The trace stopped: the trace did not start: no port."]);
  });
});

describe("traceCovers (H188)", () => {
  const owners: Owners = {
    ownerOf: new Map([
      [10, "session:shop"],
      [11, "session:shop"],
      [12, "session:shop"],
      [20, "browser"],
      [30, "session:client"],
      [31, "session:client"],
    ]),
    kindOf: kinds,
    leaseOf: new Map([[31, "L1"]]),
  };
  const processes = [
    p(4, 0, "System", 0),
    p(10, 1, "claude.exe", 0),
    p(11, 10, "bash.exe", 50 * S),
    // Too young: its start message in the job of its parent can still come.
    p(12, 10, "git.exe", 58 * S),
    p(20, 1, "chrome.exe", 0),
    p(31, 30, "node.exe", 40 * S),
  ];

  it("gives the leased processes first, then the oldest of the traced kinds", () => {
    const book = new TraceBook();
    const covers = traceCovers(book, { processes, owners, leases: [grantedLease(30, "client")], kinds: TRACED_KINDS, self: 99, now: 60 * S });
    expect(covers.map((each) => [each.root.pid, each.root.owner, each.root.lease])).toEqual([
      [31, "session:client", "L1"],
      [10, "session:shop", null],
      [11, "session:shop", null],
    ]);
  });

  it("skips the daemon, the processes in the trace and the refused processes, and stops at the cap", () => {
    const book = new TraceBook();
    book.root(1, { pid: 10, name: "claude.exe", owner: "session:shop", kind: "session", lease: null }, 0);
    book.refuse(11, 50 * S);
    expect(traceCovers(book, { processes, owners, leases: [], kinds: TRACED_KINDS, self: 31, now: 60 * S })).toEqual([]);
    // A new process with the ID of a refused process is not the same process.
    expect(traceCovers(book, { processes: [p(11, 10, "bash.exe", 51 * S)], owners, leases: [], kinds: TRACED_KINDS, self: 99, now: 60 * S })).toHaveLength(1);
    const many = Array.from({ length: COVERS_PER_READ + 50 }, (_, index) => p(1000 + index, 10, "node.exe", 0));
    const manyOwners: Owners = { ...owners, ownerOf: new Map(many.map((info) => [info.pid, "session:shop"])) };
    expect(traceCovers(new TraceBook(), { processes: many, owners: manyOwners, leases: [], kinds: TRACED_KINDS, self: 99, now: 60 * S })).toHaveLength(COVERS_PER_READ);
    expect(traceCovers(new TraceBook(), { processes, owners, leases: [], kinds: [], self: 99, now: 60 * S })).toEqual([]);
  });
});

describe("the traced starts in the starts, the status and the alert (H188)", () => {
  const traced: TracedStarts = {
    perMinute: 900,
    coverage: 0.9,
    failedPerMinute: 12,
    sources: [
      { owner: "session:shop", kind: "session", parent: "bash.exe", name: "git.exe", perMinute: 600, failedPerMinute: 0 },
      { owner: "mcp:vex", kind: "mcp", parent: "node.exe", name: "cmd.exe", perMinute: 250, failedPerMinute: 12 },
    ],
    named: 0.944,
    spanMs: 10 * MIN,
    processes: 40,
    jobs: 12,
    refused: 1,
    cpuMsPerMinute: 85,
    failure: null,
  };
  const starts: ProcessStarts = {
    ...NO_STARTS,
    perMinute: 1000,
    exact: true,
    spanMs: 10 * MIN,
    owners: [{ owner: "session:shop", kind: "session", perMinute: 700, jobsPerMinute: 0, ownPerMinute: 700 }, { owner: "browser", kind: "browser", perMinute: 40, jobsPerMinute: 0, ownPerMinute: 40 }],
  };

  it("gives an owner the higher of its two rates, and adds an owner that only the trace has", () => {
    const joined = withTrace(starts, traced);
    expect(joined.owners.map((each) => [each.owner, each.perMinute])).toEqual([
      ["session:shop", 700],
      ["mcp:vex", 250],
      ["browser", 40],
    ]);
    expect(joined.traced).toBe(traced);
    expect(withTrace(starts, null)).toBe(starts);
  });

  it("writes the lines of the status and the sources of the alert", () => {
    expect(traceLines(traced)).toEqual([
      "Traced starts: 900 a minute, 90 % of all the starts. 12 a minute failed with 0xC0000142. The trace used 85 ms of processor time a minute, with 12 jobs and 40 live processes.",
      "  Most: session:shop bash.exe > git.exe 600, mcp:vex node.exe > cmd.exe 250, 12 failed.",
    ]);
    // 94.4 % of the traced starts, and the trace has 90 % of all the starts: the sources hold 85 % of all the starts.
    expect(tracedSourcesText(traced)).toBe(" Sources: session:shop bash.exe > git.exe 600, mcp:vex node.exe > cmd.exe 250, 12 failed (85 % of all the starts). 12 a minute failed with 0xC0000142.");
    expect(tracedSourcesText(null)).toBe("");
  });

  it("adds the line of the start log (H193)", () => {
    const log = { path: "starts.db", starts: 12_400, withCommand: 12_276, withCreated: 12_400, adopted: 0, exits: 12_380, commits: 9000, writeMs: 4100, slowestWriteMs: 38, slowestLagMs: 141, failure: null };
    expect(traceLines({ ...traced, log }).at(-1)).toBe(
      "  Start log: 12,400 starts and 12,380 exits since the start of the daemon, 99 % with a command line. The longest time from the creation of a new process to its row on the disk was 141 ms. headroom starts --top ranks the starters.",
    );
    expect(startLogText({ ...log, adopted: 560 })).toContain("99 % with a command line. It also has 560 processes that ran before the trace put them in a job. The longest");
    expect(startLogText({ ...log, starts: 0, adopted: 1 })).toBe("Start log: no start yet, in starts.db. It also has 1 process that ran before the trace put it in a job.");
    expect(startLogText({ ...log, starts: 0 })).toBe("Start log: no start yet, in starts.db.");
    expect(startLogText({ ...log, failure: "the start log stopped at a write: disk I/O error" })).toBe(
      "Start log: the start log stopped at a write: disk I/O error. 12,400 starts are in starts.db.",
    );
    expect(startLogText(null)).toBeNull();
  });

  it("gives the instances procs:traced and procs:failed, and the churn alert names the sources", () => {
    const resources = RESOURCES.get("procs")?.measure.read({ starts: withTrace(starts, traced) } as Readings) ?? [];
    expect(resources.map((each) => [each.id, each.used])).toEqual([
      ["procs", 1000],
      ["procs:traced", 900],
      ["procs:failed", 12],
    ]);
  });
});

describe("Engine start trace (H188)", () => {
  it("puts no process in a job before the reader of the trace runs (H193)", () => {
    let now = 1_000_000;
    let ready = false;
    const covered: number[] = [];
    const fake: StartTrace = {
      cover: (pid) => {
        covered.push(pid);
        return covered.length;
      },
      drain: () => [],
      cpuMs: () => 0,
      jobs: () => covered.length,
      failure: () => null,
      ready: () => ready,
      close: () => undefined,
    };
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
      processes: () => [p(4, 0, "System", 0), p(77, 1, "bash.exe", now - MIN)],
      processSequence: () => 5000,
      startTrace: () => fake,
      close: () => undefined,
    };
    const engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, sessionsDir: "/nowhere" });
    engine.setConfig({ startTrace: ["other"] });
    engine.tick();
    expect(covered).toEqual([]);
    ready = true;
    now += 10 * S;
    engine.tick();
    expect(covered).toEqual([77]);
    engine.close();
  });

  it("puts the traced processes in jobs, names their starts, and stops the trace with the setting", () => {
    let now = 1_000_000;
    let sequence = 5000;
    // The parent 1 is gone, so the processes are not in the tree of System.
    let list: ProcessInfo[] = [p(4, 0, "System", 0), p(77, 1, "bash.exe", now - MIN), p(78, 1, "protected.exe", now - MIN)];
    let pending: TraceEvent[] = [];
    const covered: number[] = [];
    let closed = 0;
    const fake: StartTrace = {
      cover: (pid) => {
        if (pid === 78) return null;
        covered.push(pid);
        return covered.length;
      },
      drain: () => {
        const out = pending;
        pending = [];
        return out;
      },
      cpuMs: () => (now - 1_000_000) / 1000,
      jobs: () => covered.length,
      failure: () => null,
      close: () => {
        closed++;
      },
    };
    let started = 0;
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
      processes: () => list,
      processSequence: () => sequence,
      startTrace: () => {
        started++;
        return fake;
      },
      close: () => undefined,
    };
    const engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, sessionsDir: "/nowhere" });
    // No session here, so the processes have the owner kind other.
    expect(engine.setConfig({ startTrace: ["other"] }).startTrace).toEqual(["other"]);
    engine.tick();
    expect(covered).toEqual([77]);
    now += 10 * S;
    sequence += 100;
    for (let index = 0; index < 50; index++) pending.push(start(1, 1000 + index, 77, "git.exe", now - 5 * S), exit(1, 1000 + index, index === 0 ? DLL_INIT_FAILED : 0, now - 4 * S));
    engine.tick();
    const traced = engine.status().starts.traced;
    // 50 of the 100 starts of the computer in 10 seconds. Process 78 refused its job, and a read does not try it again.
    expect(traced).toMatchObject({ perMinute: 300, coverage: 0.5, failedPerMinute: 6, jobs: 1, refused: 1, failure: null });
    expect(traced?.sources[0]).toMatchObject({ owner: "other", parent: "bash.exe", name: "git.exe", perMinute: 300 });
    expect(engine.status().resources.filter((each) => each.kind === "procs").map((each) => [each.id, each.used])).toEqual([
      ["procs", 600],
      ["procs:traced", 300],
      ["procs:failed", 6],
    ]);
    expect(engine.setConfig({ startTrace: [] }).startTrace).toEqual([]);
    expect(closed).toBe(1);
    now += 10 * S;
    engine.tick();
    expect(engine.status().starts.traced).toBeUndefined();
    expect(() => engine.setConfig({ startTrace: ["kernel"] })).toThrow(RangeError);
    expect(engine.setConfig({ startTrace: null }).startTrace).toEqual(TRACED_KINDS);
    engine.close();
    expect(started).toBe(1);
  });

  it("gives a held job to the held kinds, and changes the open jobs with the setting (H191)", () => {
    let now = 1_000_000;
    const list: ProcessInfo[] = [p(4, 0, "System", 0), p(77, 1, "bash.exe", now - MIN), p(78, 1, "node.exe", now - MIN)];
    const covers: [number, TraceCoverOptions | undefined][] = [];
    const limits: [number, boolean][] = [];
    const fake: StartTrace = {
      cover: (pid, options) => {
        covers.push([pid, options]);
        return covers.length;
      },
      limit: (key, hold) => {
        limits.push([key, hold]);
        return true;
      },
      drain: () => [],
      cpuMs: () => 0,
      jobs: () => covers.length,
      failure: () => null,
      close: () => undefined,
    };
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
      processes: () => list,
      processSequence: () => 0,
      startTrace: () => fake,
      close: () => undefined,
    };
    const engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, sessionsDir: "/nowhere" });
    // By default only the sessions are held. These processes have the kind other, so their jobs let a child break away.
    expect(engine.setConfig({ startTrace: ["other"] }).startTraceHold).toEqual(["session"]);
    engine.tick();
    expect(covers).toEqual([
      [77, { hold: false }],
      [78, { hold: false }],
    ]);
    // A change of the setting changes the limits of each open job.
    expect(engine.setConfig({ startTraceHold: ["other"] }).startTraceHold).toEqual(["other"]);
    expect(limits).toEqual([
      [1, true],
      [2, true],
    ]);
    list.push(p(79, 1, "git.exe", now - MIN));
    now += 10 * S;
    engine.tick();
    expect(covers[2]).toEqual([79, { hold: true }]);
    // Off takes back the hold of each open job at once.
    expect(engine.setConfig({ startTraceHold: [] }).startTraceHold).toEqual([]);
    expect(limits.slice(2)).toEqual([
      [1, false],
      [2, false],
      [3, false],
    ]);
    expect(() => engine.setConfig({ startTraceHold: ["kernel"] })).toThrow(RangeError);
    expect(engine.setConfig({ startTraceHold: null }).startTraceHold).toEqual(["session"]);
    engine.close();
  });

  it("shows a trace that did not start, and does not try again until a change of the setting", () => {
    let starts = 0;
    let now = 1_000_000;
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
      processes: () => [p(4, 0, "System", 0)],
      processSequence: () => 0,
      startTrace: () => {
        starts++;
        throw new Error("no port");
      },
      close: () => undefined,
    };
    const engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, sessionsDir: "/nowhere" });
    engine.tick();
    now += 10 * S;
    engine.tick();
    expect(starts).toBe(1);
    expect(engine.status().starts.traced).toMatchObject({ failure: "the trace did not start: no port" });
    engine.setConfig({ startTrace: ["session"] });
    now += 10 * S;
    engine.tick();
    expect(starts).toBe(2);
    engine.close();
  });
});

// The real trace of Windows: job objects, the completion port and the reader thread.
/** The limit flag of a job that lets a child break away. */
const BREAKAWAY_OK = 0x800;
describe.skipIf(process.platform !== "win32")("the start trace of Windows (H188)", () => {
  /** This function starts the trace and waits for its reader, as the engine does (H193). */
  async function readyTrace(options: StartTraceOptions = {}): Promise<StartTrace> {
    const { windowsStartTrace } = await import("./trace-windows.ts");
    const trace = windowsStartTrace(options);
    for (let tries = 0; tries < 100 && trace.ready?.() !== true; tries++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(trace.ready?.()).toBe(true);
    return trace;
  }

  it("names the children of a covered process with their parent, gives the exit code of a failed start, and logs them", async () => {
    const folder = mkdtempSync(join(tmpdir(), "headroom-trace-log-"));
    const logPath = join(folder, "starts.db");
    const trace = await readyTrace({ logPath });
    const script = `process.stdin.once("data", () => {
      const { spawnSync } = require("node:child_process");
      for (let i = 0; i < 5; i++) spawnSync("cmd.exe", ["/c", "exit 3"]);
      process.stdout.write("done");
      process.stdin.once("data", () => process.exit(0));
    });`;
    const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "inherit"] });
    try {
      await new Promise((resolve) => child.once("spawn", resolve));
      const key = trace.cover(child.pid ?? 0);
      expect(key).not.toBeNull();
      expect(trace.jobs()).toBe(1);
      child.stdin?.write("go\n");
      await new Promise((resolve) => child.stdout?.once("data", resolve));
      // The reader sends a batch at least each second. The loop waits for the 5 starts of cmd.exe and for their exits. An
      // exit of another process of the job, for example of a conhost.exe, does not count (H207: a loop that stopped at 5
      // exits of any process saw 4 starts of cmd.exe on Windows CI).
      const events: TraceEvent[] = [];
      const cmdStarts = (): Extract<TraceEvent, { type: "start" }>[] =>
        events.filter((each): each is Extract<TraceEvent, { type: "start" }> => each.type === "start" && each.name?.toLowerCase() === "cmd.exe");
      const cmdExits = (): number => {
        const pids = new Set(cmdStarts().map((each) => each.pid));
        return events.filter((each) => each.type === "exit" && pids.has(each.pid)).length;
      };
      for (let tries = 0; tries < 100 && (cmdStarts().length < 5 || cmdExits() < 5); tries++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        events.push(...trace.drain());
      }
      const starts = cmdStarts();
      expect(starts).toHaveLength(5);
      expect(starts.every((each) => each.ppid === child.pid && each.key === key)).toBe(true);
      const exits = events.filter((each): each is Extract<TraceEvent, { type: "exit" }> => each.type === "exit" && starts.some((started) => started.pid === each.pid));
      expect(exits.map((each) => each.exitCode)).toEqual([3, 3, 3, 3, 3]);
      expect(trace.failure()).toBeNull();
      // The start log has each cmd.exe with its command line, the command line of its parent, and its exit (H193).
      for (let tries = 0; tries < 30 && (trace.log?.()?.exits ?? 0) < 5; tries++) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(trace.log?.()).toMatchObject({ path: logPath, failure: null });
      expect(trace.log?.()?.slowestLagMs).toBeLessThan(5000);
      const db = openStartLog(logPath);
      try {
        for (const started of starts) {
          const [logged] = startsOfPid(db, started.pid);
          expect(logged).toMatchObject({ ppid: child.pid, exit: { exitCode: 3 } });
          expect(logged?.image?.toLowerCase()).toMatch(/\\cmd\.exe$/);
          expect(logged?.command).toContain("exit 3");
          expect(logged?.parentCommand).toContain("spawnSync");
          expect(logged?.createdAt).not.toBeNull();
        }
      } finally {
        db.close();
      }
      child.stdin?.write("end\n");
      await new Promise((resolve) => child.once("exit", resolve));
      for (let tries = 0; tries < 30 && trace.jobs() > 0; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        trace.drain();
      }
      // The last process of the job ended, so the trace closed the job.
      expect(trace.jobs()).toBe(0);
      expect(trace.cpuMs()).toBeGreaterThanOrEqual(0);
    } finally {
      if (child.exitCode === null) child.kill();
      trace.close();
      // The reader closes the log when it stops. A file that it still holds stays in the temp folder.
      for (let tries = 0; tries < 20; tries++) {
        try {
          rmSync(folder, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
  }, 30_000);

  it("gives a held job no breakaway, and changes the limits of an open job (H191)", async () => {
    const trace = await readyTrace();
    // The child gives the limit flags of its innermost job at each line on its standard input: the job of the trace.
    const jobs = new URL("./jobs.ts", import.meta.url).href;
    const script = `import { ownJobFlags } from ${JSON.stringify(jobs)};
      process.stdin.on("data", () => process.stdout.write(String(ownJobFlags()) + "\\n"));`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "inherit"] });
    const flags = async (): Promise<number> => {
      const line = new Promise<string>((resolve) => child.stdout?.once("data", (chunk) => resolve(String(chunk))));
      child.stdin?.write("?\n");
      return Number((await line).trim());
    };
    try {
      await new Promise((resolve) => child.once("spawn", resolve));
      const key = trace.cover(child.pid ?? 0, { hold: true });
      expect(key).not.toBeNull();
      if (key === null) return;
      expect((await flags()) & BREAKAWAY_OK).toBe(0);
      expect(trace.limit?.(key, false)).toBe(true);
      expect((await flags()) & BREAKAWAY_OK).toBe(BREAKAWAY_OK);
      expect(trace.limit?.(key, true)).toBe(true);
      expect((await flags()) & BREAKAWAY_OK).toBe(0);
      // A key that is not open changes nothing.
      expect(trace.limit?.(key + 1000, false)).toBe(false);
    } finally {
      child.kill();
      trace.close();
    }
  }, 30_000);

  it("refuses a process that is gone", async () => {
    const trace = await readyTrace();
    try {
      const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
      expect(trace.cover(Number(gone.stdout))).toBeNull();
      expect(trace.jobs()).toBe(0);
    } finally {
      trace.close();
    }
  });
});
