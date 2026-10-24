/**
 * The temp folder of each job (H19, `docs/RESOURCES.md`).
 *
 * `headroom run` gives each job the folder `<temp root>\<lease id>` for its `TEMP`, `TMP` and `TMPDIR`. The release
 * removes it. The daemon removes the folders of the ended leases that a client left. These functions touch only the
 * folders directly under the temp root, and they do not follow a link or a junction.
 */

import { lstatSync, readdirSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { basename, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { JobSetup } from "./resources.ts";
import { MB } from "./sampler.ts";

/** The file that keeps a temp folder after its job (`--keep-temp`). The daemon does not remove a folder with this file. */
export const KEEP_MARK = ".headroom-keep";

/** The form of a lease id that can name a folder: letters, digits, `-` and `_`. */
const LEASE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** The largest count of entries that `folderSizeMb()` examines. */
const SIZE_ENTRIES = 100_000;

/** This function gives the data of a path without a link that it follows, or `null` when the path cannot be read. */
function lstatOf(path: string): Stats | null {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) ?? null;
  } catch {
    return null;
  }
}

/** This function tells if a path exists. A path that cannot be read for another reason counts as present. */
function exists(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return true;
  }
}

/** This function tells if a name has the form of a lease id. A path separator, a dot or a drive letter does not. */
export function isLeaseId(name: string): boolean {
  return LEASE_ID.test(name);
}

/**
 * This function examines a temp root and gives its full path. It refuses a relative path and the root of a drive,
 * because the sweep of the daemon reads the folders directly under it.
 */
export function checkJobTemp(path: string): string {
  if (!isAbsolute(path)) throw new Error(`The temp root must be an absolute path, not ${path}`);
  const full = resolve(path);
  if (parse(full).root === full) throw new Error(`The temp root must be a folder, not the root of a drive (${full})`);
  return full;
}

/** This function gives the temp folder of a lease: `<root>\<lease id>`. It refuses a lease id that is not a folder name. */
export function jobTempFolder(root: string, leaseId: string): string {
  if (!isLeaseId(leaseId)) throw new Error(`The lease id ${JSON.stringify(leaseId)} is not a folder name`);
  return join(checkJobTemp(root), leaseId);
}

/** This function gives the setup of a job under a temp root: `TEMP`, `TMP` and `TMPDIR` in the temp folder of its lease. */
export function jobTempSetup(root: string, leaseId: string): JobSetup {
  const folder = jobTempFolder(root, leaseId);
  return { env: { TEMP: folder, TMP: folder, TMPDIR: folder }, folders: [folder] };
}

/** This function tells if a path is a folder directly under the root. It resolves the two paths before it compares them. */
export function isDirectlyUnder(root: string, path: string): boolean {
  const part = relative(resolve(root), resolve(path));
  return part !== "" && part !== ".." && !isAbsolute(part) && !part.includes(sep) && !part.includes("/");
}

/**
 * This function removes one temp folder of a lease. It removes only a real folder directly under the root, not a link or
 * a junction. It gives `true` when the folder is gone. A file that a process holds open keeps the folder until the next try.
 */
export function removeJobTemp(root: string, folder: string): boolean {
  if (!isDirectlyUnder(root, folder) || !isLeaseId(basename(resolve(folder)))) return false;
  const stats = lstatOf(folder);
  if (stats === null) return !exists(folder);
  if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
  try {
    // rmSync removes a link inside the folder, not the target of the link.
    rmSync(folder, { recursive: true, force: true, maxRetries: 2 });
    return true;
  } catch {
    return false;
  }
}

/** This function marks a temp folder, so the daemon keeps it after its job (`--keep-temp`). */
export function keepJobTemp(folder: string): void {
  writeFileSync(join(folder, KEEP_MARK), "headroom run --keep-temp keeps this folder. Remove it by hand.\n");
}

/**
 * This function removes the temp folders of the ended leases under a temp root. It examines only the folders directly under
 * the root whose name is a lease id. `isEnded` tells if the store has that lease and the lease ended. A folder with the
 * mark of `--keep-temp` stays. The function gives the names of the removed folders.
 */
export function sweepJobTemp(root: string, isEnded: (leaseId: string) => boolean): string[] {
  let full: string;
  try {
    full = checkJobTemp(root);
  } catch {
    return [];
  }
  let entries;
  try {
    entries = readdirSync(full, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isLeaseId(entry.name)) continue;
    const folder = join(full, entry.name);
    if (exists(join(folder, KEEP_MARK))) continue;
    if (!isEnded(entry.name)) continue;
    if (removeJobTemp(full, folder)) removed.push(entry.name);
  }
  return removed;
}

/**
 * This function gives the size of the files in a folder, in MB. It does not follow a link or a junction, and it stops
 * after 100,000 entries. Thus the size of a very large folder is a lower limit.
 */
export function folderSizeMb(folder: string, limit: number = SIZE_ENTRIES): number {
  let bytes = 0;
  let count = 0;
  const stack = [folder];
  while (stack.length > 0 && count < limit) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++count > limit) break;
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) bytes += lstatOf(path)?.size ?? 0;
    }
  }
  return bytes / MB;
}
