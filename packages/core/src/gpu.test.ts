import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_RULES, detect } from "./alerts.ts";
import { Engine } from "./engine.ts";
import {
  engineFamily,
  gpuLines,
  gpuOwners,
  gpuRead,
  gpuStatus,
  leaseGpuText,
  parseGpuInstance,
  type GpuAdapterInfo,
  type GpuSample,
} from "./gpu.ts";
import { measure, withKinds, type Owners, type Readings } from "./resources.ts";
import type { CounterItem } from "./thermal.ts";
import type { Sampler } from "./sampler.ts";
import { Store } from "./store.ts";
import type { OwnerKind, ProcessInfo, SystemMemory } from "./types.ts";

const BYTES = 1024 * 1024;
/** The LUIDs of this laptop on 2026-10-25: the Radeon 860M, the Basic Render Driver and an adapter that DXGI does not list (the NPU). */
const RADEON = "0x00000000_0x0001665F";
const WARP = "0x00000000_0x0001DF3D";
const NPU = "0x00000000_0x0001DFBE";
const TOTAL_MB = 28_310;

const adapterItem = (luid: string, mb: number): CounterItem => ({ name: `luid_${luid}_phys_0`, value: mb * BYTES });
const processItem = (pid: number, luid: string, mb: number, phys = 0): CounterItem => ({ name: `pid_${pid}_luid_${luid}_phys_${phys}`, value: mb * BYTES });
const engineItem = (pid: number, luid: string, engine: number, type: string, percent: number): CounterItem => ({
  name: `pid_${pid}_luid_${luid}_phys_0_eng_${engine}_engtype_${type}`,
  value: percent,
});

const DXGI: readonly GpuAdapterInfo[] = [
  { luid: "0x00000000_0x0001665f", index: 0, name: "AMD Radeon(TM) 860M Graphics", dedicatedMb: 4096, sharedMb: 14_155, budgetMb: 17_430, software: false },
  { luid: "0x00000000_0x0001df3d", index: 1, name: "Microsoft Basic Render Driver", dedicatedMb: 0, sharedMb: 14_155, budgetMb: 13_387, software: true },
];

/** A read like the one of this laptop: dwm, VS Code and a leased Chromium on the Radeon, and two Windows AI hosts on the NPU. */
function sample(options: { readonly radeonDedicatedMb?: number; readonly engines?: CounterItem[] | null; readonly adapters?: readonly GpuAdapterInfo[] | null } = {}): GpuSample {
  return {
    counters: {
      adapterDedicated: [adapterItem(RADEON, options.radeonDedicatedMb ?? 1024), adapterItem(WARP, 0), adapterItem(NPU, 0)],
      adapterShared: [adapterItem(RADEON, 300), adapterItem(WARP, 0), adapterItem(NPU, 620)],
      processDedicated: [processItem(2320, RADEON, 216), processItem(13_048, RADEON, 373), processItem(500, RADEON, 100), processItem(500, RADEON, 50, 1)],
      processShared: [processItem(2320, RADEON, 297), processItem(13_048, RADEON, 38), processItem(9784, NPU, 160), processItem(18_800, NPU, 165), processItem(77, RADEON, 0.2)],
      engines:
        options.engines === undefined
          ? [
              engineItem(2320, RADEON, 0, "3D", 20),
              engineItem(13_048, RADEON, 0, "3D", 15),
              engineItem(13_048, RADEON, 1, "Copy", 5),
              engineItem(500, RADEON, 3, "Video Decode", 40),
              engineItem(9784, NPU, 0, "Compute 0", 10),
            ]
          : options.engines,
    },
    adapters: options.adapters === undefined ? DXGI : options.adapters,
  };
}

