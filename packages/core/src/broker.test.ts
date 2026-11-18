import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_RULES, type AlertRules } from "./alerts.ts";
import { Broker, NO_REJOIN_REASON, RECORDED_END_NOTE, type Capacity, type Lease } from "./broker.ts";
import type { LeaseEnd } from "./ends.ts";
import { rooms } from "./resources.ts";

function setup(
  options: { alive?: Set<number>; used?: number; use?: (lease: Lease) => number | null; runMs?: Record<string, number>; longRunMs?: number; ends?: Map<string, LeaseEnd> } = {},
) {
  let now = 1_000_000;
  let next = 0;
  const broker = new Broker({
    now: () => now,
    newId: () => `l${++next}`,
    isAlive: (pid) => options.alive?.has(pid) ?? true,
    used: (lease, id) => (id === "memory" ? (options.use === undefined ? (options.used ?? 0) : options.use(lease)) : null),
    longRunMs: options.longRunMs ?? 1_800_000,
    reserveMb: 1000,
    agingMs: 60_000,
    headWaitMs: 600_000,
    runMs: (lease) => options.runMs?.[lease.job] ?? null,
    backfillMs: 600_000,
    defaultTtlMs: 300_000,
    endOf: (lease) => options.ends?.get(lease.id) ?? null,
  });
  return { broker, advance: (ms: number) => (now += ms) };
}

const cap = (availableMb: number, pools: Record<string, number> = {}): Capacity => ({ totalMb: 16_000, availableMb, pools });

/** A capacity with the room of `cpu` on a computer with 16 logical processors, as the engine gives it. */
const cpuCap = (pools: Record<string, number>): Capacity => ({
  ...cap(8000, pools),
  rooms: rooms(["cpu"], [{ id: "cpu", capacity: 16, used: null, free: null }], pools),
});

/**
 * A capacity with the room of the drive `D:` (200 GB) as the engine gives it: the measured free space, and the critical
 * limit of the disk alert as the reserve. The other ids get the room of a drive with no measurement.
 */
const diskCap = (freeMb: number, limits: AlertRules = DEFAULT_ALERT_RULES, more: readonly string[] = []): Capacity => ({
  ...cap(8000),
  rooms: rooms(["disk:D:", ...more], [{ id: "disk:D:", capacity: 200_000, used: 200_000 - freeMb, free: freeMb }], {}, {}, limits),
});

