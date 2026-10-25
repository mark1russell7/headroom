import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_RULES, type AlertRules } from "./alerts.ts";
import { Broker, type Capacity } from "./broker.ts";
import { rooms } from "./resources.ts";

function setup(options: { alive?: Set<number>; used?: number } = {}) {
  let now = 1_000_000;
  let next = 0;
  const broker = new Broker({
    now: () => now,
    newId: () => `l${++next}`,
    isAlive: (pid) => options.alive?.has(pid) ?? true,
    usedMb: () => options.used ?? 0,
    reserveMb: 1000,
    agingMs: 60_000,
    headWaitMs: 600_000,
    defaultTtlMs: 300_000,
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
    const a = broker.request({ holder: "graph", job: "build", amounts: { memory: 2000 } });
    const b = broker.request({ holder: "jarvis", job: "gate", amounts: { memory: 4000 } });
    const changed = broker.tick(cap(6000));
    expect(broker.get(a.id)?.state).toBe("granted");
    expect(broker.get(b.id)?.state).toBe("waiting");
    expect(broker.get(b.id)?.reason).toMatch(/waits for memory: needs 4000, 3000 free/);
    expect(changed.map((lease) => lease.id)).toEqual(["l1", "l2"]);
  });

  it("counts only the unused part of a granted lease against new requests", () => {
    const { broker } = setup({ used: 1500 });
    broker.request({ holder: "graph", job: "build", amounts: { memory: 2000 }, pid: 10 });
    broker.tick(cap(6000));
    // 6000 available - 1000 reserve - (2000 - 1500 unused) = 4500
    expect(broker.free(cap(6000))["memory"]).toBe(4500);
  });

  it("treats a pool with no capacity as a lock of 1", () => {
    const { broker } = setup();
    const a = broker.request({ holder: "graph", job: "mongo", amounts: { docker: 1 } });
    const b = broker.request({ holder: "jarvis", job: "lab", amounts: { docker: 1 } });
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
    const big = broker.request({ holder: "jarvis", job: "gate", amounts: { memory: 4000 }, pid: 7 });
    advance(1000);
    const small = broker.request({ holder: "vex", job: "test", amounts: { memory: 500 } });
    broker.tick(cap(3000));
    expect(broker.get(small.id)?.state).toBe("granted");
    expect(broker.get(big.id)?.state).toBe("waiting");

    advance(700_000);
    const later = broker.request({ holder: "vex", job: "test 2", amounts: { memory: 100 } });
    broker.tick(cap(3000));
    expect(broker.get(later.id)?.state).toBe("waiting");
  });

  it("ends a lease when its process exits", () => {
    const alive = new Set([10]);
    const { broker } = setup({ alive });
    const lease = broker.request({ holder: "graph", job: "build", amounts: { memory: 1000 }, pid: 10 });
    broker.tick(cap(8000));
    alive.delete(10);
    broker.tick(cap(8000));
    expect(broker.get(lease.id)?.state).toBe("expired");
    expect(broker.get(lease.id)?.reason).toBe("the process exited");
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
