/**
 * The enforcement of a lease on Windows (H6): a job object holds the process of `headroom run` and each
 * process that the job starts.
 *
 * - The job ends with its holder. When the process of `headroom run` exits, Windows stops each process
 *   that is still in the job. Thus no process of the job stays as an orphan.
 * - With a memory limit, the processes of the job cannot commit more memory than the limit together.
 *   An allocation above the limit fails, and the job stops with an error of its own.
 * - The job records its peak memory, so the holder can see what the job used.
 * - The job counts each process that it held, also the processes that ended (H29). The holder reports the count.
 * - On battery, the holder puts the processes of the job in efficiency mode (EcoQoS), and takes them out on AC power (H30).
 * - The job has a CPU rate (H23): a hard cap with `--limit`, else a weight, so the leased jobs share the processors fairly.
 *   The job gives its processor time, also of the processes that ended.
 *
 * Windows nests jobs. Thus a process that is in a job already, for example a shell of a terminal, can
 * also go into the job of headroom. Only `createJob()` and `startOutsideJob()` on Windows load this file.
 */

import koffi from "koffi";
import { ACCOUNTING_SIZE, accountingCpuMs, applyCpuControl, cpuControlOf, type CpuControl, type CpuRateBinding } from "./cpu.ts";
import { EcoTracker } from "./power.ts";
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
// JobObjectBasicAccountingInformation (class 1): four times of 8 bytes, then TotalPageFaultCount, TotalProcesses,
// ActiveProcesses and TotalTerminatedProcesses of 4 bytes each.
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
const ACCOUNTING_TOTAL_PROCESSES = 36;
const queryAccounting = kernel32.func("int __stdcall QueryInformationJobObject(intptr_t job, int cls, _Out_ uint8_t *info, uint32_t length, void *returned)");
// JobObjectCpuRateControlInformation (class 15) takes JOBOBJECT_CPU_RATE_CONTROL_INFORMATION as 8 bytes (H23).
const setRawInformation = kernel32.func("int __stdcall SetInformationJobObject(intptr_t job, int cls, _In_ uint8_t *info, uint32_t length)");
// JobObjectBasicProcessIdList (class 3): NumberOfAssignedProcesses and NumberOfProcessIdsInList of 4 bytes each, then an ID
// of 8 bytes for each process (H30).
const JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3;
const PID_LIST_HEADER = 8;
const PID_SIZE = 8;
const assignProcess = kernel32.func("int __stdcall AssignProcessToJobObject(intptr_t job, intptr_t process)");
const openProcess = kernel32.func("intptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
const setProcessInformation = kernel32.func("int __stdcall SetProcessInformation(intptr_t process, int cls, _In_ uint8_t *info, uint32_t size)");
const PROCESS_SET_INFORMATION = 0x0200;
// ProcessPowerThrottling with PROCESS_POWER_THROTTLING_STATE: the version 1, the control mask and the state mask. The bit
// PROCESS_POWER_THROTTLING_EXECUTION_SPEED in the state mask asks for EcoQoS (efficiency mode).
const PROCESS_POWER_THROTTLING = 4;
const THROTTLING_VERSION = 1;
const THROTTLING_EXECUTION_SPEED = 1;
const THROTTLING_STATE_SIZE = 12;
const getCurrentProcess = kernel32.func("intptr_t __stdcall GetCurrentProcess()");
const getLastError = kernel32.func("uint32_t __stdcall GetLastError()");
const closeHandle = kernel32.func("int __stdcall CloseHandle(intptr_t handle)");

const CREATE_BREAKAWAY_FROM_JOB = 0x0100_0000;
const DETACHED_PROCESS = 0x8;
const CREATE_NEW_PROCESS_GROUP = 0x200;
const STARTF_USESTDHANDLES = 0x100;

koffi.struct("HEADROOM_STARTUPINFOW", {
  cb: "uint32_t",
  lpReserved: "void *",
  lpDesktop: "void *",
  lpTitle: "void *",
  dwX: "uint32_t",
  dwY: "uint32_t",
  dwXSize: "uint32_t",
  dwYSize: "uint32_t",
  dwXCountChars: "uint32_t",
  dwYCountChars: "uint32_t",
  dwFillAttribute: "uint32_t",
  dwFlags: "uint32_t",
  wShowWindow: "uint16_t",
  cbReserved2: "uint16_t",
  lpReserved2: "void *",
  hStdInput: "void *",
  hStdOutput: "void *",
  hStdError: "void *",
});
koffi.struct("HEADROOM_PROCESS_INFORMATION", {
  hProcess: "intptr_t",
  hThread: "intptr_t",
  dwProcessId: "uint32_t",
  dwThreadId: "uint32_t",
});
const startupSize = koffi.sizeof("HEADROOM_STARTUPINFOW");
const createProcess = kernel32.func(
  "int __stdcall CreateProcessW(const char16_t *application, void *commandLine, void *processAttributes, void *threadAttributes, int inheritHandles, uint32_t flags, void *environment, const char16_t *cwd, HEADROOM_STARTUPINFOW *startup, _Out_ HEADROOM_PROCESS_INFORMATION *info)",
);

interface ExtendedLimit {
  BasicLimitInformation: { LimitFlags: number };
  JobMemoryLimit: number | bigint;
  PeakJobMemoryUsed: number | bigint;
}

/** The limits of a job. */
export interface JobLimits {
  /** The memory that all the processes of the job can commit together, in MB. Without it, the job has no memory limit. */
  readonly memoryMb?: number | undefined;
  /**
   * The hard cap of the processor time of the job, in cycles for each 10,000 cycles of all the processors (H23):
   * `JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP`. A lease of 2 cores on 16 processors gives 1250.
   */
  readonly cpuRate?: number | undefined;
  /** The weight of the job against the other jobs, from 1 to 9 (H23): `JOB_OBJECT_CPU_RATE_CONTROL_WEIGHT_BASED`. A hard cap wins. */
  readonly cpuWeight?: number | undefined;
}

/** A job object that holds the current process and the processes that it starts. */
export interface Job {
  /** The memory limit of the job in MB, or `null` without a limit. */
  readonly limitMb: number | null;
  /** The CPU rate of the job (H23), or `null` without one, also when Windows refused it. */
  readonly cpu: CpuControl | null;
  /** Why Windows refused the CPU rate, or `null`. The job runs without the rate. */
  readonly cpuError: string | null;
  /** This function gives the processor time of the job in ms (H23): `TotalUserTime` and `TotalKernelTime`, also of the processes that ended. */
  cpuMs(): number;
  /** This function gives the peak of the memory that the processes of the job committed together, in MB. */
  peakMb(): number;
  /**
   * This function gives the count of processes that the job held since its start, also the processes that ended (H29). The
   * count includes the current process. It is `TotalProcesses` of `JobObjectBasicAccountingInformation`.
   */
  processes(): number;
  /** This function gives the IDs of the processes in the job at this time, the current process too (H30). */
  pids(): number[];
  /**
   * This function puts the processes of the job in efficiency mode (EcoQoS), or takes them out of it (H30). The current
   * process stays as it is. It changes only the processes that need a change, and gives their count.
   */
  eco(on: boolean): number;
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
  // A refused CPU rate does not stop the job: the job runs without it, and the holder says so.
  const asked = cpuControlOf(limits);
  let cpu: CpuControl | null = null;
  let cpuError: string | null = null;
  if (asked !== null) {
    try {
      applyCpuControl(BINDING, handle, asked);
      cpu = asked;
    } catch (error) {
      cpuError = error instanceof Error ? error.message : String(error);
    }
  }
  if (assignProcess(handle, getCurrentProcess()) === 0) {
    const error = getLastError();
    closeHandle(handle);
    throw new Error(`AssignProcessToJobObject failed with the error ${error}`);
  }
  let open = true;
  const tracker = new EcoTracker();
  const pids = (): number[] => (open ? jobPids(handle) : []);
  const accounting = (): Buffer | null => {
    const out = Buffer.alloc(ACCOUNTING_SIZE);
    return open && queryAccounting(handle, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION, out, ACCOUNTING_SIZE, null) !== 0 ? out : null;
  };
  return {
    limitMb,
    cpu,
    cpuError,
    cpuMs: () => {
      const out = accounting();
      return out === null ? 0 : accountingCpuMs(out);
    },
    pids,
    eco: (on) => tracker.update(on, pids().filter((pid) => pid !== process.pid), setEfficiency),
    peakMb: () => {
      const out = {} as ExtendedLimit;
      if (!open || queryInformation(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, out, extendedSize, null) === 0) return 0;
      return Number(out.PeakJobMemoryUsed) / MB;
    },
    processes: () => accounting()?.readUInt32LE(ACCOUNTING_TOTAL_PROCESSES) ?? 0,
    close: () => {
      if (!open) return;
      open = false;
      closeHandle(handle);
    },
  };
}

/** The Windows functions that set the CPU rate of a job (H23). */
const BINDING: CpuRateBinding = {
  setInformation: (job, infoClass, info, length) => Number(setRawInformation(job, infoClass, info, length)),
  lastError: () => Number(getLastError()),
};

let pidBuffer = Buffer.alloc(PID_LIST_HEADER + 64 * PID_SIZE);

/** This function gives the IDs of the processes in a job. A list that grows between two calls makes the buffer larger. */
function jobPids(job: number): number[] {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ok = queryAccounting(job, JOB_OBJECT_BASIC_PROCESS_ID_LIST, pidBuffer, pidBuffer.length, null) !== 0;
    const assigned = pidBuffer.readUInt32LE(0);
    const listed = pidBuffer.readUInt32LE(4);
    if (!ok && assigned > listed) {
      pidBuffer = Buffer.alloc(PID_LIST_HEADER + (assigned + 16) * PID_SIZE);
      continue;
    }
    if (!ok) return [];
    const list: number[] = [];
    for (let index = 0; index < listed; index++) list.push(Number(pidBuffer.readBigUInt64LE(PID_LIST_HEADER + index * PID_SIZE)));
    return list;
  }
  return [];
}

