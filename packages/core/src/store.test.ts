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
    expect(store.memorySince(0)).toEqual([{ at: 1000, ...memory }]);
    expect(store.ownersSince(0)[0]?.owner).toBe("kernel");
    store.prune(2000);
    expect(store.memorySince(0)).toEqual([]);
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
