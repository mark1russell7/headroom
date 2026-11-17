/**
 * The facts of one process on Windows, through a handle with `PROCESS_QUERY_LIMITED_INFORMATION`. These are its program,
 * its parent, its command line, its creation time and its exit code. The reader thread of the start trace (H188, H193) uses it. It
 * imports no module of the engine, so the thread stays small.
 */

import koffi from "koffi";

const kernel32 = koffi.load("kernel32.dll");
const ntdll = koffi.load("ntdll.dll");
const openProcess = kernel32.func("intptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
const imageName = kernel32.func("int __stdcall QueryFullProcessImageNameW(intptr_t process, uint32_t flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)");
const queryProcess = ntdll.func("int32_t __stdcall NtQueryInformationProcess(intptr_t process, uint32_t cls, _Out_ uint8_t *info, uint32_t length, _Out_ uint32_t *returned)");
const processTimes = kernel32.func(
  "int __stdcall GetProcessTimes(intptr_t process, _Out_ uint64_t *creation, _Out_ uint64_t *exit, _Out_ uint64_t *kernel, _Out_ uint64_t *user)",
);
const exitCodeOf = kernel32.func("int __stdcall GetExitCodeProcess(intptr_t process, _Out_ uint32_t *code)");
const closeHandle = kernel32.func("int __stdcall CloseHandle(intptr_t handle)");

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const NAME_CHARS = 1024;
// ProcessBasicInformation (class 0): PROCESS_BASIC_INFORMATION of 48 bytes on 64-bit Windows, with
// InheritedFromUniqueProcessId at 40.
const BASIC_SIZE = 48;
const PARENT_OFFSET = 40;
// ProcessCommandLineInformation (class 60, Windows 8.1 and later): a UNICODE_STRING of 16 bytes on 64-bit Windows, with
// its Length in bytes at 0, and then the text. The longest command line has 32,767 characters.
const COMMAND_LINE_INFORMATION = 60;
const UNICODE_STRING_SIZE = 16;
const COMMAND_BYTES = UNICODE_STRING_SIZE + 65_536;

const name = new Uint16Array(NAME_CHARS);
const size = [NAME_CHARS];
const basic = new Uint8Array(BASIC_SIZE);
const basicView = new DataView(basic.buffer);
const command = new Uint8Array(COMMAND_BYTES);
const commandView = new DataView(command.buffer);
const returned = [0];
const code = [0];
const times = { creation: [0n as bigint | number], exit: [0n as bigint | number], kernel: [0n as bigint | number], user: [0n as bigint | number] };

/** This function opens a process to read its facts. It gives the handle, or 0 when Windows refuses or the process is gone. */
export function openQuery(pid: number): number {
  return Number(openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
}

/** This function gives the full path of the program of a process, or `null`. */
export function imagePath(handle: number): string | null {
  size[0] = NAME_CHARS;
  if (imageName(handle, 0, name, size) === 0) return null;
  return String.fromCharCode(...name.subarray(0, size[0] ?? 0));
}

/** This function gives the pid of the parent of a process, or `null`. */
export function parentPid(handle: number): number | null {
  return queryProcess(handle, 0, basic, BASIC_SIZE, returned) === 0 ? Number(basicView.getBigUint64(PARENT_OFFSET, true)) : null;
}

/** This function gives the command line of a process, or `null`. */
export function commandLine(handle: number): string | null {
  if (queryProcess(handle, COMMAND_LINE_INFORMATION, command, COMMAND_BYTES, returned) !== 0) return null;
  const length = Math.min(commandView.getUint16(0, true), COMMAND_BYTES - UNICODE_STRING_SIZE);
  return Buffer.from(command.buffer, command.byteOffset + UNICODE_STRING_SIZE, length).toString("utf16le");
}

/** This function gives the creation time of a process as a FILETIME (units of 100 ns since 1601), or `null`. */
export function createTime(handle: number): bigint | null {
  if (processTimes(handle, times.creation, times.exit, times.kernel, times.user) === 0) return null;
  const value = times.creation[0];
  return value === undefined ? null : BigInt(value);
}

/** This function gives the exit code of a process, or `null`. A live process gives 259 (`STILL_ACTIVE`). */
export function exitCode(handle: number): number | null {
  return exitCodeOf(handle, code) !== 0 ? (code[0] ?? 0) >>> 0 : null;
}

/** This function closes a handle of `openQuery`. */
export function closeProcess(handle: number): void {
  closeHandle(handle);
}
