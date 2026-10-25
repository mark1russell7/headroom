/**
 * The battery, the power and the power events of Windows (H30), through the FFI of koffi. It starts no process and no timer.
 *
 * - `CallNtPowerInformation(SystemBatteryState)` of `powrprof.dll` gives the battery. It needs no admin rights.
 * - PDH gives the counter set "Energy Meter": one query, opened at the first read, and one collection for each read.
 * - `PowerSettingRegisterNotification` gives the power source, the charge and the lid.
 * - `PowerRegisterForEffectivePowerModeNotifications` gives the power mode: battery saver, balanced or performance.
 * - `PowerRegisterSuspendResumeNotification` gives the sleep and the wake.
 * - `PowerCreateRequest` and `PowerSetRequest` of `kernel32.dll` keep the computer awake while a lease runs on AC power.
 *
 * koffi queues a callback from a thread of Windows to the main thread, and the thread of Windows waits until it runs. Thus
 * each callback only gives the event to its listener. The calls that register and unregister run on a worker thread
 * (`.async`), because Windows can call a callback during the call. Only `windows.ts` imports this file.
 */

import koffi, { type LibraryHandle } from "koffi";
import { BATTERY_STATE_SIZE, guidBytes, guidText, modeEvent, parseBatteryState, parseMeters, POWER_SETTINGS, settingEvent, suspendEvent, type PowerEvent } from "./power.ts";
import type { BatteryRead, PowerMeters } from "./types.ts";

const powrprof = koffi.load("powrprof.dll");
const kernel32 = koffi.load("kernel32.dll");

const SYSTEM_BATTERY_STATE = 5;
const callNtPowerInformation = powrprof.func(
  "int32 __stdcall CallNtPowerInformation(int32 level, void *input, uint32 inputLength, _Out_ uint8_t *output, uint32 outputLength)",
);
const batteryBuffer = Buffer.alloc(BATTERY_STATE_SIZE);

/** This function reads the battery. It gives `null` on a computer with no battery, and when the read fails. */
export function readBattery(): BatteryRead | null {
  return callNtPowerInformation(SYSTEM_BATTERY_STATE, null, 0, batteryBuffer, BATTERY_STATE_SIZE) === 0 ? parseBatteryState(batteryBuffer) : null;
}

/** The counter of the power of each meter, in mW. The English name works in each language of Windows. */
const ENERGY_METER_PATH = "\\Energy Meter(*)\\Power";
/** `PDH_FMT_DOUBLE` and `PDH_FMT_NOCAP100`: a value above 100 stays as it is. */
const PDH_FORMAT = 0x200 | 0x8000;
const PDH_MORE_DATA = 0x8000_07d2;
/** `PDH_FMT_COUNTERVALUE_ITEM_W` on 64-bit Windows: the name pointer, the status and its padding, and the double. */
const ITEM_SIZE = 24;
const ITEM_STATUS = 8;
const ITEM_VALUE = 16;
/** `PDH_CSTATUS_VALID_DATA` and `PDH_CSTATUS_NEW_DATA`. */
const VALID_STATUS: ReadonlySet<number> = new Set([0, 1]);

/** A function of a library of Windows. */
type NativeFunction = ReturnType<LibraryHandle["func"]>;

/** The query of the Energy Meter, with the functions of PDH. */
interface MeterQuery {
  readonly query: unknown;
  readonly counter: unknown;
  readonly collect: NativeFunction;
  readonly array: NativeFunction;
  readonly close: NativeFunction;
  /** True after the first collection. The power is a rate, so the first collection gives only the base of the next one. */
  primed: boolean;
}

/** The query: `undefined` before the first read, `null` when the computer has no Energy Meter. */
let meterQuery: MeterQuery | null | undefined;
let meterBuffer = Buffer.alloc(4096);

