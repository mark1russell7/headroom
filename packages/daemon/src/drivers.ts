/**
 * The drivers of the pool tags (H9). A driver file contains each pool tag of the driver as 4 bytes.
 * Thus a search of the driver files for a tag names the drivers that can own it. Only Windows has pool tags.
 *
 * The search reads each driver file one time. It takes some seconds, so the CLI does it only on request.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/** The folders of the driver files of Windows. */
export function driverFolders(): string[] {
  const root = process.env["SystemRoot"] ?? "C:\\Windows";
  return [join(root, "System32", "drivers"), join(root, "System32", "DriverStore", "FileRepository")];
}

/** The entries of one folder: for each one, its name, and if it is a folder. */
export type ListFolder = (dir: string) => readonly { readonly name: string; isDirectory(): boolean }[];

/**
 * This function gives the paths of the driver files (`.sys`) in a folder and its subfolders, relative to the folder.
 * It skips a subfolder that it cannot read and continues. Windows refuses `System32\drivers\DriverData` (EPERM),
 * and a recursive `readdirSync` then fails for the whole folder, so refs.sys and fltmgr.sys were not searched (2026-10-29).
 */
export function sysFiles(folder: string, list: ListFolder = (dir) => readdirSync(dir, { withFileTypes: true })): string[] {
  const files: string[] = [];
  const walk = (rel: string): void => {
    let entries: ReturnType<ListFolder>;
    try {
      entries = list(rel ? join(folder, rel) : folder);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.toLowerCase().endsWith(".sys")) files.push(path);
    }
  };
  walk("");
  return files;
}

/** This function gives, for each tag, the names of the driver files that contain it. */
export function driversOf(tags: readonly string[], folders: readonly string[] = driverFolders()): Map<string, string[]> {
  const found = new Map<string, Set<string>>(tags.map((tag) => [tag, new Set<string>()]));
  const needles = tags.map((tag) => ({ tag, bytes: Buffer.from(tag, "latin1") }));
  for (const folder of folders) {
    for (const file of sysFiles(folder)) {
      let content: Buffer;
      try {
        content = readFileSync(join(folder, file));
      } catch {
        continue;
      }
      for (const needle of needles) if (content.includes(needle.bytes)) found.get(needle.tag)?.add(basename(file).toLowerCase());
    }
  }
  return new Map([...found].map(([tag, files]) => [tag, [...files].sort()]));
}
