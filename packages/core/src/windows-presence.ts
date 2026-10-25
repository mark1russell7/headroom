/**
 * The presence of Mark on Windows (H33), through the FFI of koffi. It starts no process, no timer and no window.
 *
 * - `GetLastInputInfo` of `user32.dll` gives the tick of the last input of the session. `GetTickCount64` gives the current tick.
 * - `SHQueryUserNotificationState` of `shell32.dll` tells if the session is locked, a full-screen app runs or a presentation runs.
 * - `RegEnumKeyExW` and `RegGetValueW` of `advapi32.dll` read the consent store of the camera and the microphone. They only read.
 * - The user presence and the display come as power events through `watchPower()` of `windows-power.ts`.
 *
 * Only `windows.ts` imports this file.
 */

import koffi from "koffi";
import { readCall, type CallRead, type ConsentRegistry, type PresenceRead } from "./presence.ts";

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");
const shell32 = koffi.load("shell32.dll");
const advapi32 = koffi.load("advapi32.dll");

/** `LASTINPUTINFO`: the size of the struct, then the tick of the last input. */
const LAST_INPUT_SIZE = 8;
const lastInput = Buffer.alloc(LAST_INPUT_SIZE);
const getLastInputInfo = user32.func("int __stdcall GetLastInputInfo(_Inout_ uint8_t *info)");
const getTickCount64 = kernel32.func("uint64_t __stdcall GetTickCount64()");
const queryNotificationState = shell32.func("int32 __stdcall SHQueryUserNotificationState(_Out_ int32 *state)");

/**
 * This function gives the milliseconds since the last input of the session, or `null` when the read fails. The tick of
 * the input has 32 bits, so the difference uses the low 32 bits of `GetTickCount64`. It is correct for 49 days.
 */
function idleMs(): number | null {
  lastInput.writeUInt32LE(LAST_INPUT_SIZE, 0);
  if (getLastInputInfo(lastInput) === 0) return null;
  const now = Number(BigInt(getTickCount64() as number | bigint) & 0xffff_ffffn);
  return (now - lastInput.readUInt32LE(4)) >>> 0;
}

/** This function gives the value of `SHQueryUserNotificationState`, or `null` when the call fails. */
function notificationState(): number | null {
  const state = [0];
  return queryNotificationState(state) === 0 ? (state[0] ?? null) : null;
}

/** This function reads the presence of the tick: the time since the last input and the notification state. */
export function readPresence(): PresenceRead {
  let idle: number | null = null;
  let notification: number | null = null;
  try {
    idle = idleMs();
  } catch {
    idle = null;
  }
  try {
    notification = notificationState();
  } catch {
    notification = null;
  }
  return { idleMs: idle, notification };
}

/** The predefined key `HKEY_CURRENT_USER`: the value 0x80000001 as a signed 32-bit number, extended to the size of a pointer. */
const HKEY_CURRENT_USER = -0x7fff_ffff;
const KEY_QUERY_VALUE = 0x1;
const KEY_ENUMERATE_SUB_KEYS = 0x8;
const ERROR_NO_MORE_ITEMS = 259;
const ERROR_MORE_DATA = 234;
/** `RRF_RT_REG_QWORD`: `RegGetValueW` accepts only a `REG_QWORD`. */
const RRF_RT_REG_QWORD = 0x40;
/** The longest name of a key in characters, with the end character. */
const KEY_NAME_CHARS = 256;
/** A limit of subkeys for one read, so a damaged key does not stop the tick. */
const MAX_SUBKEYS = 1000;

const regOpenKey = advapi32.func("int32 __stdcall RegOpenKeyExW(intptr_t key, const char16_t *subKey, uint32_t options, uint32_t access, _Out_ intptr_t *result)");
const regCloseKey = advapi32.func("int32 __stdcall RegCloseKey(intptr_t key)");
const regEnumKey = advapi32.func(
  "int32 __stdcall RegEnumKeyExW(intptr_t key, uint32_t index, _Out_ uint8_t *name, _Inout_ uint32_t *size, void *reserved, void *cls, void *clsSize, void *time)",
);
const regGetValue = advapi32.func(
  "int32 __stdcall RegGetValueW(intptr_t key, const char16_t *subKey, const char16_t *value, uint32_t flags, void *type, _Out_ uint8_t *data, _Inout_ uint32_t *size)",
);
const nameBuffer = Buffer.alloc(KEY_NAME_CHARS * 2);
const qwordBuffer = Buffer.alloc(8);

/** The keys of `HKEY_CURRENT_USER`, for the read of the consent store. It opens each key only to read it, and closes it. */
const currentUser: ConsentRegistry = {
  subkeys(path) {
    const opened = [0];
    if (regOpenKey(HKEY_CURRENT_USER, path, 0, KEY_QUERY_VALUE | KEY_ENUMERATE_SUB_KEYS, opened) !== 0) return [];
    const key = opened[0] ?? 0;
    const names: string[] = [];
    try {
      for (let index = 0; index < MAX_SUBKEYS; index++) {
        const size = [KEY_NAME_CHARS];
        const status = regEnumKey(key, index, nameBuffer, size, null, null, null, null);
        if (status === ERROR_NO_MORE_ITEMS) break;
        if (status === ERROR_MORE_DATA) continue;
        if (status !== 0) break;
        names.push(nameBuffer.toString("utf16le", 0, Math.min(KEY_NAME_CHARS - 1, size[0] ?? 0) * 2));
      }
    } finally {
      regCloseKey(key);
    }
    return names;
  },
  qword(path, name) {
    const size = [8];
    if (regGetValue(HKEY_CURRENT_USER, path, name, RRF_RT_REG_QWORD, null, qwordBuffer, size) !== 0) return null;
    return qwordBuffer.readBigUInt64LE(0);
  },
};

/**
 * This function tells if an app uses the camera or the microphone, from the consent store. It gives `null` when the read
 * fails. It keeps no name of an app. On this computer on 2026-10-25, one read took approximately 2 ms.
 */
export function readCalls(): CallRead | null {
  try {
    return readCall(currentUser);
  } catch {
    return null;
  }
}
