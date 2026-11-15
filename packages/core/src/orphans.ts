/**
 * The owner records and the orphans (H48, H182).
 *
 * The owner of a process comes from its parents. When a parent ends, the search up the tree stops, and the process loses
 * its owner. On 2026-10-25, an orphan `find.exe` of a session held 1.3 million handles, and headroom named no owner for it.
 *
 * Thus the engine makes a record of each process at its first read. The record has the process ID, the start, the owner,
 * the command line and the time of the read. The record keeps the owner after the parent ends. The store keeps the records of the
 * processes that live for more than one minute, so a restart of the daemon keeps them. A record of an ended process goes
 * away at the next read of the processes, in the memory and in the store.
 *
 * H182 makes the record a proof of ownership. The record also keeps the parent ID and the start of the parent at the
 * first read. Thus a new process with the ID of the parent does not count as the parent. The record keeps the session of
 * the process as a field of its own. It keeps the full command line, so the last path of a long line stays.
 */

import { baseOwner, isOrphan, ORPHAN_LABEL, parentOf, processKey, type ParentRecord, type SessionRef } from "./owners.ts";
import type { ProcessInfo } from "./types.ts";

/**
 * The longest command line in a record, in characters (H182). A longer line keeps its first `COMMAND_HEAD` characters,
 * the mark `COMMAND_CUT` and its end. Thus the program, its first arguments and its last path stay.
 *
 * The limit keeps the memory of the records small. Windows permits 32,767 characters in a command line, and the records
 * keep at most 4096 lines. With this limit, the worst case is 4096 lines of 8192 characters. Most command lines have
 * fewer than 300 characters, and a line of 8192 characters or fewer stays complete.
 */
export const COMMAND_MAX = 8192;
/** The characters at the start of a long command line that its record keeps (H182). The record keeps the end of the line after them. */
export const COMMAND_HEAD = 1024;
/** The mark between the start and the end of a long command line (H182). */
export const COMMAND_CUT = " ... ";
/** A process that lives for this time, in ms, gets its record in the store. */
export const RECORD_AFTER_MS = 60_000;
/** The most records in the memory. A computer has fewer live processes, so the limit only stops a fault. */
export const RECORDS_MAX = 4096;

/** The record of one process (H48, H182). */
export interface ProcessRecord extends ParentRecord {
  readonly pid: number;
  /** The start of the process in whole milliseconds since the epoch, or 0 when the read has no start. */
  readonly created: number;
  /** The owner of the process while its parent was alive, without the label of an orphan. */
  readonly owner: string;
  /**
   * The name of the session of the process (H182): the Claude Code session whose process was an ancestor while the parent
   * lived. It is `null` when no session was an ancestor.
   */
  readonly session: string | null;
  /** The ID of that session from its session file (H182), or `null`. */
  readonly sessionId: string | null;
  /**
   * The command line, with the name of the program and no folder (H182). A line longer than 8192 characters keeps its start
   * and its end. It is `null` for a protected process.
   */
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

/** This function tells if a UTF-16 code unit is the first half of a pair. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * This function keeps the start and the end of a long text (H182). A text of `max` characters or fewer stays as it is. A
 * longer text gives its first `head` characters, the mark `COMMAND_CUT` and its end, `max` characters in all. A cut does
 * not divide a pair of UTF-16 code units.
 */
export function keepEnds(text: string, max: number, head: number): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - COMMAND_CUT.length);
  let start = Math.min(head, room);
  if (start > 0 && isHighSurrogate(text.charCodeAt(start - 1))) start -= 1;
  let end = text.length - (room - start);
  if (end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end += 1;
  return `${text.slice(0, start)}${COMMAND_CUT}${text.slice(end)}`;
}

/**
 * This function gives a short form of a command line for a line of text, at most `max` characters (H182). It keeps one
 * third of the characters from the start and the rest from the end, so the last path stays.
 */
export function commandText(command: string, max: number): string {
  return keepEnds(command, max, Math.floor(max / 3));
}

