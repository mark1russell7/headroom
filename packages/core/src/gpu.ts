/**
 * The GPU of each process (H36). The sampler of Windows reads five wildcard counters of PDH in the query of the Energy
 * Meter, with one collection for each read of the processes. This file turns the counter arrays into adapters and processes.
 *
 * - `\GPU Adapter Memory(*)\Dedicated Usage` and `Shared Usage` give the used memory of each adapter.
 * - `\GPU Process Memory(*)\Dedicated Usage` and `Shared Usage` give the GPU memory of each process on each adapter.
 * - `\GPU Engine(*)\Utilization Percentage` gives the use of each engine of each process.
 * - DXGI gives the name and the memory limits of each adapter, one time (`windows-gpu.ts`).
 *
 * Shared GPU memory is in the RAM of the computer. Windows already counts it in the available memory, in the commit
 * charge and in the private bytes of its process (`docs/RESOURCES.md`, H36). Thus headroom only gives it to its owner.
 */

import type { Lease } from "./broker.ts";
import type { Owners } from "./resources.ts";
import type { OwnerKind } from "./types.ts";
import type { CounterItem } from "./thermal.ts";
import { diskSize, gb } from "./units.ts";

/** The counter arrays of one GPU read, in bytes and in percent. A counter that PDH does not have gives `null`. */
export interface GpuCounters {
  readonly adapterDedicated: readonly CounterItem[] | null;
  readonly adapterShared: readonly CounterItem[] | null;
  readonly processDedicated: readonly CounterItem[] | null;
  readonly processShared: readonly CounterItem[] | null;
  /**
   * The use of each engine of each process. The first collection of the query gives none, because the use is a rate. The
   * sampler can leave out the engines with no use.
   */
  readonly engines: readonly CounterItem[] | null;
}

/** One adapter of DXGI: its name and its memory limits, from one read at the first sample. */
export interface GpuAdapterInfo {
  /** The LUID of the adapter in the form of the counter names, in lowercase: `0x00000000_0x0001665f`. */
  readonly luid: string;
  /** The order of the adapter in DXGI. The adapter of the main display comes first. */
  readonly index: number;
  readonly name: string;
  /** The dedicated memory: the video memory and the system memory that only the GPU uses, in MB. */
  readonly dedicatedMb: number;
  /** The limit of the shared system memory, in MB. Windows sets half of the RAM by default. */
  readonly sharedMb: number;
  /** The budget of DXGI for one process (`QueryVideoMemoryInfo`), in MB, or `null` when the call failed. */
  readonly budgetMb: number | null;
  /** True for a software adapter, for example the Microsoft Basic Render Driver. */
  readonly software: boolean;
}

/** One GPU read of the sampler: the counter arrays, and the adapters of DXGI. */
export interface GpuSample {
  readonly counters: GpuCounters;
  /** The adapters of DXGI, or `null` when DXGI gave none. */
  readonly adapters: readonly GpuAdapterInfo[] | null;
}

/** The family of a GPU engine. Task Manager shows the same families. */
export type GpuEngine = "3d" | "compute" | "copy" | "video" | "other";

/** The use of each family of engines, in percent. A family with no use is absent. */
export type EngineUse = Readonly<Partial<Record<GpuEngine, number>>>;

