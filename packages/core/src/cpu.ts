/**
 * The processors (H23): the parts of the CPU that are not in the registry of `resources.ts`.
 *
 * - The groups of the processes: each leased job, and each process tree with no lease. The counter tracker keeps the
 *   processor time of each group, so the runaway rule and the peak cores of a lease use the same reads.
 * - The trails: the cores at each read, as an average over the minute before the read. A rule with a duration reads them.
 * - The CPU rate of a job object: a hard cap with `--limit`, else a weight. This file has the numbers and the bytes of
 *   `JOBOBJECT_CPU_RATE_CONTROL_INFORMATION`. Only `jobs.ts` loads the Windows functions.
 *
 * Each function here is pure, so the tests use fixed reads and a fake binding.
 */

import type { Lease } from "./broker.ts";
import { parentOf } from "./owners.ts";
import type { Owners, ResourceStatus } from "./resources.ts";
import { percentile90 } from "./spawn.ts";
import type { ProcessInfo } from "./types.ts";

/** The cores that the broker keeps out of the counted `cpu` pool for Mark, by default. `headroom config cpu-reserve` changes it. */
export const CPU_RESERVE_DEFAULT = 2;

/** The weight of a job without `--limit`. Windows accepts 1 to 9, and 5 is the default of Windows. */
export const CPU_WEIGHT_DEFAULT = 5;

/** The amount of `--cpu auto` for a job with no run that has a peak, in cores. */
export const CPU_AUTO_DEFAULT = 2;

/** The information class `JobObjectCpuRateControlInformation` of `SetInformationJobObject`. */
export const JOB_OBJECT_CPU_RATE_CONTROL_INFORMATION = 15;
/** `JOB_OBJECT_CPU_RATE_CONTROL_ENABLE`: the CPU rate control is on. Each other flag needs it. */
export const CPU_RATE_CONTROL_ENABLE = 0x1;
/** `JOB_OBJECT_CPU_RATE_CONTROL_WEIGHT_BASED`: the job shares the processors with the other jobs by its weight. */
export const CPU_RATE_CONTROL_WEIGHT_BASED = 0x2;
/** `JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP`: the job does not run past its rate in each scheduling interval. */
export const CPU_RATE_CONTROL_HARD_CAP = 0x4;
/** The size of `JOBOBJECT_CPU_RATE_CONTROL_INFORMATION`: `ControlFlags`, then a union of 4 bytes. */
export const CPU_RATE_INFO_SIZE = 8;
/** The cycles of all the processors in the unit of `CpuRate`. A rate of 10000 is all the processors. */
const RATE_SCALE = 10_000;

/** The prefix of the group of a leased job in the counter tracker. */
export const LEASE_GROUP = "lease:";
/** The prefix of the group of a process tree with no lease. The process ID of the root of the tree follows it. */
export const TREE_GROUP = "tree:";

/** The CPU rate of a job object: a hard cap in cycles for each 10,000 cycles, or a weight from 1 to 9. */
export type CpuControl = { readonly mode: "cap"; readonly rate: number } | { readonly mode: "weight"; readonly weight: number };

/** One point of a trail: the time of a read, and the cores over the minute before the read. */
export interface TrailPoint {
  readonly at: number;
  readonly value: number;
}

/** The processor use of one process tree with no lease (H23). The runaway rule of the CPU reads it. */
export interface TreeUse {
  /** The root of the tree. A tree of a session starts below the process of the session. */
  readonly pid: number;
  /** The live processes of the tree at the last read. */
  readonly processes: number;
  /** The cores of the tree at each read of the last 11 minutes, the oldest first. */
  readonly trail: readonly TrailPoint[];
}

/** This function gives the CPU rate of a hard cap of a count of cores, from 1 to 10000. A lease of 2 cores on 16 processors gives 1250. */
export function cpuRateOf(cores: number, processors: number): number {
  if (!(cores > 0) || !(processors > 0)) throw new RangeError("The cores and the processors must be above 0");
  return Math.min(RATE_SCALE, Math.max(1, Math.round((cores / processors) * RATE_SCALE)));
}

