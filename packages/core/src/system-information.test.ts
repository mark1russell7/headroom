import { describe, expect, it } from "vitest";
import { fileTimeMs } from "./owners.ts";
import {
  parseResident,
  parseSystemProcesses,
  PERF_MDL_PAGES,
  PERF_PFN_DATABASE,
  PERF_RESIDENT_CACHE,
  PERF_RESIDENT_CODE,
  PERF_RESIDENT_DRIVER,
  PERF_RESIDENT_PAGED_POOL,
  PERF_SIZE,
  PERF_SYSTEM_PAGE_TABLES,
  SPI_SIZE,
} from "./system-information.ts";

const MB = 1024 * 1024;
/** The size of one SYSTEM_THREAD_INFORMATION on 64-bit Windows. The threads of a process follow its entry. */
const THREAD = 0x50;
/** A FILETIME: 2026-10-25 09:00 UTC. */
const STARTED = 134_058_516_000_000_000n;

interface FakeProcess {
  readonly pid: number;
  readonly threads: number;
  readonly privateWorkingMb: number;
  readonly workingMb: number;
  readonly privateMb: number;
  readonly handles: number;
}

/**
 * This function writes the entries of a fake `SystemProcessInformation` buffer at the offsets of 64-bit Windows 11. Each
 * entry has its threads after it, so `NextEntryOffset` jumps over them. The last entry has `NextEntryOffset` 0.
 */
function fakeBuffer(processes: readonly FakeProcess[], extra = 0): { buffer: Buffer; length: number } {
  const sizes = processes.map((each) => SPI_SIZE + each.threads * THREAD);
  const length = sizes.reduce((a, b) => a + b, 0);
  const buffer = Buffer.alloc(length + extra, 0xee);
  let at = 0;
  processes.forEach((each, index) => {
    buffer.fill(0, at, at + (sizes[index] ?? 0));
    buffer.writeUInt32LE(index === processes.length - 1 ? 0 : (sizes[index] ?? 0), at + 0x00);
    buffer.writeUInt32LE(each.threads, at + 0x04);
    buffer.writeBigInt64LE(BigInt(each.privateWorkingMb * MB), at + 0x08);
    buffer.writeBigInt64LE(STARTED, at + 0x20);
    buffer.writeBigInt64LE(30_000_000n, at + 0x28);
    buffer.writeBigInt64LE(20_000_000n, at + 0x30);
    buffer.writeBigUInt64LE(BigInt(each.pid), at + 0x50);
    buffer.writeUInt32LE(each.handles, at + 0x60);
    buffer.writeBigUInt64LE(BigInt(each.workingMb * MB), at + 0x90);
    buffer.writeBigUInt64LE(BigInt(each.privateMb * MB), at + 0xb8);
    buffer.writeBigUInt64LE(BigInt(each.privateMb * MB), at + 0xc8);
    buffer.writeBigInt64LE(4096n, at + 0xe8);
    buffer.writeBigInt64LE(8192n, at + 0xf0);
    at += sizes[index] ?? 0;
  });
  return { buffer, length };
}

const COMPRESSION: FakeProcess = { pid: 3140, threads: 0, privateWorkingMb: 197, workingMb: 197, privateMb: 5, handles: 0 };
const VM: FakeProcess = { pid: 7804, threads: 3, privateWorkingMb: 1417, workingMb: 1419, privateMb: 2238, handles: 214 };

describe("parseSystemProcesses (H49)", () => {
  it("reads the memory, the times, the I/O bytes and the handles at the offsets of 64-bit Windows", () => {
    const { buffer, length } = fakeBuffer([COMPRESSION, VM]);
    expect(parseSystemProcesses(buffer, length).get(7804)).toEqual({
      startedAt: fileTimeMs(STARTED),
      cpuMs: 5000,
      readBytes: 4096,
      writeBytes: 8192,
      handles: 214,
      workingBytes: 1419 * MB,
      privateWorkingBytes: 1417 * MB,
      privateBytes: 2238 * MB,
    });
  });

  it("walks the entries by NextEntryOffset over the threads of each process", () => {
    const { buffer, length } = fakeBuffer([{ ...VM, pid: 4, threads: 7 }, COMPRESSION, VM]);
    const totals = parseSystemProcesses(buffer, length);
    expect([...totals.keys()]).toEqual([4, 3140, 7804]);
    expect(totals.get(3140)?.privateWorkingBytes).toBe(197 * MB);
  });

  it("stops at the entry with NextEntryOffset 0, also with more bytes in the buffer", () => {
    const { buffer, length } = fakeBuffer([COMPRESSION, VM], 2 * SPI_SIZE);
    expect([...parseSystemProcesses(buffer, buffer.length).keys()]).toEqual([3140, 7804]);
    expect(parseSystemProcesses(buffer, length).size).toBe(2);
  });

  it("gives no entries for a read of zero bytes, and stops at an entry past the returned length", () => {
    const { buffer } = fakeBuffer([COMPRESSION, VM]);
    expect(parseSystemProcesses(buffer, 0).size).toBe(0);
    expect([...parseSystemProcesses(buffer, 2 * SPI_SIZE - 1).keys()]).toEqual([3140]);
  });

  it("skips the idle process (ID 0)", () => {
    const { buffer, length } = fakeBuffer([{ ...COMPRESSION, pid: 0 }, VM]);
    expect([...parseSystemProcesses(buffer, length).keys()]).toEqual([7804]);
  });
});

describe("parseResident (H49)", () => {
  const PAGE = 4096;
  const buffer = Buffer.alloc(512);
  const pages = (mb: number): number => (mb * MB) / PAGE;
  buffer.writeUInt32LE(pages(12), PERF_RESIDENT_CODE);
  buffer.writeUInt32LE(pages(1913), PERF_RESIDENT_CACHE);
  buffer.writeUInt32LE(pages(1278), PERF_RESIDENT_PAGED_POOL);
  buffer.writeUInt32LE(pages(48), PERF_RESIDENT_DRIVER);
  buffer.writeBigUInt64LE(BigInt(pages(410)), PERF_MDL_PAGES);
  buffer.writeBigUInt64LE(BigInt(pages(336)), PERF_PFN_DATABASE);
  buffer.writeBigUInt64LE(BigInt(pages(148)), PERF_SYSTEM_PAGE_TABLES);

  it("gives the PFN database, the locked pages and the page tables of Windows 11 22H2 and later", () => {
    expect(parseResident(buffer, PERF_SIZE, PAGE)).toEqual({
      cacheMb: 1913,
      kernelPagedResidentMb: 1278,
      driversMb: 60,
      pfnDatabaseMb: 336,
      driverLockedMb: 410,
      pageTablesMb: 148,
    });
  });

  it("gives only the four counts of 4 bytes for a shorter struct, and nothing for a short read", () => {
    expect(parseResident(buffer, 336, PAGE)).toEqual({ cacheMb: 1913, kernelPagedResidentMb: 1278, driversMb: 60 });
    expect(parseResident(buffer, PERF_RESIDENT_DRIVER, PAGE)).toEqual({});
  });
});
