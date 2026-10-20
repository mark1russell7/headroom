/**
 * The sampler of Windows. It calls `kernel32.dll` through the FFI of koffi, so it starts no process.
 *
 * - `K32GetPerformanceInfo` gives the physical memory, the commit charge and the kernel pools.
 * - A Toolhelp snapshot gives each process with its parent.
 * - `K32GetProcessMemoryInfo` gives the private memory and the working set of each process.
 * - `NtQuerySystemInformation` of `ntdll.dll` gives the use of the kernel pools by each pool tag.
 * - `GetGuiResources` of `user32.dll` gives the USER and GDI objects of the session.
 *
 * koffi registers each struct name once for each process, so the declarations are at the top level.
 * Only `createSampler()` on Windows imports this file.
 */

import koffi from "koffi";
import { MB, type Sampler } from "./sampler.ts";
import type { PoolTag, ProcessInfo, SystemMemory } from "./types.ts";

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

const ntdll = koffi.load("ntdll.dll");
const querySystemInformation = ntdll.func("int32 __stdcall NtQuerySystemInformation(uint32 cls, _Out_ uint8_t *buffer, uint32 length, _Out_ uint32 *returned)");
const SYSTEM_POOL_TAG_INFORMATION = 22;
const STATUS_INFO_LENGTH_MISMATCH = -1073741820;
// One entry of SYSTEM_POOLTAG on 64-bit Windows: the tag, the paged counts and size, then the non-paged counts and size.
const TAG_ENTRY = 40;
let tagBuffer = Buffer.alloc(512 * 1024);

/** This function reads the use of the kernel pools by each pool tag. A user without admin rights can read it. */
function poolTags(): PoolTag[] {
  for (let attempt = 0; attempt < 5; attempt++) {
    const returned = [0];
    const status = querySystemInformation(SYSTEM_POOL_TAG_INFORMATION, tagBuffer, tagBuffer.length, returned);
    if (status === STATUS_INFO_LENGTH_MISMATCH) {
      tagBuffer = Buffer.alloc(Math.max(tagBuffer.length * 2, (returned[0] ?? 0) + 64 * 1024));
      continue;
    }
    if (status !== 0) throw new Error(`NtQuerySystemInformation failed with the status 0x${(status >>> 0).toString(16)}`);
    const count = tagBuffer.readUInt32LE(0);
    const tags: PoolTag[] = [];
    for (let index = 0; index < count; index++) {
      const at = 8 + index * TAG_ENTRY;
      tags.push({
        tag: tagBuffer.toString("latin1", at, at + 4),
        pagedMb: Number(tagBuffer.readBigUInt64LE(at + 16)) / MB,
        nonPagedMb: Number(tagBuffer.readBigUInt64LE(at + 32)) / MB,
      });
    }
    return tags;
  }
  throw new Error("NtQuerySystemInformation: the buffer stays too small");
}

const user32 = koffi.load("user32.dll");
const getGuiResources = user32.func("uint32_t __stdcall GetGuiResources(intptr_t process, uint32_t flags)");
// GR_GLOBAL in place of a process handle gives the counts of all the processes of the session.
const GR_GLOBAL = -2;
const GR_GDIOBJECTS = 0;
const GR_USEROBJECTS = 1;

/** This function reads the USER and GDI objects of all the processes of the session. */
function gui(): { userObjects: number; gdiObjects: number } {
  return { userObjects: getGuiResources(GR_GLOBAL, GR_USEROBJECTS), gdiObjects: getGuiResources(GR_GLOBAL, GR_GDIOBJECTS) };
}

/** This function gives the sampler of Windows. The libraries stay loaded for the life of the process. */
export function windowsSampler(): Sampler {
  return { memory, processes, poolTags, gui, close: () => {} };
}