/** One adapter at one read. */
export interface GpuAdapter {
  /** The instance id: `gpu:<n>`. A DXGI adapter gets its DXGI order. */
  readonly id: string;
  readonly name: string;
  readonly luid: string;
  readonly dedicatedMb: number;
  /** The used shared memory, in MB. It is in the RAM of the computer. */
  readonly sharedMb: number;
  /** The dedicated memory and the shared memory, in MB. */
  readonly usedMb: number;
  /** The dedicated limit and the shared limit, in MB. Without a dedicated limit, the dedicated use counts as its limit. */
  readonly capacityMb: number;
  /** The dedicated limit from DXGI, in MB, or `null` without DXGI. */
  readonly dedicatedLimitMb: number | null;
  readonly sharedLimitMb: number;
  /** The budget of DXGI for one process, in MB, or `null`. */
  readonly budgetMb: number | null;
  /** `dxgi`: the limits come from DXGI. `default`: the shared limit is half of the RAM, the default of Windows. */
  readonly limitsFrom: "dxgi" | "default";
  /** The use of the busiest engine, in percent, as Task Manager shows it, or `null` before two collections. */
  readonly busyPercent: number | null;
  /** The use of the busiest engine of each family, in percent. */
  readonly engines: EngineUse;
}

/** The GPU use of one process on one adapter. */
export interface GpuProcess {
  readonly pid: number;
  /** The id of the adapter: `gpu:<n>`. */
  readonly adapter: string;
  readonly dedicatedMb: number;
  readonly sharedMb: number;
  /** The use of the busiest engine of the process, in percent. */
  readonly busyPercent: number;
  /** The use of the busiest engine of each family of the process, in percent. */
  readonly engines: EngineUse;
}

/** The GPU at one read: the adapters, and the processes with GPU memory or GPU use. */
export interface GpuRead {
  readonly adapters: readonly GpuAdapter[];
  readonly processes: readonly GpuProcess[];
}

/** The parts of the name of an instance of a GPU counter. */
export interface GpuInstance {
  /** The process, or `null` for an instance of an adapter. */
  readonly pid: number | null;
  /** The LUID of the adapter, in lowercase: `0x00000000_0x0001665f`. */
  readonly luid: string;
  readonly phys: number;
  /** The engine: its index and its type, for an instance of `GPU Engine`. Other instances have none. */
  readonly engine: { readonly index: number; readonly type: string } | null;
}

/** The longest instance name that the parser examines. A name of Windows has fewer than 100 characters. */
const MAX_NAME = 200;

/** This function tells if a text is 1 to `max` decimal digits. */
function isDigits(text: string, max: number): boolean {
  if (text.length === 0 || text.length > max) return false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

/** This function tells if a text is `0x` and 8 hexadecimal digits. */
function isHex32(text: string): boolean {
  if (text.length !== 10 || !text.startsWith("0x")) return false;
  for (let index = 2; index < 10; index++) {
    const code = text.charCodeAt(index) | 0x20;
    if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) return false;
  }
  return true;
}

/**
 * This function gives the parts of an instance name of a GPU counter, or `null` for a name of an other form. The forms
 * are `luid_0x…_0x…_phys_0`, `pid_1234_luid_0x…_0x…_phys_0` and `pid_1234_luid_0x…_0x…_phys_0_eng_0_engtype_3D`. The
 * parser uses plain string code, with no regular expression.
 */
export function parseGpuInstance(name: string): GpuInstance | null {
  if (name.length > MAX_NAME) return null;
  let at = 0;
  let pid: number | null = null;
  if (name.startsWith("pid_")) {
    const end = name.indexOf("_", 4);
    const digits = end < 0 ? "" : name.slice(4, end);
    if (!isDigits(digits, 10)) return null;
    pid = Number(digits);
    at = end + 1;
  }
  if (!name.startsWith("luid_", at)) return null;
  const high = name.slice(at + 5, at + 15);
  const low = name.slice(at + 16, at + 26);
  if (!isHex32(high) || name.charAt(at + 15) !== "_" || !isHex32(low)) return null;
  const luid = `${high}_${low}`.toLowerCase();
  at += 26;
  if (!name.startsWith("_phys_", at)) return null;
  at += 6;
  const physEnd = name.indexOf("_", at);
  const physText = physEnd < 0 ? name.slice(at) : name.slice(at, physEnd);
  if (!isDigits(physText, 4)) return null;
  const phys = Number(physText);
  if (physEnd < 0) return { pid, luid, phys, engine: null };
  if (!name.startsWith("_eng_", physEnd)) return null;
  at = physEnd + 5;
  const engineEnd = name.indexOf("_", at);
  const engineText = engineEnd < 0 ? "" : name.slice(at, engineEnd);
  if (!isDigits(engineText, 4) || !name.startsWith("_engtype_", engineEnd)) return null;
  return { pid, luid, phys, engine: { index: Number(engineText), type: name.slice(engineEnd + 9) } };
}

