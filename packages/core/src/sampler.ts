/**
 * The sampler reads the memory of the computer and of its processes. Each platform has its own sampler.
 */

import type { GpuSample } from "./gpu.ts";
import type { PowerEvent } from "./power.ts";
import type { CallRead, PresenceRead } from "./presence.ts";
import type { KeyState } from "./reboot.ts";
import type { ThermalRead } from "./thermal.ts";
import type {
  BatteryRead,
  DiskSpace,
  NetAdapter,
  PoolTag,
  PowerMeters,
  ProcessInfo,
  ProcessLink,
  Sample,
  SystemMemory,
  TcpEndpoints,
  TcpTable,
} from "./types.ts";

/** A sampler of one platform. */
export interface Sampler {
  /** This function reads the memory of the computer. */
  memory(): SystemMemory;
  /** This function reads the processes with their parents and their memory. */
  processes(): ProcessInfo[];
  /**
   * This function reads the command line of one process, or gives `null` when the process is protected or ended (H48).
   * The engine reads it one time for each new process, for the owner record of the process.
   */
  commandLine?(pid: number): string | null;
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
   * This function reads the TCP rows of IPv4 and IPv6 with this local port and this remote port, with their addresses and
   * processes (H46). Only Windows has it, because the files of Linux give no process.
   */
  tcpEndpoints?(localPort: number, remotePort: number): TcpEndpoints[];
  /** This function reads the process ID, the parent, the name and the start of each process, with no read of the memory (H46). */
  processTree?(): ProcessLink[];
  /** This function gives the start of a live process, or `undefined` when the process ended or is protected (H46). */
  processStart?(pid: number): number | undefined;
  /**
   * This function gives the start of the computer, in milliseconds since the epoch. The engine compares no pool tags
   * and no kernel pools across a start, because a start empties the pools.
   */
  bootedAt?(): number;
  /** This function reads the battery (H30). It gives `null` on a computer with no battery. Only Windows has it. */
  battery?(): BatteryRead | null;
  /** This function reads the counter set "Energy Meter" (H30). It gives `null` when the computer has no such counters. Only Windows has it. */
  power?(): PowerMeters | null;
  /**
   * This function reads the speed limits, the speed and the thermal zones of the CPU (H35). The counters are in the query of
   * the Energy Meter, so a read in the same second uses one collection. It gives `null` when the computer has none of them.
   */
  thermal?(): ThermalRead | null;
  /**
   * This function reads the GPU counters of PDH and, at its first call, the adapters of DXGI (H36). It uses the collection of
   * the read of the Energy Meter. It gives `null` when the computer has no GPU counters. Only Windows has it.
   */
  gpu?(): GpuSample | null;
  /**
   * This function registers for the power events of the operating system (H30). The events are the power source, the
   * charge, the lid, the power mode, the sleep and the wake. The listener runs on the main thread, so it only sets the state and asks
   * for a sample. A failed registration writes one line to the log, and the sample every 10 seconds continues. The
   * function gives a function that ends the registrations.
   */
  watchPower?(listener: (event: PowerEvent) => void, log: (line: string) => void): () => void;
  /**
   * This function holds a power request that keeps the computer out of sleep, with a reason for `powercfg /requests`, or
   * ends the request with `null` (H30). A closed lid still puts a laptop to sleep.
   */
  keepAwake?(reason: string | null): void;
  /**
   * This function tells if a key of `HKEY_LOCAL_MACHINE` exists (H34). It only opens the key to read it, and closes it. A
   * key that refuses the read exists. Only Windows has a registry.
   */
  registryKey?(path: string): KeyState;
  /**
   * This function reads the time since the last input of the session and the notification state of the shell (H33). The
   * engine calls it at each tick. Each read is a few microseconds. Only Windows has it.
   */
  presence?(): PresenceRead;
  /**
   * This function tells if an app uses the camera or the microphone, from the consent store of the registry (H33). It
   * reads only, and keeps no name of an app. The engine calls it at most one time in 30 seconds. Only Windows has it.
   */
  calls?(): CallRead | null;
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
