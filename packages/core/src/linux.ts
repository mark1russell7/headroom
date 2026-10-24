/**
 * The sampler of Linux and WSL. It reads `/proc`, so it starts no process.
 */

import { readdirSync, readFileSync, statfsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { MB, type Sampler } from "./sampler.ts";
import type { DiskSpace, ProcessInfo, SystemMemory } from "./types.ts";

/** This function reads the fields of `/proc/meminfo` or of `/proc/<pid>/status`, in kB. */
export function parseKb(text: string): Map<string, number> {
  const fields = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^([\w()]+):\s+(\d+)/.exec(line);
    if (match?.[1] && match[2]) fields.set(match[1], Number(match[2]));
  }
  return fields;
}

/** This function reads the memory of the computer from the text of `/proc/meminfo`. */
export function parseMeminfo(text: string): SystemMemory {
  const kb = parseKb(text);
  const mb = (...names: string[]): number => Math.round(names.reduce((sum, name) => sum + (kb.get(name) ?? 0), 0) / 1024);
  return {
    totalMb: mb("MemTotal"),
    availableMb: mb("MemAvailable"),
    commitMb: mb("Committed_AS"),
    commitLimitMb: mb("CommitLimit"),
    kernelPagedMb: mb("SReclaimable"),
    kernelNonpagedMb: mb("SUnreclaim", "KernelStack", "PageTables"),
  };
}

/** The parent, the name, the processor time and the start of a process, from `/proc/<pid>/stat`. */
export interface StatLine {
  readonly ppid: number;
  readonly name: string;
  /** The processor time of the process in clock ticks: `utime` and `stime`. It is absent in a short line. */
  readonly cpuTicks?: number;
  /** The start of the process, in clock ticks after the start of the computer. It is absent in a short line. */
  readonly startTicks?: number;
}

/** This function reads the parent, the name, the processor time and the start of a process from the text of `/proc/<pid>/stat`. */
export function parseStat(text: string): StatLine | null {
  // The name is in parentheses and can hold spaces, so the fields start after the last ")".
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const fields = text.slice(close + 2).split(" ");
  const ppid = Number(fields[1]);
  if (!Number.isInteger(ppid)) return null;
  const name = text.slice(open + 1, close);
  // The fields 14 and 15 of the line are the user time and the kernel time, and the field 22 is the start. The list starts at the field 3.
  const field = (index: number): number => (fields[index] === undefined ? Number.NaN : Number(fields[index]));
  const cpuTicks = field(11) + field(12);
  const startTicks = field(19);
  return {
    ppid,
    name,
    ...(Number.isFinite(cpuTicks) ? { cpuTicks } : {}),
    ...(Number.isFinite(startTicks) ? { startTicks } : {}),
  };
}

/** The clock ticks in one second. Linux uses 100 on almost each computer. */
const CLOCK_TICKS = 100;

/** This function gives the start of the computer in milliseconds since the epoch, from the text of `/proc/stat`. */
export function parseBootTime(text: string): number | undefined {
  const match = /^btime\s+(\d+)/m.exec(text);
  return match?.[1] === undefined ? undefined : Number(match[1]) * 1000;
}

/** This function reads `read_bytes` and `write_bytes` of `/proc/<pid>/io`. The file of a process of another user is not readable, so it gives no bytes. */
function ioOf(path: string): { readonly readBytes?: number | undefined; readonly writeBytes?: number | undefined } {
  try {
    const io = parseKb(readFileSync(path, "utf8"));
    return { readBytes: io.get("read_bytes"), writeBytes: io.get("write_bytes") };
  } catch {
    return {};
  }
}

/** This function makes the sampler of Linux. */
export function linuxSampler(root = "/proc"): Sampler {
  function memory(): SystemMemory {
    return parseMeminfo(readFileSync(`${root}/meminfo`, "utf8"));
  }

  function processes(): ProcessInfo[] {
    const list: ProcessInfo[] = [];
    let bootAt: number | undefined;
    try {
      bootAt = parseBootTime(readFileSync(`${root}/stat`, "utf8"));
    } catch {
      // Without the start of the computer, the processes have no start.
    }
    for (const dir of readdirSync(root)) {
      if (!/^\d+$/.test(dir)) continue;
      try {
        const stat = parseStat(readFileSync(`${root}/${dir}/stat`, "utf8"));
        if (!stat) continue;
        const status = parseKb(readFileSync(`${root}/${dir}/status`, "utf8"));
        list.push({
          pid: Number(dir),
          ppid: stat.ppid,
          name: stat.name,
          privateMb: ((status.get("RssAnon") ?? 0) * 1024) / MB,
          workingMb: ((status.get("VmRSS") ?? 0) * 1024) / MB,
          startedAt: bootAt === undefined || stat.startTicks === undefined ? undefined : bootAt + (stat.startTicks * 1000) / CLOCK_TICKS,
          cpuMs: stat.cpuTicks === undefined ? undefined : (stat.cpuTicks * 1000) / CLOCK_TICKS,
          ...ioOf(`${root}/${dir}/io`),
        });
      } catch {
        // The process ended while its files were read.
      }
    }
    return list;
  }

  return { memory, processes, disks: () => linuxDisks(), close: () => {} };
}

/**
 * This function reads the free space of the file systems of "/" and of the home folder. When the two
 * folders are on the same device, it gives that device one time.
 */
export function linuxDisks(mounts: readonly string[] = ["/", homedir()]): DiskSpace[] {
  const devices = new Set<number>();
  const list: DiskSpace[] = [];
  for (const mount of mounts) {
    try {
      const device = statSync(mount).dev;
      if (devices.has(device)) continue;
      devices.add(device);
      const stats = statfsSync(mount);
      list.push({ mount, freeMb: Math.round((stats.bavail * stats.bsize) / MB), totalMb: Math.round((stats.blocks * stats.bsize) / MB) });
    } catch {
      // The folder is not readable: it has no free space to show.
    }
  }
  return list;
}