/** This function gives the family of an engine type: `3D`, `Compute 0`, `Copy`, `Video Decode` or another type. */
export function engineFamily(type: string): GpuEngine {
  const lower = type.toLowerCase();
  if (lower === "3d" || lower.startsWith("graphics")) return "3d";
  if (lower.startsWith("compute") || lower === "cuda") return "compute";
  if (lower.startsWith("copy")) return "copy";
  if (lower.startsWith("video")) return "video";
  return "other";
}

/** The number of bytes in one MB. */
const BYTES_PER_MB = 1024 * 1024;

/** This function rounds to one decimal. */
const tenth = (value: number): number => Math.round(value * 10) / 10;

/** This function keeps the higher value of a family. */
function keepMax(into: Map<GpuEngine, number>, family: GpuEngine, value: number): void {
  into.set(family, Math.max(into.get(family) ?? 0, value));
}

/** This function gives the families with a use, rounded to one decimal. */
function engineUse(families: ReadonlyMap<GpuEngine, number>): EngineUse {
  const use: Partial<Record<GpuEngine, number>> = {};
  for (const [family, value] of families) if (value >= 0.05) use[family] = tenth(Math.min(100, value));
  return use;
}

/** The use of one process on one adapter, while the read adds its counters. */
interface ProcessSum {
  readonly pid: number;
  readonly luid: string;
  dedicatedMb: number;
  sharedMb: number;
  readonly families: Map<GpuEngine, number>;
}

/** The smallest GPU memory of a process in the read, in MB. A process with less memory and no engine use is absent. */
const PROCESS_FLOOR_MB = 1;

/**
 * This function gives the adapters and the processes of one GPU read, or `null` when the computer has no GPU counters.
 * `totalMb` is the physical memory: without DXGI, the shared limit is half of it, the default of Windows.
 *
 * - The memory of an adapter and of a process is the sum of its instances.
 * - The use of an engine is the sum of its processes. The use of an adapter is the use of its busiest engine.
 * - The adapters are the DXGI hardware adapters and each other adapter with memory in use.
 */
