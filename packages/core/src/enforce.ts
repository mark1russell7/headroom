/**
 * The enforcement of a lease on each platform (H6, H7). On Windows, a job object holds the job. Linux
 * (cgroups, H7) has no enforcement yet, so `createJob()` gives `null` there.
 */

import type { Job, JobLimits, ShellStart, StartedProcess } from "./jobs.ts";

export type { Job, JobLimits, ShellStart, StartedProcess } from "./jobs.ts";

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

/**
 * This function gives the environment block of `CreateProcessW` with `CREATE_UNICODE_ENVIRONMENT`: each `name=value` in
 * UTF-16, ended by a zero, and one more zero at the end. Windows wants the names in order, with no regard to case. Names
 * are not case-sensitive on Windows, so the first of two names that differ only in case stays. An empty name cannot go in a
 * block. Also a name with `=` after its first character, and a name or a value with a zero, cannot go in. They stay out.
 */
export function environmentBlock(env: Readonly<Record<string, string | undefined>>): Buffer {
  const seen = new Set<string>();
  const entries: [string, string][] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || name === "" || name.indexOf("=", 1) !== -1 || name.includes("\0") || value.includes("\0")) continue;
    const key = name.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push([name, value]);
  }
  entries.sort(([a], [b]) => {
    const left = a.toUpperCase();
    const right = b.toUpperCase();
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const text = entries.map(([name, value]) => `${name}=${value}\0`).join("");
  return Buffer.from(`${text === "" ? "\0" : text}\0`, "utf16le");
}

/**
 * This function starts a Windows command line with the shell of the desktop as its parent process (H190). The process
 * then has the jobs of the shell, and not the jobs of the current process. Thus a job of the caller that closes, for
 * example the job of an editor, does not stop it. On another platform, and when Windows refuses, the result tells why.
 */
export async function startUnderShell(
  commandLine: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Promise<ShellStart> {
  if (platform !== "win32") return { kind: "unavailable", reason: `the start under the shell is for Windows, not ${platform}` };
  const { startWindowsUnderShell } = await import("./jobs.ts");
  return startWindowsUnderShell(commandLine, cwd, environmentBlock(env));
}
