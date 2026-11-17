/**
 * The start log (H193): each new process of the start trace and each end, in its own SQLite file with the pragma
 * `synchronous` FULL. A commit is on the disk when it ends, so the rows stay after a bugcheck or a power cut. The reader
 * thread of the trace (`trace-reader.ts`) writes it, at most `START_LOG_WRITE_EVERY_MS` after the message of the job.
 *
 * - A start row has the pid, the parent and the exact creation time: a FILETIME, to join with a crash dump. It also has
 *   the image, the command line, the command line of the parent and the time since a traced process with the pid ended.
 * - The table `texts` keeps each image and command line once. A row names its texts by id.
 * - The file has no index of its own. The rows come in the order of time, so a search by time is a binary search on the
 *   rowid. Each index costs writes of pages at each commit.
 * - The log keeps 24 hours, counted back from its newest row. Thus a long stop after a crash does not empty it.
 * - It covers only the processes of the trace: the jobs of the traced owner kinds.
 */

import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { migrate, openDatabase, transaction, type Migration } from "@mark1russell7/sqlite";

/** The time that the log keeps, counted back from its newest row. */
export const START_LOG_KEEP_MS = 86_400_000;
/** The longest time from the message of a job to the commit of its row. The 4 crashes came 251 ms to 525 ms after the creation. */
export const START_LOG_WRITE_EVERY_MS = 100;
/** The time between two prunes of the writer. */
export const START_LOG_PRUNE_EVERY_MS = 600_000;
/** The longest time from the exit of a pid to its next start that a start row keeps as `reuseMs`. */
export const START_LOG_REUSE_MS = 60_000;
/** The writer writes the time of the use of a text at most once in this time. So a prune keeps the texts of this time more. */
const TOUCH_EVERY_MS = 3_600_000;
/** The most texts in the memory of the writer. */
const CACHED_TEXTS = 20_000;
/** The difference between the epoch of a FILETIME (1601) and the Unix epoch, in units of 100 ns. */
const FILETIME_UNIX = 116_444_736_000_000_000n;

/** A new process, as the reader writes it. */
export interface StartRow {
  /** The time when the reader got the message of the job, in ms since the Unix epoch. */
  readonly at: number;
  /** The key of the job of the trace. */
  readonly key: number;
  readonly pid: number;
  readonly ppid: number | null;
  /** The creation time of the process: a FILETIME, in units of 100 ns since 1601. A crash dump has the same value. */
  readonly created: bigint | null;
  /** The full path of the program. */
  readonly image: string | null;
  readonly command: string | null;
  /** The command line of the parent, when the reader could read it. */
  readonly parentCommand: string | null;
  /** The time from the exit of the last traced process with the same pid to this creation, under `START_LOG_REUSE_MS`. */
  readonly reuseMs: number | null;
}

/** The end of a process, as the reader writes it. */
export interface ExitRow {
  readonly at: number;
  readonly key: number;
  readonly pid: number;
  readonly exitCode: number | null;
  /**
   * The creation time of the process that ended, when the reader held its handle. A process is its pid and its creation
   * time. An exit joins its start by both, also when a new process gets the pid in the same ms.
   */
  readonly created: bigint | null;
}

/** The facts of the writer since its start. The trace gives them to the status. */
export interface StartLogStats {
  readonly path: string;
  /** The start rows that the writer wrote. */
  readonly starts: number;
  /** The start rows with a command line. */
  readonly withCommand: number;
  /** The start rows with a creation time. */
  readonly withCreated: number;
  readonly exits: number;
  readonly commits: number;
  /** The time of all the commits, in ms. */
  readonly writeMs: number;
  /** The longest commit, in ms. */
  readonly slowestWriteMs: number;
  /** The longest time from the creation of a process to the commit of its row, in ms: what a bugcheck can lose. */
  readonly slowestLagMs: number;
  /** The reason when the writer stopped with an error, or `null` while it writes. */
  readonly failure: string | null;
}

/**
 * The steps of the schema (@mark1russell7/sqlite). The user_version of the file is the count of its steps. Each change
 * of the schema is a new step at the end.
 */