/** This function gives the cores of a CPU rate, with 2 decimals. */
export function coresOfRate(rate: number, processors: number): number {
  return Math.round((rate / RATE_SCALE) * processors * 100) / 100;
}

/**
 * This function gives the CPU control of a job from its limits. A hard cap wins over a weight. A weight outside 1 to 9
 * goes to the nearest end. Without a rate and a weight, the job has no CPU control.
 */
export function cpuControlOf(limits: { readonly cpuRate?: number | undefined; readonly cpuWeight?: number | undefined }): CpuControl | null {
  if (limits.cpuRate !== undefined) return { mode: "cap", rate: Math.min(RATE_SCALE, Math.max(1, Math.round(limits.cpuRate))) };
  if (limits.cpuWeight !== undefined) return { mode: "weight", weight: Math.min(9, Math.max(1, Math.round(limits.cpuWeight))) };
  return null;
}

/** This function gives the bytes of `JOBOBJECT_CPU_RATE_CONTROL_INFORMATION` for a CPU control: `ControlFlags`, then `CpuRate` or `Weight`. */
export function cpuRateInfo(control: CpuControl): Buffer {
  const info = Buffer.alloc(CPU_RATE_INFO_SIZE);
  const flags = CPU_RATE_CONTROL_ENABLE | (control.mode === "cap" ? CPU_RATE_CONTROL_HARD_CAP : CPU_RATE_CONTROL_WEIGHT_BASED);
  info.writeUInt32LE(flags, 0);
  info.writeUInt32LE(control.mode === "cap" ? control.rate : control.weight, 4);
  return info;
}

/** The functions of `kernel32.dll` that set the CPU rate of a job. The tests give a fake binding. */
export interface CpuRateBinding {
  /** This function is `SetInformationJobObject` with a buffer. It gives 0 when it fails. */
  setInformation(job: number, infoClass: number, info: Buffer, length: number): number;
  /** This function is `GetLastError`. */
  lastError(): number;
}

/** This function sets the CPU rate of a job object. It throws an error with the error code of Windows when the call fails. */
export function applyCpuControl(binding: CpuRateBinding, job: number, control: CpuControl): void {
  const info = cpuRateInfo(control);
  if (binding.setInformation(job, JOB_OBJECT_CPU_RATE_CONTROL_INFORMATION, info, CPU_RATE_INFO_SIZE) === 0) {
    throw new Error(`SetInformationJobObject (CPU rate) failed with the error ${binding.lastError()}`);
  }
}

/** The size of `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION`. */
export const ACCOUNTING_SIZE = 48;
/** The offsets of `TotalUserTime` and `TotalKernelTime` in `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION`, in units of 100 ns. */
const ACCOUNTING_USER_TIME = 0;
const ACCOUNTING_KERNEL_TIME = 8;

/** This function gives the processor time of a job in ms from its accounting: `TotalUserTime` and `TotalKernelTime`. */
export function accountingCpuMs(info: Buffer): number {
  if (info.length < ACCOUNTING_KERNEL_TIME + 8) return 0;
  const ticks = info.readBigInt64LE(ACCOUNTING_USER_TIME) + info.readBigInt64LE(ACCOUNTING_KERNEL_TIME);
  return Number(ticks) / 10_000;
}

/**
 * This function gives the time that a condition held at the end of a trail. The time starts at the first point of the last
 * run of points that pass, and ends at `now`. The points are the oldest first. It gives 0 when the last point does not pass.
 */
export function heldMs(points: readonly TrailPoint[], now: number, pass: (value: number) => boolean): number {
  let from: number | null = null;
  for (let index = points.length - 1; index >= 0; index--) {
    const point = points[index];
    if (point === undefined || !pass(point.value)) break;
    from = point.at;
  }
  return from === null ? 0 : Math.max(0, now - from);
}

