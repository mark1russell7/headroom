import { describe, expect, it } from "vitest";
import { Broker, type Lease } from "./broker.ts";
import { attribute } from "./owners.ts";
import { leasesOf, type Owners } from "./resources.ts";
import { random } from "@mark1russell7/rigor-generators";
import {
  isNewProcess,
  RATE_STEP_MAX_MS,
  RECENT_STARTS_MS,
  startCost,
  startCostText,
  startsFromRates,
  StartTracker,
  startsLine,
  STARTS_WINDOW_MS,
  type RatePoint,
} from "./starts.ts";
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

describe("StartTracker recent rate (H31)", () => {
  it("stays exact after a read with no sequence number, and counts the misses (2026-11-17)", () => {
    const tracker = new StartTracker();
    const list = second;
    tracker.read(0, list, ownersOf(list, []), 1000);
    tracker.read(10 * S, list, ownersOf(list, []), 1100);
    // The 4 newest processes ended before the read opened them: no number. Two reads miss.
    tracker.read(20 * S, list, ownersOf(list, []), undefined);
    tracker.read(30 * S, list, ownersOf(list, []), undefined);
    // The next number counts the starts of the misses too: 500 in 50 seconds.
    tracker.read(60 * S, list, ownersOf(list, []), 1600);
    expect(tracker.summary(60 * S)).toMatchObject({ perMinute: 600, exact: true, sequenceMisses: 2, spanMs: 60 * S });
    expect(tracker.recent(60 * S, 60 * S)).toBe(600);
    // Only misses in the window: a lower bound.
    tracker.read(70 * S, list, ownersOf(list, []), undefined);
    expect(tracker.recent(70 * S, 10 * S)).toBe(0);
    expect(tracker.summary(60 * S + STARTS_WINDOW_MS)).toMatchObject({ exact: false, sequenceMisses: 1 });
  });

  it("gives the exact starts of the computer over the last 2 minutes, for starts<N", () => {
    const tracker = new StartTracker();
    expect(tracker.recent(0)).toBeNull();
    tracker.read(0, first, ownersOf(first, []), 1000);
    expect(tracker.recent(0)).toBeNull();
    // A burst: 600 starts in 60 seconds, then a quiet minute and a half with 30 starts.
    let sequence = 1000;
    for (let at = 10 * S; at <= 60 * S; at += 10 * S) tracker.read(at, second, ownersOf(second, []), (sequence += 100));
    expect(tracker.recent(60 * S)).toBe(600);
    for (let at = 70 * S; at <= 150 * S; at += 10 * S) tracker.read(at, second, ownersOf(second, []), (sequence += at % (30 * S) === 0 ? 10 : 0));
    // The window of 2 minutes holds the reads from 40 to 150 seconds: 330 starts in 120 seconds.
    expect(tracker.recent(150 * S)).toBe(165);
    expect(tracker.summary(150 * S).perMinute).toBe(252);
    expect(tracker.recent(150 * S, 30 * S)).toBe(20);
    expect(RECENT_STARTS_MS).toBe(120 * S);
  });

  it("gives a lower bound without the sequence numbers", () => {
    const tracker = new StartTracker();
    tracker.read(0, first, ownersOf(first, []));
    tracker.read(10 * S, second, ownersOf(second, []));
    // The second read finds 5 new processes in 10 seconds.
    expect(tracker.recent(10 * S)).toBe(30);
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

describe("startsFromRates (H63)", () => {
  const MIN = 60_000;
  const T0 = Date.UTC(2026, 10, 18, 12, 0);
  /** One sample each minute from `from` to `to`, both included, with the rate that `rate` gives for each time. */
  const samples = (from: number, to: number, rate: (at: number) => number | null, step = MIN): RatePoint[] => {
    const points: RatePoint[] = [];
    for (let at = from; at <= to; at += step) points.push([at, rate(at)]);
    return points;
  };

  it("counts a steady rate over the window, also when the samples do not fall on its ends", () => {
    expect(startsFromRates(samples(T0 - MIN, T0 + 60 * MIN, () => 100), T0, T0 + 60 * MIN)).toBeCloseTo(6000, 6);
    // Samples at 30 seconds past each minute: the first and the last step count only their parts in the window.
    expect(startsFromRates(samples(T0 - MIN / 2, T0 + 60 * MIN + MIN / 2, () => 100), T0, T0 + 60 * MIN)).toBeCloseTo(6000, 6);
    // Each step counts the rate of its later sample.
    expect(startsFromRates([[T0, 999], [T0 + MIN, 10], [T0 + 2 * MIN, 20]], T0, T0 + 2 * MIN)).toBeCloseTo(30, 6);
  });

  it("covers a short gap at the rate of the steps, and gives null when the steps cover less than 90 % of the window", () => {
    const withGap = (gapMinutes: number): RatePoint[] =>
      samples(T0 - MIN, T0 + 60 * MIN, () => 100).filter(([at]) => at <= T0 + 20 * MIN || at >= T0 + (20 + gapMinutes) * MIN);
    // A step of 5 minutes counts. A step of 6 minutes is a gap: 54 of the 60 minutes are covered, so the count is scaled.
    expect(startsFromRates(withGap(RATE_STEP_MAX_MS / MIN), T0, T0 + 60 * MIN)).toBeCloseTo(6000, 6);
    expect(startsFromRates(withGap(6), T0, T0 + 60 * MIN)).toBeCloseTo(6000, 6);
    expect(startsFromRates(withGap(7), T0, T0 + 60 * MIN)).toBeNull();
    // A sample with no rate is a gap too.
    const missing = samples(T0 - MIN, T0 + 60 * MIN, (at) => (at > T0 + 10 * MIN && at <= T0 + 17 * MIN ? null : 100));
    expect(startsFromRates(missing, T0, T0 + 60 * MIN)).toBeNull();
    expect(startsFromRates([], T0, T0 + 60 * MIN)).toBeNull();
    expect(startsFromRates(samples(T0, T0 + 10 * MIN, () => 100), T0 + 5 * MIN, T0 + 5 * MIN)).toBeNull();
  });

  it("adds over two windows that meet and scales with the rate, for 20 seeds", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const draw = random(`h63-rates-${seed}`);
      const rates = new Map<number, number>();
      const points = samples(T0 - MIN, T0 + 120 * MIN, (at) => {
        const rate = draw.int(0, 3000);
        rates.set(at, rate);
        return rate;
      });
      const from = T0 + draw.int(0, 30 * MIN);
      const middle = from + draw.int(10 * MIN, 40 * MIN);
      const to = middle + draw.int(10 * MIN, 40 * MIN);
      const whole = startsFromRates(points, from, to);
      const first = startsFromRates(points, from, middle);
      const second = startsFromRates(points, middle, to);
      expect(whole, `seed ${seed}`).not.toBeNull();
      expect((first ?? 0) + (second ?? 0), `seed ${seed}`).toBeCloseTo(whole ?? 0, 6);
      const doubled = points.map(([at, rate]): RatePoint => [at, rate === null ? null : 2 * rate]);
      expect(startsFromRates(doubled, from, to), `seed ${seed}`).toBeCloseTo(2 * (whole ?? 0), 6);
      // The reference: the sum over the whole minutes of the window of the rate of the sample at the end of each minute.
      const aligned = Math.ceil((from - T0) / MIN) * MIN + T0;
      const end = Math.floor((to - T0) / MIN) * MIN + T0;
      let inner = 0;
      for (let at = aligned + MIN; at <= end; at += MIN) inner += rates.get(at) ?? 0;
      expect(startsFromRates(points, aligned, end), `seed ${seed}`).toBeCloseTo(inner, 6);
    }
  });
});

describe("startCost and startCostText (H63)", () => {
  it("gives the growth for each start and its text", () => {
    const cost = startCost(60.4, 310.2, 84_213.6);
    expect(cost).toEqual({ minutes: 60, growthMb: 310, starts: 84_214, bytesPerStart: 3862 });
    expect(startCostText(cost)).toBe(
      "Process starts: 84,214 in the last 60 minutes. The kernel pools grew 310 MB in that time, 3.8 KB for each start. Fewer starts slow this growth with no reboot.",
    );
    expect(startCostText(startCost(60, 0.5, 2000))).toBe(
      "Process starts: 2,000 in the last 60 minutes. The kernel pools grew 1 MB in that time, 262 B for each start. Fewer starts slow this growth with no reboot.",
    );
  });

  it("gives no cost for each start with no starts or when the pools did not grow", () => {
    expect(startCost(55, -40, 50_000).bytesPerStart).toBeNull();
    expect(startCostText(startCost(55, -40, 50_000))).toBe("Process starts: 50,000 in the last 55 minutes. The kernel pools fell 40 MB in that time.");
    expect(startCostText(startCost(55, 0, 50_000))).toBe("Process starts: 50,000 in the last 55 minutes. The kernel pools did not grow in that time.");
    expect(startCost(55, 12, 0).bytesPerStart).toBeNull();
  });
});
