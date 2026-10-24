/**
 * The large files that fill a drive. While a disk alert is active, the engine names the new large files,
 * so the reader can find the file that filled the drive. For example, a trace of 100 GB filled the drive C: on 2026-10-24.
 */

import { readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { MB } from "./sampler.ts";

/** One large file. */
export interface LargeFile {
  readonly path: string;
  /** The size of the file, in MB. */
  readonly mb: number;
  /** The time of the last change of the file. */
  readonly modifiedAt: number;
}

/** The files of Windows that Windows itself sizes. They are large, but they are not new files. */
const SYSTEM_FILES: ReadonlySet<string> = new Set(["pagefile.sys", "hiberfil.sys", "swapfile.sys"]);

/**
 * This function gives the folders where large files usually appear. They are the home folder, the downloads, the
 * temporary folders and the root of each drive in `mounts`. Each folder is in the list one time.
 */
export function largeFileDirs(mounts: readonly string[], platform: NodeJS.Platform = process.platform, home: string = homedir()): string[] {
  const dirs =
    platform === "win32"
      ? [home, win32.join(home, "Downloads"), win32.join(home, "AppData", "Local", "Temp"), tmpdir(), "C:\\Windows\\Temp", ...mounts.map((mount) => `${mount}\\`)]
      : [home, posix.join(home, "Downloads"), tmpdir(), "/tmp", "/var/tmp", ...mounts];
  const seen = new Set<string>();
  return dirs.filter((dir) => {
    const key = platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * This function gives the files larger than `minMb` that changed after `since`, in the folders, the largest first.
 * It does not read the sub-folders. It ignores a folder or a file that it cannot read.
 */
export function largeFiles(dirs: readonly string[], since: number, minMb = 1024, limit = 3): LargeFile[] {
  const found = new Map<string, LargeFile>();
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || SYSTEM_FILES.has(entry.name.toLowerCase())) continue;
      const path = join(dir, entry.name);
      try {
        const stats = statSync(path);
        const mb = stats.size / MB;
        if (mb > minMb && stats.mtimeMs >= since) found.set(path, { path, mb, modifiedAt: stats.mtimeMs });
      } catch {
        // The file was deleted, or another process locks it.
      }
    }
  }
  return [...found.values()].sort((a, b) => b.mb - a.mb).slice(0, limit);
}
