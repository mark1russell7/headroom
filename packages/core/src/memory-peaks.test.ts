import { describe, expect, it } from "vitest";
import type { DockerRead } from "./docker.ts";
import { Engine } from "./engine.ts";
import { PeakTracker, type MemoryPeak, type PeakContainer } from "./memory-peaks.ts";
import type { Sampler } from "./sampler.ts";
import { Store } from "./store.ts";
import type { ProcessInfo } from "./types.ts";

const MINUTE = 60_000;
const p = (pid: number, ppid: number, name: string, privateMb: number, startedAt = 1000): ProcessInfo => ({ pid, ppid, name, privateMb, workingMb: privateMb, startedAt });
const box = (id: string, memoryMb: number | null, fields: Partial<PeakContainer> = {}): PeakContainer => ({
  id, name: `name-${id}`, image: "mongo:7", state: "running", memoryMb, owner: "shop", ...fields,
});
const peak = (key: string, peakMb: number, fields: Partial<MemoryPeak> = {}): MemoryPeak => ({
  kind: "process", key, name: "node.exe", owner: "shop", pid: Number(key.split(":")[0]), created: Number(key.split(":")[1]), lease: null, peakMb, command: null, ...fields,
});

describe("PeakTracker (H62 part 5)", () => {
  it("keeps the largest read of each large process in the minute, with its owner, its lease and its command", () => {
    const tracker = new PeakTracker(512, 30);
    const owners = new Map([[10, "shop"], [11, "shop"]]);
    tracker.observeProcesses([p(10, 1, "node.exe", 600), p(11, 1, "small.exe", 511)], owners, new Map(), () => "node build.js");
    tracker.observeProcesses([p(10, 1, "node.exe", 2400)], owners, new Map([[10, "lease-1"]]), () => null);
    tracker.observeProcesses([p(10, 1, "node.exe", 900)], owners, new Map(), () => null);
    expect(tracker.close()).toEqual([
      { kind: "process", key: "10:1000", name: "node.exe", owner: "shop", pid: 10, created: 1000, lease: "lease-1", peakMb: 2400, command: "node build.js" },
    ]);
    // The close starts the next minute.
    expect(tracker.close()).toEqual([]);
  });

  it("gives a new process with the ID of an ended process its own key", () => {
    const tracker = new PeakTracker(512, 30);
    tracker.observeProcesses([p(10, 1, "node.exe", 700, 1000)], new Map(), new Map());
    tracker.observeProcesses([p(10, 1, "node.exe", 800, 5000)], new Map(), new Map());
    expect(tracker.close().map((each) => each.key)).toEqual(["10:5000", "10:1000"]);
  });

  it("keeps the large running containers with their lease and image, and the largest holders first up to the limit", () => {
    const tracker = new PeakTracker(512, 2);
    tracker.observeContainers(
      [box("a", 3000), box("b", 100), box("c", null), box("d", 900, { state: "exited" }), box("e", 700)],
      new Map([["a", { lease: "lease-2" }]]),
    );
    tracker.observeProcesses([p(20, 1, "vmmem", 5000)], new Map([[20, "docker"]]), new Map());
    const peaks = tracker.close();
    expect(peaks.map((each) => [each.kind, each.key, each.peakMb])).toEqual([["process", "20:1000", 5000], ["container", "a", 3000]]);
    expect(peaks[1]).toMatchObject({ name: "name-a", owner: "shop", lease: "lease-2", pid: null, created: null, command: "mongo:7" });
  });
});