/**
 * This function gives the command line of a record: the name of the program with no folder and no `.exe`, then the
 * arguments. `"C:\Program Files\Git\usr\bin\find.exe" / -name x` gives `find / -name x`. A line longer than
 * `COMMAND_MAX` keeps its start and its end (H182).
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
  return keepEnds(`${name === "" ? program : name}${text.slice(end)}`, COMMAND_MAX, COMMAND_HEAD);
}

/**
 * This function gives the owner of a process for the text of an alert (H48). An orphan gets `(orphan, parent ended)`. An
 * owner with the label `(orphan)` from an ended ancestor keeps it.
 */
export function ownerText(owner: string, orphan: boolean): string {
  return orphan ? `${baseOwner(owner)} (orphan, parent ended)` : owner;
}

/** This function tells if an owner comes from the record of an orphan: `session:shop (orphan)`. */
export function isOrphanOwner(owner: string): boolean {
  return owner.endsWith(ORPHAN_LABEL);
}

/** The state of a record in the store: absent, the same, or with an older owner. */
type Stored = "absent" | "same" | "changed";

/**
 * This function gives the session fields of a record (H182). A read with no session keeps the session of the record.
 * The ancestors of a process do not change. Thus a session file that is gone only shows that its session ends.
 */
function sessionFields(record: Pick<ProcessRecord, "session" | "sessionId"> | undefined, session: SessionRef | undefined): Pick<ProcessRecord, "session" | "sessionId"> {
  if (session === undefined) return { session: record?.session ?? null, sessionId: record?.sessionId ?? null };
  return { session: session.name, sessionId: session.id === "" ? null : session.id };
}

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
   * - A new process also gets its parent ID, the start of its parent and its session from `sessionOf` (H182). A parent that
   *   started after the process, or that ended before the read, gives the start 0.
   * - While the parent of a process runs, its record follows its owner and its session, for example when the file of a new
   *   session appears. After the parent ends, the record keeps them.
   * - A record of an older version, with no parent ID, gets its parent at the next read while the parent runs.
   * - A record goes to the store when its process is one minute old.
   */
  observe(
    now: number,
    processes: readonly ProcessInfo[],
    ownerOf: ReadonlyMap<number, string>,
    commandOf: (pid: number) => string | null,
    sessionOf: ReadonlyMap<number, SessionRef> = new Map(),
  ): RecordChanges {
    const byPid = new Map(processes.map((info) => [info.pid, info]));
    const live = new Set<string>();
    const save: ProcessRecord[] = [];
    for (const info of processes) {
      // The idle process is not a process.
      if (info.pid === 0) continue;
      const key = processKey(info);
      live.add(key);
      const owner = baseOwner(ownerOf.get(info.pid) ?? "other");
      const session = sessionOf.get(info.pid);
      let record = this.#records.get(key);
      if (record === undefined) {
        if (this.#records.size >= RECORDS_MAX) continue;
        const line = commandOf(info.pid);
        record = {
          pid: info.pid,
          created: Math.round(info.startedAt ?? 0),
          ...parentFields(info, byPid),
          owner,
          ...sessionFields(undefined, session),
          command: line === null ? null : shortCommand(line),
          firstSeen: now,
        };
        this.#records.set(key, record);
        this.#stored.set(key, "absent");
      } else if (!isOrphan(info, byPid, record)) {
        const next: ProcessRecord = { ...record, owner, ...sessionFields(record, session), ...(record.ppid === 0 ? parentFields(info, byPid) : {}) };
        if (next.owner !== record.owner || next.session !== record.session || next.sessionId !== record.sessionId || next.ppid !== record.ppid || next.parentCreated !== record.parentCreated) {
          record = next;
          this.#records.set(key, record);
          if (this.#stored.get(key) === "same") this.#stored.set(key, "changed");
        }
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

/**
 * This function gives the parent fields of a new record (H182). They are the parent ID, and the start of the parent when
 * it runs and started at or before the process. Otherwise the start is 0.
 */
function parentFields(info: ProcessInfo, byPid: ReadonlyMap<number, ProcessInfo>): ParentRecord {
  const start = parentOf(info, byPid)?.startedAt;
  return { ppid: Math.max(0, info.ppid), parentCreated: start === undefined ? 0 : Math.round(start) };
}