describe("Broker", () => {
  it("grants a request that fits and holds one that does not", () => {
    const { broker } = setup();
    const a = broker.request({ holder: "shop", job: "build", amounts: { memory: 2000 } });
    const b = broker.request({ holder: "assistant", job: "gate", amounts: { memory: 4000 } });
    const changed = broker.tick(cap(6000));
    expect(broker.get(a.id)?.state).toBe("granted");
    expect(broker.get(b.id)?.state).toBe("waiting");
    expect(broker.get(b.id)?.reason).toMatch(/waits for memory: needs 4000, 3000 free/);
    expect(changed.map((lease) => lease.id)).toEqual(["l1", "l2"]);
  });

  it("counts only the unused part of a granted lease against new requests", () => {
    const { broker } = setup({ used: 1500 });
    broker.request({ holder: "shop", job: "build", amounts: { memory: 2000 }, pid: 10 });
    broker.tick(cap(6000));
    // 6000 available - 1000 reserve - (2000 - 1500 unused) = 4500
    expect(broker.free(cap(6000))["memory"]).toBe(4500);
  });

  it("treats a pool with no capacity as a lock of 1", () => {
    const { broker } = setup();
    const a = broker.request({ holder: "shop", job: "mongo", amounts: { docker: 1 } });
    const b = broker.request({ holder: "assistant", job: "lab", amounts: { docker: 1 } });
    broker.tick(cap(8000));
    expect(broker.get(a.id)?.state).toBe("granted");
    expect(broker.get(b.id)?.state).toBe("waiting");
    broker.release(a.id);
    broker.tick(cap(8000));
    expect(broker.get(b.id)?.state).toBe("granted");
  });

  it("uses a configured pool capacity", () => {
    const { broker } = setup();
    broker.request({ holder: "a", job: "x", amounts: { cpu: 4 } });
    const b = broker.request({ holder: "b", job: "y", amounts: { cpu: 4 } });
    const c = broker.request({ holder: "c", job: "z", amounts: { cpu: 4 } });
    broker.tick(cap(8000, { cpu: 8 }));
    expect(broker.get(b.id)?.state).toBe("granted");
    expect(broker.get(c.id)?.state).toBe("waiting");
  });

  it("grants the higher priority first, and ages the waiting requests", () => {
    const { broker, advance } = setup();
    const low = broker.request({ holder: "a", job: "low", amounts: { memory: 3000 } });
    advance(1000);
    const high = broker.request({ holder: "b", job: "high", amounts: { memory: 3000 }, priority: 1 });
    broker.tick(cap(4500));
    expect(broker.get(high.id)?.state).toBe("granted");
    expect(broker.get(low.id)?.state).toBe("waiting");
  });

  it("lets a smaller request go first, until the first request waited too long", () => {
    const { broker, advance } = setup();
    // A process holds it, so it does not expire for lack of a heartbeat while it waits.
    const big = broker.request({ holder: "assistant", job: "gate", amounts: { memory: 4000 }, pid: 7 });
    advance(1000);
    const small = broker.request({ holder: "vex", job: "test", amounts: { memory: 500 }, pid: 8 });
    broker.tick(cap(4800));
    expect(broker.get(small.id)?.state).toBe("granted");
    expect(broker.get(big.id)?.state).toBe("waiting");

    advance(700_000);
    const later = broker.request({ holder: "vex", job: "test 2", amounts: { memory: 100 } });
    broker.tick(cap(4800));
    // Other processes hold 200 of the 4000 of `gate`, and `small`, which went first, holds 500: more than that room (H187).
    expect(broker.get(later.id)).toMatchObject({ state: "waiting", reason: "waits for the first request (gate): the run time of this job is not known" });
  });

  describe("after the long wait of the first request (H178)", () => {
    const MIN = 60_000;

    it("lets a short job go first when no end of a granted lease lets the first request start", () => {
      const { broker, advance } = setup({ runMs: { quick: 5 * MIN, slow: 20 * MIN } });
      const small = broker.request({ holder: "vex", job: "test", amounts: { memory: 500 }, pid: 7 });
      broker.tick(cap(4800));
      // The room of the first request is held outside the leases: the end of `small` gives it 3800 of 4000.
      const big = broker.request({ holder: "assistant", job: "gate", amounts: { memory: 4000 }, pid: 8 });
      broker.tick(cap(4800));
      advance(700_000);
      const quick = broker.request({ holder: "lag", job: "quick", amounts: { memory: 100 } });
      // Each needs more than the cap of H187: 4000 less 3200 free and the 100 of `quick` leaves 700, and 100 of it is taken.
      const slow = broker.request({ holder: "lag", job: "slow", amounts: { memory: 700 } });
      const unknown = broker.request({ holder: "lag", job: "new", amounts: { memory: 700 } });
      broker.tick(cap(4800));
      expect(broker.get(small.id)?.state).toBe("granted");
      expect(broker.get(big.id)?.state).toBe("waiting");
      expect(broker.get(quick.id)?.state).toBe("granted");
      expect(broker.get(slow.id)).toMatchObject({ state: "waiting", reason: "waits for the first request (gate): its run of 20 min would delay that request" });
      expect(broker.get(unknown.id)).toMatchObject({ state: "waiting", reason: "waits for the first request (gate): the run time of this job is not known" });
    });

    it("lets a job go first when it ends before the expected start of the first request, or fits in the room that it does not need", () => {
      const { broker, advance } = setup({ runMs: { build: 30 * MIN, long: 60 * MIN, short: 10 * MIN, tiny: 60 * MIN } });
      const build = broker.request({ holder: "graph", job: "build", amounts: { memory: 5000 }, pid: 7 });
      broker.tick(cap(8000));
      expect(broker.get(build.id)?.state).toBe("granted");
      // Free now: 8000 - 1000 - 5000 = 2000. At the end of `build` in 30 minutes: 7000, so 1000 more than `gate` needs.
      const gate = broker.request({ holder: "assistant", job: "gate", amounts: { memory: 6000 }, pid: 8 });
      broker.tick(cap(8000));
      advance(700_000);
      const long = broker.request({ holder: "lag", job: "long", amounts: { memory: 1500 } });
      const short = broker.request({ holder: "lag", job: "short", amounts: { memory: 1500 } });
      const tiny = broker.request({ holder: "lag", job: "tiny", amounts: { memory: 400 } });
      broker.tick(cap(8000));
      expect(broker.get(gate.id)?.state).toBe("waiting");
      // It fits now, but it runs past the start of `gate` and needs more than the 1000 that `gate` leaves.
      expect(broker.get(long.id)).toMatchObject({ state: "waiting", reason: "waits for the first request (gate): its run of 60 min would delay that request" });
      // It ends 10 minutes from now, before the end of `build`.
      expect(broker.get(short.id)?.state).toBe("granted");
      // It runs past the start of `gate`, but it fits in the 1000 that `gate` leaves.
      expect(broker.get(tiny.id)?.state).toBe("granted");
    });

    it("takes the end of a granted lease with no known run time as now, so a later job cannot pass by its time", () => {
      const { broker, advance } = setup({ runMs: { short: 1 * MIN } });
      broker.request({ holder: "graph", job: "build", amounts: { memory: 5000 }, pid: 7 });
      broker.tick(cap(8000));
      const gate = broker.request({ holder: "assistant", job: "gate", amounts: { memory: 6000 }, pid: 8 });
      broker.tick(cap(8000));
      advance(700_000);
      const short = broker.request({ holder: "lag", job: "short", amounts: { memory: 1500 } });
      broker.tick(cap(8000));
      expect(broker.get(gate.id)?.state).toBe("waiting");
      expect(broker.get(short.id)).toMatchObject({ state: "waiting", reason: "waits for the first request (gate): its run of 1 min would delay that request" });
    });
  });

  describe("the hold of a long lease and the cap of the first request (H187)", () => {
    const MIN = 60_000;

    it("holds the measured peak of a lease after 30 minutes of measures, so the queue of 2026-11-13 moves", () => {
      // 2026-11-13 04:43Z: a server held 1024 MB for days and used 32 MB. The first request of 3500 MB was 923 MB short.
      const { broker, advance } = setup({ use: (lease) => (lease.job === "jarvis serve" ? 32 : 0) });
      const server = broker.request({ holder: "jarvis", job: "jarvis serve", amounts: { memory: 1024 }, pid: 5 });
      broker.tick(cap(8000));
      expect(broker.get(server.id)?.state).toBe("granted");
      const gate = broker.request({ holder: "assistant", job: "gate", amounts: { memory: 3500 }, pid: 8 });
      broker.tick(cap(4569));
      expect(broker.get(gate.id)).toMatchObject({ state: "waiting", reason: "waits for memory: needs 3500, 2577 free" });
      advance(29 * MIN);
      broker.tick(cap(4569));
      expect(broker.get(gate.id)?.state).toBe("waiting");
      advance(2 * MIN);
      // After 30 minutes of measures, the server holds 32 x 1.25 = 40 MB: 4569 - 1000 - (40 - 32) = 3561 free.
      broker.tick(cap(4569));
      expect(broker.get(gate.id)?.state).toBe("granted");
    });

    it("holds the peak times 1.25, or the use now when it is more", () => {
      let use = 600;
      const { broker, advance } = setup({ use: () => use });
      broker.request({ holder: "graph", job: "serve", amounts: { memory: 2000 }, pid: 5 });
      broker.tick(cap(8000));
      // The measures of a lease start at the first tick after its grant.
      broker.tick(cap(8000));
      use = 200;
      advance(31 * MIN);
      broker.tick(cap(8000));
      // The peak of 600 gives a hold of 750, and the job uses 200 of it.
      expect(broker.free(cap(8000))["memory"]).toBe(8000 - 1000 - 550);
      use = 1500;
      // The use now is more than the hold of the peak, and more than the amount: the lease holds what it uses.
      expect(broker.free(cap(8000))["memory"]).toBe(8000 - 1000);
      broker.tick(cap(8000));
      expect(broker.free(cap(8000))["memory"]).toBe(8000 - 1000 - 375);
    });

    it("keeps the amount of a lease that the read does not measure, and of a lease after a restart until 30 minutes of new measures", () => {
      const { broker, advance } = setup({ use: (lease) => (lease.job === "stack" ? null : 32) });
      broker.request({ holder: "graph", job: "stack", amounts: { memory: 1000 }, pid: 5 });
      const server = broker.request({ holder: "jarvis", job: "serve", amounts: { memory: 1000 }, pid: 6 });
      broker.tick(cap(8000));
      broker.tick(cap(8000));
      advance(31 * MIN);
      broker.tick(cap(8000));
      // The stack keeps its 1000. The server holds 40 and uses 32 of it.
      expect(broker.free(cap(8000))["memory"]).toBe(8000 - 1000 - 1000 - 8);
      const restarted = setup({ use: () => 32 });
      restarted.broker.restore([{ ...(broker.get(server.id) as Lease) }]);
      restarted.broker.tick(cap(8000));
      restarted.advance(10 * MIN);
      restarted.broker.tick(cap(8000));
      expect(restarted.broker.free(cap(8000))["memory"]).toBe(8000 - 1000 - 968);
      restarted.advance(21 * MIN);
      restarted.broker.tick(cap(8000));
      expect(restarted.broker.free(cap(8000))["memory"]).toBe(8000 - 1000 - 8);
    });

    it("lets a long job go first in the room that the first request waits for from other processes, and no more", () => {
      const { broker, advance } = setup({ runMs: { long: 60 * MIN } });
      broker.request({ holder: "vex", job: "test", amounts: { memory: 500 }, pid: 7 });
      broker.tick(cap(4800));
      const gate = broker.request({ holder: "assistant", job: "gate", amounts: { memory: 4000 }, pid: 8 });
      broker.tick(cap(4800));
      advance(11 * MIN);
      // 3300 free, and other processes hold 700 of the 4000 of the first request. No end of a lease gives it its room.
      const first = broker.request({ holder: "lag", job: "long", amounts: { memory: 300 }, pid: 9 });
      const second = broker.request({ holder: "lag", job: "long", amounts: { memory: 300 }, pid: 10 });
      const third = broker.request({ holder: "lag", job: "long", amounts: { memory: 300 }, pid: 11 });
      broker.tick(cap(4800));
      expect([first, second].map((each) => broker.get(each.id)?.state)).toEqual(["granted", "granted"]);
      // 600 went first. A third 300 makes 900, more than the 700 that the first request now waits for.
      expect(broker.get(third.id)).toMatchObject({ state: "waiting", reason: "waits for the first request (gate): its run of 60 min would delay that request" });
      expect(broker.get(gate.id)?.state).toBe("waiting");
    });

    it("does not let a stream of short jobs starve the first request when its room comes back", () => {
      const alive = new Set<number>();
      const { broker, advance } = setup({ alive, runMs: { quick: 5 * MIN } });
      alive.add(8);
      const gate = broker.request({ holder: "assistant", job: "gate", amounts: { memory: 4000 }, pid: 8 });
      broker.tick(cap(4500));
      advance(11 * MIN);
      // A new short job comes each 2 minutes and runs 5 minutes. At minute 10 other processes give back 500 MB.
      let pid = 100;
      const started: { pid: number; at: number }[] = [];
      let grantedAt: number | null = null;
      for (let minute = 0; minute <= 30 && grantedAt === null; minute += 1) {
        for (const each of started) if (minute - each.at >= 5) alive.delete(each.pid);
        if (minute % 2 === 0) {
          pid += 1;
          alive.add(pid);
          broker.request({ holder: "lag", job: "quick", amounts: { memory: 500 }, pid });
          started.push({ pid, at: minute });
        }
        broker.tick(cap(minute >= 10 ? 5000 : 4500));
        if (broker.get(gate.id)?.state === "granted") grantedAt = minute;
        advance(MIN);
      }
      // The short jobs went first before minute 10. After it, no new job goes first, so the first request starts when they end.
      expect(started.length).toBeGreaterThan(5);
      expect(grantedAt).not.toBeNull();
      expect(grantedAt ?? 99).toBeLessThanOrEqual(15);
    });
  });

  it("ends a lease when its process exits", () => {
    const alive = new Set([10]);
    const { broker } = setup({ alive });
    const lease = broker.request({ holder: "shop", job: "build", amounts: { memory: 1000 }, pid: 10 });
    broker.tick(cap(8000));
    alive.delete(10);
    broker.tick(cap(8000));
    expect(broker.get(lease.id)?.state).toBe("expired");
    expect(broker.get(lease.id)?.reason).toBe("the process exited");
  });

  describe("the end record of a client (H202)", () => {
    it("ends a lease whose process exited as released, with the exit, the use and the time of the record", () => {
      const alive = new Set([10]);
      const ends = new Map<string, LeaseEnd>();
      const { broker, advance } = setup({ alive, ends });
      const lease = broker.request({ holder: "shop", job: "build", amounts: { memory: 1000 }, pid: 10 });
      broker.tick(cap(8000));
      advance(5000);
      ends.set(lease.id, { id: lease.id, at: 1_003_000, reason: "the job ended with code 5, peak 200 MB", peakMb: 200, usage: { cpuMs: 40 }, exitCode: 5, processes: 3 });
      alive.delete(10);
      advance(5000);
      broker.tick(cap(8000));
      expect(broker.get(lease.id)).toMatchObject({
        state: "released",
        endedAt: 1_003_000,
        reason: `the job ended with code 5, peak 200 MB ${RECORDED_END_NOTE}`,
        exitCode: 5,
        peakMb: 200,
        usage: { cpuMs: 40 },
        processes: 3,
      });
    });

    it("keeps the signal of a job that a signal stopped, and takes the time of the tick for a record from the future", () => {
      const alive = new Set([10]);
      const ends = new Map<string, LeaseEnd>();
      const { broker } = setup({ alive, ends });
      const lease = broker.request({ holder: "shop", job: "build", amounts: { memory: 1000 }, pid: 10 });
      broker.tick(cap(8000));
      ends.set(lease.id, { id: lease.id, at: 9_000_000, reason: "the job ended with signal SIGTERM", signal: "SIGTERM" });
      alive.delete(10);
      broker.tick(cap(8000));
      const ended = broker.get(lease.id);
      expect(ended).toMatchObject({ state: "released", endedAt: 1_000_000, signal: "SIGTERM" });
      expect(ended?.exitCode).toBeUndefined();
    });

    it("reads no record while the process runs, and expires a lease with no record as before", () => {
      const alive = new Set([10, 11]);
      const ends = new Map<string, LeaseEnd>();
      let reads = 0;
      const { broker } = setup({ alive, ends });
      const runs = broker.request({ holder: "shop", job: "build", amounts: { memory: 1000 }, pid: 10 });
      const gone = broker.request({ holder: "shop", job: "test", amounts: { memory: 1000 }, pid: 11 });
      ends.set(runs.id, { id: runs.id, at: 1_000_000, reason: "the job ended with code 0", exitCode: 0 });
      const get = ends.get.bind(ends);
      ends.get = (id) => ((reads += 1), get(id));
      broker.tick(cap(8000));
      expect(reads).toBe(0);
      expect(broker.get(runs.id)?.state).toBe("granted");
      alive.delete(11);
      broker.tick(cap(8000));
      expect(reads).toBe(1);
      expect(broker.get(gone.id)).toMatchObject({ state: "expired", reason: "the process exited" });
    });
  });

  it("ends a lease without a process when its heartbeat stops, and keeps a renewed one", () => {
    const { broker, advance } = setup();
    const quiet = broker.request({ holder: "a", job: "x", amounts: { memory: 100 } });
    const renewed = broker.request({ holder: "b", job: "y", amounts: { memory: 100 } });
    broker.tick(cap(8000));
    advance(200_000);
    broker.renew(renewed.id);
    advance(200_000);
    broker.tick(cap(8000));
    expect(broker.get(quiet.id)?.state).toBe("expired");
    expect(broker.get(renewed.id)?.state).toBe("granted");
  });

  it("moves the heartbeat of each active lease forward by a sleep, so no lease ends because the laptop slept (H30)", () => {
    const { broker, advance } = setup();
    const lease = broker.request({ holder: "a", job: "x", amounts: { memory: 100 } });
    broker.tick(cap(8000));
    advance(200_000);
    // The laptop sleeps for 2 hours, with a heartbeat 200 seconds old.
    advance(7_200_000);
    expect(broker.resume(7_200_000).map((each) => each.heartbeatAt)).toEqual([8_200_000]);
    broker.tick(cap(8000));
    expect(broker.get(lease.id)?.state).toBe("granted");
    // A heartbeat does not move past the time of the call, and a sleep of 0 changes nothing.
    expect(broker.resume(999_999_999).map((each) => each.heartbeatAt)).toEqual([8_400_000]);
    expect(broker.resume(0)).toEqual([]);
    advance(400_000);
    broker.tick(cap(8000));
    expect(broker.get(lease.id)?.state).toBe("expired");
  });

  it("cancels a request that can never fit", () => {
    const { broker } = setup();
    const lease = broker.request({ holder: "a", job: "huge", amounts: { memory: 20_000 } });
    broker.tick(cap(8000));
    expect(broker.get(lease.id)?.state).toBe("cancelled");
    expect(broker.get(lease.id)?.reason).toMatch(/more than the capacity/);
  });

  it("grants --cpu 2 with no pool cpu: the capacity is the count of processors, less the reserve of 2 cores (H23)", () => {
    const { broker } = setup();
    const a = broker.request({ holder: "a", job: "x", amounts: { cpu: 2 } });
    const b = broker.request({ holder: "b", job: "y", amounts: { cpu: 13 } });
    broker.tick(cpuCap({}));
    expect(broker.get(a.id)?.state).toBe("granted");
    expect(broker.get(b.id)?.state).toBe("waiting");
    expect(broker.get(b.id)?.reason).toBe("waits for cpu: needs 13, 12 free");
    expect(broker.free(cpuCap({}))["cpu"]).toBe(12);
  });

  it("keeps the reserve out of the cpu amounts: the granted leases do not take the last cores (H23)", () => {
    const { broker } = setup();
    const a = broker.request({ holder: "a", job: "x", amounts: { cpu: 8 } });
    const b = broker.request({ holder: "b", job: "y", amounts: { cpu: 6 } });
    const c = broker.request({ holder: "c", job: "z", amounts: { cpu: 1 } });
    const whole = broker.request({ holder: "d", job: "all", amounts: { cpu: 15 } });
    broker.tick(cpuCap({}));
    expect([a, b].map((each) => broker.get(each.id)?.state)).toEqual(["granted", "granted"]);
    // 8 and 6 take the 14 cores that leases can get. The last 2 cores stay for Mark.
    expect(broker.get(c.id)?.reason).toBe("waits for cpu: needs 1, 0 free");
    expect(broker.get(whole.id)).toMatchObject({ state: "cancelled", reason: "cpu: 15 is more than the capacity of 14" });
    broker.release(a.id);
    broker.tick(cpuCap({}));
    expect(broker.get(c.id)?.state).toBe("granted");
  });

  it("cancels --cpu 2 when the pool cpu is 1, because a configured pool cpu is a cap", () => {
    const { broker } = setup();
    const lease = broker.request({ holder: "a", job: "x", amounts: { cpu: 2 } });
    broker.tick(cpuCap({ cpu: 1 }));
    expect(broker.get(lease.id)?.state).toBe("cancelled");
    expect(broker.get(lease.id)?.reason).toBe("cpu: 2 is more than the capacity of 1");
  });

  it("admits a second measured kind with the same rule, and a disk lease keeps its full amount", () => {
    const { broker } = setup({ used: 1500 });
    const disk: Capacity = { ...cap(8000), rooms: { "disk:D:": { mode: "measured", capacity: 200_000, free: 10_000, reserve: 5120 } } };
    const a = broker.request({ holder: "a", job: "build", amounts: { "disk:D:": 4000 }, pid: 10 });
    const b = broker.request({ holder: "b", job: "test", amounts: { "disk:D:": 1000 } });
    const huge = broker.request({ holder: "c", job: "image", amounts: { "disk:D:": 196_000 } });
    broker.tick(disk);
    expect(broker.get(a.id)?.state).toBe("granted");
    // 10000 free - 5120 reserve - 4000 of the granted lease = 880. The job uses no part of the disk amount.
    expect(broker.get(b.id)?.reason).toBe("waits for disk:D:: needs 1000, 880 free");
    expect(broker.get(huge.id)?.reason).toBe("disk:D:: 196000 is more than the capacity of 194880");
  });

  describe("disk leases (step 5)", () => {
    // 20 GB free on a drive of 200 GB. The reserve is the critical limit of the disk alert: 5120 MB.
    it("grants a disk lease that fits in the free space less the critical limit, and holds its full amount", () => {
      const { broker } = setup();
      const lease = broker.request({ holder: "a", job: "test", amounts: { "disk:D:": 5120 }, pid: 10 });
      broker.tick(diskCap(20_000));
      expect(broker.get(lease.id)?.state).toBe("granted");
      // 20000 free - 5120 reserve - 5120 of the granted lease. The job writes nothing yet, and the lease keeps its amount.
      expect(broker.free(diskCap(20_000))["disk:D:"]).toBe(9760);
    });

    it("holds a disk lease that does not fit, and grants it when the space is free", () => {
      const { broker } = setup();
      const a = broker.request({ holder: "a", job: "trace", amounts: { "disk:D:": 8000 } });
      const b = broker.request({ holder: "b", job: "test", amounts: { "disk:D:": 8000 } });
      broker.tick(diskCap(20_000));
      expect(broker.get(a.id)?.state).toBe("granted");
      expect(broker.get(b.id)?.state).toBe("waiting");
      expect(broker.get(b.id)?.reason).toBe("waits for disk:D:: needs 8000, 6880 free");
      broker.release(a.id);
      broker.tick(diskCap(20_000));
      expect(broker.get(b.id)?.state).toBe("granted");
    });

    it("cancels a disk lease larger than the drive, and a lease for a drive that does not exist", () => {
      const { broker } = setup();
      const huge = broker.request({ holder: "a", job: "image", amounts: { "disk:D:": 300_000 } });
      const missing = broker.request({ holder: "b", job: "test", amounts: { "disk:Q:": 1024 } });
      broker.tick(diskCap(20_000, DEFAULT_ALERT_RULES, ["disk:Q:"]));
      expect(broker.get(huge.id)?.state).toBe("cancelled");
      expect(broker.get(huge.id)?.reason).toBe("disk:D:: 300000 is more than the capacity of 194880");
      expect(broker.get(missing.id)?.state).toBe("cancelled");
      expect(broker.get(missing.id)?.reason).toBe("disk:Q:: 1024 is more than the capacity of 0");
    });

    it("takes the reserve of a drive from the critical limit of the disk alert", () => {
      const { broker } = setup();
      const limits = { ...DEFAULT_ALERT_RULES, diskCriticalMb: 8192 };
      expect(diskCap(20_000, limits).rooms?.["disk:D:"]?.reserve).toBe(8192);
      expect(broker.free(diskCap(20_000, limits))["disk:D:"]).toBe(11_808);
      // On a small drive, 5% of its size is the lower limit.
      const small: Capacity = { ...cap(8000), rooms: rooms(["disk:E:"], [{ id: "disk:E:", capacity: 30_720, used: 20_720, free: 10_000 }], {}, {}, limits) };
      expect(small.rooms?.["disk:E:"]?.reserve).toBe(1536);
    });
  });

  it("cancels a waiting lease on release, and refuses a negative amount", () => {
    const { broker } = setup();
    const lease = broker.request({ holder: "a", job: "x", amounts: { memory: 9000 } });
    expect(broker.release(lease.id)?.state).toBe("cancelled");
    expect(() => broker.request({ holder: "a", job: "x", amounts: { memory: -1 } })).toThrow(RangeError);
  });
});