/**
 * This function puts one process in efficiency mode (EcoQoS), or takes it out of it, with `SetProcessInformation` (H30).
 * It gives `false` when the process ended or refuses the change.
 */
export function setEfficiency(pid: number, on: boolean): boolean {
  const handle = Number(openProcess(PROCESS_SET_INFORMATION, 0, pid));
  if (handle === 0) return false;
  try {
    const state = Buffer.alloc(THROTTLING_STATE_SIZE);
    state.writeUInt32LE(THROTTLING_VERSION, 0);
    state.writeUInt32LE(THROTTLING_EXECUTION_SPEED, 4);
    state.writeUInt32LE(on ? THROTTLING_EXECUTION_SPEED : 0, 8);
    return setProcessInformation(handle, PROCESS_POWER_THROTTLING, state, THROTTLING_STATE_SIZE) !== 0;
  } finally {
    closeHandle(handle);
  }
}

/**
 * This function gives the limit flags of the job of the current process, or `null` when the process is in no job.
 * With nested jobs, it gives the flags of the innermost job.
 */
export function ownJobFlags(): number | null {
  const out = {} as ExtendedLimit;
  if (queryInformation(0, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, out, extendedSize, null) === 0) return null;
  return out.BasicLimitInformation.LimitFlags;
}

/** A process that `startOutsideJob()` started. */
export interface StartedProcess {
  readonly pid: number;
  /** True: the process is outside the job of the current process. False: the job refused the breakaway. */
  readonly breakaway: boolean;
  /** The limit flags of the job of the current process, or `null` when the current process is in no job. */
  readonly jobFlags: number | null;
}

