/**
 * The alerts (H9, H14): the conditions that come before a computer runs out of memory.
 *
 * - `runaway`: one process above a size that holds no lease, outside Docker and the system.
 * - `orphan`: a large process with no owner whose parent stopped. Nothing reads its output.
 * - `memory`: little available memory.
 * - `commit`: a commit charge near its limit.
 * - `pool`: a large non-paged kernel pool, or a pool that grows fast. A driver leak shows here.
 *
 * The alerts only report. headroom does not stop a process for an alert.
 */

import type { Lease } from "./broker.ts";
import type { OwnerKind, ProcessInfo, SystemMemory } from "./types.ts";

/** The kind of an alert. */
export type AlertKind = "runaway" | "orphan" | "memory" | "commit" | "pool";

/** One active alert. */
export interface Alert {
  /** The key of the alert: the kind and the subject. The same condition keeps the same key. */
  readonly id: string;
  readonly kind: AlertKind;
  /** The process, or the part of the computer. */
  readonly subject: string;
  readonly pid: number | null;
  /** The size that started the alert, in MB. */
  readonly mb: number;
  readonly message: string;
  /** The time of the first sample that showed the condition. */
  readonly since: number;
}

/** The limits of the alerts. */
export interface AlertRules {
  /** A process above this size, in MB, with no lease, is a runaway. The default is 4096. */
  readonly runawayMb: number;
  /** An orphan above this size, in MB, starts an alert. The default is 1024. */
  readonly orphanMb: number;
  /** Less available memory than this, in MB, starts an alert. The default is 1024. */
  readonly availableMb: number;
  /** A commit charge above this part of its limit starts an alert. The default is 0.9. */
  readonly commitRatio: number;
  /** A non-paged pool above this size, in MB, starts an alert. The default is 3072. */
  readonly poolMb: number;
  /** A non-paged pool that grows more than this in one hour, in MB, starts an alert. The default is 500. */
  readonly poolGrowthMb: number;
}

/** The default limits. */
export const DEFAULT_ALERT_RULES: AlertRules = {
  runawayMb: 4096,
  orphanMb: 1024,
  availableMb: 1024,
  commitRatio: 0.9,
  poolMb: 3072,
  poolGrowthMb: 500,
};

/** The data of one check. */
export interface AlertInput {
  readonly memory: SystemMemory;
  readonly processes: readonly ProcessInfo[];
  /** The owner of each process, and the kind of each owner. */
  readonly ownerOf: ReadonlyMap<number, string>;
  readonly kindOf: ReadonlyMap<string, OwnerKind>;
  readonly leases: readonly Lease[];
  /** The non-paged pool one hour ago, in MB, when the history has it. */
  readonly poolHourAgoMb?: number | undefined;
}

/** The owner kinds that a runaway alert does not examine: Docker and WSL have caps of their own, and the system is not a job. */
const NOT_JOBS: ReadonlySet<OwnerKind> = new Set(["docker", "system", "kernel"]);

const gb = (mb: number): string => `${(mb / 1024).toFixed(1)} GB`;

/** This function gives the processes under the granted leases: each lease process and its descendants. */
function leased(processes: readonly ProcessInfo[], leases: readonly Lease[]): Set<number> {
  const children = new Map<number, number[]>();
  for (const info of processes) {
    if (info.pid === info.ppid) continue;
    children.set(info.ppid, [...(children.get(info.ppid) ?? []), info.pid]);
  }
  const result = new Set<number>();
  const stack = leases.filter((lease) => lease.state === "granted" && lease.pid !== null).map((lease) => lease.pid as number);
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    if (result.has(pid)) continue;
    result.add(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return result;
}

/** This function gives the conditions of one check, without their start time. */
export function detect(input: AlertInput, rules: AlertRules = DEFAULT_ALERT_RULES): Omit<Alert, "since">[] {
  const alerts: Omit<Alert, "since">[] = [];
  const pids = new Set(input.processes.map((info) => info.pid));
  const underLease = leased(input.processes, input.leases);
  for (const info of input.processes) {
    const owner = input.ownerOf.get(info.pid) ?? "other";
    const kind = input.kindOf.get(owner) ?? "other";
    const subject = `${info.name} (${info.pid})`;
    if (info.privateMb > rules.runawayMb && !underLease.has(info.pid) && !NOT_JOBS.has(kind)) {
      alerts.push({
        id: `runaway:${info.pid}`,
        kind: "runaway",
        subject,
        pid: info.pid,
        mb: Math.round(info.privateMb),
        message: `${subject} of ${owner} holds ${gb(info.privateMb)} with no lease`,
      });
    } else if (info.privateMb > rules.orphanMb && kind === "other" && info.ppid > 0 && !pids.has(info.ppid)) {
      alerts.push({
        id: `orphan:${info.pid}`,
        kind: "orphan",
        subject,
        pid: info.pid,
        mb: Math.round(info.privateMb),
        message: `${subject} holds ${gb(info.privateMb)}, and its parent (${info.ppid}) stopped`,
      });
    }
  }
  const { memory } = input;
  if (memory.availableMb < rules.availableMb) {
    alerts.push({ id: "memory", kind: "memory", subject: "memory", pid: null, mb: Math.round(memory.availableMb), message: `Only ${Math.round(memory.availableMb)} MB of memory is available` });
  }
  if (memory.commitLimitMb > 0 && memory.commitMb > memory.commitLimitMb * rules.commitRatio) {
    alerts.push({
      id: "commit",
      kind: "commit",
      subject: "commit",
      pid: null,
      mb: Math.round(memory.commitMb),
      message: `The commit charge is ${gb(memory.commitMb)} of its limit ${gb(memory.commitLimitMb)}`,
    });
  }
  const growth = input.poolHourAgoMb === undefined ? 0 : memory.kernelNonpagedMb - input.poolHourAgoMb;
  if (memory.kernelNonpagedMb > rules.poolMb || growth > rules.poolGrowthMb) {
    alerts.push({
      id: "pool",
      kind: "pool",
      subject: "non-paged pool",
      pid: null,
      mb: Math.round(memory.kernelNonpagedMb),
      message: `The non-paged kernel pool is ${gb(memory.kernelNonpagedMb)}${growth > 0 ? `, ${Math.round(growth)} MB more than one hour ago` : ""}. A driver can leak it.`,
    });
  }
  return alerts;
}