/** This function opens the query of the Energy Meter, or gives `null` when PDH or the counter set is absent. */
function openMeters(): MeterQuery | null {
  try {
    const pdh = koffi.load("pdh.dll");
    const open = pdh.func("uint32 __stdcall PdhOpenQueryW(const char16_t *source, uintptr_t data, _Out_ void **query)");
    const add = pdh.func("uint32 __stdcall PdhAddEnglishCounterW(void *query, const char16_t *path, uintptr_t data, _Out_ void **counter)");
    const collect = pdh.func("uint32 __stdcall PdhCollectQueryData(void *query)");
    const array = pdh.func(
      "uint32 __stdcall PdhGetFormattedCounterArrayW(void *counter, uint32 format, _Inout_ uint32 *size, _Out_ uint32 *count, _Out_ uint8_t *buffer)",
    );
    const close = pdh.func("uint32 __stdcall PdhCloseQuery(void *query)");
    const query: unknown[] = [null];
    if (open(null, 0, query) !== 0) return null;
    const counter: unknown[] = [null];
    if (add(query[0], ENERGY_METER_PATH, 0, counter) !== 0) {
      close(query[0]);
      return null;
    }
    return { query: query[0], counter: counter[0], collect, array, close, primed: false };
  } catch {
    return null;
  }
}

/** This function reads a string of UTF-16 code units that ends with 0, from an offset in a buffer. */
function wideAt(buffer: Buffer, offset: number): string {
  if (offset < 0 || offset >= buffer.length) return "";
  let end = offset;
  while (end + 1 < buffer.length && buffer.readUInt16LE(end) !== 0) end += 2;
  return buffer.toString("utf16le", offset, end);
}

/**
 * This function reads the counter set "Energy Meter", with one collection of the query. It gives `null` on a computer with
 * no such counters, at the first read, and when the read fails. The names of the items point into the buffer of the read.
 * On this computer on 2026-10-24, the query cost approximately 4 MB of private memory and 1 second at its start. Each
 * collection cost 5 to 25 ms.
 */
export function readMeters(): PowerMeters | null {
  if (meterQuery === undefined) meterQuery = openMeters();
  const meters = meterQuery;
  if (meters === null) return null;
  if (meters.collect(meters.query) !== 0) return null;
  if (!meters.primed) {
    meters.primed = true;
    return null;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const size = [meterBuffer.length];
    const count = [0];
    const status = Number(meters.array(meters.counter, PDH_FORMAT, size, count, meterBuffer)) >>> 0;
    if (status === PDH_MORE_DATA) {
      meterBuffer = Buffer.alloc((size[0] ?? meterBuffer.length) + 1024);
      continue;
    }
    if (status !== 0) return null;
    const base = koffi.address(meterBuffer);
    const items: { name: string; milliwatts: number }[] = [];
    for (let index = 0; index < (count[0] ?? 0); index++) {
      const at = index * ITEM_SIZE;
      if (at + ITEM_SIZE > meterBuffer.length) break;
      if (!VALID_STATUS.has(meterBuffer.readUInt32LE(at + ITEM_STATUS))) continue;
      const name = wideAt(meterBuffer, Number(meterBuffer.readBigUInt64LE(at) - base));
      if (name !== "") items.push({ name, milliwatts: meterBuffer.readDoubleLE(at + ITEM_VALUE) });
    }
    return parseMeters(items);
  }
  return null;
}

/** This function closes the query of the Energy Meter. */
function closeMeters(): void {
  if (meterQuery) meterQuery.close(meterQuery.query);
  meterQuery = undefined;
}

const DEVICE_NOTIFY_CALLBACK = 2;
const PBT_POWERSETTINGCHANGE = 0x8013;
const EFFECTIVE_POWER_MODE_V2 = 2;
/** `POWERBROADCAST_SETTING`: the GUID, the length of the data, and a DWORD of data for the settings that headroom watches. */
const SETTING_SIZE = 24;

const DeviceNotify = koffi.proto("uint32 __stdcall HEADROOM_DEVICE_NOTIFY_CALLBACK(void *context, uint32 type, void *setting)");
const EffectiveMode = koffi.proto("void __stdcall HEADROOM_EFFECTIVE_POWER_MODE_CALLBACK(int32 mode, void *context)");

