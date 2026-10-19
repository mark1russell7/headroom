/**
 * The files of headroom: the folder, the database and the discovery file of the running daemon.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The folder of headroom. `HEADROOM_HOME` changes it. */
export function headroomHome(): string {
  return process.env["HEADROOM_HOME"] ?? join(homedir(), ".headroom");
}

/** The SQLite file. */
export function databasePath(): string {
  return join(headroomHome(), "headroom.db");
}

/** The discovery file of the running daemon. Only this user can read it, because it holds the token. */
export function discoveryPath(): string {
  return join(headroomHome(), "daemon.json");
}

/** The log file of the daemon when it runs as a service. */
export function logPath(): string {
  return join(headroomHome(), "daemon.log");
}

/** The data that a client uses to reach the daemon. */
export interface Discovery {
  readonly pid: number;
  readonly endpoint: string;
  readonly token: string;
  readonly startedAt: string;
}

/** This function writes the discovery file. */
export function writeDiscovery(discovery: Discovery): void {
  writeFileSync(discoveryPath(), JSON.stringify(discovery, null, 2) + "\n", { mode: 0o600 });
}

/** This function reads the discovery file, or gives `null` when no daemon wrote one. */
export function readDiscovery(): Discovery | null {
  try {
    return JSON.parse(readFileSync(discoveryPath(), "utf8")) as Discovery;
  } catch {
    return null;
  }
}

/** This function removes the discovery file when this process wrote it. */
export function removeDiscovery(pid: number = process.pid): void {
  if (readDiscovery()?.pid === pid) rmSync(discoveryPath(), { force: true });
}
