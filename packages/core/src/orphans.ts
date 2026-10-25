/**
 * The owner records and the orphans (H48).
 *
 * The owner of a process comes from its parents. When a parent ends, the search up the tree stops, and the process loses
 * its owner. On 2026-10-25, an orphan `find.exe` of a session held 1.3 million handles, and headroom named no owner for it.
 *
 * Thus the engine makes a record of each process at its first read. The record has the process ID, the start, the owner,
 * the command line and the time of the read. The record keeps the owner after the parent ends. The store keeps the records of the
 * processes that live for more than one minute, so a restart of the daemon keeps them. A record of an ended process goes
 * away at the next read of the processes, in the memory and in the store.
 */

import { baseOwner, isOrphan, ORPHAN_LABEL, processKey } from "./owners.ts";
import type { ProcessInfo } from "./types.ts";

/** The longest command line in a record, in characters. */
export const COMMAND_MAX = 200;
/** A process that lives for this time, in ms, gets its record in the store. */
export const RECORD_AFTER_MS = 60_000;
/** The most records in the memory. A computer has fewer live processes, so the limit only stops a fault. */
export const RECORDS_MAX = 4096;

/** The record of one process (H48). */
export interface ProcessRecord {
  readonly pid: number;
  /** The start of the process in whole milliseconds since the epoch, or 0 when the read has no start. */
  readonly created: number;
  /** The owner of the process while its parent was alive, without the label of an orphan. */
  readonly owner: string;
  /** The command line, with the name of the program and no folder, cut to 200 characters. It is `null` for a protected process. */
  readonly command: string | null;
  /** The time of the first read of the process, in milliseconds since the epoch. */
  readonly firstSeen: number;
}

/** The changes of the records at one read, for the store. */
export interface RecordChanges {
  /** The records to write: the new records of processes older than one minute, and the records with a new owner. */
  readonly save: readonly ProcessRecord[];
  /** The records in the store of the processes that ended. */
  readonly ended: readonly ProcessRecord[];
}

/**
 * This function gives a short command line: the name of the program with no folder and no `.exe`, then the arguments, cut
 * to 200 characters. `"C:\Program Files\Git\usr\bin\find.exe" / -name x` gives `find / -name x`.
 */
export function shortCommand(line: string): string {
  const text = line.trim();
  let end: number;
  let program: string;
  if (text.startsWith('"')) {
    const close = text.indexOf('"', 1);
    end = close < 0 ? text.length : close + 1;
    program = text.slice(1, close < 0 ? text.length : close);
  } else {
    const space = text.indexOf(" ");
    end = space < 0 ? text.length : space;
    program = text.slice(0, end);
  }
  const base = program.slice(Math.max(program.lastIndexOf("\\"), program.lastIndexOf("/")) + 1);
  const name = base.toLowerCase().endsWith(".exe") ? base.slice(0, -4) : base;
  return `${name === "" ? program : name}${text.slice(end)}`.slice(0, COMMAND_MAX);
}

/**
 * This function gives the owner of a process for the text of an alert (H48). An orphan gets `(orphan, parent ended)`. An
 * owner with the label `(orphan)` from an ended ancestor keeps it.
 */
export function ownerText(owner: string, orphan: boolean): string {
  return orphan ? `${baseOwner(owner)} (orphan, parent ended)` : owner;
}

/** This function tells if an owner comes from the record of an orphan: `session:graph (orphan)`. */
export function isOrphanOwner(owner: string): boolean {
  return owner.endsWith(ORPHAN_LABEL);
}

/** The state of a record in the store: absent, the same, or with an older owner. */
type Stored = "absent" | "same" | "changed";

/**
 * The owner records of the live processes (H48). The engine gives it each read of the processes with the owner of each
 * process. It keeps one record for each live process, at most 4096, so its memory stays small.
 */
export class OwnerRecords {
  /** The record of each live process, by `processKey()`. */
  readonly #records = new Map<string, ProcessRecord>();
  /** The state of each record in the store, by the same key. */
  readonly #stored = new Map<string, Stored>();

  /** This function adds the records from the store after a start of the daemon. The next read removes the records of ended processes. */
  restore(rows: readonly ProcessRecord[]): void {
    for (const record of rows) {
      if (this.#records.size >= RECORDS_MAX) break;
      const key = `${record.pid}:${record.created}`;
      this.#records.set(key, record);
      this.#stored.set(key, "same");
    }
  }

  /** This function gives the record of a process, or `undefined` when the engine has none. */
  get(info: Pick<ProcessInfo, "pid" | "startedAt">): ProcessRecord | undefined {
    return this.#records.get(processKey(info));
  }

  /** This function gives the record of each process by its key, for `attribute()`. */
  byKey(): ReadonlyMap<string, ProcessRecord> {
    return this.#records;
  }

  /** The count of the records in the memory. */
  get size(): number {
    return this.#records.size;
  }

  /**
   * This function adds the records of the new processes of a read, and removes the records of the ended processes.
   *
   * - A new process gets the owner of `ownerOf` without the label of an orphan, and its command line from `commandOf`.
   * - While the parent of a process runs, its record follows its owner, for example when the file of a new session appears.
   *   After the parent ends, the record keeps its owner.
   * - A record goes to the store when its process is one minute old.
   */
  observe(now: number, processes: readonly ProcessInfo[], ownerOf: ReadonlyMap<number, string>, commandOf: (pid: number) => string | null): RecordChanges {
    const byPid = new Map(processes.map((info) => [info.pid, info]));
    const live = new Set<string>();
    const save: ProcessRecord[] = [];
    for (const info of processes) {
      // The idle process is not a process.
      if (info.pid === 0) continue;
      const key = processKey(info);
      live.add(key);
      const owner = baseOwner(ownerOf.get(info.pid) ?? "other");
      let record = this.#records.get(key);
      if (record === undefined) {
        if (this.#records.size >= RECORDS_MAX) continue;
        const line = commandOf(info.pid);
        record = { pid: info.pid, created: Math.round(info.startedAt ?? 0), owner, command: line === null ? null : shortCommand(line), firstSeen: now };
        this.#records.set(key, record);
        this.#stored.set(key, "absent");
      } else if (record.owner !== owner && !isOrphan(info, byPid)) {
        record = { ...record, owner };
        this.#records.set(key, record);
        if (this.#stored.get(key) === "same") this.#stored.set(key, "changed");
      }
      const from = record.created > 0 ? record.created : record.firstSeen;
      if (this.#stored.get(key) !== "same" && now - from >= RECORD_AFTER_MS) {
        this.#stored.set(key, "same");
        save.push(record);
      }
    }
    const ended: ProcessRecord[] = [];
    for (const [key, record] of this.#records) {
      if (live.has(key)) continue;
      this.#records.delete(key);
      if (this.#stored.get(key) !== "absent") ended.push(record);
      this.#stored.delete(key);
    }
    return { save, ended };
  }
}