const proc = (pid: number, name: string): ProcessInfo => ({ pid, ppid: 1, name, privateMb: 100, workingMb: 50 });
const PROCESSES = [proc(2320, "dwm.exe"), proc(13_048, "Code.exe"), proc(500, "chrome.exe"), proc(9784, "WorkloadsSessionHost.exe"), proc(18_800, "WorkloadsSessionHost.exe")];
const NAMES = new Map(PROCESSES.map((info) => [info.pid, info.name]));
const OWNER_OF: Record<number, [string, OwnerKind]> = {
  2320: ["system", "system"],
  13_048: ["session:graph", "session"],
  500: ["session:graph", "session"],
  9784: ["system", "system"],
  18_800: ["system", "system"],
};
const OWNERS: Owners = {
  ownerOf: new Map(Object.entries(OWNER_OF).map(([pid, [owner]]) => [Number(pid), owner])),
  kindOf: new Map(Object.values(OWNER_OF).map(([owner, kind]) => [owner, kind])),
  leaseOf: new Map([[500, "L1"]]),
};
const MEMORY: SystemMemory = { totalMb: TOTAL_MB, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 };

describe("parseGpuInstance (H36)", () => {
  it("parses the names of an adapter, a process and an engine", () => {
    expect(parseGpuInstance(`luid_${RADEON}_phys_0`)).toEqual({ pid: null, luid: "0x00000000_0x0001665f", phys: 0, engine: null });
    expect(parseGpuInstance(`pid_11392_luid_${RADEON}_phys_0`)).toEqual({ pid: 11_392, luid: "0x00000000_0x0001665f", phys: 0, engine: null });
    expect(parseGpuInstance(`pid_11392_luid_${RADEON}_phys_0_eng_2_engtype_Compute 0`)).toEqual({
      pid: 11_392,
      luid: "0x00000000_0x0001665f",
      phys: 0,
      engine: { index: 2, type: "Compute 0" },
    });
  });

  it("parses odd names: an empty engine type, an underscore in the type, a second node and lowercase hex digits", () => {
    expect(parseGpuInstance("pid_7_luid_0xFFFFFFFF_0xabcdef01_phys_1_eng_12_engtype_")).toEqual({
      pid: 7,
      luid: "0xffffffff_0xabcdef01",
      phys: 1,
      engine: { index: 12, type: "" },
    });
    expect(parseGpuInstance(`pid_7_luid_${RADEON}_phys_0_eng_3_engtype_Graphics_1`)?.engine).toEqual({ index: 3, type: "Graphics_1" });
    expect(parseGpuInstance(`pid_0_luid_${RADEON}_phys_0_eng_0_engtype_Video Codec Engine`)).toMatchObject({ pid: 0, engine: { type: "Video Codec Engine" } });
  });

  it("gives null for bad names, and stays fast on a long name", () => {
    const bad = [
      "",
      "_Total",
      `pid__luid_${RADEON}_phys_0`,
      `pid_12a_luid_${RADEON}_phys_0`,
      `pid_12345678901_luid_${RADEON}_phys_0`,
      "luid_0x0000000_0x0001665F_phys_0",
      "luid_0x00000000-0x0001665F_phys_0",
      "luid_0x0000000G_0x0001665F_phys_0",
      "luid_00000000000_0x0001665F_phys_0",
      `luid_${RADEON}`,
      `luid_${RADEON}_phys_`,
      `luid_${RADEON}_phys_0_extra`,
      `luid_${RADEON}_phys_x`,
      `pid_1_luid_${RADEON}_phys_0_eng__engtype_3D`,
      `pid_1_luid_${RADEON}_phys_0_eng_1_type_3D`,
      `pid_1_luid_${RADEON}_phys_0_eng_1`,
      `pid_1_${"_".repeat(50_000)}`,
      `pid_${"1".repeat(50_000)}_luid_${RADEON}_phys_0`,
    ];
    const start = performance.now();
    for (const name of bad) expect(parseGpuInstance(name), name.slice(0, 60)).toBeNull();
    expect(performance.now() - start).toBeLessThan(50);
  });

  it("gives the family of each engine type", () => {
    const families = ["3D", "Graphics_1", "Compute 0", "Cuda", "Copy", "VideoDecode", "Video Codec Engine", "Security 1", "Timer 0", ""].map(engineFamily);
    expect(families).toEqual(["3d", "3d", "compute", "compute", "copy", "video", "video", "other", "other", "other"]);
  });
});

