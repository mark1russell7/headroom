/**
 * The end records of jobs (H202). A client writes the end of its job to a file before its release call. When the daemon
 * does not answer the call, for example during a restart, the file keeps the true exit. The daemon reads the file before it
 * ends a lease whose process exited. Thus the lease gets the exit code of the job, and not "the process exited".
 *
 * The client removes the file after a release that the daemon accepted. The daemon removes the files of the ended leases.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobUsage } from "./resources.ts";

/** The end of a job, as its client gave it. The fields are the fields of the release call. */
export interface LeaseEnd {
  /** The ID of the lease. */
  readonly id: string;
  /** The time of the end of the job, in ms. */
  readonly at: number;
  /** The reason of the release, for example "the job ended with code 0, peak 120 MB". */
  readonly reason: string;
  readonly peakMb?: number | undefined;
  readonly usage?: JobUsage | undefined;
  /** The exit code of the job. A job that a signal stopped has no exit code. */
  readonly exitCode?: number | undefined;
  readonly signal?: string | undefined;
  /** The count of processes that the job started. */
  readonly processes?: number | undefined;
}

/** A lease ID is letters, digits and hyphens. Thus an ID cannot name a file outside the folder. */
const ID = /^[A-Za-z0-9-]{1,64}$/;
const SUFFIX = ".json";

/** This function gives the file of the end of a lease, or `null` for an ID that cannot name a file. */
export function leaseEndPath(dir: string, id: string): string | null {
  return ID.test(id) ? join(dir, `${id}${SUFFIX}`) : null;
}

/**
 * This function writes the end of a job. It writes a temporary file first and then renames it. Thus a reader does not see
 * half a file at any time. It gives `false` when the write fails, because the release call comes next in any case.
 */
export function writeLeaseEnd(dir: string, end: LeaseEnd): boolean {
  const path = leaseEndPath(dir, end.id);
  if (path === null) return false;
  try {
    mkdirSync(dir, { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(end)}\n`);
    renameSync(temporary, path);
    return true;
  } catch {
    return false;
  }
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** This function gives the usage of a record when each of its fields is a number, or `undefined`. */
function usageOf(value: unknown): JobUsage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.every(([, amount]) => finite(amount)) ? (Object.fromEntries(entries) as JobUsage) : undefined;
}

/** This function reads the end of a lease. It gives `null` when no file exists, or when the file is not a valid end of that lease. */
export function readLeaseEnd(dir: string, id: string): LeaseEnd | null {
  const path = leaseEndPath(dir, id);
  if (path === null) return null;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || value["id"] !== id || !finite(value["at"]) || typeof value["reason"] !== "string") return null;
  const usage = usageOf(value["usage"]);
  return {
    id,
    at: value["at"],
    reason: value["reason"],
    ...(finite(value["peakMb"]) ? { peakMb: value["peakMb"] } : {}),
    ...(usage === undefined ? {} : { usage }),
    ...(Number.isInteger(value["exitCode"]) ? { exitCode: value["exitCode"] as number } : {}),
    ...(typeof value["signal"] === "string" ? { signal: value["signal"] } : {}),
    ...(Number.isInteger(value["processes"]) && (value["processes"] as number) >= 0 ? { processes: value["processes"] as number } : {}),
  };
}

/** This function removes the end of a lease. A file that does not exist is no error. */
export function removeLeaseEnd(dir: string, id: string): void {
  const path = leaseEndPath(dir, id);
  if (path !== null) rmSync(path, { force: true });
}

/** A temporary file older than this is from a write that stopped. */
const STOPPED_WRITE_MS = 60_000;

/**
 * This function removes the end records of the leases that ended, and the temporary files of writes that stopped. It
 * keeps the records of the active leases. It gives the IDs of the removed records.
 */
export function sweepLeaseEnds(dir: string, ended: (id: string) => boolean, now: number = Date.now()): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (name.endsWith(".tmp")) {
      try {
        if (now - statSync(join(dir, name)).mtimeMs > STOPPED_WRITE_MS) rmSync(join(dir, name), { force: true });
      } catch {
        // The write ended, and its rename took the file.
      }
      continue;
    }
    if (!name.endsWith(SUFFIX)) continue;
    const id = name.slice(0, -SUFFIX.length);
    if (!ID.test(id) || !ended(id)) continue;
    rmSync(join(dir, name), { force: true });
    removed.push(id);
  }
  return removed;
}