/** The longest chain of parents that `cpuGroups()` follows. */
const MAX_DEPTH = 64;

/**
 * This function gives the CPU group of each process. A leased process goes to `lease:<id>`. Each other process goes to
 * `tree:<pid>`, with the root of its tree: its top ancestor with the same owner and no lease. A session is different.
 * Its tree starts below the process of the session, so each command of the session is one tree.
 */
export function cpuGroups(processes: readonly ProcessInfo[], owners: Owners): Map<number, string> {
  const byPid = new Map(processes.map((info) => [info.pid, info]));
  const groups = new Map<number, string>();
  for (const info of processes) {
    const lease = owners.leaseOf.get(info.pid);
    if (lease !== undefined) {
      groups.set(info.pid, `${LEASE_GROUP}${lease}`);
      continue;
    }
    const owner = owners.ownerOf.get(info.pid) ?? "other";
    const chain: ProcessInfo[] = [info];
    const seen = new Set([info.pid]);
    for (let parent = parentOf(info, byPid); parent !== undefined && chain.length < MAX_DEPTH; parent = parentOf(parent, byPid)) {
      if (seen.has(parent.pid) || owners.leaseOf.has(parent.pid) || (owners.ownerOf.get(parent.pid) ?? "other") !== owner) break;
      chain.push(parent);
      seen.add(parent.pid);
    }
    const session = owners.kindOf.get(owner) === "session";
    const root = (session && chain.length >= 2 ? chain[chain.length - 2] : chain[chain.length - 1]) ?? info;
    groups.set(info.pid, `${TREE_GROUP}${root.pid}`);
  }
  return groups;
}

/**
 * This function gives the cores of `--cpu auto` from the peak cores of the last runs of a job: the rule of `--mem auto`.
 * It is the 90th percentile and 25% more, up to a whole core. It is at least 1 and at most the cores that the leases can
 * get. Without a peak, it gives `null`.
 */
export function suggestCores(peaks: readonly number[], leasable: number): number | null {
  const p90 = percentile90(peaks);
  if (p90 === null) return null;
  return Math.max(1, Math.min(Math.max(1, Math.floor(leasable)), Math.ceil(p90 * 1.25)));
}

/** This function gives a count of cores for a person: "1 core" or "2.5 cores". */
export function coresText(cores: number): string {
  const rounded = Math.round(cores * 10) / 10;
  return `${rounded} ${rounded === 1 ? "core" : "cores"}`;
}

/** The count of owners that the CPU line of `headroom status` names. */
const OWNERS_SHOWN = 3;

/**
 * This function gives the CPU line of `headroom status`, for example "CPU: 11.2 of 16 cores in use (2 kept for Mark).
 * Capped: graph-e2e 4 cores." A daemon of an older version gives no reserve and no cap. Before two reads, it gives `null`.
 */
export function cpuLine(cpu: ResourceStatus | undefined, reserve: number | undefined, leases: readonly Lease[]): string | null {
  if (cpu === undefined || cpu.used === null || cpu.capacity === null) return null;
  const kept = reserve === undefined || reserve <= 0 ? "" : ` (${reserve} kept for Mark)`;
  const most = (cpu.owners ?? []).filter((each) => each.value >= 0.05).slice(0, OWNERS_SHOWN);
  const named = most.length === 0 ? "" : ` Most: ${most.map((each) => `${each.owner} ${each.value.toFixed(1)}`).join(", ")}.`;
  const capped = leases.filter((lease) => lease.state === "granted" && lease.cpuCap !== undefined);
  const caps = capped.length === 0 ? "" : ` Capped: ${capped.map((lease) => `${lease.job.slice(0, 40)} ${coresText(lease.cpuCap ?? 0)}`).join(", ")}.`;
  return `CPU: ${cpu.used.toFixed(1)} of ${cpu.capacity} cores in use${kept}.${named}${caps}`;
}
