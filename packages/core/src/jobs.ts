/**
 * The enforcement of a lease on Windows (H6): a job object holds the process of `headroom run` and each
 * process that the job starts.
 *
 * - The job ends with its holder. When the process of `headroom run` exits, Windows stops each process
 *   that is still in the job. Thus no process of the job stays as an orphan.
 * - With a memory limit, the processes of the job cannot commit more memory than the limit together.
 *   An allocation above the limit fails, and the job stops with an error of its own.
 * - The job records its peak memory, so the holder can see what the job used.
 *
 * Windows nests jobs. Thus a process that is in a job already, for example a shell of a terminal, can
 * also go into the job of headroom. Only `createJob()` on Windows loads this file.
 */

import koffi from "koffi";
import { MB } from "./sampler.ts";

const JOB_OBJECT_LIMIT_JOB_MEMORY = 0x200;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;

const kernel32 = koffi.load("kernel32.dll");

const BASIC_LIMIT = koffi.struct("HEADROOM_JOB_BASIC_LIMIT", {
  PerProcessUserTimeLimit: "int64_t",
  PerJobUserTimeLimit: "int64_t",
  LimitFlags: "uint32_t",
  MinimumWorkingSetSize: "size_t",
  MaximumWorkingSetSize: "size_t",
  ActiveProcessLimit: "uint32_t",
  Affinity: "uintptr_t",
  PriorityClass: "uint32_t",
  SchedulingClass: "uint32_t",
});
const IO_COUNTERS = koffi.struct("HEADROOM_JOB_IO_COUNTERS", {
  ReadOperationCount: "uint64_t",
  WriteOperationCount: "uint64_t",
  OtherOperationCount: "uint64_t",
  ReadTransferCount: "uint64_t",
  WriteTransferCount: "uint64_t",
  OtherTransferCount: "uint64_t",
});
const EXTENDED_LIMIT = koffi.struct("HEADROOM_JOB_EXTENDED_LIMIT", {
  BasicLimitInformation: BASIC_LIMIT,
  IoInfo: IO_COUNTERS,
  ProcessMemoryLimit: "size_t",
  JobMemoryLimit: "size_t",
  PeakProcessMemoryUsed: "size_t",
  PeakJobMemoryUsed: "size_t",
});
const extendedSize = koffi.sizeof(EXTENDED_LIMIT);

const createJobObject = kernel32.func("intptr_t __stdcall CreateJobObjectW(void *attributes, const char16_t *name)");
const setInformation = kernel32.func("int __stdcall SetInformationJobObject(intptr_t job, int cls, _In_ HEADROOM_JOB_EXTENDED_LIMIT *info, uint32_t length)");
const queryInformation = kernel32.func("int __stdcall QueryInformationJobObject(intptr_t job, int cls, _Out_ HEADROOM_JOB_EXTENDED_LIMIT *info, uint32_t length, void *returned)");
const assignProcess = kernel32.func("int __stdcall AssignProcessToJobObject(intptr_t job, intptr_t process)");
const getCurrentProcess = kernel32.func("intptr_t __stdcall GetCurrentProcess()");
const getLastError = kernel32.func("uint32_t __stdcall GetLastError()");
const closeHandle = kernel32.func("int __stdcall CloseHandle(intptr_t handle)");

interface ExtendedLimit {
  BasicLimitInformation: { LimitFlags: number };
  JobMemoryLimit: number | bigint;
  PeakJobMemoryUsed: number | bigint;
}

/** The limits of a job. */
export interface JobLimits {
  /** The memory that all the processes of the job can commit together, in MB. Without it, the job has no memory limit. */
  readonly memoryMb?: number | undefined;
}

/** A job object that holds the current process and the processes that it starts. */
export interface Job {
  /** The memory limit of the job in MB, or `null` without a limit. */
  readonly limitMb: number | null;
  /** This function gives the peak of the memory that the processes of the job committed together, in MB. */
  peakMb(): number;
  /**
   * This function closes the job: Windows stops each process that is still in it, the current process too.
   * The holder does not need it. The job closes when the current process exits.
   */
  close(): void;
}

/** This function makes a job, puts the current process into it, and gives the job. The children of the process go into the job too. */
export function createWindowsJob(limits: JobLimits = {}): Job {
  const handle = Number(createJobObject(null, null));
  if (handle === 0) throw new Error(`CreateJobObjectW failed with the error ${getLastError()}`);
  const limitMb = limits.memoryMb !== undefined && limits.memoryMb > 0 ? Math.ceil(limits.memoryMb) : null;
  const info = {
    BasicLimitInformation: { LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | (limitMb === null ? 0 : JOB_OBJECT_LIMIT_JOB_MEMORY) },
    JobMemoryLimit: limitMb === null ? 0 : limitMb * MB,
  };
  if (setInformation(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, extendedSize) === 0) {
    const error = getLastError();
    closeHandle(handle);
    throw new Error(`SetInformationJobObject failed with the error ${error}`);
  }
  if (assignProcess(handle, getCurrentProcess()) === 0) {
    const error = getLastError();
    closeHandle(handle);
    throw new Error(`AssignProcessToJobObject failed with the error ${error}`);
  }
  let open = true;
  return {
    limitMb,
    peakMb: () => {
      const out = {} as ExtendedLimit;
      if (!open || queryInformation(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, out, extendedSize, null) === 0) return 0;
      return Number(out.PeakJobMemoryUsed) / MB;
    },
    close: () => {
      if (!open) return;
      open = false;
      closeHandle(handle);
    },
  };
}