describe("gpuRead (H36)", () => {
  it("sums the memory of each process and adapter, and takes the busiest engine as the use of an adapter", () => {
    const read = gpuRead(sample(), TOTAL_MB);
    expect(read?.adapters).toEqual([
      {
        id: "gpu:0",
        name: "AMD Radeon(TM) 860M Graphics",
        luid: "0x00000000_0x0001665f",
        dedicatedMb: 1024,
        sharedMb: 300,
        usedMb: 1324,
        capacityMb: 4096 + 14_155,
        dedicatedLimitMb: 4096,
        sharedLimitMb: 14_155,
        budgetMb: 17_430,
        limitsFrom: "dxgi",
        // Engine 0 (3D) has 20% + 15%, the video engine has 40%: the busiest engine gives the use.
        busyPercent: 40,
        engines: { "3d": 35, copy: 5, video: 40 },
      },
      {
        // DXGI does not list the NPU, so its shared limit is half of the RAM. The software adapter with no memory is absent.
        id: "gpu:2",
        name: "adapter 0x0001dfbe",
        luid: "0x00000000_0x0001dfbe",
        dedicatedMb: 0,
        sharedMb: 620,
        usedMb: 620,
        capacityMb: 14_155,
        dedicatedLimitMb: null,
        sharedLimitMb: 14_155,
        budgetMb: null,
        limitsFrom: "default",
        busyPercent: 10,
        engines: { compute: 10 },
      },
    ]);
    // The two nodes of the process 500 add up, and the process 77 with less than 1 MB and no use is absent.
    expect(read?.processes.find((each) => each.pid === 500)).toEqual({ pid: 500, adapter: "gpu:0", dedicatedMb: 150, sharedMb: 0, busyPercent: 40, engines: { video: 40 } });
    expect(read?.processes.map((each) => each.pid)).toEqual([2320, 13_048, 18_800, 9784, 500]);
  });

  it("gives no use before two collections, 0% with only idle engines, and at most 100%", () => {
    expect(gpuRead(sample({ engines: null }), TOTAL_MB)?.adapters[0]?.busyPercent).toBeNull();
    expect(gpuRead(sample({ engines: [] }), TOTAL_MB)?.adapters[0]).toMatchObject({ busyPercent: 0, engines: {} });
    const full = gpuRead(sample({ engines: [engineItem(1, RADEON, 0, "3D", 70), engineItem(2, RADEON, 0, "3D", 60)] }), TOTAL_MB);
    expect(full?.adapters[0]).toMatchObject({ busyPercent: 100, engines: { "3d": 100 } });
  });

  it("uses half of the RAM as the shared limit without DXGI, and orders the adapters by LUID", () => {
    const read = gpuRead(sample({ adapters: null }), TOTAL_MB);
    expect(read?.adapters.map((each) => [each.id, each.name, each.capacityMb, each.limitsFrom])).toEqual([
      ["gpu:0", "adapter 0x0001665f", 1024 + 14_155, "default"],
      ["gpu:2", "adapter 0x0001dfbe", 14_155, "default"],
    ]);
  });

  it("gives no GPU with no counter set, and no instance and no crash in the measure", () => {
    expect(gpuRead(null, TOTAL_MB)).toBeNull();
    expect(gpuRead(undefined, TOTAL_MB)).toBeNull();
    const empty: GpuSample = { counters: { adapterDedicated: null, adapterShared: null, processDedicated: null, processShared: null, engines: null }, adapters: DXGI };
    expect(gpuRead(empty, TOTAL_MB)).toBeNull();
    const readings: Readings = { at: 0, memory: MEMORY, processes: [], previous: [], disks: [], load: { processes: 0, userObjects: null, gdiObjects: null }, processors: 16, pools: {}, granted: {} };
    expect(measure(readings).filter((each) => each.id.startsWith("gpu:"))).toEqual([]);
  });
});

