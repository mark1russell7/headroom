import { describe, expect, it } from "vitest";
import type { Lease } from "./broker.ts";
import { treeMb } from "./owners.ts";
import { kindOf, leasesOf, limitOf, measure, RESOURCES, resourceOf, roomOf, rooms, type Owners, type Readings } from "./resources.ts";
import type { ProcessInfo } from "./types.ts";

const p = (pid: number, ppid: number, name: string, privateMb: number): ProcessInfo => ({ pid, ppid, name, privateMb, workingMb: privateMb });
const processes = [p(1, 0, "claude.exe", 500), p(2, 1, "node.exe", 1000), p(3, 2, "vitest.exe", 3000), p(4, 0, "vmmemWSL", 8000)];

const readings: Readings = {
  at: 0,
  memory: { totalMb: 28_000, availableMb: 8000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 },
  processes,
  previous: [],
  disks: [{ mount: "C:", freeMb: 265_000, totalMb: 774_000 }, { mount: "D:", freeMb: 4000, totalMb: 200_000 }],
  load: { processes: 504, userObjects: 2685, gdiObjects: 4445 },
  processors: 16,
  pools: { docker: 2, cpu: 8 },
  granted: { memory: 2048, browser: 1, cpu: 4 },
};

const lease = (pid: number | null): Lease => ({
  id: "l1", holder: "graph", job: "vitest", amounts: { memory: 6000 }, priority: 0, pid, ttlMs: 0, state: "granted",
  requestedAt: 0, grantedAt: 0, endedAt: null, heartbeatAt: 0, reason: null, peakMb: null,
});

const owners: Owners = {
  ownerOf: new Map([[1, "session:graph"], [2, "session:graph"], [3, "session:graph"], [4, "docker"]]),
  kindOf: new Map([["session:graph", "session"], ["docker", "docker"]]),
  leaseOf: new Map([[2, "l1"], [3, "l1"]]),
};

describe("resources", () => {
  it("gives the kind of an id, and a slot for an id with no known kind", () => {
    expect(kindOf("memory")).toBe("memory");
    expect(kindOf("disk:D:")).toBe("disk");
    expect(kindOf("pool:paged")).toBe("pool");
    expect(kindOf("cpu")).toBe("cpu");
    expect(kindOf("browser")).toBe("slot");
    expect(kindOf("npm-publish")).toBe("slot");
    expect(resourceOf("docker").kind).toBe("slot");
  });

  it("measures each kind from the reads of one tick", () => {
    expect(measure(readings)).toEqual([
      { id: "memory", capacity: 28_000, used: 20_000, free: 8000 },
      { id: "commit", capacity: 80_000, used: 30_000, free: 50_000 },
      { id: "pool:nonpaged", capacity: null, used: 1000, free: null },
      { id: "pool:paged", capacity: null, used: 900, free: null },
      { id: "desktop", capacity: null, used: 504, free: null },
      { id: "disk:C:", capacity: 774_000, used: 509_000, free: 265_000 },
      { id: "disk:D:", capacity: 200_000, used: 196_000, free: 4000 },
      { id: "cpu", capacity: 16, used: null, free: null },
      { id: "docker", capacity: 2, used: 0, free: 2 },
      { id: "browser", capacity: 1, used: 1, free: 0 },
    ]);
  });

  it("gives no commit capacity when the commit limit is unknown", () => {
    const [commit] = RESOURCES.get("commit")?.measure.read({ ...readings, memory: { ...readings.memory, commitLimitMb: 0 } }) ?? [];
    expect(commit).toEqual({ id: "commit", capacity: null, used: 30_000, free: null });
  });

  it("keeps the memory rules of the broker: a lease uses the private memory of its process tree", () => {
    const admit = RESOURCES.get("memory")?.admit;
    expect(admit?.mode).toBe("measured");
    expect(admit?.reserve).toEqual({ amount: 1024 });
    expect(admit?.used?.(lease(2), "memory", readings, owners)).toBe(treeMb(2, processes));
    expect(admit?.used?.(lease(2), "memory", readings, owners)).toBe(4000);
    expect(admit?.used?.(lease(null), "memory", readings, owners)).toBe(0);
    expect(RESOURCES.get("memory")?.enforce?.limit(2048)).toEqual({ memoryMb: 2048 });
  });

  it("gives the memory of each owner and of each lease, the largest first", () => {
    const use = RESOURCES.get("memory")?.attribute?.read(readings, owners);
    expect(use).toEqual([
      { resource: "memory", owner: "docker", kind: "docker", amount: 8000, processes: 1 },
      { resource: "memory", owner: "session:graph", kind: "session", amount: 4500, processes: 3 },
      { resource: "memory", owner: "lease:l1", kind: "lease", amount: 4000, processes: 2 },
    ]);
  });

  it("gives the lease of each process under a granted lease", () => {
    expect([...leasesOf(processes, [lease(2)])]).toEqual([[2, "l1"], [3, "l1"]]);
    expect(leasesOf(processes, [{ ...lease(2), state: "waiting" }]).size).toBe(0);
  });

  it("gives the lower of the amount and the part of the capacity", () => {
    expect(limitOf({ amount: 5120, ratio: 0.05 }, 200_000)).toBe(5120);
    expect(limitOf({ amount: 5120, ratio: 0.05 }, 30_720)).toBe(1536);
    expect(limitOf({ ratio: 0.9 }, null)).toBeNull();
    expect(limitOf({}, 100)).toBeNull();
  });

  it("gives the room of each id: measured, counted, a cap on the processors, and a slot", () => {
    const measurements = measure(readings);
    expect(rooms(["memory", "cpu", "docker", "browser", "npm-publish"], measurements, readings.pools, { memory: 1000 })).toEqual({
      memory: { mode: "measured", capacity: 28_000, free: 8000, reserve: 1000 },
      cpu: { mode: "counted", capacity: 8, free: null, reserve: 0 },
      docker: { mode: "counted", capacity: 2, free: null, reserve: 0 },
      browser: { mode: "counted", capacity: 1, free: null, reserve: 0 },
      "npm-publish": { mode: "counted", capacity: 1, free: null, reserve: 0 },
    });
    // Without a pool cpu, the capacity of cpu is the count of processors.
    expect(roomOf("cpu", measurements.find((each) => each.id === "cpu"), {})).toEqual({ mode: "counted", capacity: 16, free: null, reserve: 0 });
    // The reserve of a drive is its critical limit.
    expect(roomOf("disk:D:", measurements.find((each) => each.id === "disk:D:"), {})).toEqual({ mode: "measured", capacity: 200_000, free: 4000, reserve: 5120 });
    // A drive that does not exist gets the capacity 0. A kind with no admit part counts as a slot.
    expect(roomOf("disk:Q:", undefined, {})).toEqual({ mode: "measured", capacity: 0, free: 0, reserve: 0 });
    expect(roomOf("commit", measurements.find((each) => each.id === "commit"), {})).toEqual({ mode: "counted", capacity: 1, free: null, reserve: 0 });
  });
});
