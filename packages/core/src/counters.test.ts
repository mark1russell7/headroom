import { describe, expect, it } from "vitest";
import { counterDelta, CounterTracker } from "./counters.ts";
import type { OwnerKind, ProcessInfo } from "./types.ts";

const MB = 1024 * 1024;
const p = (pid: number, writeMb: number, cpuMs: number, startedAt = 0): ProcessInfo => ({
  pid, ppid: 1, name: `p${pid}.exe`, privateMb: 10, workingMb: 10, startedAt, cpuMs, writeBytes: writeMb * MB,
});
const kinds = new Map<string, OwnerKind>([["session:graph", "session"], ["mcp:vex", "mcp"]]);

describe("counterDelta", () => {
  it("gives the change of a total of the same process, and 0 when the total decreased", () => {
    expect(counterDelta("writeBytes", p(5, 30, 0), p(5, 10, 0), 1000)).toBe(20 * MB);
    expect(counterDelta("writeBytes", p(5, 10, 0), p(5, 30, 0), 1000)).toBe(0);
  });

  it("starts a new process at its first read, unless it started after the previous read", () => {
    expect(counterDelta("writeBytes", p(5, 100_000, 0, 500), undefined, 1000)).toBeUndefined();
    expect(counterDelta("writeBytes", p(5, 40, 0, 1500), undefined, 1000)).toBe(40 * MB);
    // The first read has no previous read, so it only keeps the totals.
    expect(counterDelta("writeBytes", p(5, 40, 0, 1500), undefined, null)).toBeUndefined();
  });

  it("counts a new process with the ID of an ended process as a new process", () => {
    expect(counterDelta("cpuMs", p(5, 0, 300, 1500), p(5, 0, 9000, 200), 1000)).toBe(300);
    expect(counterDelta("cpuMs", p(5, 0, 300, 900), p(5, 0, 9000, 200), 1000)).toBeUndefined();
  });

  it("gives nothing for a process with no total", () => {
    expect(counterDelta("writeBytes", { pid: 5, ppid: 1, name: "a", privateMb: 0, workingMb: 0 }, p(5, 1, 0), 1000)).toBeUndefined();
  });
});

describe("CounterTracker", () => {
  it("gives the MB of the last hour, the speed of the last 10 minutes and the cores of the last minute of each owner", () => {
    const tracker = new CounterTracker();
    const ownerOf = new Map([[10, "session:graph"], [20, "mcp:vex"], [30, "session:graph"]]);
    let at = 0;
    tracker.read(at, [p(10, 5000, 0), p(20, 1, 0)], ownerOf, kinds);
    expect(tracker.writes(at)).toEqual([]);
    expect(tracker.cores(at)).toBeUndefined();
    // Each read is 10 seconds later. The session writes 100 MB and uses 15 s of processor time in each one: 1.5 cores.
    for (let step = 1; step <= 6; step++) {
      at = step * 10_000;
      tracker.read(at, [p(10, 5000 + step * 100, step * 15_000), p(20, 1 + step, step * 1000)], ownerOf, kinds);
    }
    expect(tracker.writes(at)).toEqual([
      { owner: "session:graph", kind: "session", mbPerMin: 600, mbLastHour: 600 },
      { owner: "mcp:vex", kind: "mcp", mbPerMin: 6, mbLastHour: 6 },
    ]);
    expect(tracker.cores(at)).toEqual([
      { owner: "session:graph", kind: "session", cores: 1.5 },
      { owner: "mcp:vex", kind: "mcp", cores: 0.1 },
    ]);
    // A process that starts after the previous read counts with all of its writes.
    at = 70_000;
    tracker.read(at, [p(10, 5600, 90_000), p(20, 7, 6000), p(30, 50, 0, 65_000)], ownerOf, kinds);
    expect(tracker.writes(at)[0]).toMatchObject({ owner: "session:graph", mbLastHour: 650 });
  });

  it("keeps the closed minutes for one hour, and continues the hour from the stored minutes", () => {
    const tracker = new CounterTracker();
    const ownerOf = new Map([[10, "session:graph"]]);
    tracker.read(0, [p(10, 0, 0)], ownerOf, kinds);
    tracker.read(60_000, [p(10, 2048, 0)], ownerOf, kinds);
    const closed = tracker.close(60_000);
    expect(closed.get("writeBytes")?.get("session:graph")).toBe(2048 * MB);
    // After 20 minutes with no writes, the speed is 0 and the hour keeps the 2 GB.
    expect(tracker.writes(20 * 60_000)).toEqual([{ owner: "session:graph", kind: "session", mbPerMin: 0, mbLastHour: 2048 }]);
    tracker.close(61 * 60_000);
    expect(tracker.writes(61 * 60_000)).toEqual([]);

    const restarted = new CounterTracker();
    restarted.restore("writeBytes", [
      { at: 60_000, owner: "mcp:vex", kind: "mcp", amount: 300 * MB },
      { at: 120_000, owner: "mcp:vex", kind: "mcp", amount: 200 * MB },
    ]);
    expect(restarted.writes(30 * 60_000)).toEqual([{ owner: "mcp:vex", kind: "mcp", mbPerMin: 0, mbLastHour: 500 }]);
  });

  it("gives the reads of each owner with the counter readBytes, and no reads without it (H50)", () => {
    const reader = (pid: number, readMb: number): ProcessInfo => ({ ...p(pid, 0, 0), readBytes: readMb * MB });
    const ownerOf = new Map([[10, "system:search"], [20, "session:graph"]]);
    const searchKinds = new Map<string, OwnerKind>([["system:search", "system"], ["session:graph", "session"]]);
    const tracker = new CounterTracker(["cpuMs", "writeBytes", "readBytes"]);
    const plain = new CounterTracker();
    for (const each of [tracker, plain]) {
      each.read(0, [reader(10, 1000), reader(20, 5)], ownerOf, searchKinds);
      each.read(60_000, [reader(10, 4000), reader(20, 105)], ownerOf, searchKinds);
    }
    expect(tracker.reads(60_000)).toEqual([
      { owner: "system:search", kind: "system", mbPerMin: 3000, mbLastHour: 3000 },
      { owner: "session:graph", kind: "session", mbPerMin: 100, mbLastHour: 100 },
    ]);
    expect(tracker.writes(60_000)).toEqual([]);
    expect(plain.reads(60_000)).toEqual([]);
  });
});