export function gpuRead(sample: GpuSample | null | undefined, totalMb: number): GpuRead | null {
  if (sample === null || sample === undefined) return null;
  const { counters } = sample;
  if (counters.adapterDedicated === null && counters.adapterShared === null) return null;
  const usage = new Map<string, { dedicatedMb: number; sharedMb: number }>();
  const addAdapter = (items: readonly CounterItem[] | null, part: "dedicatedMb" | "sharedMb"): void => {
    for (const item of items ?? []) {
      const instance = parseGpuInstance(item.name);
      if (instance === null || instance.pid !== null) continue;
      const row = usage.get(instance.luid) ?? { dedicatedMb: 0, sharedMb: 0 };
      row[part] += Math.max(0, item.value) / BYTES_PER_MB;
      usage.set(instance.luid, row);
    }
  };
  addAdapter(counters.adapterDedicated, "dedicatedMb");
  addAdapter(counters.adapterShared, "sharedMb");

  const processes = new Map<string, ProcessSum>();
  const processOf = (pid: number, luid: string): ProcessSum => {
    const key = `${pid}|${luid}`;
    let row = processes.get(key);
    if (row === undefined) {
      row = { pid, luid, dedicatedMb: 0, sharedMb: 0, families: new Map() };
      processes.set(key, row);
    }
    return row;
  };
  const addProcess = (items: readonly CounterItem[] | null, part: "dedicatedMb" | "sharedMb"): void => {
    for (const item of items ?? []) {
      const instance = parseGpuInstance(item.name);
      if (instance === null || instance.pid === null || instance.engine !== null || !(item.value > 0)) continue;
      processOf(instance.pid, instance.luid)[part] += item.value / BYTES_PER_MB;
    }
  };
  addProcess(counters.processDedicated, "dedicatedMb");
  addProcess(counters.processShared, "sharedMb");

  // The use of each engine of an adapter is the sum of its processes. The key is the adapter, the node and the engine.
  // The sampler can skip the engines with no use, so an engine counter with no items gives 0%, not `null`.
  const engines = new Map<string, { readonly luid: string; readonly family: GpuEngine; sum: number }>();
  for (const item of counters.engines ?? []) {
    const instance = parseGpuInstance(item.name);
    if (instance === null || instance.pid === null || instance.engine === null || !(item.value > 0)) continue;
    const family = engineFamily(instance.engine.type);
    const key = `${instance.luid}|${instance.phys}|${instance.engine.index}`;
    const engine = engines.get(key) ?? { luid: instance.luid, family, sum: 0 };
    engine.sum += item.value;
    engines.set(key, engine);
    keepMax(processOf(instance.pid, instance.luid).families, family, item.value);
  }
  const familiesOf = new Map<string, Map<GpuEngine, number>>();
  for (const engine of engines.values()) {
    const families = familiesOf.get(engine.luid) ?? new Map<GpuEngine, number>();
    keepMax(families, engine.family, engine.sum);
    familiesOf.set(engine.luid, families);
  }

  const infos = sample.adapters ?? [];
  const byLuid = new Map(infos.map((info) => [info.luid, info]));
  const others = [...usage.keys()].filter((luid) => !byLuid.has(luid)).sort();
  const adapters: GpuAdapter[] = [];
  for (const [luid, used] of [...usage].sort((a, b) => a[0].localeCompare(b[0]))) {
    const info = byLuid.get(luid);
    const usedMb = used.dedicatedMb + used.sharedMb;
    // A software adapter and an unknown adapter count only with memory in use.
    if ((info === undefined || info.software) && usedMb < PROCESS_FLOOR_MB) continue;
    const index = info === undefined ? infos.length + others.indexOf(luid) : info.index;
    const dedicatedLimitMb = info === undefined ? null : info.dedicatedMb;
    const sharedLimitMb = info === undefined ? Math.round(totalMb / 2) : info.sharedMb;
    const families = familiesOf.get(luid) ?? new Map<GpuEngine, number>();
    const busiest = Math.max(0, ...families.values());
    adapters.push({
      id: `gpu:${index}`,
      name: info?.name ?? `adapter ${luid.slice(luid.indexOf("_") + 1)}`,
      luid,
      dedicatedMb: tenth(used.dedicatedMb),
      sharedMb: tenth(used.sharedMb),
      usedMb: tenth(usedMb),
      capacityMb: tenth((dedicatedLimitMb ?? used.dedicatedMb) + sharedLimitMb),
      dedicatedLimitMb,
      sharedLimitMb,
      budgetMb: info?.budgetMb ?? null,
      limitsFrom: info === undefined ? "default" : "dxgi",
      busyPercent: counters.engines === null ? null : tenth(Math.min(100, busiest)),
      engines: engineUse(families),
    });
  }
  adapters.sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)));
  const idOf = new Map(adapters.map((adapter) => [adapter.luid, adapter.id]));
  const list: GpuProcess[] = [];
  for (const row of processes.values()) {
    const adapter = idOf.get(row.luid);
    const busiest = Math.max(0, ...row.families.values());
    if (adapter === undefined || (row.dedicatedMb + row.sharedMb < PROCESS_FLOOR_MB && busiest < 0.05)) continue;
    list.push({
      pid: row.pid,
      adapter,
      dedicatedMb: tenth(row.dedicatedMb),
      sharedMb: tenth(row.sharedMb),
      busyPercent: tenth(Math.min(100, busiest)),
      engines: engineUse(row.families),
    });
  }
  list.sort((a, b) => b.dedicatedMb + b.sharedMb - (a.dedicatedMb + a.sharedMb) || a.pid - b.pid);
  return { adapters, processes: list };
}

