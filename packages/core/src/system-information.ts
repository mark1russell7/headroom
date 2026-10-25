/**
 * The parsers of two reads of `NtQuerySystemInformation` (H49). They read a buffer and load no library, so the tests run
 * on each platform. `windows.ts` makes the reads.
 *
 * - `SystemProcessInformation` gives one entry for each process: its memory, its times, its I/O bytes and its handles.
 *   The read opens no process, so it also gives the memory of the protected processes and of the minimal processes.
 * - `SystemPerformanceInformation` gives the file cache, the paged pool and the drivers in RAM. On Windows 11 22H2 and
 *   later, it also gives the PFN database, the pages that drivers lock and the page tables of the system.
 */

import { fileTimeMs } from "./owners.ts";
import type { SystemMemory } from "./types.ts";

/**
 * The offsets in SYSTEM_PROCESS_INFORMATION on 64-bit Windows. The documented struct of `winternl.h` gives the same
 * offsets, with reserved fields between them. The threads of the process follow its entry.
 */
export const SPI_NEXT_ENTRY = 0x00;
/** `WorkingSetPrivateSize`: the private working set. `winternl.h` marks these bytes as reserved, and `ntexapi.h` of phnt names them. */
export const SPI_PRIVATE_WORKING_SET = 0x08;
export const SPI_CREATE_TIME = 0x20;
export const SPI_USER_TIME = 0x28;
export const SPI_KERNEL_TIME = 0x30;
export const SPI_PROCESS_ID = 0x50;
export const SPI_HANDLE_COUNT = 0x60;
export const SPI_WORKING_SET = 0x90;
/** `PagefileUsage`: the private commit, the same value as `PrivateUsage` of `K32GetProcessMemoryInfo`. */
export const SPI_PAGEFILE_USAGE = 0xb8;
export const SPI_READ_TRANSFER = 0xe8;
export const SPI_WRITE_TRANSFER = 0xf0;
/** The size of one entry without its threads. */
export const SPI_SIZE = 0x100;

/** The totals of one process from `SystemProcessInformation`. */
export interface ProcessTotals {
  readonly startedAt: number;
  readonly cpuMs: number;
  readonly readBytes: number;
  readonly writeBytes: number;
  /** The count of the open handles of the process at the read (H48). */
  readonly handles: number;
  /** The working set: `WorkingSetSize`. It includes the pages that the process shares with other processes. */
  readonly workingBytes: number;
  /** The private working set: `WorkingSetPrivateSize`. Only this process uses these pages in RAM (H49). */
  readonly privateWorkingBytes: number;
  /** The private memory: `PagefileUsage`, the same value as `PrivateUsage` of `K32GetProcessMemoryInfo`. */
  readonly privateBytes: number;
}

/**
 * This function reads the entries of a buffer of `SystemProcessInformation`. `length` is the count of bytes that the read
 * gave. `NextEntryOffset` gives the next entry, and the value 0 ends the list. An entry past `length` stops the walk.
 * The idle process (ID 0) is absent, because its processor time is the idle time. The times count units of 100
 * nanoseconds, and the start counts them from 1601-01-01.
 */
export function parseSystemProcesses(buffer: Buffer, length: number): Map<number, ProcessTotals> {
  const totals = new Map<number, ProcessTotals>();
  const end = Math.min(length, buffer.length);
  for (let at = 0; at + SPI_SIZE <= end; ) {
    const pid = Number(buffer.readBigUInt64LE(at + SPI_PROCESS_ID));
    if (pid !== 0) {
      totals.set(pid, {
        startedAt: fileTimeMs(buffer.readBigInt64LE(at + SPI_CREATE_TIME)),
        cpuMs: Number(buffer.readBigInt64LE(at + SPI_USER_TIME) + buffer.readBigInt64LE(at + SPI_KERNEL_TIME)) / 10_000,
        readBytes: Number(buffer.readBigInt64LE(at + SPI_READ_TRANSFER)),
        writeBytes: Number(buffer.readBigInt64LE(at + SPI_WRITE_TRANSFER)),
        handles: buffer.readUInt32LE(at + SPI_HANDLE_COUNT),
        workingBytes: Number(buffer.readBigUInt64LE(at + SPI_WORKING_SET)),
        privateWorkingBytes: Number(buffer.readBigUInt64LE(at + SPI_PRIVATE_WORKING_SET)),
        privateBytes: Number(buffer.readBigUInt64LE(at + SPI_PAGEFILE_USAGE)),
      });
    }
    const next = buffer.readUInt32LE(at + SPI_NEXT_ENTRY);
    if (next === 0) break;
    at += next;
  }
  return totals;
}

/**
 * The offsets of page counts in SYSTEM_PERFORMANCE_INFORMATION. The four counts of 4 bytes give the same values as the
 * counters "System Code Resident Bytes", "System Cache Resident Bytes", "Pool Paged Resident Bytes" and "System Driver
 * Resident Bytes" of the object Memory.
 */
export const PERF_RESIDENT_CODE = 140;
export const PERF_RESIDENT_CACHE = 164;
export const PERF_RESIDENT_PAGED_POOL = 168;
export const PERF_RESIDENT_DRIVER = 172;
/** The counts of 8 bytes of Windows 11 22H2 and later (H49): `MdlPagesAllocated`, `PfnDatabaseCommittedPages` and `SystemPageTableCommittedPages`. */
export const PERF_MDL_PAGES = 344;
export const PERF_PFN_DATABASE = 352;
export const PERF_SYSTEM_PAGE_TABLES = 360;
/** The size of the struct on Windows 11 22H2 and later. A shorter read gives no counts of 8 bytes. */
export const PERF_SIZE = 376;

/** The amounts in RAM that `parseResident()` gives, in MB. */
export type ResidentMemory = Pick<SystemMemory, "cacheMb" | "kernelPagedResidentMb" | "driversMb" | "pfnDatabaseMb" | "driverLockedMb" | "pageTablesMb">;

/**
 * This function reads the amounts in RAM of a buffer of `SystemPerformanceInformation`. `length` is the count of bytes
 * that the read gave, and `pageBytes` is the size of a page. A read that is too short gives no amounts.
 */
export function parseResident(buffer: Buffer, length: number, pageBytes: number): ResidentMemory {
  const end = Math.min(length, buffer.length);
  if (end < PERF_RESIDENT_DRIVER + 4) return {};
  const mb = (pages: number): number => Math.round((pages * pageBytes) / (1024 * 1024));
  const pages = (offset: number): number => buffer.readUInt32LE(offset);
  const resident: ResidentMemory = {
    cacheMb: mb(pages(PERF_RESIDENT_CACHE)),
    kernelPagedResidentMb: mb(pages(PERF_RESIDENT_PAGED_POOL)),
    driversMb: mb(pages(PERF_RESIDENT_DRIVER) + pages(PERF_RESIDENT_CODE)),
  };
  if (end < PERF_SIZE) return resident;
  const large = (offset: number): number => mb(Number(buffer.readBigUInt64LE(offset)));
  return {
    ...resident,
    pfnDatabaseMb: large(PERF_PFN_DATABASE),
    driverLockedMb: large(PERF_MDL_PAGES),
    pageTablesMb: large(PERF_SYSTEM_PAGE_TABLES),
  };
}