describe("GPU owners (H36)", () => {
  const read = gpuRead(sample(), TOTAL_MB);
  if (read === null) throw new Error("The sample gives no read.");

  it("sums the GPU memory and the use of each owner on one adapter, with a row for the leased job", () => {
    expect(gpuOwners(read, OWNERS, NAMES, "gpu:0")).toEqual([
      { owner: "session:graph", kind: "session", mb: 561, dedicatedMb: 523, sharedMb: 38, busyPercent: 40, processes: 2, top: "Code.exe" },
      { owner: "system", kind: "system", mb: 513, dedicatedMb: 216, sharedMb: 297, busyPercent: 20, processes: 1, top: "dwm.exe" },
      { owner: "lease:L1", kind: "lease", mb: 150, dedicatedMb: 150, sharedMb: 0, busyPercent: 40, processes: 1, top: "chrome.exe" },
    ]);
    // On all the adapters, the system also holds the shared memory of the NPU.
    expect(gpuOwners(read, OWNERS, NAMES).find((each) => each.owner === "system")).toMatchObject({ mb: 838, processes: 3, top: "dwm.exe" });
  });

  it("gives the status of each adapter, the GPU memory of each lease, and the lines of headroom status", () => {
    const status = gpuStatus(read, OWNERS, NAMES);
    expect(status?.leases).toEqual({ L1: 150 });
    expect(status?.adapters[0]).toMatchObject({ freeMb: 18_251 - 1324, owners: [{ owner: "session:graph" }, { owner: "system" }] });
    expect(gpuLines(status)).toEqual([
      "GPU 0 (AMD Radeon(TM) 860M Graphics): 1.3 of 17.8 GB (0.3 GB in RAM), 40% busy. Most: session:graph Code.exe 561 MB, system dwm.exe 513 MB.",
      "GPU 2 (adapter 0x0001dfbe): 0.6 of 13.8 GB (0.6 GB in RAM), 10% busy. Most: system WorkloadsSessionHost.exe 325 MB.",
    ]);
    const one = gpuStatus({ adapters: read.adapters.slice(0, 1), processes: read.processes.filter((each) => each.adapter === "gpu:0") }, OWNERS, NAMES);
    expect(gpuLines(one)[0]).toMatch(/^GPU: 1\.3 of 17\.8 GB/);
    expect(gpuLines(null)).toEqual([]);
    expect(leaseGpuText({ id: "L1", peakGpuMb: 900 }, status)).toBe("GPU 150 MB, peak 900 MB");
    expect(leaseGpuText({ id: "L2", peakGpuMb: undefined }, status)).toBeNull();
  });

  it("gives the owners of each adapter in the resources, not the owners of all the adapters", () => {
    const readings: Readings = {
      at: 0, memory: MEMORY, processes: PROCESSES, previous: [], disks: [], load: { processes: 5, userObjects: null, gdiObjects: null },
      processors: 16, pools: {}, granted: {}, gpu: read,
    };
    const resources = withKinds(measure(readings), { readings, owners: OWNERS });
    expect(resources.find((each) => each.id === "gpu:0")?.owners.map((each) => [each.owner, each.value])).toEqual([["session:graph", 561], ["system", 513]]);
    expect(resources.find((each) => each.id === "gpu:2")?.owners.map((each) => [each.owner, each.value])).toEqual([["system", 325]]);
  });
});

describe("the memory rule of H36", () => {
  it("keeps the available memory as the free memory: Windows already counts the shared GPU memory in it", () => {
    const read = gpuRead(sample(), TOTAL_MB);
    const readings: Readings = {
      at: 0, memory: MEMORY, processes: PROCESSES, previous: [], disks: [], load: { processes: 5, userObjects: null, gdiObjects: null },
      processors: 16, pools: {}, granted: {}, gpu: read ?? undefined,
    };
    const byId = new Map(measure(readings).map((each) => [each.id, each]));
    expect(byId.get("memory")).toEqual({ id: "memory", capacity: TOTAL_MB, used: TOTAL_MB - 9000, free: 9000 });
    expect(byId.get("gpu:0")).toMatchObject({ capacity: 18_251, used: 1324, free: 16_927, gpu: { sharedMb: 300 } });
  });
});