/** The GPU use of one owner or one leased job. */
export interface GpuOwnerUse {
  /** The owner, or `lease:<id>` for a leased job. */
  readonly owner: string;
  readonly kind: OwnerKind | "lease";
  /** The dedicated memory and the shared memory, in MB. */
  readonly mb: number;
  readonly dedicatedMb: number;
  readonly sharedMb: number;
  /** The use of the busiest family of engines of the owner, in percent. */
  readonly busyPercent: number;
  readonly processes: number;
  /** The name of the process with the most GPU memory, for example `chrome.exe`, or `null` when the read has no name. */
  readonly top: string | null;
}

/** The sums of one owner while `gpuOwners()` adds its processes. */
interface OwnerSum {
  readonly kind: OwnerKind | "lease";
  dedicatedMb: number;
  sharedMb: number;
  processes: number;
  top: { name: string | null; mb: number };
  readonly families: Map<GpuEngine, number>;
}

/**
 * This function gives the GPU use of each owner and of each leased job, the most memory first. `names` gives the name of
 * each process. With `adapter`, only the processes on that adapter count. A lease row is a part of the row of its owner.
 */
export function gpuOwners(read: GpuRead, owners: Owners, names: ReadonlyMap<number, string>, adapter?: string): GpuOwnerUse[] {
  const sums = new Map<string, OwnerSum>();
  const add = (owner: string, kind: OwnerKind | "lease", process: GpuProcess): void => {
    let sum = sums.get(owner);
    if (sum === undefined) {
      sum = { kind, dedicatedMb: 0, sharedMb: 0, processes: 0, top: { name: null, mb: -1 }, families: new Map() };
      sums.set(owner, sum);
    }
    const mb = process.dedicatedMb + process.sharedMb;
    sum.dedicatedMb += process.dedicatedMb;
    sum.sharedMb += process.sharedMb;
    sum.processes += 1;
    if (mb > sum.top.mb) sum.top = { name: names.get(process.pid) ?? null, mb };
    for (const [family, value] of Object.entries(process.engines) as [GpuEngine, number][]) sum.families.set(family, (sum.families.get(family) ?? 0) + value);
  };
  for (const process of read.processes) {
    if (adapter !== undefined && process.adapter !== adapter) continue;
    const owner = owners.ownerOf.get(process.pid) ?? "other";
    add(owner, owners.kindOf.get(owner) ?? "other", process);
    const lease = owners.leaseOf.get(process.pid);
    if (lease !== undefined) add(`lease:${lease}`, "lease", process);
  }
  return [...sums]
    .map(([owner, sum]) => ({
      owner,
      kind: sum.kind,
      mb: tenth(sum.dedicatedMb + sum.sharedMb),
      dedicatedMb: tenth(sum.dedicatedMb),
      sharedMb: tenth(sum.sharedMb),
      busyPercent: tenth(Math.min(100, Math.max(0, ...sum.families.values()))),
      processes: sum.processes,
      top: sum.top.name,
    }))
    .sort((a, b) => b.mb - a.mb || b.busyPercent - a.busyPercent || a.owner.localeCompare(b.owner));
}

/** The GPU memory of each leased job, in MB, by lease id. */
export function leaseGpuMb(read: GpuRead | null | undefined, leaseOf: ReadonlyMap<number, string>): Map<string, number> {
  const result = new Map<string, number>();
  for (const process of read?.processes ?? []) {
    const lease = leaseOf.get(process.pid);
    if (lease !== undefined) result.set(lease, tenth((result.get(lease) ?? 0) + process.dedicatedMb + process.sharedMb));
  }
  return result;
}