describe("CounterTracker after a sleep (H30)", () => {
  it("gives no rate across a gap, and measures again from the next read", () => {
    const tracker = new CounterTracker();
    const ownerOf = new Map([[10, "session:graph"]]);
    tracker.read(0, [p(10, 0, 0)], ownerOf, kinds);
    tracker.gap();
    // Two hours of processor time in the sleep: no rate spans the sleep.
    const wake = 2 * 3_600_000;
    tracker.read(wake, [p(10, 0, 7_200_000)], ownerOf, kinds);
    expect(tracker.cores(wake)?.find((each) => each.owner === "session:graph")).toBeUndefined();
    tracker.read(wake + 60_000, [p(10, 0, 7_230_000)], ownerOf, kinds);
    expect(tracker.cores(wake + 60_000)?.find((each) => each.owner === "session:graph")?.cores).toBe(0.5);
  });
});

describe("CounterTracker groups (H23)", () => {
  it("gives a trail of one-minute averages for all processes and for each group, and the groups of the last reads", () => {
    const tracker = new CounterTracker();
    const ownerOf = new Map([[10, "session:graph"], [20, "session:graph"], [30, "mcp:vex"]]);
    const groupOf = new Map([[10, "tree:10"], [20, "lease:abc"], [30, "tree:30"]]);
    // Each read is 10 seconds later. The tree uses 4 cores, the lease 1 core and the server 0.01 core, below the floor of a group.
    for (let step = 0; step <= 72; step++) {
      const at = step * 10_000;
      tracker.read(at, [p(10, 0, step * 40_000), p(20, 0, step * 10_000), p(30, 0, step * 100)], ownerOf, kinds, groupOf);
    }
    const now = 720_000;
    const all = tracker.coresTrail(now);
    // The reads of the last 11 minutes stay, and each point is the average of the last minute.
    expect(all[0]?.at).toBe(now - 650_000);
    expect(all.at(-1)).toEqual({ at: now, value: 5.01 });
    expect(tracker.coresTrail(now, "tree:10").every((point) => point.value === 4)).toBe(true);
    expect(tracker.coresTrail(now, "tree:30").every((point) => point.value === 0)).toBe(true);
    expect([...tracker.groupsSeen(now, "tree:")]).toEqual(["tree:10"]);
    expect(tracker.groupCores(now, "lease:")).toEqual(new Map([["lease:abc", 1]]));
    // With no read in the last minute, the groups have no cores.
    expect(tracker.groupCores(now + 120_000, "lease:")).toEqual(new Map());
  });
});
