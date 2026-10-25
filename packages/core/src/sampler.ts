/**
 * The sampler reads the memory of the computer and of its processes. Each platform has its own sampler.
 */

import type { DiskSpace, NetAdapter, PoolTag, ProcessInfo, Sample, SystemMemory, TcpTable } from "./types.ts";

/** A sampler of one platform. */
export interface Sampler {
  /** This function reads the memory of the computer. */
  memory(): SystemMemory;
  /** This function reads the processes with their parents and their memory. */
  processes(): ProcessInfo[];
  /**
   * This function gives the sequence number of the newest process at the last read of the processes (H29). Windows gives
   * each new process the next number, so the change between two reads is the exact count of starts. Only Windows has it.
   */
  processSequence?(): number | undefined;
  /** This function reads the use of the kernel pools by each pool tag. Only Windows has pool tags. */
  poolTags?(): PoolTag[];
  /** This function reads the USER and GDI objects of all the processes of the session. Only Windows has them. */
  gui?(): { readonly userObjects: number; readonly gdiObjects: number };
  /** This function reads the free space of the fixed drives. It does not read a network drive or a removable drive, because they can stop the read. */
  disks?(): DiskSpace[];
  /** This function reads the byte counters of the physical adapters and the Wi-Fi adapters (H24). */
  network?(): NetAdapter[];
  /** This function reads the TCP connections of IPv4 and IPv6 with their processes, and the dynamic port range (H24). */
  tcp?(): TcpTable;
  /**
   * This function gives the start of the computer, in milliseconds since the epoch. The engine compares no pool tags
   * and no kernel pools across a start, because a start empties the pools.
   */
  bootedAt?(): number;
  /** This function frees the resources of the sampler. */
  close(): void;
}

/** This function reads one sample. With `processes: false`, it reads only the memory of the computer. */
export function takeSample(sampler: Sampler, options: { readonly processes?: boolean; readonly now?: number } = {}): Sample {
  return {
    at: options.now ?? Date.now(),
    memory: sampler.memory(),
    processes: options.processes === false ? [] : sampler.processes(),
  };
}

/** This function makes the sampler of the platform where it runs. */
export async function createSampler(platform: NodeJS.Platform = process.platform): Promise<Sampler> {
  if (platform === "win32") {
    const { windowsSampler } = await import("./windows.ts");
    return windowsSampler();
  }
  if (platform === "linux") {
    const { linuxSampler } = await import("./linux.ts");
    return linuxSampler();
  }
  throw new Error(`headroom has no sampler for the platform ${platform} yet`);
}

/** The number of bytes in one MB. */
export const MB: number = 1024 * 1024;
