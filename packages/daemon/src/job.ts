/**
 * The parts of `headroom run` around its job: the disk amounts of `--disk` and the environment of the job. Also the temp
 * folder of its lease (H19) and the limits of its job object (H23).
 */

import { mkdirSync, realpathSync } from "node:fs";
import { CPU_WEIGHT_DEFAULT, cpuRateOf, diskSize, folderSizeMb, jobTempSetup, keepJobTemp, removeJobTemp, type Config, type JobLimits } from "@headroom/core";
import type { Connection } from "./client.ts";
import { mountOf, parseDisk } from "./parse.ts";

/**
 * This function gives the environment of a job: the environment of this process with more variables. On Windows, the
 * names have no case, so a variable `Temp` of the parent goes before the job gets `TEMP`.
 */
export function jobEnv(more: Readonly<Record<string, string>>, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const names = new Set(Object.keys(more).map((name) => name.toUpperCase()));
  for (const name of Object.keys(env)) if (names.has(name.toUpperCase())) delete env[name];
  return { ...env, ...more };
}

/** The limits that `headroom run` asks for: `--limit`, and the memory and the cores of the lease. */
export interface LimitOptions {
  /** True (--limit): the job cannot commit more memory than its lease, and cannot use more cores than its lease (H23). */
  readonly limit: boolean;
  readonly leaseMb: number | null;
  /** The cores of the lease (H23). With --limit, they are the hard cap of the job. */
  readonly leaseCores?: number | null | undefined;
}

/**
 * This function gives the limits of the job object of a run. With --limit, the memory of the lease is a memory limit.
 * The cores of the lease are a hard cap of the CPU rate (H23). The process of headroom is also in the job. Thus the memory
 * limit adds its memory and a margin. Without a cap, the job gets the default weight, so the leased jobs share the
 * processors fairly.
 */
export function jobLimits(options: LimitOptions, selfMb: number, processors: number): JobLimits {
  const memoryMb = options.limit && options.leaseMb !== null ? options.leaseMb + selfMb + 64 : undefined;
  const cores = options.limit ? (options.leaseCores ?? null) : null;
  return {
    ...(memoryMb === undefined ? {} : { memoryMb }),
    ...(cores === null ? { cpuWeight: CPU_WEIGHT_DEFAULT } : { cpuRate: cpuRateOf(cores, processors) }),
  };
}

/** The options of `diskAmounts()`. The tests set them. */
export interface DiskOptions {
  /** This function gives the real path of the current folder. */
  readonly here?: (() => string) | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

/**
 * This function gives the amounts of `--disk` by id: `disk:<mount>`. A value with no drive uses the drive of the real
 * path of the current folder. It gives an error text when the current folder is on no fixed drive.
 */
export function diskAmounts(values: readonly string[], mounts: readonly string[], options: DiskOptions = {}): Record<string, number> | string {
  const amounts: Record<string, number> = {};
  for (const value of values) {
    const { mount, mb } = parseDisk(value);
    let drive = mount;
    if (drive === null) {
      const here = (options.here ?? (() => realpathSync.native(process.cwd())))();
      drive = mountOf(here, mounts, options.platform);
      if (drive === null) return `the current folder ${here} is on no fixed drive. Name the drive, for example --disk D:=${value}.`;
    }
    const id = `disk:${drive}`;
    amounts[id] = (amounts[id] ?? 0) + mb;
  }
  return amounts;
}

/** The temp folder of a job (H19), under the temp root of the settings. */
export interface JobTemp {
  readonly root: string;
  readonly folder: string;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * This function makes the temp folder of a lease when the settings have a temp root. Without the setting, or when the
 * folder cannot be made, it gives `null`, and the job keeps the `TEMP` of its parent.
 */
export async function prepareTemp(connection: Pick<Connection, "call">, leaseId: string): Promise<JobTemp | null> {
  // A daemon of an older version has no settings.
  const config = await connection.call<Config>(["config", "get"], {}).catch(() => null);
  const root = config?.jobTemp ?? null;
  if (root === null) return null;
  try {
    const setup = jobTempSetup(root, leaseId);
    for (const folder of setup.folders) mkdirSync(folder, { recursive: true });
    return { root, folder: setup.folders[0] ?? root, env: setup.env };
  } catch (error) {
    console.error(`headroom: the job gets no temp folder of its own (${error instanceof Error ? error.message : String(error)}). It uses the TEMP of its parent.`);
    return null;
  }
}

/**
 * This function ends the temp folder of a job. It measures the folder, then removes it, or marks it with `--keep-temp`.
 * It gives the size of the folder in MB.
 */
export function finishTemp(temp: JobTemp, keep: boolean): number {
  const sizeMb = Math.round(folderSizeMb(temp.folder) * 10) / 10;
  if (sizeMb >= 100) console.error(`headroom: the temp folder of the job holds ${diskSize(sizeMb)} at its end.`);
  if (keep) {
    try {
      keepJobTemp(temp.folder);
    } catch {
      // The folder is gone, or the job made it read-only. Without the mark, the daemon removes the folder.
    }
    console.error(`headroom: --keep-temp keeps the temp folder ${temp.folder}. Remove it by hand when you are done.`);
  } else if (!removeJobTemp(temp.root, temp.folder)) {
    console.error(`headroom: a process holds files in the temp folder ${temp.folder}. The daemon removes it later.`);
  }
  return sizeMb;
}
