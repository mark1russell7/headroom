/**
 * The sampler of Windows. It calls `kernel32.dll` through the FFI of koffi, so it starts no process.
 *
 * - `K32GetPerformanceInfo` gives the physical memory, the commit charge and the kernel pools.
 * - `NtQuerySystemInformation` with `SystemPerformanceInformation` gives the file cache, the paged pool and the drivers in RAM.
 * - A Toolhelp snapshot gives each process with its parent.
 * - `K32GetProcessMemoryInfo` gives the private memory and the working set of each process.
 * - `NtQueryInformationProcess` gives the command line of each new `node.exe`, for its `--title` (the owner `service:<name>`).
 * - `NtQueryInformationProcess` with `ProcessSequenceNumber` gives the sequence number of the newest process (H29).
 * - `GetTickCount64` gives the start of the computer.
 * - `NtQuerySystemInformation` with `SystemProcessInformation` gives the start, the processor time and the I/O bytes of each process (H20).
 * - `NtQuerySystemInformation` of `ntdll.dll` also gives the use of the kernel pools by each pool tag.
 * - `GetGuiResources` of `user32.dll` gives the USER and GDI objects of the session.
 * - `GetLogicalDrives` and `GetDriveTypeW` give the fixed drives, and `statfs` gives their free space.
 * - `GetIfTable2` of `iphlpapi.dll` gives the byte counters of the adapters, and `GetExtendedTcpTable` gives the TCP connections (H24).
 * - `windows-power.ts` gives the battery, the Energy Meter, the power events and the power request (H30).
 * - For `resources.peer` (H46), `GetExtendedTcpTable` gives the rows of one connection, and `GetProcessTimes` gives the start of one process.
 *
 * koffi registers each struct name once for each process, so the declarations are at the top level.
 * Only `createSampler()` on Windows imports this file.
 */

import { execFileSync } from "node:child_process";
import { statfsSync } from "node:fs";
import koffi from "koffi";
import { DEFAULT_DYNAMIC_PORTS, parseDynamicPorts, parseIfTable, parseTcpEndpoints, parseTcpTable } from "./network.ts";
import { fileTimeMs, programName, titleOf } from "./owners.ts";
import { MB, type Sampler } from "./sampler.ts";
import type { DiskSpace, NetAdapter, PoolTag, PortRange, ProcessInfo, ProcessLink, SystemMemory, TcpConnection, TcpEndpoints, TcpTable } from "./types.ts";
import { closePower, keepAwake, readBattery, readMeters, watchPower } from "./windows-power.ts";

const TH32CS_SNAPPROCESS = 0x2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

const kernel32 = koffi.load("kernel32.dll");
const ntdll = koffi.load("ntdll.dll");
const querySystemInformation = ntdll.func("int32 __stdcall NtQuerySystemInformation(uint32 cls, _Out_ uint8_t *buffer, uint32 length, _Out_ uint32 *returned)");
const STATUS_INFO_LENGTH_MISMATCH = -1073741820;
const STATUS_BUFFER_TOO_SMALL = -1073741789;

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
    ...resident(mb),
  };
}

const SYSTEM_PERFORMANCE_INFORMATION = 2;
// The offsets of page counts (ULONG) in SYSTEM_PERFORMANCE_INFORMATION. The struct has 376 bytes on Windows 11.
// The four counts give the same values as the counters "System Code Resident Bytes", "System Cache Resident Bytes",
// "Pool Paged Resident Bytes" and "System Driver Resident Bytes" of the object Memory.
const SPI_RESIDENT_CODE = 140;
const SPI_RESIDENT_CACHE = 164;
const SPI_RESIDENT_PAGED_POOL = 168;
const SPI_RESIDENT_DRIVER = 172;
let performanceBuffer = Buffer.alloc(512);

/**
 * This function reads the file cache, the paged pool and the code of the kernel and the drivers in RAM, with one call of
 * `NtQuerySystemInformation(SystemPerformanceInformation)`. A failed read gives no amounts.
 */
