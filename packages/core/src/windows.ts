/**
 * The sampler of Windows. It calls `kernel32.dll` through the FFI of koffi, so it starts no process.
 *
 * - `K32GetPerformanceInfo` gives the physical memory, the commit charge and the kernel pools.
 * - A Toolhelp snapshot gives each process with its parent.
 * - `K32GetProcessMemoryInfo` gives the private memory and the working set of each process.
 * - `NtQuerySystemInformation` with `SystemProcessInformation` gives the start, the processor time and the I/O bytes of each process (H20).
 * - `NtQuerySystemInformation` of `ntdll.dll` also gives the use of the kernel pools by each pool tag.
 * - `GetGuiResources` of `user32.dll` gives the USER and GDI objects of the session.
 * - `GetLogicalDrives` and `GetDriveTypeW` give the fixed drives, and `statfs` gives their free space.
 *
 * koffi registers each struct name once for each process, so the declarations are at the top level.
 * Only `createSampler()` on Windows imports this file.
 */

import { statfsSync } from "node:fs";
import koffi from "koffi";
import { MB, type Sampler } from "./sampler.ts";
import type { DiskSpace, PoolTag, ProcessInfo, SystemMemory } from "./types.ts";

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

/** This function reads the processes with their parents, their memory, their start, their processor time and their I/O bytes. */
function processes(): ProcessInfo[] {
  const totals = processTotals();
  const snapshot = Number(createSnapshot(TH32CS_SNAPPROCESS, 0));
  if (snapshot === -1 || snapshot === 0) throw new Error("CreateToolhelp32Snapshot failed");
  const list: ProcessInfo[] = [];
  try {
    const entry = { dwSize: entrySize } as ProcessEntry;
    for (let more = processFirst(snapshot, entry); more !== 0; more = processNext(snapshot, entry)) {
      const pid = Number(entry.th32ProcessID);
      // The memory of a protected process is not readable, so it counts as 0. The totals come from the kernel for each process.
      const counters = pid === 0 ? null : memoryOf(pid);
      const total = totals.get(pid);
      list.push({
        pid,
        ppid: Number(entry.th32ParentProcessID),
        name: String(entry.szExeFile),
        privateMb: counters ? Number(counters.PrivateUsage) / MB : 0,
        workingMb: counters ? Number(counters.WorkingSetSize) / MB : 0,
        startedAt: total?.startedAt,
        cpuMs: total?.cpuMs,
        readBytes: total?.readBytes,
        writeBytes: total?.writeBytes,
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
const STATUS_BUFFER_TOO_SMALL = -1073741789;

const SYSTEM_PROCESS_INFORMATION = 5;
// The offsets in SYSTEM_PROCESS_INFORMATION on 64-bit Windows. The entry of a process is at least 0x100 bytes, and its threads follow it.
const SPI_CREATE_TIME = 0x20;
const SPI_USER_TIME = 0x28;
const SPI_KERNEL_TIME = 0x30;
const SPI_PROCESS_ID = 0x50;
const SPI_READ_TRANSFER = 0xe8;
const SPI_WRITE_TRANSFER = 0xf0;
const SPI_SIZE = 0x100;
/** The time between 1601-01-01, the start of a FILETIME, and 1970-01-01, in milliseconds. */
const FILETIME_EPOCH_MS = 11_644_473_600_000;
let processBuffer = Buffer.alloc(256 * 1024);

/** The totals of one process since its start. */
interface ProcessTotals {
  readonly startedAt: number;
  readonly cpuMs: number;
  readonly readBytes: number;
  readonly writeBytes: number;
}

/**
 * This function reads the start, the processor time and the I/O bytes of each process with one call of
 * `NtQuerySystemInformation(SystemProcessInformation)`. It opens no process, so it also reads the protected processes.
 * The I/O bytes are `ReadTransferCount` and `WriteTransferCount`: each read and write, also to a pipe or a device.
 * The idle process (ID 0) is absent, because its processor time is the idle time. A failed read gives no totals.
 */
function processTotals(): Map<number, ProcessTotals> {
  const totals = new Map<number, ProcessTotals>();
  for (let attempt = 0; attempt < 5; attempt++) {
    const returned = [0];
    const status = querySystemInformation(SYSTEM_PROCESS_INFORMATION, processBuffer, processBuffer.length, returned);
    if (status === STATUS_INFO_LENGTH_MISMATCH || status === STATUS_BUFFER_TOO_SMALL) {
      processBuffer = Buffer.alloc(Math.max(processBuffer.length * 2, (returned[0] ?? 0) + 64 * 1024));
      continue;
    }
    if (status !== 0) return totals;
    const buffer = processBuffer;
    for (let at = 0; at + SPI_SIZE <= buffer.length; ) {
      const pid = Number(buffer.readBigUInt64LE(at + SPI_PROCESS_ID));
      if (pid !== 0) {
        // The times count units of 100 nanoseconds. The start counts them from 1601-01-01.
        totals.set(pid, {
          startedAt: Math.round(Number(buffer.readBigInt64LE(at + SPI_CREATE_TIME)) / 10_000 - FILETIME_EPOCH_MS),
          cpuMs: Number(buffer.readBigInt64LE(at + SPI_USER_TIME) + buffer.readBigInt64LE(at + SPI_KERNEL_TIME)) / 10_000,
          readBytes: Number(buffer.readBigInt64LE(at + SPI_READ_TRANSFER)),
          writeBytes: Number(buffer.readBigInt64LE(at + SPI_WRITE_TRANSFER)),
        });
      }
      const next = buffer.readUInt32LE(at);
      if (next === 0) break;
      at += next;
    }
    return totals;
  }
  return totals;
}
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

const getLogicalDrives = kernel32.func("uint32_t __stdcall GetLogicalDrives()");
const getDriveType = kernel32.func("uint32_t __stdcall GetDriveTypeW(const char16_t *root)");
const DRIVE_FIXED = 3;

/**
 * This function reads the free space of the fixed drives. `GetLogicalDrives` gives one bit for each drive letter, and
 * `GetDriveTypeW` keeps only the fixed drives. A network drive or a removable drive can stop the read, so it reads none.
 */
function disks(): DiskSpace[] {
  const mask = getLogicalDrives();
  const list: DiskSpace[] = [];
  for (let bit = 0; bit < 26; bit++) {
    if (((mask >>> bit) & 1) === 0) continue;
    const mount = `${String.fromCharCode(65 + bit)}:`;
    const root = `${mount}\\`;
    if (getDriveType(root) !== DRIVE_FIXED) continue;
    try {
      const stats = statfsSync(root);
      list.push({ mount, freeMb: Math.round((stats.bavail * stats.bsize) / MB), totalMb: Math.round((stats.blocks * stats.bsize) / MB) });
    } catch {
      // A drive that is not ready (for example a locked BitLocker drive) has no free space to show.
    }
  }
  return list;
}

/** This function gives the sampler of Windows. The libraries stay loaded for the life of the process. */
export function windowsSampler(): Sampler {
  return { memory, processes, poolTags, gui, disks, close: () => {} };
}
