import { describe, expect, it } from "vitest";
import { Broker, type Lease } from "./broker.ts";
import { attribute } from "./owners.ts";
import { leasesOf, type Owners } from "./resources.ts";
import { isNewProcess, StartTracker, startsLine, STARTS_WINDOW_MS } from "./starts.ts";
import type { ProcessInfo } from "./types.ts";

const S = 1000;
const p = (pid: number, ppid: number, name: string, startedAt: number | undefined): ProcessInfo => ({ pid, ppid, name, privateMb: 1, workingMb: 1, startedAt });
const sessions = [
  { pid: 10, name: "client", sessionId: "a", status: null, cwd: null },
  { pid: 20, name: "organizer", sessionId: "b", status: null, cwd: null },
];

function ownersOf(processes: readonly ProcessInfo[], leases: readonly Lease[], list: typeof sessions = sessions): Owners {
  const { owners, ownerOf } = attribute(processes, list);
  return { ownerOf, kindOf: new Map(owners.map((owner) => [owner.owner, owner.kind])), leaseOf: leasesOf(processes, leases) };
}

/** The lease of `headroom run` (process 30, under the session client), with the name of a job of another project. */
function grantedLease(pid = 30, holder = "client", job = "coeval-063-test-compiler"): Lease {
  const broker = new Broker({ now: () => 0, newId: () => "L1", isAlive: () => true });
  broker.request({ holder, job, amounts: {}, pid });
  broker.tick({ totalMb: 1000, availableMb: 1000, pools: {} });
  const lease = broker.get("L1");
  if (lease === undefined) throw new Error("no lease");
  return lease;
}

// The first read: the two sessions, `headroom run` under the session client, an old service and the idle process.
const first = [p(0, 0, "[System Process]", undefined), p(10, 1, "claude.exe", -500 * S), p(20, 1, "claude.exe", -400 * S), p(30, 10, "node.exe", -1 * S), p(60, 1, "svchost.exe", -100 * S)];
// The second read, 10 seconds later: a pipeline of the session client, a test of the lease, a command of the organizer,
// and a new process with the ID 60 of the ended service.
const second = [
  ...first.filter((info) => info.pid !== 60),
  p(41, 10, "bash.exe", 5 * S),
  p(42, 41, "gh.exe", 6 * S),
  p(43, 30, "node.exe", 7 * S),
  p(51, 20, "git.exe", 8 * S),
  p(60, 10, "tr.exe", 9 * S),
];

describe("isNewProcess", () => {
  it("finds a new ID, an ID in use again and no old process", () => {
    expect(isNewProcess(p(5, 1, "a.exe", 12 * S), undefined, 10 * S)).toBe(true);
    expect(isNewProcess(p(5, 1, "a.exe", 12 * S), { startedAt: 2 * S }, 10 * S)).toBe(true);
    expect(isNewProcess(p(5, 1, "a.exe", 2 * S), { startedAt: 2 * S }, 10 * S)).toBe(false);
    // The previous read missed a process that started long before it.
    expect(isNewProcess(p(5, 1, "a.exe", -60 * S), undefined, 10 * S)).toBe(false);
    expect(isNewProcess(p(0, 0, "[System Process]", undefined), undefined, 10 * S)).toBe(false);
  });
});