/** One registration: a name for the log, a call that registers with the handle as its last argument, and the call that unregisters. */
interface Registration {
  readonly name: string;
  readonly register: (handle: unknown[], done: (error: unknown, status: number) => void) => void;
  readonly unregister: (handle: unknown) => void;
}

/** This function gives the callback memory of `DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS`: the callback and a context of 0. It stays until the end. */
function subscribeParameters(callback: bigint): unknown {
  const parameters: unknown = koffi.alloc("uint8_t", 16);
  koffi.encode(parameters, 0, "uint64_t", callback);
  koffi.encode(parameters, 8, "uint64_t", 0n);
  return parameters;
}

/**
 * This function registers for the power events. The listener gets each event on the main thread. A registration that
 * fails writes one line to the log. The function gives a function that ends the registrations.
 */
export function watchPower(listener: (event: PowerEvent) => void, log: (line: string) => void): () => void {
  const give = (event: PowerEvent | null): void => {
    if (event === null) return;
    try {
      listener(event);
    } catch (error) {
      log(`A power event failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const callbacks: bigint[] = [];
  const memory: unknown[] = [];
  const registrations: Registration[] = [];
  try {
    const setting = koffi.register((_context: unknown, type: number, data: unknown): number => {
      if (type !== PBT_POWERSETTINGCHANGE || data === null) return 0;
      const view = Buffer.from(koffi.view(data, SETTING_SIZE));
      give(settingEvent(guidText(view), view.readUInt32LE(16) >= 4 ? view.readUInt32LE(20) : 0));
      return 0;
    }, koffi.pointer(DeviceNotify));
    callbacks.push(setting);
    const recipient = subscribeParameters(setting);
    memory.push(recipient);
    const registerSetting = powrprof.func("uint32 __stdcall PowerSettingRegisterNotification(const uint8_t *guid, uint32 flags, void *recipient, _Out_ void **handle)");
    const unregisterSetting = powrprof.func("uint32 __stdcall PowerSettingUnregisterNotification(void *handle)");
    for (const guid of POWER_SETTINGS) {
      // The GUID stays in memory until the call on the worker thread ends.
      const bytes = guidBytes(guid);
      registrations.push({
        name: `the power setting ${guid}`,
        register: (handle, done) => registerSetting.async(bytes, DEVICE_NOTIFY_CALLBACK, recipient, handle, done),
        unregister: (handle) => unregisterSetting.async(handle, () => undefined),
      });
    }
  } catch (error) {
    log(`The power events: the power settings did not register (${error instanceof Error ? error.message : String(error)}).`);
  }
  try {
    const suspend = koffi.register((_context: unknown, type: number): number => {
      give(suspendEvent(type));
      return 0;
    }, koffi.pointer(DeviceNotify));
    callbacks.push(suspend);
    const recipient = subscribeParameters(suspend);
    memory.push(recipient);
    const registerSuspend = powrprof.func("uint32 __stdcall PowerRegisterSuspendResumeNotification(uint32 flags, void *recipient, _Out_ void **handle)");
    const unregisterSuspend = powrprof.func("uint32 __stdcall PowerUnregisterSuspendResumeNotification(void *handle)");
    registrations.push({
      name: "the sleep and the wake",
      register: (handle, done) => registerSuspend.async(DEVICE_NOTIFY_CALLBACK, recipient, handle, done),
      unregister: (handle) => unregisterSuspend.async(handle, () => undefined),
    });
  } catch (error) {
    log(`The power events: the sleep and the wake did not register (${error instanceof Error ? error.message : String(error)}).`);
  }
  try {
    const mode = koffi.register((value: number): void => give(modeEvent(value)), koffi.pointer(EffectiveMode));
    callbacks.push(mode);
    const registerMode = powrprof.func(
      "int32 __stdcall PowerRegisterForEffectivePowerModeNotifications(uint32 version, HEADROOM_EFFECTIVE_POWER_MODE_CALLBACK *callback, void *context, _Out_ void **handle)",
    );
    const unregisterMode = powrprof.func("int32 __stdcall PowerUnregisterFromEffectivePowerModeNotifications(void *handle)");
    registrations.push({
      name: "the power mode",
      register: (handle, done) => registerMode.async(EFFECTIVE_POWER_MODE_V2, mode, null, handle, done),
      unregister: (handle) => unregisterMode.async(handle, () => undefined),
    });
  } catch (error) {
    log(`The power events: the power mode did not register (${error instanceof Error ? error.message : String(error)}).`);
  }

  let stopped = false;
  const handles: { readonly registration: Registration; readonly handle: unknown }[] = [];
  for (const registration of registrations) {
    const out: unknown[] = [null];
    registration.register(out, (error, status) => {
      if (error || status !== 0 || out[0] === null || out[0] === undefined) {
        const detail = error instanceof Error ? error.message : `status 0x${(Number(status) >>> 0).toString(16)}`;
        log(`The power events: ${registration.name} did not register (${detail}). The sample every 10 seconds continues.`);
        return;
      }
      if (stopped) registration.unregister(out[0]);
      else handles.push({ registration, handle: out[0] });
    });
  }
  return () => {
    if (stopped) return;
    stopped = true;
    for (const { registration, handle } of handles) registration.unregister(handle);
    // The callbacks and their memory stay for the life of the process: an event can be on its way during the unregistration.
    void callbacks;
    void memory;
  };
}

const POWER_REQUEST_CONTEXT_VERSION = 0;
const POWER_REQUEST_CONTEXT_SIMPLE_STRING = 0x1;
const POWER_REQUEST_SYSTEM_REQUIRED = 1;
/** `REASON_CONTEXT` on 64-bit Windows: the version, the flags and the union of 24 bytes. */
const REASON_CONTEXT_SIZE = 32;
const createRequest = kernel32.func("intptr_t __stdcall PowerCreateRequest(_In_ uint8_t *context)");
const setRequest = kernel32.func("int __stdcall PowerSetRequest(intptr_t request, int32 type)");
const clearRequest = kernel32.func("int __stdcall PowerClearRequest(intptr_t request, int32 type)");
const closeHandle = kernel32.func("int __stdcall CloseHandle(intptr_t handle)");

/** The power request that keeps the computer awake, with its reason, or `null`. */
let request: { readonly handle: number; readonly reason: string } | null = null;

/** This function makes a power request with a reason and sets it, or gives `null` when Windows refuses it. */
function createPowerRequest(reason: string): { readonly handle: number; readonly reason: string } | null {
  const text = Buffer.from(`${reason}\0`, "utf16le");
  const context = Buffer.alloc(REASON_CONTEXT_SIZE);
  context.writeUInt32LE(POWER_REQUEST_CONTEXT_VERSION, 0);
  context.writeUInt32LE(POWER_REQUEST_CONTEXT_SIMPLE_STRING, 4);
  context.writeBigUInt64LE(koffi.address(text), 8);
  // Windows copies the reason when it makes the request.
  const handle = Number(createRequest(context));
  if (handle === 0 || handle === -1) return null;
  if (setRequest(handle, POWER_REQUEST_SYSTEM_REQUIRED) === 0) {
    closeHandle(handle);
    return null;
  }
  return { handle, reason };
}

/**
 * This function holds one power request (`PowerRequestSystemRequired`) with a reason, or ends it with `null`. A new reason
 * makes a new request, because a request keeps the reason of its start. A closed lid still puts the laptop to sleep.
 */
export function keepAwake(reason: string | null): void {
  if ((request?.reason ?? null) === reason) return;
  const next = reason === null ? null : createPowerRequest(reason);
  if (request !== null) {
    clearRequest(request.handle, POWER_REQUEST_SYSTEM_REQUIRED);
    closeHandle(request.handle);
  }
  request = next;
}

/** This function ends the power request and closes the query of the Energy Meter. */
export function closePower(): void {
  keepAwake(null);
  closeMeters();
}