/** One adapter in `Status.gpu`, with its owners. */
export interface GpuAdapterStatus extends GpuAdapter {
  readonly freeMb: number;
  /** The 10 owners with the most GPU memory on the adapter. The rows of the leased jobs are absent. */
  readonly owners: readonly GpuOwnerUse[];
}

/** The GPU in `Status` (H36). */
export interface GpuStatus {
  readonly adapters: readonly GpuAdapterStatus[];
  /** The GPU memory of each granted lease, in MB, by lease id. A lease with no GPU memory is absent. */
  readonly leases: Readonly<Record<string, number>>;
}

/** The count of owners of each adapter in `Status.gpu`. */
const GPU_OWNERS_KEPT = 10;

/** This function gives the GPU of the status from a read, or `null` when the computer has no GPU counters. */
export function gpuStatus(read: GpuRead | null | undefined, owners: Owners, names: ReadonlyMap<number, string>): GpuStatus | null {
  if (read === null || read === undefined) return null;
  return {
    adapters: read.adapters.map((adapter) => ({
      ...adapter,
      freeMb: tenth(Math.max(0, adapter.capacityMb - adapter.usedMb)),
      owners: gpuOwners(read, owners, names, adapter.id).filter((each) => each.kind !== "lease").slice(0, GPU_OWNERS_KEPT),
    })),
    leases: Object.fromEntries(leaseGpuMb(read, owners.leaseOf)),
  };
}

/** The count of owners that a GPU line and the GPU alert name. */
export const GPU_OWNERS_SHOWN = 3;

/** This function gives "session:graph chrome.exe 0.8 GB, docker 300 MB" for the owners with at least 1 MB. */
export function gpuOwnersText(owners: readonly GpuOwnerUse[], count: number = GPU_OWNERS_SHOWN): string {
  return owners
    .filter((each) => each.kind !== "lease" && each.mb >= 1)
    .slice(0, count)
    .map((each) => `${each.owner}${each.top === null ? "" : ` ${each.top}`} ${diskSize(each.mb)}`)
    .join(", ");
}

/**
 * This function gives one line for each adapter for `headroom status`, for example "GPU: 1.2 of 17.8 GB (0.3 GB in RAM),
 * 34% busy. Most: session:graph chrome.exe 0.8 GB." A computer with no GPU counters gives no line.
 */
export function gpuLines(gpu: GpuStatus | null | undefined): string[] {
  const adapters = gpu?.adapters ?? [];
  return adapters.map((adapter) => {
    const label = adapters.length === 1 ? "GPU" : `GPU ${adapter.id.slice(4)} (${adapter.name})`;
    const busy = adapter.busyPercent === null ? "" : `, ${Math.round(adapter.busyPercent)}% busy`;
    const most = gpuOwnersText(adapter.owners);
    return `${label}: ${(adapter.usedMb / 1024).toFixed(1)} of ${gb(adapter.capacityMb)} (${gb(adapter.sharedMb)} in RAM)${busy}.${most === "" ? "" : ` Most: ${most}.`}`;
  });
}

/** This function gives the GPU text of a lease for `headroom status`: "GPU 0.4 GB, peak 0.9 GB", or `null` with no GPU memory. */
export function leaseGpuText(lease: Pick<Lease, "id" | "peakGpuMb">, gpu: GpuStatus | null | undefined): string | null {
  const now = gpu?.leases[lease.id];
  const peak = lease.peakGpuMb;
  if ((now === undefined || now < 1) && (peak === undefined || peak < 1)) return null;
  const parts = [`GPU ${diskSize(now ?? 0)}`];
  if (peak !== undefined && peak >= 1) parts.push(`peak ${diskSize(peak)}`);
  return parts.join(", ");
}
