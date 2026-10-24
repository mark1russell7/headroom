import { describe, expect, it } from "vitest";
import { Broker } from "./broker.ts";
import { parseMeminfo, parseStat } from "./linux.ts";
import { Store } from "./store.ts";

describe("Store", () => {
  it("keeps the leases, the pools and the samples", () => {
    const store = new Store(":memory:");
    const broker = new Broker({ now: () => 5000, newId: () => "l1" });
    const lease = broker.request({ holder: "graph", job: "build", amounts: { memory: 2000, docker: 1 }, pid: 42 });
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

    // A snapshot removes the snapshots that are older than 2 hours.
    store.savePoolTags(1000 + 2 * 3_600_000 + 1, [{ tag: "DAL3", nonPagedMb: 310, pagedMb: 0 }]);
    expect(store.poolTagsSince(0).map((snapshot) => snapshot.at)).toEqual([2000, 1000 + 2 * 3_600_000 + 1]);
    store.prune(3000);
    expect(store.poolTagsSince(0).map((snapshot) => snapshot.at)).toEqual([1000 + 2 * 3_600_000 + 1]);
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
});
