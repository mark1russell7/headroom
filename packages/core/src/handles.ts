/**
 * The handles of the processes (H48).
 *
 * Each open handle holds kernel memory: a file, a registry key, an event or another kernel object. A process that opens
 * handles and does not close them fills the kernel pools. On 2026-10-25, an orphan `find.exe` held 1.3 million handles.
 * The paged pool grew 593 MB an hour with the pool tags `Key` and `FMfn`, and a Playwright run failed with 0xC0000142.
 *
 * - The tracker keeps the handles of each process at each read of the last 7 minutes. The rule needs 5 minutes for the
 *   gain and 2 minutes for the clear. A read keeps only the processes with 1,000 handles or more, so the reads stay small.
 * - The text of the alert names the process, its owner from its record (`orphans.ts`), its command line and its age.
 * - headroom does not stop the process. The owner stops it by its process ID.
 */

import type { TrailPoint } from "./cpu.ts";
import { spanText } from "./forecast.ts";
import { ownerText, type ProcessRecord } from "./orphans.ts";
import { isOrphan, processKey } from "./owners.ts";
import type { AlertText, ProcessTrail, TrailFacts } from "./resources.ts";
import { countText } from "./starts.ts";
import type { ProcessInfo } from "./types.ts";

/** A read keeps only the processes with this count of handles or more. */
export const HANDLES_FLOOR = 1000;
/** The window of the reads: 5 minutes for the gain and 2 minutes for the clear. */
export const HANDLES_TRAIL_MS: number = 7 * 60_000;
/** The count of processes that `headroom status` names when one process is above the warning line. */
export const HANDLE_HOLDERS_SHOWN = 3;

/** One process with many handles, for `Status.handles`. */
export interface HandleHolder {
  readonly pid: number;
  readonly name: string;
  readonly handles: number;
  /** The owner, with `(orphan, parent ended)` when the parent of the process ended. */
  readonly owner: string;
  /** The command line from the record of the process, or `null`. */
  readonly command: string | null;
  /** The start of the process, in milliseconds since the epoch, when the read has it. */
  readonly startedAt?: number | undefined;
}

/** The handles of the computer at the last read of the processes (H48). */
export interface HandleStatus {
  /** The sum of the handles of all the processes. */
  readonly total: number;
  /** The warning line of one process. */
  readonly warning: number;
  /** The 3 processes with the most handles, the most first. */
  readonly top: readonly HandleHolder[];
}

/** One read of the tracker: its time and the handles of each process at or above the floor, by `processKey()`. */
interface HandleRead {
  readonly at: number;
  readonly counts: ReadonlyMap<string, number>;
}

/**
 * The tracker of the handles of each process (H48). The engine gives it each read of the processes. It keeps the reads
 * of the last 7 minutes, with only the processes at or above the floor.
 */
export class HandleTracker {
  #reads: HandleRead[] = [];

  /** This function adds one read of the processes, and removes the reads older than the window. */
  read(at: number, processes: readonly ProcessInfo[]): void {
    const counts = new Map<string, number>();
    for (const info of processes) if (info.handles !== undefined && info.handles >= HANDLES_FLOOR) counts.set(processKey(info), info.handles);
    const old = this.#reads.findIndex((each) => at - each.at <= HANDLES_TRAIL_MS);
    this.#reads = old < 0 ? [] : this.#reads.slice(old);
    this.#reads.push({ at, counts });
  }

  /** This function removes all the reads, for example after a sleep of the computer. */
  clear(): void {
    this.#reads = [];
  }

  /**
   * This function gives the trails of the live processes that went above an amount in a read of the window. A read with no
   * count of the process gives 0 before its start, and else the floor, the most that it can have held.
   */
  trails(processes: readonly ProcessInfo[], above: number): ProcessTrail[] {
    const high = new Set<string>();
    for (const read of this.#reads) for (const [key, count] of read.counts) if (count > above) high.add(key);
    if (high.size === 0) return [];
    const trails: ProcessTrail[] = [];
    for (const info of processes) {
      const key = processKey(info);
      if (!high.has(key)) continue;
      const trail = this.#reads.map((read) => ({
        at: read.at,
        value: read.counts.get(key) ?? (info.startedAt !== undefined && read.at < info.startedAt ? 0 : HANDLES_FLOOR),
      }));
      trails.push({ pid: info.pid, trail });
    }
    return trails;
  }
}