const MIGRATIONS: readonly Migration<DatabaseSync>[] = [
  `CREATE TABLE texts (id INTEGER PRIMARY KEY, hash INTEGER UNIQUE, text TEXT NOT NULL, last INTEGER NOT NULL);
   CREATE TABLE starts (at INTEGER NOT NULL, key INTEGER NOT NULL, pid INTEGER NOT NULL, ppid INTEGER, created INTEGER,
     image INTEGER, command INTEGER, parent_command INTEGER, reuse_ms INTEGER);
   CREATE TABLE exits (at INTEGER NOT NULL, key INTEGER NOT NULL, pid INTEGER NOT NULL, code INTEGER, created INTEGER);`,
];

/** This function gives the first 8 bytes of the SHA-256 of a text, as a signed 64-bit integer. */
function textHash(text: string): bigint {
  return createHash("sha256").update(text).digest().readBigInt64LE(0);
}

/** This function gives the Unix time in ms of a FILETIME. */
export function filetimeMs(filetime: bigint): number {
  return Number((filetime - FILETIME_UNIX) / 10_000n);
}

/** This function gives the FILETIME of a Unix time in ms. */
export function msFiletime(ms: number): bigint {
  return BigInt(Math.round(ms)) * 10_000n + FILETIME_UNIX;
}

/** The tables of the log. A name goes into SQL, so it comes only from this list. */
type LogTable = "starts" | "exits";

/**
 * This function gives the last rowid of a table with `at` before `cutoff`, or `null`. The rows come in the order of
 * time, so it is a binary search on the rowid. A probe reads the first row at or after a rowid, because a prune leaves a
 * gap at the start.
 */
function lastRowBefore(db: DatabaseSync, table: LogTable, cutoff: number): number | null {
  const bounds = db.prepare(`SELECT min(rowid) AS low, max(rowid) AS high FROM ${table}`).get() as { low: number | null; high: number | null };
  if (bounds.low === null || bounds.high === null) return null;
  const probe = db.prepare(`SELECT rowid AS id, at FROM ${table} WHERE rowid >= ? ORDER BY rowid LIMIT 1`);
  let low = bounds.low;
  let high = bounds.high;
  let answer: number | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const row = probe.get(middle) as { id: number; at: number } | undefined;
    if (row === undefined) break;
    if (row.at < cutoff) {
      answer = row.id;
      low = row.id + 1;
    } else high = middle - 1;
  }
  return answer;
}

/** This function gives the first rowid of a table with `at` at or after `from`, or 0 when all the rows are before it. */
function firstRowFrom(db: DatabaseSync, table: LogTable, from: number): number {
  const before = lastRowBefore(db, table, from);
  return before === null ? 0 : before + 1;
}

/** The options of the writer. */
export interface StartLogWriterOptions {
  /** The clock. A test gives its own. */
  readonly now?: (() => number) | undefined;
  readonly keepMs?: number | undefined;
}

/** The writer of the log. Only the reader thread of the trace makes one. */
export class StartLogWriter {
  readonly #path: string;
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #keepMs: number;
  readonly #insertStart: StatementSync;
  readonly #insertExit: StatementSync;
  readonly #findText: StatementSync;
  readonly #insertText: StatementSync;
  readonly #touchText: StatementSync;
  /** The id of each text and the time of its last use in the file, by its text. */
  readonly #texts = new Map<string, { id: number; last: number }>();
  #starts = 0;
  #withCommand = 0;
  #withCreated = 0;
  #exits = 0;
  #commits = 0;
  #writeMs = 0;
  #slowestWriteMs = 0;
  #slowestLagMs = 0;

