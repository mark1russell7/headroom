/**
 * The enforcement of a lease on each platform (H6, H7). On Windows, a job object holds the job. Linux
 * (cgroups, H7) has no enforcement yet, so `createJob()` gives `null` there.
 */

import type { Job, JobLimits, StartedProcess } from "./jobs.ts";

export type { Job, JobLimits, StartedProcess } from "./jobs.ts";

/** This function puts the current process and its future children into a job, or gives `null` on a platform with no jobs yet. */
export async function createJob(limits: JobLimits = {}, platform: NodeJS.Platform = process.platform): Promise<Job | null> {
  if (platform !== "win32") return null;
  const { createWindowsJob } = await import("./jobs.ts");
  return createWindowsJob(limits);
}

/**
 * This function starts a Windows command line as a detached process outside the job of the current process, when the
 * job accepts a breakaway. Otherwise, the process starts in the job. The function is for Windows only.
 */
export async function startOutsideJob(commandLine: string, cwd: string | null = null, platform: NodeJS.Platform = process.platform): Promise<StartedProcess> {
  if (platform !== "win32") throw new Error(`startOutsideJob is for Windows, not ${platform}`);
  const { startWindowsProcess } = await import("./jobs.ts");
  return startWindowsProcess(commandLine, cwd);
}