/** This function gives the oldest point of a trail in the window before the point at `index`. */
function basePoint(trail: readonly TrailPoint[], index: number, windowMs: number): TrailPoint | undefined {
  const end = trail[index];
  if (end === undefined) return undefined;
  return trail.find((point) => point.at >= end.at - windowMs);
}

/** This function gives the gain of a trail over the window before its last point, in each minute, or 0 over less than one minute. */
export function gainPerMinute(trail: readonly TrailPoint[], windowMs: number): number {
  const last = trail.at(-1);
  const base = basePoint(trail, trail.length - 1, windowMs);
  if (last === undefined || base === undefined || last.at - base.at < 60_000) return 0;
  return ((last.value - base.value) / (last.at - base.at)) * 60_000;
}

/** This function gives the gain of a trail over the window before the point at `index`. */
export function gainAt(trail: readonly TrailPoint[], index: number, windowMs: number): number {
  const end = trail[index];
  const base = basePoint(trail, index, windowMs);
  return end === undefined || base === undefined ? 0 : end.value - base.value;
}

/**
 * This function gives the text of the handles alert (H48). The text names the process, its handles, their gain in one
 * minute and its age. It also names the owner, the command line and the next step.
 */
export function handlesText({ process, owner, orphan, record, trail, at }: TrailFacts, windowMs: number): AlertText {
  const count = trail.at(-1)?.value ?? process.handles ?? 0;
  const perMinute = Math.round(gainPerMinute(trail, windowMs));
  const rate = perMinute >= 1 ? `, +${countText(perMinute)} a minute` : "";
  const age = process.startedAt === undefined ? "" : ` It started ${spanText(Math.max(0, at - process.startedAt) / 60_000)} ago.`;
  const command = record?.command ? ` Command: ${record.command}.` : "";
  return {
    subject: `${process.name} (${process.pid})`,
    mb: 0,
    message: `${process.name} (pid ${process.pid}) holds ${countText(count)} handles${rate}.${age} Owner: ${ownerText(owner, orphan)}.${command} The owner stops it by its pid.`,
  };
}

/**
 * This function gives the lines of the handles for `headroom status` (H48): "Handles: 202,903 in all." Only when one process
 * is above the warning line, one line follows for each of the 3 processes with the most handles. A daemon of an older
 * version and a computer with no count of handles give no line.
 */
export function handlesLines(handles: HandleStatus | null | undefined): string[] {
  if (handles === null || handles === undefined) return [];
  const lines = [`Handles: ${countText(handles.total)} in all.`];
  if ((handles.top[0]?.handles ?? 0) <= handles.warning) return lines;
  lines[0] = `Handles: ${countText(handles.total)} in all. Most handles:`;
  for (const each of handles.top) {
    const command = each.command === null ? "" : `  ${each.command.slice(0, 80)}`;
    lines.push(`  ${`${each.name} (${each.pid})`.padEnd(24)} ${countText(each.handles).padStart(10)}  ${each.owner}${command}`);
  }
  return lines;
}

/**
 * This function gives the handles of the computer for `Status.handles` (H48): the sum, and the 3 processes with the most
 * handles. It gives `null` when no process has a count, for example on Linux.
 */
export function handleStatus(
  processes: readonly ProcessInfo[],
  ownerOf: ReadonlyMap<number, string>,
  recordOf: (info: ProcessInfo) => ProcessRecord | undefined,
  warning: number,
): HandleStatus | null {
  let total = 0;
  let counted = false;
  const top: ProcessInfo[] = [];
  for (const info of processes) {
    if (info.handles === undefined) continue;
    counted = true;
    total += info.handles;
    // A short list in order: the new process goes to its place, and the list keeps 3.
    const at = top.findIndex((each) => (each.handles ?? 0) < (info.handles ?? 0));
    if (at >= 0) top.splice(at, 0, info);
    else top.push(info);
    if (top.length > HANDLE_HOLDERS_SHOWN) top.pop();
  }
  if (!counted) return null;
  const byPid = new Map(processes.map((info) => [info.pid, info]));
  return {
    total,
    warning,
    top: top.map((info) => {
      const orphan = isOrphan(info, byPid);
      return {
        pid: info.pid,
        name: info.name,
        handles: info.handles ?? 0,
        owner: ownerText(ownerOf.get(info.pid) ?? "other", orphan),
        command: recordOf(info)?.command ?? null,
        ...(info.startedAt === undefined ? {} : { startedAt: info.startedAt }),
      };
    }),
  };
}