  constructor(path: string, options: StartLogWriterOptions = {}) {
    this.#path = path;
    this.#now = options.now ?? Date.now;
    this.#keepMs = options.keepMs ?? START_LOG_KEEP_MS;
    this.#db = openDatabase(path, { synchronous: "FULL", busyTimeoutMs: 1000, makeFolder: true });
    migrate(this.#db, MIGRATIONS);
    this.#insertStart = this.#db.prepare(
      "INSERT INTO starts (at, key, pid, ppid, created, image, command, parent_command, reuse_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.#insertExit = this.#db.prepare("INSERT INTO exits (at, key, pid, code, created) VALUES (?, ?, ?, ?, ?)");
    this.#findText = this.#db.prepare("SELECT id, text, last FROM texts WHERE hash = ?");
    this.#insertText = this.#db.prepare("INSERT INTO texts (hash, text, last) VALUES (?, ?, ?)");
    this.#touchText = this.#db.prepare("UPDATE texts SET last = ? WHERE id = ?");
  }

  /** This function gives the id of a text, and writes the text when the file does not have it. */
  #textId(text: string | null, now: number): number | null {
    if (text === null) return null;
    const cached = this.#texts.get(text);
    if (cached !== undefined) {
      if (now - cached.last >= TOUCH_EVERY_MS) {
        this.#touchText.run(now, cached.id);
        cached.last = now;
      }
      return cached.id;
    }
    const hash = textHash(text);
    const found = this.#findText.get(hash) as { id: number; text: string; last: number } | undefined;
    let entry: { id: number; last: number };
    if (found !== undefined && found.text === text) {
      entry = { id: found.id, last: found.last };
      if (now - found.last >= TOUCH_EVERY_MS) {
        this.#touchText.run(now, found.id);
        entry.last = now;
      }
    } else {
      // A different text with the same hash gets no hash, so the search never finds it. The memory still finds it.
      entry = { id: Number(this.#insertText.run(found === undefined ? hash : null, text, now).lastInsertRowid), last: now };
    }
    if (this.#texts.size >= CACHED_TEXTS) this.#texts.clear();
    this.#texts.set(text, entry);
    return entry.id;
  }

  /** This function writes the rows in one transaction. When it ends, the rows are on the disk. */
  write(starts: readonly StartRow[], exits: readonly ExitRow[]): void {
    if (starts.length === 0 && exits.length === 0) return;
    const begin = performance.now();
    const now = this.#now();
    transaction(this.#db, () => {
      for (const row of starts) {
        this.#insertStart.run(
          row.at, row.key, row.pid, row.ppid, row.created,
          this.#textId(row.image, now), this.#textId(row.command, now), this.#textId(row.parentCommand, now), row.reuseMs,
        );
      }
      for (const row of exits) this.#insertExit.run(row.at, row.key, row.pid, row.exitCode, row.created);
    });
    const ms = performance.now() - begin;
    const end = this.#now();
    this.#commits++;
    this.#writeMs += ms;
    this.#slowestWriteMs = Math.max(this.#slowestWriteMs, ms);
    this.#exits += exits.length;
    for (const row of starts) {
      this.#starts++;
      if (row.command !== null) this.#withCommand++;
      if (row.created === null) continue;
      this.#withCreated++;
      this.#slowestLagMs = Math.max(this.#slowestLagMs, end - filetimeMs(row.created));
    }
  }

  /**
   * This function deletes the rows older than the keep time before the newest row, and the texts that no kept row can
   * name. It gives the counts of the deleted rows.
   */
  prune(): { readonly starts: number; readonly exits: number; readonly texts: number } {
    const newest = Math.max(
      (this.#db.prepare("SELECT at FROM starts ORDER BY rowid DESC LIMIT 1").get() as { at: number } | undefined)?.at ?? 0,
      (this.#db.prepare("SELECT at FROM exits ORDER BY rowid DESC LIMIT 1").get() as { at: number } | undefined)?.at ?? 0,
    );
    if (newest === 0) return { starts: 0, exits: 0, texts: 0 };
    const cutoff = newest - this.#keepMs;
    const result = transaction(this.#db, () => {
      const count = (table: LogTable): number => {
        const last = lastRowBefore(this.#db, table, cutoff);
        return last === null ? 0 : Number(this.#db.prepare(`DELETE FROM ${table} WHERE rowid <= ?`).run(last).changes);
      };
      const starts = count("starts");
      const exits = count("exits");
      // A kept row is at or after the cutoff, and the last use of each of its texts is at most TOUCH_EVERY_MS before it.
      const texts = Number(this.#db.prepare("DELETE FROM texts WHERE last < ?").run(cutoff - TOUCH_EVERY_MS).changes);
      return { starts, exits, texts };
    });
    if (result.texts > 0) this.#texts.clear();
    return result;
  }

  /** This function gives the facts of the writer. */
  stats(failure: string | null = null): StartLogStats {
    return {
      path: this.#path,
      starts: this.#starts,
      withCommand: this.#withCommand,
      withCreated: this.#withCreated,
      exits: this.#exits,
      commits: this.#commits,
      writeMs: Math.round(this.#writeMs * 10) / 10,
      slowestWriteMs: Math.round(this.#slowestWriteMs * 10) / 10,
      slowestLagMs: Math.round(this.#slowestLagMs),
      failure,
    };
  }

  close(): void {
    this.#db.close();
  }
}

/** A start of the log, with its texts and its exit. */
export interface LoggedStart {
  readonly at: number;
  readonly key: number;
  readonly pid: number;
  readonly ppid: number | null;
  /** The FILETIME of the creation, as decimal text: it has more digits than a number keeps. */
  readonly created: string | null;
  /** The creation time in ms since the Unix epoch. */
  readonly createdAt: number | null;
  readonly image: string | null;
  readonly command: string | null;
  readonly parentCommand: string | null;
  readonly reuseMs: number | null;
  /** The first exit of the pid after the start, before the next start of the pid. */
  readonly exit: { readonly at: number; readonly exitCode: number | null } | null;
}

/** The span of the log. */
export interface StartLogSpan {
  readonly from: number | null;
  readonly to: number | null;
  readonly starts: number;
  readonly exits: number;
}

/** This function opens the log to read it. The file must exist. */
export function openStartLog(path: string): DatabaseSync {
  return openDatabase(path, { readOnly: true, busyTimeoutMs: 2000 });
}

/** This function gives the span of the log: its first and last times and its counts of rows. */
export function startLogSpan(db: DatabaseSync): StartLogSpan {
  const starts = db.prepare("SELECT min(at) AS first, max(at) AS last, count(*) AS n FROM starts").get() as { first: number | null; last: number | null; n: number };
  const exits = db.prepare("SELECT min(at) AS first, max(at) AS last, count(*) AS n FROM exits").get() as { first: number | null; last: number | null; n: number };
  const firsts = [starts.first, exits.first].filter((value): value is number => value !== null);
  const lasts = [starts.last, exits.last].filter((value): value is number => value !== null);
  return { from: firsts.length === 0 ? null : Math.min(...firsts), to: lasts.length === 0 ? null : Math.max(...lasts), starts: starts.n, exits: exits.n };
}

const START_COLUMNS = `s.rowid AS id, s.at, s.key, s.pid, s.ppid, CAST(s.created AS TEXT) AS created, s.reuse_ms AS reuseMs,
  i.text AS image, c.text AS command, p.text AS parentCommand
  FROM starts s LEFT JOIN texts i ON i.id = s.image LEFT JOIN texts c ON c.id = s.command LEFT JOIN texts p ON p.id = s.parent_command`;

interface StartRecord {
  readonly id: number;
  readonly at: number;
  readonly key: number;
  readonly pid: number;
  readonly ppid: number | null;
  readonly created: string | null;
  readonly reuseMs: number | null;
  readonly image: string | null;
  readonly command: string | null;
  readonly parentCommand: string | null;
}

/** This function adds the exit to a start: the first exit of its pid after it, before the next start of the pid. */
function withExit(db: DatabaseSync, record: StartRecord): LoggedStart {
  const next = db.prepare("SELECT at FROM starts WHERE rowid > ? AND pid = ? ORDER BY rowid LIMIT 1").get(record.id, record.pid) as { at: number } | undefined;
  const from = firstRowFrom(db, "exits", record.at);
  // An exit with another creation time is of another process with the pid. An exit with no creation time is of a process
  // whose handle the reader did not hold: it joins by the time only.
  const exit = (
    record.created === null
      ? db.prepare("SELECT at, code FROM exits WHERE rowid >= ? AND pid = ? AND created IS NULL ORDER BY rowid LIMIT 1").get(from, record.pid)
      : db.prepare("SELECT at, code FROM exits WHERE rowid >= ? AND pid = ? AND (created IS NULL OR created = ?) ORDER BY rowid LIMIT 1").get(from, record.pid, BigInt(record.created))
  ) as { at: number; code: number | null } | undefined;
  const ended = exit !== undefined && (next === undefined || exit.at <= next.at) ? { at: exit.at, exitCode: exit.code } : null;
  const { id: _id, ...rest } = record;
  return { ...rest, createdAt: record.created === null ? null : filetimeMs(BigInt(record.created)), exit: ended };
}

/** This function gives the starts of a pid in the log, the newest first, each with its exit. */
export function startsOfPid(db: DatabaseSync, pid: number, limit = 20): LoggedStart[] {
  const records = db.prepare(`SELECT ${START_COLUMNS} WHERE s.pid = ? ORDER BY s.rowid DESC LIMIT ?`).all(pid, limit) as unknown as StartRecord[];
  return records.map((record) => withExit(db, record));
}

/**
 * This function gives the parents of a start in the log, the nearest first. A parent is the newest start of the parent
 * pid before the start of its child. It stops at a parent that the log does not have, or at `depth` parents.
 */
export function parentsOf(db: DatabaseSync, start: LoggedStart, depth = 8): LoggedStart[] {
  const parents: LoggedStart[] = [];
  const find = db.prepare(`SELECT ${START_COLUMNS} WHERE s.pid = ? AND s.at <= ? ORDER BY s.rowid DESC LIMIT 1`);
  let child = start;
  while (parents.length < depth && child.ppid !== null && child.ppid !== 0) {
    const record = find.get(child.ppid, child.at) as unknown as StartRecord | undefined;
    if (record === undefined) break;
    const parent = withExit(db, record);
    // A parent is older than its child. An older pid holder with the same pid is not the parent.
    if (parent.exit !== null && parent.exit.at < child.at) break;
    parents.push(parent);
    child = parent;
  }
  return parents;
}

/** This function gives the starts with a time from `from` to `to`, the oldest first, with their exits. */
export function startsBetween(db: DatabaseSync, from: number, to: number, limit = 100_000): LoggedStart[] {
  const first = firstRowFrom(db, "starts", from);
  const records = db.prepare(`SELECT ${START_COLUMNS} WHERE s.rowid >= ? AND s.at <= ? ORDER BY s.rowid LIMIT ?`).all(first, to, limit) as unknown as StartRecord[];
  return records.map((record) => withExit(db, record));
}

/** One line of a ranking: a text and its starts. */
export interface RankedStarter {
  readonly text: string | null;
  readonly starts: number;
  readonly perMinute: number;
}

/** The ranking of the starters over a time. */
export interface StartRanking {
  /** The start and the end of the time that the ranking covers. */
  readonly from: number;
  readonly to: number;
  readonly starts: number;
  readonly perMinute: number;
  /** The top images. */
  readonly images: readonly RankedStarter[];
  /** The top command lines of the parents. */
  readonly parents: readonly RankedStarter[];
  /** The starts that got a pid that a traced process left less than 1 s before, and the starts with a reuse under 60 s. */
  readonly reusedUnder1s: number;
  readonly reusedUnder60s: number;
}

/**
 * This function ranks the starters of the last `spanMs` before the newest row. It gives the starts in one minute by
 * image and by the command line of the parent: the top `top` of each.
 */
export function rankStarters(db: DatabaseSync, spanMs: number, top = 20): StartRanking | null {
  const span = startLogSpan(db);
  if (span.to === null || span.from === null) return null;
  const to = span.to;
  const from = Math.max(span.from, to - spanMs);
  const first = firstRowFrom(db, "starts", from);
  const minutes = Math.max(1, to - from) / 60_000;
  const rate = (count: number): number => Math.round((count / minutes) * 10) / 10;
  const totals = db.prepare(
    `SELECT count(*) AS n, sum(reuse_ms IS NOT NULL AND reuse_ms < 1000) AS fast, sum(reuse_ms IS NOT NULL) AS reused FROM starts WHERE rowid >= ?`,
  ).get(first) as { n: number; fast: number | null; reused: number | null };
  const rank = (column: "image" | "parent_command"): RankedStarter[] =>
    (
      db.prepare(
        `SELECT t.text AS text, r.n AS n FROM (SELECT ${column} AS id, count(*) AS n FROM starts WHERE rowid >= ? GROUP BY ${column} ORDER BY n DESC LIMIT ?) r
         LEFT JOIN texts t ON t.id = r.id ORDER BY r.n DESC`,
      ).all(first, top) as { text: string | null; n: number }[]
    ).map((row) => ({ text: row.text, starts: row.n, perMinute: rate(row.n) }));
  return {
    from,
    to,
    starts: totals.n,
    perMinute: rate(totals.n),
    images: rank("image"),
    parents: rank("parent_command"),
    reusedUnder1s: totals.fast ?? 0,
    reusedUnder60s: totals.reused ?? 0,
  };
}
