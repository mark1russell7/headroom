/**
 * The enforcement of a lease on each platform (H6, H7). On Windows, a job object holds the job. Linux
 * (cgroups, H7) has no enforcement yet, so `createJob()` gives `null` there.
 */

import type { Job, JobLimits } from "./jobs.ts";

export type { Job, JobLimits } from "./jobs.ts";

/** This function puts the current process and its future children into a job, or gives `null` on a platform with no jobs yet. */
export async function createJob(limits: JobLimits = {}, platform: NodeJS.Platform = process.platform): Promise<Job | null> {
  if (platform !== "win32") return null;
  const { createWindowsJob } = await import("./jobs.ts");
  return createWindowsJob(limits);
}