describe("Store memory peaks (H62 part 5)", () => {
  it("gives each holder with its largest minute, its first and last minute, its command, and its trail", () => {
    const store = new Store(":memory:");
    try {
      store.saveMemoryPeaks(MINUTE, [peak("10:1000", 600, { command: "node build.js" }), peak("11:1000", 900)]);
      store.saveMemoryPeaks(2 * MINUTE, [peak("10:1000", 2400, { lease: "lease-1" }), peak("11:1000", 700)]);
      store.saveMemoryPeaks(3 * MINUTE, [peak("10:1000", 800, { lease: "lease-1" })]);
      store.saveMemoryPeaks(4 * MINUTE, []);
      const peaks = store.peaksSince(0);
      expect(peaks.map((each) => [each.key, each.peakMb, each.at, each.firstAt, each.lastAt, each.minutes, each.lease])).toEqual([
        ["10:1000", 2400, 2 * MINUTE, MINUTE, 3 * MINUTE, 3, "lease-1"],
        ["11:1000", 900, MINUTE, MINUTE, 2 * MINUTE, 2, null],
      ]);
      // A later minute with no command keeps the command of the holder.
      expect(peaks[0]?.command).toBe("node build.js");
      expect(store.peaksSince(0, { minMb: 1000 }).map((each) => each.key)).toEqual(["10:1000"]);
      expect(store.peaksSince(0, { lease: "lease-1" })[0]).toMatchObject({ key: "10:1000", minutes: 2, firstAt: 2 * MINUTE });
      expect(store.peaksSince(0, { limit: 1 })).toHaveLength(1);
      expect(store.peaksSince(3 * MINUTE).map((each) => [each.key, each.peakMb])).toEqual([["10:1000", 800]]);
      expect(store.peakTrail("process", "10:1000", 0)).toEqual([
        { at: MINUTE, peakMb: 600, lease: null },
        { at: 2 * MINUTE, peakMb: 2400, lease: "lease-1" },
        { at: 3 * MINUTE, peakMb: 800, lease: "lease-1" },
      ]);
      expect(store.peakTrail("container", "10:1000", 0)).toEqual([]);
      // The prune removes the old minutes and the holders with no newer minute.
      store.prune(2 * MINUTE + 1);
      expect(store.peaksSince(0).map((each) => [each.key, each.minutes, each.command])).toEqual([["10:1000", 1, "node build.js"]]);
    } finally {
      store.close();
    }
  });
});

describe("Engine memory peaks (H62 part 5)", () => {
  it("keeps the peak of a large process between two samples, and the container of a lease", () => {
    let now = 1_000_000;
    const job = process.pid;
    let list: ProcessInfo[] = [p(4, 0, "System", 1), p(job, 4, "node.exe", 300), p(job + 1, job, "docker.exe", 50)];
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 12_000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
      processes: () => list,
      close: () => undefined,
    };
    let read: DockerRead | undefined;
    const store = new Store(":memory:");
    const engine = new Engine({ sampler, store, now: () => now, sessionsDir: "/nowhere", docker: () => read });
    try {
      const stack = engine.request({ holder: "shop", job: "share-stack", amounts: { memory: 500 }, ttlMs: 600_000, pid: job, folder: "D:\\work\\Shop" });
      engine.tick();
      // The job grows to 2.9 GB between two samples, and then it shrinks.
      now += 20_000;
      list = [p(4, 0, "System", 1), p(job, 4, "node.exe", 2900), p(job + 1, job, "docker.exe", 50)];
      const mongo = { id: "m1", name: "share-mongo-1", image: "mongo:7", state: "running", project: "share", workingDir: "D:\\work\\Shop\\deploy", leaseLabel: stack.id };
      read = { at: now, version: "29.9.2", api: "1.56", disk: null, readMs: 40, containers: [{ ...mongo, upMinMs: 5000, memoryMb: 3000, limitMb: null, cores: 0.2, sizeRwMb: 0 }] };
      engine.tick();
      now += 20_000;
      list = [p(4, 0, "System", 1), p(job, 4, "node.exe", 300), p(job + 1, job, "docker.exe", 50)];
      engine.tick();
      now += 30_000;
      engine.tick();
      const answer = engine.peaks(0);
      expect(answer).toMatchObject({ minMb: 512, limit: 30 });
      expect(answer.peaks.map((each) => [each.kind, each.name, each.peakMb, each.lease])).toEqual([
        ["container", "share-mongo-1", 3000, stack.id],
        ["process", "node.exe", 2900, stack.id],
      ]);
      expect(answer.peaks[0]?.command).toBe("mongo:7");
      const key = answer.peaks[1]?.key ?? "";
      expect(engine.peaks(0, { kind: "process", key }).trail).toEqual([{ at: answer.peaks[1]?.at, peakMb: 2900, lease: stack.id }]);
      expect(engine.peaks(0).trail).toBeUndefined();
    } finally {
      engine.close();
    }
  });
});