function resident(mb: (pages: number) => number): Pick<SystemMemory, "cacheMb" | "kernelPagedResidentMb" | "driversMb"> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const returned = [0];
    const status = querySystemInformation(SYSTEM_PERFORMANCE_INFORMATION, performanceBuffer, performanceBuffer.length, returned);
    if (status === STATUS_INFO_LENGTH_MISMATCH) {
      performanceBuffer = Buffer.alloc(Math.max(performanceBuffer.length * 2, returned[0] ?? 0));
      continue;
    }
    if (status !== 0 || (returned[0] ?? 0) < SPI_RESIDENT_DRIVER + 4) return {};
    const pages = (offset: number): number => performanceBuffer.readUInt32LE(offset);
    return {
      cacheMb: mb(pages(SPI_RESIDENT_CACHE)),
      kernelPagedResidentMb: mb(pages(SPI_RESIDENT_PAGED_POOL)),
      driversMb: mb(pages(SPI_RESIDENT_DRIVER) + pages(SPI_RESIDENT_CODE)),
    };
  }
  return {};
}

const getTickCount64 = kernel32.func("uint64_t __stdcall GetTickCount64()");

/** This function gives the start of the computer: the time of the read less the milliseconds since the start. */
function bootedAt(): number {
  return Date.now() - Number(getTickCount64());
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
  // The newest process can end in a moment, so its sequence number comes first.
  sequence = newestSequence(totals);
  const snapshot = Number(createSnapshot(TH32CS_SNAPPROCESS, 0));
  if (snapshot === -1 || snapshot === 0) throw new Error("CreateToolhelp32Snapshot failed");
  const list: ProcessInfo[] = [];
  try {
    const entry = { dwSize: entrySize } as ProcessEntry;
    for (let more = processFirst(snapshot, entry); more !== 0; more = processNext(snapshot, entry)) {
      const pid = Number(entry.th32ProcessID);
      const name = String(entry.szExeFile);
      // The memory of a protected process is not readable, so it counts as 0. The totals come from the kernel for each process.
      const counters = pid === 0 ? null : memoryOf(pid);
      const total = totals.get(pid);
      const title = programName(name) === "node" ? titleOfProcess(pid, total?.startedAt) : null;
      list.push({
        pid,
        ppid: Number(entry.th32ParentProcessID),
        name,
        privateMb: counters ? Number(counters.PrivateUsage) / MB : 0,
        workingMb: counters ? Number(counters.WorkingSetSize) / MB : 0,
        startedAt: total?.startedAt,
        cpuMs: total?.cpuMs,
        readBytes: total?.readBytes,
        writeBytes: total?.writeBytes,
        ...(title === null ? {} : { title }),
      });
      entry.dwSize = entrySize;
    }
  } finally {
    closeHandle(snapshot);
  }
  // The cache of the titles keeps only the live processes.
  const live = new Set(list.map((info) => info.pid));
  for (const pid of titles.keys()) if (!live.has(pid)) titles.delete(pid);
  return list;
}

const queryInformationProcess = ntdll.func(
  "int32 __stdcall NtQueryInformationProcess(intptr_t process, uint32 cls, _Out_ uint8_t *buffer, uint32 length, _Out_ uint32 *returned)",
);
const PROCESS_COMMAND_LINE_INFORMATION = 60;
/** The UNICODE_STRING at the start of the buffer has 16 bytes on 64-bit Windows. The text of the command line follows it. */
const COMMAND_LINE_TEXT = 16;
let commandLineBuffer = Buffer.alloc(4096);
/** The title of each `node.exe`, by process ID, with the start of the process. A new process with the same ID has a different start. */
const titles = new Map<number, { readonly startedAt: number | undefined; readonly title: string | null }>();

/** This function gives the `--title` of a Node process from its command line, one read for each process. */
function titleOfProcess(pid: number, startedAt: number | undefined): string | null {
  const cached = titles.get(pid);
  if (cached !== undefined && cached.startedAt === startedAt) return cached.title;
  const line = commandLine(pid);
  const title = line === null ? null : titleOf(line);
  titles.set(pid, { startedAt, title });
  return title;
}

/** This function reads the command line of a process, or gives `null` when the process is protected or ended. */
function commandLine(pid: number): string | null {
  const handle = Number(openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
  if (handle === 0) return null;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const returned = [0];
      const status = queryInformationProcess(handle, PROCESS_COMMAND_LINE_INFORMATION, commandLineBuffer, commandLineBuffer.length, returned);
      if (status === STATUS_INFO_LENGTH_MISMATCH || status === STATUS_BUFFER_TOO_SMALL) {
        commandLineBuffer = Buffer.alloc(Math.max(commandLineBuffer.length * 2, (returned[0] ?? 0) + 64));
        continue;
      }
      if (status !== 0) return null;
      const length = commandLineBuffer.readUInt16LE(0);
      return commandLineBuffer.toString("utf16le", COMMAND_LINE_TEXT, COMMAND_LINE_TEXT + length);
    }
    return null;
  } finally {
    closeHandle(handle);
  }
}

