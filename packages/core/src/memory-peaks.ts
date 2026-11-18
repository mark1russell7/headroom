/**
 * The memory peaks of the large holders (H62 part 5). The minute sample keeps the memory of each owner at one read. A
 * process that grows and ends between two samples leaves no trace there. Thus each read of the processes also gives the
 * private memory of each large process and each running container to a tracker. The minute sample keeps the largest
 * amount of each holder in the minute, with its owner and its lease.
 *
 * - **A holder** is a process, by its ID and its start, or a container, by its ID. A new process with the ID of an ended
 *   process is a different holder.
 * - **A large holder** has `PEAK_MIN_MB` or more at one read. The minute keeps the `PEAK_LIMIT` largest holders.
 * - The memory of a container is in the VM of Docker. The VM process is also a large process, so a sum of the rows of
 *   one minute counts the memory of a container two times. The rows are peaks, not a sum.
 */

import type { DockerContainerStatus } from "./docker.ts";
import { processKey } from "./owners.ts";
import type { ProcessInfo } from "./types.ts";

/** The least private memory in MB of a holder that the minute keeps. */
export const PEAK_MIN_MB = 512;

/** The most holders that one minute keeps, the largest first. */
export const PEAK_LIMIT = 30;

/** The kind of a holder of memory. */
export type PeakKind = "process" | "container";

/** The largest memory of one holder in one minute. */
export interface MemoryPeak {
  readonly kind: PeakKind;
  /** The key of the holder: `<pid>:<start>` for a process, the ID for a container. */
  readonly key: string;
  /** The program name of a process, or the name of a container. */
  readonly name: string;
  /** The owner of the holder: a session, a role or a kind, for example `docker`. */
  readonly owner: string | null;
  /** The ID of a process. `null` for a container. */
  readonly pid: number | null;
  /** The start of a process in milliseconds since the epoch, or 0 when the read does not give it. `null` for a container. */
  readonly created: number | null;
  /** The lease of the holder at its peak, or `null`. */
  readonly lease: string | null;
  /** The largest private memory of the holder in the minute, in MB. */
  readonly peakMb: number;
  /**
   * The command line of a process from the records of the owners, or the image of a container. A secret in a command line
   * has a mark in its place. `null` when the read does not give it.
   */
  readonly command: string | null;
}

/** The fields of a container that the tracker reads. */
export type PeakContainer = Pick<DockerContainerStatus, "id" | "name" | "image" | "state" | "memoryMb" | "owner">;

/** The tracker of the peaks of one minute. The engine gives it each read, and the minute sample closes it. */
export class PeakTracker {
  readonly #minMb: number;
  readonly #limit: number;
  #peaks = new Map<string, MemoryPeak>();

  constructor(minMb: number = PEAK_MIN_MB, limit: number = PEAK_LIMIT) {
    this.#minMb = minMb;
    this.#limit = limit;
  }

  /**
   * This function reads the large processes of one read. `ownerOf` and `leaseOf` give the owner and the lease of each ID.
   * `commandOf` gives the command line of a process.
   */
  observeProcesses(
    processes: readonly ProcessInfo[],
    ownerOf: ReadonlyMap<number, string>,
    leaseOf: ReadonlyMap<number, string>,
    commandOf: (info: ProcessInfo) => string | null = () => null,
  ): void {
    for (const info of processes) {
      if (info.privateMb < this.#minMb) continue;
      this.#keep({
        kind: "process",
        key: processKey(info),
        name: info.name,
        owner: ownerOf.get(info.pid) ?? null,
        pid: info.pid,
        created: Math.round(info.startedAt ?? 0),
        lease: leaseOf.get(info.pid) ?? null,
        peakMb: info.privateMb,
        command: commandOf(info),
      });
    }
  }

  /** This function reads the large running containers of one read. `leaseOf` gives the lease of each container ID. */
  observeContainers(containers: readonly PeakContainer[], leaseOf: ReadonlyMap<string, { readonly lease: string }> | undefined): void {
    for (const container of containers) {
      if (container.state !== "running" || container.memoryMb === null || container.memoryMb < this.#minMb) continue;
      this.#keep({
        kind: "container",
        key: container.id,
        name: container.name,
        owner: container.owner,
        pid: null,
        created: null,
        lease: leaseOf?.get(container.id)?.lease ?? null,
        peakMb: container.memoryMb,
        command: container.image,
      });
    }
  }

  /** This function gives the peaks of the minute, the largest first, and starts the next minute. */
  close(): MemoryPeak[] {
    const peaks = [...this.#peaks.values()].sort((a, b) => b.peakMb - a.peakMb).slice(0, this.#limit);
    this.#peaks = new Map();
    return peaks;
  }

  /** This function keeps the larger of two reads of one holder. A field that one read does not give comes from the other read. */
  #keep(peak: MemoryPeak): void {
    const id = `${peak.kind}:${peak.key}`;
    const known = this.#peaks.get(id);
    if (known === undefined) return void this.#peaks.set(id, peak);
    const [high, low] = peak.peakMb > known.peakMb ? [peak, known] : [known, peak];
    this.#peaks.set(id, { ...high, owner: high.owner ?? low.owner, lease: high.lease ?? low.lease, command: high.command ?? low.command });
  }
}

/** The peaks of one holder in a window: its largest peak, its minutes and its command line. */
export interface PeakSummary extends MemoryPeak {
  /** The minute of the largest peak. */
  readonly at: number;
  /** The first and the last minute of the holder in the window. */
  readonly firstAt: number;
  readonly lastAt: number;
  /** The count of minutes in which the holder was large. */
  readonly minutes: number;
}

/** One minute of one holder: its peak and its lease. */
export interface PeakPoint {
  readonly at: number;
  readonly peakMb: number;
  readonly lease: string | null;
}

/** The answer of the query of the peaks. */
export interface PeaksAnswer {
  /** The least memory of a kept holder, and the most holders of one minute. */
  readonly minMb: number;
  readonly limit: number;
  /** The holders of the window, the largest peak first. */
  readonly peaks: readonly PeakSummary[];
  /** The minutes of one holder, the oldest first, when the query names a key. */
  readonly trail?: readonly PeakPoint[] | undefined;
}