/**
 * This function starts a process with no console and no standard handles, in a new process group. The process does
 * not stop with the current process. The function tries `CREATE_BREAKAWAY_FROM_JOB` first. When the job of the current
 * process refuses it, the function starts the process in the job.
 *
 * Node cannot start a process outside a job, because libuv does not set `CREATE_BREAKAWAY_FROM_JOB`.
 */
export function startWindowsProcess(commandLine: string, cwd: string | null = null): StartedProcess {
  const jobFlags = ownJobFlags();
  const attempt = (flags: number): number | null => {
    // CreateProcessW can change the command line, so it gets a buffer that it can write.
    const line = Buffer.from(`${commandLine}\0`, "utf16le");
    const startup = { cb: startupSize, dwFlags: STARTF_USESTDHANDLES, hStdInput: null, hStdOutput: null, hStdError: null };
    const info = { hProcess: 0, hThread: 0, dwProcessId: 0, dwThreadId: 0 };
    if (createProcess(null, line, null, null, 0, flags, null, cwd, startup, info) === 0) return null;
    closeHandle(info.hThread);
    closeHandle(info.hProcess);
    return info.dwProcessId;
  };
  const base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
  const outside = attempt(base | CREATE_BREAKAWAY_FROM_JOB);
  if (outside !== null) return { pid: outside, breakaway: true, jobFlags };
  const inside = attempt(base);
  if (inside === null) throw new Error(`CreateProcessW failed with the error ${getLastError()}`);
  return { pid: inside, breakaway: false, jobFlags };
}
