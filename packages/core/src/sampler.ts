/**
 * The sampler reads the memory of the computer and of its processes. Each platform has its own sampler.
 */

import type { PoolTag, ProcessInfo, Sample, SystemMemory } from "./types.ts";

/** A sampler of one platform. */
export interface Sampler {
  /** This function reads the memory of the computer. */
  memory(): SystemMemory;
  /** This function reads the processes with their parents and their memory. */
  processes(): ProcessInfo[];
  /** This function reads the use of the kernel pools by each pool tag. Only Windows has pool tags. */
  poolTags?(): PoolTag[];
  /** This function reads the USER and GDI objects of all the processes of the session. Only Windows has them. */
  gui?(): { readonly userObjects: number; readonly gdiObjects: number };
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