describe("Broker cancel and the leases of a restart", () => {
  it("cancels a waiting lease with who cancelled it, and does not change a granted lease", () => {
    const { broker } = setup();
    const runs = broker.request({ holder: "shop", job: "build", amounts: { memory: 6000 } });
    const waits = broker.request({ holder: "assistant", job: "gate", amounts: { memory: 4000 } });
    broker.tick(cap(8000));
    expect(broker.get(waits.id)?.state).toBe("waiting");
    expect(broker.cancel(waits.id, "assistant")).toMatchObject({ state: "cancelled", reason: "cancelled by assistant (headroom cancel)", cancelledBy: "assistant", endedAt: 1_000_000 });
    expect(broker.cancel(runs.id, "assistant")).toMatchObject({ state: "granted" });
    expect(broker.cancel("nothing", "cli")).toBeUndefined();
    // A second cancel does not change the lease.
    expect(broker.cancel(waits.id, "cli")).toMatchObject({ cancelledBy: "assistant" });
  });

  it("ends a waiting lease of a dead client at the next tick, by its process", () => {
    const alive = new Set([10, 11]);
    const { broker, advance } = setup({ alive });
    broker.request({ holder: "shop", job: "build", amounts: { memory: 6000 }, pid: 10 });
    const waits = broker.request({ holder: "assistant", job: "gate", amounts: { memory: 4000 }, pid: 11 });
    broker.tick(cap(8000));
    alive.delete(11);
    advance(2000);
    broker.tick(cap(8000));
    expect(broker.get(waits.id)).toMatchObject({ state: "expired", reason: "the process exited" });
  });

  it("ends a waiting lease with no process when its client stops its heartbeat, after its limit", () => {
    const { broker, advance } = setup();
    broker.request({ holder: "shop", job: "build", amounts: { memory: 6000 }, ttlMs: 3_600_000 });
    const waits = broker.request({ holder: "assistant", job: "gate", amounts: { memory: 4000 }, ttlMs: 60_000 });
    broker.tick(cap(8000));
    advance(60_000);
    broker.tick(cap(8000));
    expect(broker.get(waits.id)?.state).toBe("waiting");
    advance(1);
    broker.tick(cap(8000));
    expect(broker.get(waits.id)).toMatchObject({ state: "expired", reason: "no heartbeat" });
  });

  it("gives the restored leases a new limit, and ends a restored waiting lease that no client calls for", () => {
    const alive = new Set([10, 11, 12]);
    const { broker, advance } = setup({ alive });
    const base = { holder: "a", amounts: { memory: 100 }, priority: 0, requestedAt: 0, grantedAt: null, endedAt: null, reason: null, peakMb: null };
    const old = 1_000_000 - 3_600_000;
    const leases: Lease[] = [
      // A client that does not come back. Its process ID belongs to another process now.
      { ...base, id: "gone", job: "x", pid: 10, ttlMs: 300_000, state: "waiting", heartbeatAt: old },
      // A client that calls again after the restart.
      { ...base, id: "back", job: "y", pid: 11, ttlMs: 300_000, state: "waiting", heartbeatAt: old },
      // A waiting lease with no process. Its heartbeat was an hour old at the restart.
      { ...base, id: "quiet", job: "z", pid: null, ttlMs: 300_000, state: "waiting", heartbeatAt: old },
      // A granted lease with a process: the process decides.
      { ...base, id: "runs", job: "w", pid: 12, ttlMs: 300_000, state: "granted", grantedAt: old, heartbeatAt: old },
    ];
    broker.restore(leases);
    // The waiting leases do not fit, so they stay in the queue.
    broker.tick(cap(1000));
    expect(broker.leases().filter((lease) => lease.state === "expired")).toEqual([]);
    expect(broker.get("quiet")?.heartbeatAt).toBe(1_000_000);
    advance(200_000);
    broker.renew("back");
    advance(100_001);
    broker.tick(cap(1000));
    expect(broker.get("gone")).toMatchObject({ state: "expired", reason: NO_REJOIN_REASON });
    expect(broker.get("quiet")).toMatchObject({ state: "expired", reason: NO_REJOIN_REASON });
    expect(broker.get("back")?.state).toBe("waiting");
    expect(broker.get("runs")?.state).toBe("granted");
    // After its call, the lease of a client with a process does not end for no heartbeat.
    advance(3_600_000);
    broker.tick(cap(1000));
    expect(broker.get("back")?.state).toBe("waiting");
    alive.delete(11);
    broker.tick(cap(1000));
    expect(broker.get("back")).toMatchObject({ state: "expired", reason: "the process exited" });
  });
});
