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

/** This function reads the parent and the name of a process from the text of `/proc/<pid>/stat`. */
export function parseStat(text: string): { readonly ppid: number; readonly name: string } | null {
  // The name is in parentheses and can hold spaces, so the fields start after the last ")".
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const fields = text.slice(close + 2).split(" ");
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) ? { ppid, name: text.slice(open + 1, close) } : null;
}

/** This function makes the sampler of Linux. */
export function linuxSampler(root = "/proc"): Sampler {
  function memory(): SystemMemory {
    return parseMeminfo(readFileSync(`${root}/meminfo`, "utf8"));
  }

  function processes(): ProcessInfo[] {
    const list: ProcessInfo[] = [];
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
