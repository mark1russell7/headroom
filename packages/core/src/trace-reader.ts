/**
 * The reader of the start trace (H188). It runs in a worker thread of the daemon, so a sync wait on the completion port
 * does not stop the event loop. For each new process, it reads the name and the parent at once, and it keeps a handle to
 * the process until its exit. Thus it gets the exit code, also of a process that ends after 10 ms.
 *
 * It sends the messages to the daemon in batches, at most one batch each `postEveryMs`. Each batch has the processor
 * time of the thread: the cost of the trace. A packet with the stop key stops it. Only `trace-windows.ts` starts this file, on Windows.
 *
 * With a `logPath`, it also writes each start and each exit to the start log (H193), at most `writeEveryMs` after the
 * message. Each start row has the command line and the exact creation time, so the pid of a crash dump names its program.
 * An error of the log stops the log, and the trace goes on.
 *
 * It sends an empty batch when its loop starts. The trace is ready at that message. The modules of the thread load in
 * approximately 170 ms, and a short process that ends in that time has no name.
 *
 * It imports no module of the engine: only types, the process reads of Windows and the start log.
 */

import { parentPort, workerData } from "node:worker_threads";
import koffi from "koffi";
import { filetimeMs, START_LOG_PRUNE_EVERY_MS, START_LOG_REUSE_MS, StartLogWriter, type ExitRow, type StartLogStats, type StartRow } from "./start-log.ts";
import type { TraceBatch, TraceEvent } from "./trace.ts";
import { closeProcess, commandLine, createTime, exitCode, imagePath, openQuery, parentPid } from "./windows-process-facts.ts";

/** The data of the worker. */
interface ReaderData {
  /** The completion port of the jobs. */
  readonly port: number;
  /** The longest time between two batches. */
  readonly postEveryMs: number;
  /** The key that stops the reader. */
  readonly stopKey: number;
  /** The file of the start log, or `null` for no log. */
  readonly logPath: string | null;
  /** The longest time from a message to the commit of its row. */
  readonly writeEveryMs: number;
}

const kernel32 = koffi.load("kernel32.dll");
const dequeue = kernel32.func(
  "int __stdcall GetQueuedCompletionStatusEx(intptr_t port, _Out_ uint8_t *entries, uint32_t count, _Out_ uint32_t *removed, uint32_t ms, int alertable)",
);
const lastError = kernel32.func("uint32_t __stdcall GetLastError()");
const currentThread = kernel32.func("intptr_t __stdcall GetCurrentThread()");
const threadTimes = kernel32.func(
  "int __stdcall GetThreadTimes(intptr_t thread, _Out_ uint64_t *creation, _Out_ uint64_t *exit, _Out_ uint64_t *kernel, _Out_ uint64_t *user)",
);

// The messages of a job (JOBOBJECT_ASSOCIATE_COMPLETION_PORT): the message is in dwNumberOfBytesTransferred, and the ID
// of the process is in lpOverlapped.
const MESSAGE_ACTIVE_PROCESS_ZERO = 4;
const MESSAGE_NEW_PROCESS = 6;
const MESSAGE_EXIT_PROCESS = 7;
const MESSAGE_ABNORMAL_EXIT_PROCESS = 8;
// OVERLAPPED_ENTRY on 64-bit Windows: lpCompletionKey at 0, lpOverlapped at 8, Internal at 16 and
// dwNumberOfBytesTransferred at 24, 32 bytes in all.
const ENTRY_SIZE = 32;
const ENTRIES = 128;
/** The error of a wait that ended with no packet. Another error, for example a closed port, stops the reader. */
const WAIT_TIMEOUT = 258;
/** The most parents whose command lines the reader keeps. */
const PARENTS_KEPT = 4096;

const data = workerData as ReaderData;
const entries = new Uint8Array(ENTRY_SIZE * ENTRIES);
const view = new DataView(entries.buffer);
const removed = [0];
const times = { creation: [0n], exit: [0n], kernel: [0n], user: [0n] };
/** The handle of each live process of the trace, for its exit code, with its creation time when the log reads it. */
const held = new Map<number, { readonly handle: number; created: bigint | null }>();
/** The command line of each recent parent, with its creation time: a new process with the pid of the parent is not the parent. */
const parents = new Map<number, { readonly created: bigint; readonly command: string | null }>();
/** The time of the last exit of each pid of the trace, for `reuseMs`. */
const exitedAt = new Map<number, number>();

