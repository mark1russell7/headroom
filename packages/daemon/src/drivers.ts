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

/** This function gives, for each tag, the names of the driver files that contain it. */
export function driversOf(tags: readonly string[], folders: readonly string[] = driverFolders()): Map<string, string[]> {
  const found = new Map<string, Set<string>>(tags.map((tag) => [tag, new Set<string>()]));
  const needles = tags.map((tag) => ({ tag, bytes: Buffer.from(tag, "latin1") }));
  for (const folder of folders) {
    let files: string[];
    try {
      files = readdirSync(folder, { recursive: true, encoding: "utf8" }).filter((file) => file.toLowerCase().endsWith(".sys"));
    } catch {
      continue;
    }
    for (const file of files) {
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