describe("the GPU alert (H36)", () => {
  const high = gpuRead(sample({ radeonDedicatedMb: 16_500 }), TOTAL_MB);
  const input = (at: number, points: readonly number[]) => ({
    memory: MEMORY,
    processes: PROCESSES,
    ownerOf: OWNERS.ownerOf,
    kindOf: OWNERS.kindOf,
    leases: [],
    gpu: high ?? undefined,
    at,
    trails: new Map([["gpu:0", points.map((at) => ({ at, value: 16_800 }))]]),
  });

  it("warns after 2 minutes above 90% of the limits, and names the owners with the most GPU memory", () => {
    const [alert] = detect(input(120_000, [0, 60_000, 120_000]), DEFAULT_ALERT_RULES);
    expect(alert).toMatchObject({ id: "gpu:0", kind: "gpu", severity: "warning", subject: "AMD Radeon(TM) 860M Graphics", mb: 16_800 });
    expect(alert?.message).toBe(
      "The GPU memory of AMD Radeon(TM) 860M Graphics is 16.4 GB of 17.8 GB (92%), above 90% for 2 minutes. Most GPU memory: session:graph Code.exe 561 MB, system dwm.exe 513 MB. The shared part (0.3 GB) is in the RAM, so less memory is available for the jobs.",
    );
  });

  it("gives no alert before 2 minutes, and none below the limit", () => {
    expect(detect(input(100_000, [0, 60_000, 100_000]), DEFAULT_ALERT_RULES)).toEqual([]);
    const low = { ...input(120_000, [0, 60_000, 120_000]), trails: new Map([["gpu:0", [0, 60_000, 120_000].map((at) => ({ at, value: 10_000 }))]]) };
    expect(detect(low, DEFAULT_ALERT_RULES)).toEqual([]);
  });
});

describe("the engine with a GPU (H36)", () => {
  const self = process.pid;
  const memory = (): SystemMemory => MEMORY;

  it("reads the GPU at each read of the processes, keeps the peak of a lease, and alerts after 2 minutes", () => {
    let now = 1_000_000;
    let leaseMb = 300;
    let dedicatedMb = 1024;
    const gpu = (): GpuSample => {
      const base = sample({ radeonDedicatedMb: dedicatedMb });
      return { ...base, counters: { ...base.counters, processShared: [...(base.counters.processShared ?? []), processItem(self, RADEON, leaseMb)] } };
    };
    const sampler: Sampler = { memory, processes: () => [proc(self, "node.exe"), ...PROCESSES], gpu, close: () => undefined };
    const engine = new Engine({ sampler, store: new Store(":memory:"), sessionsDir: "/nowhere", processors: 16, now: () => now });
    const lease = engine.request({ holder: "graph", job: "e2e", amounts: {}, ttlMs: 3_600_000, pid: self });
    engine.tick();
    expect(engine.status().gpu?.leases[lease.id]).toBe(300);
    expect(engine.status().resources.find((each) => each.id === "gpu:0")).toMatchObject({ kind: "gpu", unit: "MB", used: 1324, capacity: 18_251 });
    leaseMb = 900;
    now += 10_000;
    engine.tick();
    leaseMb = 100;
    now += 10_000;
    engine.tick();
    expect(engine.status().gpu?.leases[lease.id]).toBe(100);
    expect(engine.jobs({ query: lease.id })[0]).toMatchObject({ peakGpuMb: 900 });
    // 16.4 GB of 17.8 GB is above 90%: the alert starts only after 2 minutes above the limit.
    dedicatedMb = 16_500;
    const step = (): void => {
      now += 10_000;
      engine.tick();
    };
    // The first read above the limit and 11 more reads cover 110 seconds.
    for (let count = 0; count < 12; count++) step();
    expect(engine.alerts().active.map((alert) => alert.id)).not.toContain("gpu:0");
    step();
    expect(engine.alerts().active.find((alert) => alert.id === "gpu:0")).toMatchObject({ kind: "gpu", severity: "warning" });
    engine.close();
  });

  it("gives no GPU and continues when the read gives nothing or fails", () => {
    for (const gpu of [() => null, (): GpuSample => { throw new Error("PDH failed"); }]) {
      const sampler: Sampler = { memory, processes: () => PROCESSES, gpu, close: () => undefined };
      const engine = new Engine({ sampler, store: new Store(":memory:"), sessionsDir: "/nowhere", processors: 16 });
      engine.tick();
      const status = engine.status();
      expect(status.gpu).toBeNull();
      expect(status.resources.some((each) => each.kind === "gpu")).toBe(false);
      expect(status.resources.find((each) => each.id === "memory")).toMatchObject({ free: 9000 });
      engine.close();
    }
  });
});
