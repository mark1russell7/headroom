/**
 * The start trace of Windows (H188): one job object for each root process, all with one completion port, and a reader
 * thread (`trace-reader.ts`). `trace.ts` tells the design. Only the Windows sampler loads this file.
 *
 * - A job of the trace stops no process and limits no resource. It has only the limit `JOB_OBJECT_LIMIT_BREAKAWAY_OK`,
 *   so a child with `CREATE_BREAKAWAY_FROM_JOB` can leave it. A held job (H191) has no limit, so no child can leave it.
 * - A job gets its port at its creation, when it has no process. Windows then nests it in the jobs of the root.
 * - The trace closes the handle of a job when the reader tells that its last process ended.
 */

import { Worker } from "node:worker_threads";
import koffi from "koffi";
import { TRACE_STOP_KEY, type StartTrace, type TraceBatch, type TraceCoverOptions, type TraceEvent } from "./trace.ts";

const kernel32 = koffi.load("kernel32.dll");
const createPort = kernel32.func("intptr_t __stdcall CreateIoCompletionPort(intptr_t file, intptr_t port, uintptr_t key, uint32_t threads)");
const postPacket = kernel32.func("int __stdcall PostQueuedCompletionStatus(intptr_t port, uint32_t bytes, uintptr_t key, void *overlapped)");
const createJob = kernel32.func("intptr_t __stdcall CreateJobObjectW(void *attributes, const char16_t *name)");
const setInformation = kernel32.func("int __stdcall SetInformationJobObject(intptr_t job, int cls, _In_ uint8_t *info, uint32_t length)");
const openProcess = kernel32.func("intptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
const assignProcess = kernel32.func("int __stdcall AssignProcessToJobObject(intptr_t job, intptr_t process)");
const closeHandle = kernel32.func("int __stdcall CloseHandle(intptr_t handle)");

const INVALID_HANDLE_VALUE = -1;
// JobObjectExtendedLimitInformation (class 9): JOBOBJECT_EXTENDED_LIMIT_INFORMATION of 144 bytes, with LimitFlags at 16.
const EXTENDED_LIMIT_INFORMATION = 9;
const EXTENDED_LIMIT_SIZE = 144;
const LIMIT_FLAGS_OFFSET = 16;
const JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x800;
// JobObjectAssociateCompletionPortInformation (class 7): CompletionKey at 0 and CompletionPort at 8.
const ASSOCIATE_COMPLETION_PORT = 7;
const ASSOCIATE_SIZE = 16;
// AssignProcessToJobObject needs PROCESS_SET_QUOTA and PROCESS_TERMINATE.
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
/** The longest time between two batches of the reader. */
const POST_EVERY_MS = 1000;

/** The limits of a job that lets a child break away: only the right to break away. */
const ALLOW_LIMITS = new Uint8Array(EXTENDED_LIMIT_SIZE);
new DataView(ALLOW_LIMITS.buffer).setUint32(LIMIT_FLAGS_OFFSET, JOB_OBJECT_LIMIT_BREAKAWAY_OK, true);
/** The limits of a held job (H191): no limit, so a breakaway fails. */
const HOLD_LIMITS = new Uint8Array(EXTENDED_LIMIT_SIZE);

/** This function sets the limits of a job. It gives false when Windows refuses. */
function setLimits(job: number, hold: boolean): boolean {
  return setInformation(job, EXTENDED_LIMIT_INFORMATION, hold ? HOLD_LIMITS : ALLOW_LIMITS, EXTENDED_LIMIT_SIZE) !== 0;
}

/** This function starts the trace: it makes the completion port and starts the reader thread. */
export function windowsStartTrace(): StartTrace {
  const port = Number(createPort(INVALID_HANDLE_VALUE, 0, 0, 1));
  if (port === 0) throw new Error("Windows did not make the completion port of the start trace");
  const jobs = new Map<number, number>();
  let events: TraceEvent[] = [];
  let cpu = 0;
  let nextKey = TRACE_STOP_KEY + 1;
  let failure: string | null = null;
  let closed = false;
  const worker = new Worker(new URL("./trace-reader.ts", import.meta.url), { workerData: { port, postEveryMs: POST_EVERY_MS, stopKey: TRACE_STOP_KEY } });
  // The reader is a helper: it does not keep the daemon alive.
  worker.unref();
  worker.on("message", (batch: TraceBatch) => {
    cpu = batch.cpuMs;
    for (const event of batch.events) {
      if (event.type !== "empty") continue;
      const job = jobs.get(event.key);
      jobs.delete(event.key);
      if (job !== undefined) closeHandle(job);
    }
    if (!closed) events.push(...batch.events);
    if (batch.stopped === true && !closed) failure = "the completion port closed";
  });
  worker.on("error", (error: unknown) => {
    failure = `the reader failed: ${error instanceof Error ? error.message : String(error)}`;
  });
  worker.once("exit", () => closeHandle(port));
  return {
    cover(pid: number, options: TraceCoverOptions = {}): number | null {
      if (closed || failure !== null) return null;
      const job = Number(createJob(null, null));
      if (job === 0) return null;
      const key = nextKey++;
      const associate = new Uint8Array(ASSOCIATE_SIZE);
      const view = new DataView(associate.buffer);
      view.setBigUint64(0, BigInt(key), true);
      view.setBigInt64(8, BigInt(port), true);
      let assigned = false;
      if (setLimits(job, options.hold === true) && setInformation(job, ASSOCIATE_COMPLETION_PORT, associate, ASSOCIATE_SIZE) !== 0) {
        const process = Number(openProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid));
        if (process !== 0) {
          assigned = assignProcess(job, process) !== 0;
          closeHandle(process);
        }
      }
      if (!assigned) {
        closeHandle(job);
        return null;
      }
      jobs.set(key, job);
      return key;
    },
    limit(key: number, hold: boolean): boolean {
      const job = jobs.get(key);
      return !closed && job !== undefined && setLimits(job, hold);
    },
    drain(): readonly TraceEvent[] {
      const out = events;
      events = [];
      return out;
    },
    cpuMs: () => cpu,
    jobs: () => jobs.size,
    failure: () => failure,
    close(): void {
      if (closed) return;
      closed = true;
      postPacket(port, 0, TRACE_STOP_KEY, null);
      for (const job of jobs.values()) closeHandle(job);
      jobs.clear();
      events = [];
    },
  };
}