/** This function gives the processor time of this thread, in ms. The times are in units of 100 ns. */
function cpuMs(): number {
  threadTimes(currentThread(), times.creation, times.exit, times.kernel, times.user);
  return Number((times.kernel[0] ?? 0n) + (times.user[0] ?? 0n)) / 10_000;
}

/** This function gives the command line of the parent of a new process, or `null` when the parent is gone or is not older. */
function parentCommand(ppid: number | null, created: bigint | null): string | null {
  if (ppid === null || ppid === 0) return null;
  const own = held.get(ppid)?.handle;
  const handle = own ?? openQuery(ppid);
  if (handle === 0) return null;
  try {
    const parentCreated = createTime(handle);
    if (parentCreated === null || (created !== null && parentCreated > created)) return null;
    const known = parents.get(ppid);
    if (known !== undefined && known.created === parentCreated) return known.command;
    const text = commandLine(handle);
    if (parents.size >= PARENTS_KEPT) parents.clear();
    parents.set(ppid, { created: parentCreated, command: text });
    return text;
  } finally {
    if (own === undefined) closeProcess(handle);
  }
}

/** This function reads the facts of a new process, and keeps a handle to it. It gives the event and the row of the log. */
function started(key: number, pid: number, at: number, log: boolean): { readonly event: TraceEvent; readonly row: StartRow | null } {
  const old = held.get(pid);
  if (old !== undefined) closeProcess(old.handle);
  held.delete(pid);
  const exited = exitedAt.get(pid);
  exitedAt.delete(pid);
  const reuse = (createdAt: number): number | null => (exited !== undefined && createdAt - exited < START_LOG_REUSE_MS ? createdAt - exited : null);
  const handle = openQuery(pid);
  if (handle === 0) {
    const row = log ? { at, key, pid, ppid: null, created: null, image: null, command: null, parentCommand: null, reuseMs: reuse(at) } : null;
    return { event: { type: "start", key, pid, ppid: null, name: null, at }, row };
  }
  const holder = { handle, created: null as bigint | null };
  held.set(pid, holder);
  const path = imagePath(handle);
  const ppid = parentPid(handle);
  const event: TraceEvent = { type: "start", key, pid, ppid, name: path === null ? null : path.slice(path.lastIndexOf("\\") + 1), at };
  if (!log) return { event, row: null };
  const created = createTime(handle);
  holder.created = created;
  const reuseMs = reuse(created === null ? at : filetimeMs(created));
  return { event, row: { at, key, pid, ppid, created, image: path, command: commandLine(handle), parentCommand: parentCommand(ppid, created), reuseMs } };
}

/** This function reads the exit code of an ended process and closes its handle. It gives the event and the creation time. */
function ended(key: number, pid: number, at: number): { readonly event: TraceEvent; readonly created: bigint | null } {
  const holder = held.get(pid);
  held.delete(pid);
  exitedAt.set(pid, at);
  if (holder === undefined) return { event: { type: "exit", key, pid, exitCode: null, at }, created: null };
  const code = exitCode(holder.handle);
  closeProcess(holder.handle);
  return { event: { type: "exit", key, pid, exitCode: code, at }, created: holder.created };
}

/** This function forgets the exits that are too old for `reuseMs`. */
function forgetExits(now: number): void {
  for (const [pid, at] of exitedAt) if (now - at >= START_LOG_REUSE_MS) exitedAt.delete(pid);
}

/** The writer of the start log, and the reason when it stopped. */
interface Log {
  writer: StartLogWriter | null;
  failure: string | null;
  last: StartLogStats | null;
}

/** This function opens the start log. An error gives no writer and its reason. */
function openLog(path: string | null): Log {
  if (path === null) return { writer: null, failure: null, last: null };
  try {
    return { writer: new StartLogWriter(path), failure: null, last: null };
  } catch (error) {
    return { writer: null, failure: `the start log did not open: ${error instanceof Error ? error.message : String(error)}`, last: null };
  }
}