const PROCESS_SEQUENCE_NUMBER = 92;
/** The count of the newest processes that `newestSequence()` tries. A short process can end before its read. */
const SEQUENCE_TRIES = 4;
const sequenceBuffer = Buffer.alloc(8);
/** The sequence number of the newest process at the last read of the processes (H29). */
let sequence: number | undefined;

/** This function reads the sequence number of a process, or gives `undefined` when the process is protected or ended. */
function sequenceOf(pid: number): number | undefined {
  const handle = Number(openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
  if (handle === 0) return undefined;
  try {
    const status = queryInformationProcess(handle, PROCESS_SEQUENCE_NUMBER, sequenceBuffer, sequenceBuffer.length, [0]);
    return status === 0 ? Number(sequenceBuffer.readBigUInt64LE(0)) : undefined;
  } finally {
    closeHandle(handle);
  }
}

/**
 * This function gives the sequence number of the newest process (H29). Windows gives each new process the next number,
 * so the change between two reads is the exact count of starts. It tries the newest processes first, and it opens at
 * most 4 processes. On 2026-10-24, two processes that started one after the other had numbers with a difference of 1.
 */
function newestSequence(totals: ReadonlyMap<number, ProcessTotals>): number | undefined {
  const newest = [...totals].sort((a, b) => b[1].startedAt - a[1].startedAt).slice(0, SEQUENCE_TRIES);
  for (const [pid] of newest) {
    const value = sequenceOf(pid);
    if (value !== undefined) return value;
  }
  return undefined;
}

const SYSTEM_POOL_TAG_INFORMATION = 22;

const SYSTEM_PROCESS_INFORMATION = 5;
// The offsets in SYSTEM_PROCESS_INFORMATION on 64-bit Windows. The entry of a process is at least 0x100 bytes, and its threads follow it.
const SPI_CREATE_TIME = 0x20;
const SPI_USER_TIME = 0x28;
const SPI_KERNEL_TIME = 0x30;
const SPI_PROCESS_ID = 0x50;
const SPI_READ_TRANSFER = 0xe8;
const SPI_WRITE_TRANSFER = 0xf0;
const SPI_SIZE = 0x100;
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
          startedAt: fileTimeMs(buffer.readBigInt64LE(at + SPI_CREATE_TIME)),
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

const iphlpapi = koffi.load("iphlpapi.dll");
// GetIfTable2 allocates the table, and FreeMibTable frees it.
const getIfTable2 = iphlpapi.func("uint32_t __stdcall GetIfTable2(_Out_ void **table)");
const freeMibTable = iphlpapi.func("void __stdcall FreeMibTable(void *memory)");
const getExtendedTcpTable = iphlpapi.func(
  "uint32_t __stdcall GetExtendedTcpTable(_Out_ uint8_t *table, _Inout_ uint32_t *size, int order, uint32_t family, int tableClass, uint32_t reserved)",
);
const AF_INET = 2;
const AF_INET6 = 23;
const TCP_TABLE_OWNER_PID_ALL = 5;
const ERROR_INSUFFICIENT_BUFFER = 122;
const IF_ROW_SIZE = 1352;
let tcpBuffer = Buffer.alloc(64 * 1024);
let dynamicRange: PortRange | undefined;

/**
 * This function reads the byte counters of the physical adapters and the Wi-Fi adapters with `GetIfTable2`. It frees
 * the table at the end. A failed read gives no adapters.
 */
function network(): NetAdapter[] {
  const out: unknown[] = [null];
  if (getIfTable2(out) !== 0 || out[0] === null || out[0] === undefined) return [];
  const table = out[0];
  try {
    const count = Number(koffi.decode(table, "uint32_t"));
    return parseIfTable(Buffer.from(koffi.view(table, 8 + count * IF_ROW_SIZE)));
  } finally {
    freeMibTable(table);
  }
}

/**
 * This function reads one table of `GetExtendedTcpTable` into the shared buffer, or gives `null` when the read fails. A
 * table that grows between the calls makes the buffer larger. The caller parses the buffer before the next read.
 */
function readTcp(family: number): Buffer | null {
  for (let attempt = 0; attempt < 5; attempt++) {
    const size = [tcpBuffer.length];
    const status = getExtendedTcpTable(tcpBuffer, size, 0, family, TCP_TABLE_OWNER_PID_ALL, 0);
    if (status === ERROR_INSUFFICIENT_BUFFER) {
      tcpBuffer = Buffer.alloc((size[0] ?? tcpBuffer.length) + 16 * 1024);
      continue;
    }
    return status === 0 ? tcpBuffer : null;
  }
  return null;
}

/** This function reads the connections of one table of `GetExtendedTcpTable`. */
function tcpTable(family: number): TcpConnection[] {
  const buffer = readTcp(family);
  return buffer === null ? [] : parseTcpTable(buffer, family === AF_INET6);
}

/** This function reads the rows of IPv4 and IPv6 with this local port and this remote port (H46). It reads each table one time. */
function tcpEndpoints(localPort: number, remotePort: number): TcpEndpoints[] {
  const rows: TcpEndpoints[] = [];
  for (const family of [AF_INET, AF_INET6]) {
    const buffer = readTcp(family);
    if (buffer !== null) rows.push(...parseTcpEndpoints(buffer, family === AF_INET6, localPort, remotePort));
  }
  return rows;
}

/**
 * This function gives the dynamic port range from `netsh int ipv4 show dynamicport tcp`. It starts `netsh` one time,
 * at the first read. Without an answer, the range is the default of Windows.
 */
function dynamicPorts(): PortRange {
  if (dynamicRange !== undefined) return dynamicRange;
  try {
    const text = execFileSync("netsh", ["int", "ipv4", "show", "dynamicport", "tcp"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    dynamicRange = parseDynamicPorts(text);
  } catch {
    dynamicRange = DEFAULT_DYNAMIC_PORTS;
  }
  return dynamicRange;
}

/** This function reads the TCP connections of IPv4 and IPv6 with their processes. A user without admin rights can read them. */
function tcp(): TcpTable {
  return { dynamic: dynamicPorts(), connections: [...tcpTable(AF_INET), ...tcpTable(AF_INET6)] };
}

/**
 * This function reads the process tree with no read of the memory and no open of a process (H46). The Toolhelp snapshot
 * comes first, so each process of the snapshot that still runs has its start in the totals that come next.
 */
function processTree(): ProcessLink[] {
  const snapshot = Number(createSnapshot(TH32CS_SNAPPROCESS, 0));
  if (snapshot === -1 || snapshot === 0) throw new Error("CreateToolhelp32Snapshot failed");
  const list: { pid: number; ppid: number; name: string }[] = [];
  try {
    const entry = { dwSize: entrySize } as ProcessEntry;
    for (let more = processFirst(snapshot, entry); more !== 0; more = processNext(snapshot, entry)) {
      list.push({ pid: Number(entry.th32ProcessID), ppid: Number(entry.th32ParentProcessID), name: String(entry.szExeFile) });
      entry.dwSize = entrySize;
    }
  } finally {
    closeHandle(snapshot);
  }
  const totals = processTotals();
  return list.map((info) => ({ ...info, startedAt: totals.get(info.pid)?.startedAt }));
}

const getProcessTimes = kernel32.func(
  "int __stdcall GetProcessTimes(intptr_t process, _Out_ uint8_t *creation, _Out_ uint8_t *exit, _Out_ uint8_t *kernel, _Out_ uint8_t *user)",
);
const creationTime = Buffer.alloc(8);
const exitTime = Buffer.alloc(8);
const kernelTime = Buffer.alloc(8);
const userTime = Buffer.alloc(8);

/**
 * This function gives the start of a live process with `GetProcessTimes` (H46). A process that ended has an exit time,
 * even while another process holds a handle to it. Thus it gives `undefined` for it, and for a protected process.
 */
function processStart(pid: number): number | undefined {
  if (pid === 0) return undefined;
  const handle = Number(openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
  if (handle === 0) return undefined;
  try {
    if (getProcessTimes(handle, creationTime, exitTime, kernelTime, userTime) === 0) return undefined;
    if (exitTime.readBigUInt64LE(0) !== 0n) return undefined;
    return fileTimeMs(creationTime.readBigInt64LE(0));
  } finally {
    closeHandle(handle);
  }
}

/** This function gives the sampler of Windows. The libraries stay loaded for the life of the process. */
export function windowsSampler(): Sampler {
  return {
    memory,
    processes,
    processSequence: () => sequence,
    poolTags,
    gui,
    disks,
    network,
    tcp,
    tcpEndpoints,
    processTree,
    processStart,
    bootedAt,
    battery: readBattery,
    power: readMeters,
    watchPower,
    keepAwake,
    close: closePower,
  };
}