describe("StartTracker", () => {
  it("counts the new processes of each owner outside the leases, the exact count of each job and the exact total of the computer", () => {
    const lease = grantedLease();
    const tracker = new StartTracker();
    tracker.read(0, first, ownersOf(first, [lease]), 1000);
    expect(tracker.summary(0)).toMatchObject({ perMinute: 0, spanMs: 0, owners: [], jobs: [] });
    const owners = ownersOf(second, [lease]);
    tracker.read(10 * S, second, owners, 1100, [lease]);
    tracker.report(lease, 10 * S, 50, owners);
    const starts = tracker.summary(10 * S);
    // 100 sequence numbers in 10 seconds.
    expect(starts).toMatchObject({ perMinute: 600, exact: true, spanMs: 10 * S });
    // The holder decides the owner of the job, not the name of the job.
    expect(starts.jobs).toEqual([{ id: "L1", job: "coeval-063-test-compiler", holder: "client", owner: "session:client", processes: 50, perMinute: 300 }]);
    // The test of the lease (43) counts in the job, not in the own commands: 41, 42 and 60 are the own commands.
    expect(starts.owners).toEqual([
      { owner: "session:client", kind: "session", perMinute: 318, jobsPerMinute: 300, ownPerMinute: 18 },
      { owner: "session:organizer", kind: "session", perMinute: 6, jobsPerMinute: 0, ownPerMinute: 6 },
    ]);
    expect(startsLine(starts)).toBe(
      "Process starts: 600 a minute. Most (at least): session:client 318 (jobs 300, own commands 18, job coeval-063-test-compiler: 50 so far), session:organizer 6.",
    );
  });

  it("gives a lower bound without the sequence numbers, and the new processes of a lease with no count", () => {
    const lease = grantedLease();
    const tracker = new StartTracker();
    tracker.read(0, first, ownersOf(first, [lease]));
    tracker.read(10 * S, second, ownersOf(second, [lease]), undefined, [lease]);
    const starts = tracker.summary(10 * S);
    // 4 own commands and 1 process of the lease in 10 seconds.
    expect(starts).toMatchObject({ perMinute: 30, exact: false, jobs: [] });
    expect(starts.owners[0]).toEqual({ owner: "session:client", kind: "session", perMinute: 24, jobsPerMinute: 6, ownPerMinute: 18 });
    expect(startsLine(starts)).toBe("Process starts: 30 a minute (at least). Most: session:client 24 (jobs 6, own commands 18), session:organizer 6.");
  });

  it("gives a job to the session of its holder when the process of the lease is not in the read", () => {
    const lease = grantedLease(999);
    const tracker = new StartTracker();
    tracker.read(0, first, ownersOf(first, [lease]), 1000);
    tracker.read(10 * S, first, ownersOf(first, [lease]), 1000);
    tracker.report(lease, 10 * S, 20, ownersOf(first, [lease]));
    expect(tracker.summary(10 * S).jobs[0]).toMatchObject({ owner: "session:client", processes: 20 });
    expect(tracker.summary(10 * S).owners).toEqual([{ owner: "session:client", kind: "session", perMinute: 120, jobsPerMinute: 120, ownPerMinute: 0 }]);
  });

  // The session s7-site (70). The shell between the session and its `headroom run` (31) stopped, so the process tree gives
  // the job to other. The job starts 383 processes in one minute, and each one ends before a read.
  const siteSessions = [...sessions, { pid: 70, name: "s7-site", sessionId: "c", status: null, cwd: null }];
  const site = [...first, p(70, 1, "claude.exe", -300 * S), p(31, 999, "node.exe", -2 * S)];

  it("gives the starts of a job to the session of its holder when the process tree gives the job to other", () => {
    const lease = grantedLease(31, "s7-site", "pnpm test:scripts");
    const tracker = new StartTracker();
    const owners = ownersOf(site, [lease], siteSessions);
    expect(owners.ownerOf.get(31)).toBe("other");
    tracker.read(0, site, owners, 1000, [lease]);
    tracker.read(60 * S, site, owners, 1400, [lease]);
    tracker.report(lease, 60 * S, 383, owners);
    const starts = tracker.summary(60 * S);
    expect(starts.jobs).toEqual([{ id: "L1", job: "pnpm test:scripts", holder: "s7-site", owner: "session:s7-site", processes: 383, perMinute: 383 }]);
    expect(starts.owners).toEqual([{ owner: "session:s7-site", kind: "session", perMinute: 383, jobsPerMinute: 383, ownPerMinute: 0 }]);
    expect(startsLine(starts)).toBe("Process starts: 400 a minute. Most (at least): session:s7-site 383 (jobs 383, own commands 0, job pnpm test:scripts: 383 so far).");
  });

  it("gives the new processes of a lease with no count to its holder, and a holder with no session is its own owner", () => {
    const lease = grantedLease(31, "s7-site", "pnpm test:scripts");
    // A test of the job (32) under the `headroom run` with no parent.
    const busy = [...site, p(32, 31, "node.exe", 5 * S)];
    const withSession = new StartTracker();
    withSession.read(0, site, ownersOf(site, [lease], siteSessions), undefined, [lease]);
    withSession.read(10 * S, busy, ownersOf(busy, [lease], siteSessions), undefined, [lease]);
    expect(withSession.summary(10 * S).owners).toEqual([{ owner: "session:s7-site", kind: "session", perMinute: 6, jobsPerMinute: 6, ownPerMinute: 0 }]);
    // No session has the name s7-site.
    const noSession = new StartTracker();
    noSession.read(0, site, ownersOf(site, [lease]), undefined, [lease]);
    noSession.read(10 * S, busy, ownersOf(busy, [lease]), undefined, [lease]);
    noSession.report(lease, 10 * S, 383, ownersOf(busy, [lease]));
    const starts = noSession.summary(10 * S);
    expect(starts.jobs[0]).toMatchObject({ holder: "s7-site", owner: "s7-site", processes: 383 });
    expect(starts.owners[0]).toMatchObject({ owner: "s7-site", kind: "other", jobsPerMinute: 2298, ownPerMinute: 0 });
  });

  it("forgets the reads and the jobs after the window, and keeps the highest sequence number", () => {
    const lease = grantedLease();
    const tracker = new StartTracker();
    tracker.read(0, first, ownersOf(first, [lease]), 1000);
    tracker.read(10 * S, second, ownersOf(second, [lease]), 1100);
    tracker.report(lease, 10 * S, 50, ownersOf(second, [lease]));
    // The newest live process can be older than the newest process of the previous read: no negative count.
    tracker.read(20 * S, second, ownersOf(second, [lease]), 1090);
    tracker.read(30 * S, second, ownersOf(second, [lease]), 1130);
    expect(tracker.summary(30 * S)).toMatchObject({ perMinute: 260, exact: true, spanMs: 30 * S });
    const later = 30 * S + STARTS_WINDOW_MS;
    tracker.read(later, second, ownersOf(second, [lease]), 1130);
    expect(tracker.summary(later)).toMatchObject({ perMinute: 0, owners: [], jobs: [] });
  });
});

describe("StartTracker after a sleep (H30)", () => {
  it("gives no rate across a gap", () => {
    const tracker = new StartTracker();
    tracker.read(0, first, ownersOf(first, []), 1000);
    tracker.gap(3_600_000);
    // The sequence number grew by 9000 in the sleep, and processes started: the next read only keeps them.
    tracker.read(3_600_000, second, ownersOf(second, []), 10_000);
    expect(tracker.summary(3_600_000).perMinute).toBe(0);
    tracker.read(3_610_000, second, ownersOf(second, []), 10_050);
    expect(tracker.summary(3_610_000)).toMatchObject({ perMinute: 300, exact: true });
  });
});