/** This function runs one step of the log: a write, or a prune. An error closes the writer and keeps its reason. */
function logStep(log: Log, step: (writer: StartLogWriter) => void, what: string): void {
  const writer = log.writer;
  if (writer === null) return;
  try {
    step(writer);
  } catch (error) {
    log.last = writer.stats();
    log.failure = `the start log stopped at a ${what}: ${error instanceof Error ? error.message : String(error)}`;
    log.writer = null;
    try {
      writer.close();
    } catch {
      // The file can be broken. The reason above is the first error.
    }
  }
}

/** This function gives the facts of the log for a batch, or `undefined` for no log. */
function logStats(log: Log): StartLogStats | undefined {
  if (log.writer !== null) return log.writer.stats();
  if (log.last !== null) return { ...log.last, failure: log.failure };
  if (log.failure === null) return undefined;
  return { path: data.logPath ?? "", starts: 0, withCommand: 0, withCreated: 0, adopted: 0, exits: 0, commits: 0, writeMs: 0, slowestWriteMs: 0, slowestLagMs: 0, failure: log.failure };
}

function run(): void {
  const port = parentPort;
  if (port === null) return;
  const log = openLog(data.logPath);
  let batch: TraceEvent[] = [];
  let postedAt = Date.now();
  let prunedAt = 0;
  let starts: StartRow[] = [];
  let exits: ExitRow[] = [];
  /** The time of the oldest message whose row waits for its commit. */
  let waitingSince: number | null = null;
  const opened = logStats(log);
  port.postMessage({ events: [], cpuMs: cpuMs(), ...(opened === undefined ? {} : { log: opened }) } satisfies TraceBatch);
  for (;;) {
    const wait = waitingSince === null ? data.postEveryMs : Math.max(0, waitingSince + data.writeEveryMs - Date.now());
    const ok = dequeue(data.port, entries, ENTRIES, removed, wait, 0) !== 0;
    const at = Date.now();
    let stop = !ok && lastError() !== WAIT_TIMEOUT;
    for (let index = 0; ok && index < (removed[0] ?? 0); index++) {
      const key = Number(view.getBigUint64(index * ENTRY_SIZE, true));
      const pid = Number(view.getBigUint64(index * ENTRY_SIZE + 8, true));
      const message = view.getUint32(index * ENTRY_SIZE + 24, true);
      if (key === data.stopKey) stop = true;
      else if (message === MESSAGE_NEW_PROCESS) {
        const read = started(key, pid, at, log.writer !== null);
        batch.push(read.event);
        if (read.row !== null) {
          starts.push(read.row);
          waitingSince ??= at;
        }
      } else if (message === MESSAGE_EXIT_PROCESS || message === MESSAGE_ABNORMAL_EXIT_PROCESS) {
        const end = ended(key, pid, at);
        batch.push(end.event);
        if (log.writer !== null && end.event.type === "exit") {
          exits.push({ at, key, pid, exitCode: end.event.exitCode, created: end.created });
          waitingSince ??= at;
        }
      } else if (message === MESSAGE_ACTIVE_PROCESS_ZERO) batch.push({ type: "empty", key, at });
    }
    if (waitingSince !== null && (stop || at - waitingSince >= data.writeEveryMs)) {
      const rows = { starts, exits };
      logStep(log, (writer) => writer.write(rows.starts, rows.exits), "write");
      starts = [];
      exits = [];
      waitingSince = null;
    }
    if (at - prunedAt >= START_LOG_PRUNE_EVERY_MS) {
      logStep(log, (writer) => writer.prune(), "prune");
      prunedAt = at;
    }
    if (stop || at - postedAt >= data.postEveryMs) {
      forgetExits(at);
      const stats = logStats(log);
      port.postMessage({ events: batch, cpuMs: cpuMs(), stopped: stop, ...(stats === undefined ? {} : { log: stats }) } satisfies TraceBatch);
      batch = [];
      postedAt = at;
    }
    if (stop) break;
  }
  for (const holder of held.values()) closeProcess(holder.handle);
  held.clear();
  log.writer?.close();
}

run();
