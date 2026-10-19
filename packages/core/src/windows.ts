/**
 * The sampler of Windows. It calls `kernel32.dll` through the FFI of koffi, so it starts no process.
 *
 * - `K32GetPerformanceInfo` gives the physical memory, the commit charge and the kernel pools.
 * - A Toolhelp snapshot gives each process with its parent.
 * - `K32GetProcessMemoryInfo` gives the private memory and the working set of each process.
 *
 * koffi registers each struct name once for each process, so the declarations are at the top level.
 * Only `createSampler()` on Windows imports this file.
 */

import koffi from "koffi";
import { MB, type Sampler } from "./sampler.ts";
import type { ProcessInfo, SystemMemory } from "./types.ts";

const TH32CS_SNAPPROCESS = 0x2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

const kernel32 = koffi.load("kernel32.dll");

const PERFORMANCE_INFORMATION = koffi.struct("PERFORMANCE_INFORMATION", {
  cb: "uint32_t",
  CommitTotal: "size_t",
  CommitLimit: "size_t",
  CommitPeak: "size_t",
  PhysicalTotal: "size_t",
  PhysicalAvailable: "size_t",
  SystemCache: "size_t",
  KernelTotal: "size_t",
  KernelPaged: "size_t",
  KernelNonpaged: "size_t",
  PageSize: "size_t",
  HandleCount: "uint32_t",
  ProcessCount: "uint32_t",
  ThreadCount: "uint32_t",
});
const PROCESSENTRY32W = koffi.struct("PROCESSENTRY32W", {
  dwSize: "uint32_t",
  cntUsage: "uint32_t",
  th32ProcessID: "uint32_t",
  th32DefaultHeapID: "uintptr_t",
  th32ModuleID: "uint32_t",
  cntThreads: "uint32_t",
  th32ParentProcessID: "uint32_t",
  pcPriClassBase: "int32_t",
  dwFlags: "uint32_t",
  szExeFile: koffi.array("char16_t", 260),
});
const PROCESS_MEMORY_COUNTERS_EX = koffi.struct("PROCESS_MEMORY_COUNTERS_EX", {
  cb: "uint32_t",
  PageFaultCount: "uint32_t",
  PeakWorkingSetSize: "size_t",
  WorkingSetSize: "size_t",
  QuotaPeakPagedPoolUsage: "size_t",
  QuotaPagedPoolUsage: "size_t",
  QuotaPeakNonPagedPoolUsage: "size_t",
  QuotaNonPagedPoolUsage: "size_t",
  PagefileUsage: "size_t",
  PeakPagefileUsage: "size_t",
  PrivateUsage: "size_t",
});

// The handles are numbers here (intptr_t), so the code compares them with 0 and -1.
const getPerformanceInfo = kernel32.func("int __stdcall K32GetPerformanceInfo(_Out_ PERFORMANCE_INFORMATION *info, uint32_t cb)");
const createSnapshot = kernel32.func("intptr_t __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)");
const processFirst = kernel32.func("int __stdcall Process32FirstW(intptr_t snapshot, _Inout_ PROCESSENTRY32W *entry)");
const processNext = kernel32.func("int __stdcall Process32NextW(intptr_t snapshot, _Inout_ PROCESSENTRY32W *entry)");
const openProcess = kernel32.func("intptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
const getMemoryInfo = kernel32.func("int __stdcall K32GetProcessMemoryInfo(intptr_t process, _Out_ PROCESS_MEMORY_COUNTERS_EX *counters, uint32_t cb)");
const closeHandle = kernel32.func("int __stdcall CloseHandle(intptr_t handle)");

const performanceSize = koffi.sizeof(PERFORMANCE_INFORMATION);
const entrySize = koffi.sizeof(PROCESSENTRY32W);
const countersSize = koffi.sizeof(PROCESS_MEMORY_COUNTERS_EX);

interface PerformanceInformation {
  CommitTotal: number | bigint;
  CommitLimit: number | bigint;
  PhysicalTotal: number | bigint;
  PhysicalAvailable: number | bigint;
  KernelPaged: number | bigint;
  KernelNonpaged: number | bigint;
  PageSize: number | bigint;
}

interface ProcessEntry {
  dwSize: number;
  th32ProcessID: number;
  th32ParentProcessID: number;
  szExeFile: string;
}

interface MemoryCounters {
  WorkingSetSize: number | bigint;
  PrivateUsage: number | bigint;
}

/** This function reads the memory of the computer. */
function memory(): SystemMemory {
  const info = {} as PerformanceInformation;
  if (getPerformanceInfo(info, performanceSize) === 0) throw new Error("K32GetPerformanceInfo failed");
  const page = Number(info.PageSize);
  const mb = (pages: number | bigint): number => Math.round((Number(pages) * page) / MB);
  return {
    totalMb: mb(info.PhysicalTotal),
    availableMb: mb(info.PhysicalAvailable),
    commitMb: mb(info.CommitTotal),
    commitLimitMb: mb(info.CommitLimit),
    kernelPagedMb: mb(info.KernelPaged),
    kernelNonpagedMb: mb(info.KernelNonpaged),
  };
}

/** This function reads the memory of one process, or gives `null` when the process is protected or ended. */
function memoryOf(pid: number): MemoryCounters | null {
  const handle = Number(openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
  if (handle === 0) return null;
  try {
    const counters = {} as MemoryCounters;
    return getMemoryInfo(handle, counters, countersSize) === 0 ? null : counters;
  } finally {
    closeHandle(handle);
  }
}

/** This function reads the processes with their parents and their memory. */
function processes(): ProcessInfo[] {
  const snapshot = Number(createSnapshot(TH32CS_SNAPPROCESS, 0));
  if (snapshot === -1 || snapshot === 0) throw new Error("CreateToolhelp32Snapshot failed");
  const list: ProcessInfo[] = [];
  try {
    const entry = { dwSize: entrySize } as ProcessEntry;
    for (let more = processFirst(snapshot, entry); more !== 0; more = processNext(snapshot, entry)) {
      const pid = Number(entry.th32ProcessID);
      // The counters of a protected process are not readable: its memory counts as 0.
      const counters = pid === 0 ? null : memoryOf(pid);
      list.push({
        pid,
        ppid: Number(entry.th32ParentProcessID),
        name: String(entry.szExeFile),
        privateMb: counters ? Number(counters.PrivateUsage) / MB : 0,
        workingMb: counters ? Number(counters.WorkingSetSize) / MB : 0,
      });
      entry.dwSize = entrySize;
    }
  } finally {
    closeHandle(snapshot);
  }
  return list;
}

/** This function gives the sampler of Windows. The library stays loaded for the life of the process. */
export function windowsSampler(): Sampler {
  return { memory, processes, close: () => {} };
}
