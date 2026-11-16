/**
 * The reader of the start trace (H188). It runs in a worker thread of the daemon, so a sync wait on the completion port
 * does not stop the event loop. For each new process, it reads the name and the parent at once, and it keeps a handle to
 * the process until its exit. Thus it gets the exit code, also of a process that ends after 10 ms.
 *
 * It sends the messages to the daemon in batches, at most one batch each `postEveryMs`. Each batch has the processor
 * time of the thread: the cost of the trace. A packet with the stop key stops it. Only `trace-windows.ts` starts this file, on Windows.
 * It imports only types, so the thread loads no module of the engine.
 */

import { parentPort, workerData } from "node:worker_threads";
import koffi from "koffi";
import type { TraceBatch, TraceEvent } from "./trace.ts";

/** The data of the worker: the completion port of the jobs, the time between two batches and the key that stops the reader. */
interface ReaderData {
  readonly port: number;
  readonly postEveryMs: number;
  readonly stopKey: number;
}

const kernel32 = koffi.load("kernel32.dll");
const ntdll = koffi.load("ntdll.dll");
const dequeue = kernel32.func(
  "int __stdcall GetQueuedCompletionStatusEx(intptr_t port, _Out_ uint8_t *entries, uint32_t count, _Out_ uint32_t *removed, uint32_t ms, int alertable)",
);
const openProcess = kernel32.func("intptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
const imageName = kernel32.func("int __stdcall QueryFullProcessImageNameW(intptr_t process, uint32_t flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)");
const queryProcess = ntdll.func("int32_t __stdcall NtQueryInformationProcess(intptr_t process, uint32_t cls, _Out_ uint8_t *info, uint32_t length, _Out_ uint32_t *returned)");
const exitCodeOf = kernel32.func("int __stdcall GetExitCodeProcess(intptr_t process, _Out_ uint32_t *code)");
const closeHandle = kernel32.func("int __stdcall CloseHandle(intptr_t handle)");
const lastError = kernel32.func("uint32_t __stdcall GetLastError()");
const currentThread = kernel32.func("intptr_t __stdcall GetCurrentThread()");
const threadTimes = kernel32.func(
  "int __stdcall GetThreadTimes(intptr_t thread, _Out_ uint64_t *creation, _Out_ uint64_t *exit, _Out_ uint64_t *kernel, _Out_ uint64_t *user)",
);

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
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
// PROCESS_BASIC_INFORMATION on 64-bit Windows: 48 bytes, with InheritedFromUniqueProcessId at 40.
const BASIC_SIZE = 48;
const PARENT_OFFSET = 40;
const NAME_CHARS = 1024;
/** The error of a wait that ended with no packet. Another error, for example a closed port, stops the reader. */
const WAIT_TIMEOUT = 258;

const data = workerData as ReaderData;
const entries = new Uint8Array(ENTRY_SIZE * ENTRIES);
const view = new DataView(entries.buffer);
const removed = [0];
const name = new Uint16Array(NAME_CHARS);
const size = [NAME_CHARS];
const basic = new Uint8Array(BASIC_SIZE);
const basicView = new DataView(basic.buffer);
const returned = [0];
const code = [0];
const times = { creation: [0n], exit: [0n], kernel: [0n], user: [0n] };
/** The handle of each live process of the trace, for its exit code. */
const held = new Map<number, number>();

/** This function gives the processor time of this thread, in ms. The times are in units of 100 ns. */
function cpuMs(): number {
  threadTimes(currentThread(), times.creation, times.exit, times.kernel, times.user);
  return Number((times.kernel[0] ?? 0n) + (times.user[0] ?? 0n)) / 10_000;
}

/** This function reads the name and the parent of a new process, and keeps a handle to it. */
function started(key: number, pid: number, at: number): TraceEvent {
  const old = held.get(pid);
  if (old !== undefined) closeHandle(old);
  held.delete(pid);
  const handle = Number(openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
  if (handle === 0) return { type: "start", key, pid, ppid: null, name: null, at };
  held.set(pid, handle);
  size[0] = NAME_CHARS;
  let program: string | null = null;
  if (imageName(handle, 0, name, size) !== 0) {
    const path = String.fromCharCode(...name.subarray(0, size[0] ?? 0));
    program = path.slice(path.lastIndexOf("\\") + 1);
  }
  const ppid = queryProcess(handle, 0, basic, BASIC_SIZE, returned) === 0 ? Number(basicView.getBigUint64(PARENT_OFFSET, true)) : null;
  return { type: "start", key, pid, ppid, name: program, at };
}

/** This function reads the exit code of an ended process and closes its handle. */
function ended(key: number, pid: number, at: number): TraceEvent {
  const handle = held.get(pid);
  held.delete(pid);
  if (handle === undefined) return { type: "exit", key, pid, exitCode: null, at };
  const exitCode = exitCodeOf(handle, code) !== 0 ? (code[0] ?? 0) >>> 0 : null;
  closeHandle(handle);
  return { type: "exit", key, pid, exitCode, at };
}

function run(): void {
  const port = parentPort;
  if (port === null) return;
  let batch: TraceEvent[] = [];
  let postedAt = Date.now();
  for (;;) {
    const ok = dequeue(data.port, entries, ENTRIES, removed, data.postEveryMs, 0) !== 0;
    const at = Date.now();
    let stop = !ok && lastError() !== WAIT_TIMEOUT;
    for (let index = 0; ok && index < (removed[0] ?? 0); index++) {
      const key = Number(view.getBigUint64(index * ENTRY_SIZE, true));
      const pid = Number(view.getBigUint64(index * ENTRY_SIZE + 8, true));
      const message = view.getUint32(index * ENTRY_SIZE + 24, true);
      if (key === data.stopKey) stop = true;
      else if (message === MESSAGE_NEW_PROCESS) batch.push(started(key, pid, at));
      else if (message === MESSAGE_EXIT_PROCESS || message === MESSAGE_ABNORMAL_EXIT_PROCESS) batch.push(ended(key, pid, at));
      else if (message === MESSAGE_ACTIVE_PROCESS_ZERO) batch.push({ type: "empty", key, at });
    }
    if (stop || at - postedAt >= data.postEveryMs) {
      port.postMessage({ events: batch, cpuMs: cpuMs(), stopped: stop } satisfies TraceBatch);
      batch = [];
      postedAt = at;
    }
    if (stop) break;
  }
  for (const handle of held.values()) closeHandle(handle);
  held.clear();
}

run();
