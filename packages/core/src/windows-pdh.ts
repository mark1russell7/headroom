/**
 * The one PDH query of the daemon (H30, H35, H36), through the FFI of koffi. It starts no process and no timer.
 *
 * - The query opens at the first read with all the counters of `PDH_COUNTERS`. A counter that Windows does not have stays out.
 * - Each read of the processes collects the query one time. A second reader in the same second uses the same collection.
 * - A rate needs two collections, for example the power of the Energy Meter and the use of a GPU engine.
 *
 * Only `windows-power.ts` and `windows-gpu.ts` import this file.
 */

import koffi, { type LibraryHandle } from "koffi";
import type { CounterItem } from "./thermal.ts";

/** The counters of the query, by name. The English names work in each language of Windows. */
export const PDH_COUNTERS = {
  /** The power of each meter, in mW (H30). */
  meters: "\\Energy Meter(*)\\Power",
  /** The part of the speed that a power or heat limit takes, in percent (H35). One value. */
  performanceLimit: "\\Processor Information(_Total)\\% Performance Limit",
  /** The speed of the CPU, in percent of the nominal speed. One value, and a rate. */
  performance: "\\Processor Information(_Total)\\% Processor Performance",
  /** The nominal frequency of the CPU, in MHz. One value. */
  frequency: "\\Processor Information(_Total)\\Processor Frequency",
  /** The temperature of each thermal zone, in kelvin. */
  temperature: "\\Thermal Zone Information(*)\\Temperature",
  /** The passive limit of each thermal zone, in percent. */
  passiveLimit: "\\Thermal Zone Information(*)\\% Passive Limit",
  /** The throttle reasons of each thermal zone. */
  throttleReasons: "\\Thermal Zone Information(*)\\Throttle Reasons",
  /** The used dedicated memory of each GPU adapter, in bytes (H36). */
  gpuAdapterDedicated: "\\GPU Adapter Memory(*)\\Dedicated Usage",
  /** The used shared memory of each GPU adapter, in bytes. */
  gpuAdapterShared: "\\GPU Adapter Memory(*)\\Shared Usage",
  /** The dedicated GPU memory of each process on each adapter, in bytes. */
  gpuProcessDedicated: "\\GPU Process Memory(*)\\Dedicated Usage",
  /** The shared GPU memory of each process on each adapter, in bytes. */
  gpuProcessShared: "\\GPU Process Memory(*)\\Shared Usage",
  /** The use of each engine of each process, in percent. */
  gpuEngines: "\\GPU Engine(*)\\Utilization Percentage",
} as const;

/** The name of a counter of the query. */
export type PdhCounterName = keyof typeof PDH_COUNTERS;

/** `PDH_FMT_DOUBLE` and `PDH_FMT_NOCAP100`: a value above 100 stays as it is. */
const PDH_FORMAT = 0x200 | 0x8000;
const PDH_MORE_DATA = 0x8000_07d2;
/** `PDH_FMT_COUNTERVALUE_ITEM_W` on 64-bit Windows: the name pointer, the status and its padding, and the double. */
const ITEM_SIZE = 24;
const ITEM_STATUS = 8;
const ITEM_VALUE = 16;
/** `PDH_CSTATUS_VALID_DATA` and `PDH_CSTATUS_NEW_DATA`. */
const VALID_STATUS: ReadonlySet<number> = new Set([0, 1]);
/** `PDH_FMT_COUNTERVALUE` on 64-bit Windows: the status and its padding, and the double. */
const VALUE_SIZE = 16;
const VALUE_DOUBLE = 8;
/** A reader in this time after a collection uses that collection. */
const FRESH_MS = 1000;

/** A function of a library of Windows. */
type NativeFunction = ReturnType<LibraryHandle["func"]>;

/** The query, with its counters and the functions of PDH. */
interface Query {
  readonly query: unknown;
  readonly counters: ReadonlyMap<PdhCounterName, unknown>;
  readonly collect: NativeFunction;
  readonly array: NativeFunction;
  readonly value: NativeFunction;
  readonly close: NativeFunction;
  /** The count of good collections. A rate needs 2. */
  collections: number;
  /** The time of the last collection, from `performance.now()`, and its result. */
  collectedAt: number;
  collected: boolean;
}

/** The query: `undefined` before the first read, `null` when PDH or all the counters are absent. */
let shared: Query | null | undefined;
let buffer = Buffer.alloc(8192);
const valueBuffer = Buffer.alloc(VALUE_SIZE);

/** This function opens the query with each counter of `PDH_COUNTERS`, or gives `null` when PDH or all the counters are absent. */
function open(): Query | null {
  try {
    const pdh = koffi.load("pdh.dll");
    const openQuery = pdh.func("uint32 __stdcall PdhOpenQueryW(const char16_t *source, uintptr_t data, _Out_ void **query)");
    const add = pdh.func("uint32 __stdcall PdhAddEnglishCounterW(void *query, const char16_t *path, uintptr_t data, _Out_ void **counter)");
    const collect = pdh.func("uint32 __stdcall PdhCollectQueryData(void *query)");
    const array = pdh.func(
      "uint32 __stdcall PdhGetFormattedCounterArrayW(void *counter, uint32 format, _Inout_ uint32 *size, _Out_ uint32 *count, _Out_ uint8_t *buffer)",
    );
    const value = pdh.func("uint32 __stdcall PdhGetFormattedCounterValue(void *counter, uint32 format, uint32 *type, _Out_ uint8_t *value)");
    const close = pdh.func("uint32 __stdcall PdhCloseQuery(void *query)");
    const query: unknown[] = [null];
    if (openQuery(null, 0, query) !== 0) return null;
    const counters = new Map<PdhCounterName, unknown>();
    for (const [name, path] of Object.entries(PDH_COUNTERS) as [PdhCounterName, string][]) {
      const counter: unknown[] = [null];
      if (add(query[0], path, 0, counter) === 0) counters.set(name, counter[0]);
    }
    if (counters.size === 0) {
      close(query[0]);
      return null;
    }
    return { query: query[0], counters, collect, array, value, close, collections: 0, collectedAt: Number.NEGATIVE_INFINITY, collected: false };
  } catch {
    return null;
  }
}

/** This function opens the query at the first read. */
function query(): Query | null {
  if (shared === undefined) shared = open();
  return shared;
}

/**
 * This function collects the query, at most one time in one second. It gives the count of good collections, or 0 when
 * the query is absent or the collection failed. A rate needs a count of 2 or more.
 */
export function collectPdh(now: number = performance.now()): number {
  const open = query();
  if (open === null) return 0;
  if (now - open.collectedAt >= FRESH_MS) {
    open.collectedAt = now;
    open.collected = open.collect(open.query) === 0;
    if (open.collected) open.collections += 1;
  }
  return open.collected ? open.collections : 0;
}

/** This function reads a string of UTF-16 code units that ends with 0, from an offset in a buffer. */
function wideAt(from: Buffer, offset: number): string {
  if (offset < 0 || offset >= from.length) return "";
  let end = offset;
  while (end + 1 < from.length && from.readUInt16LE(end) !== 0) end += 2;
  return from.toString("utf16le", offset, end);
}

/**
 * This function gives the items of one counter from the last collection, or `null` when the query has no such counter or
 * the read failed. The items with no valid data are absent. With `skipZero`, the items with the value 0 are absent too,
 * so the read decodes fewer names. The names point into the buffer of the read.
 */
export function pdhItems(name: PdhCounterName, skipZero = false): CounterItem[] | null {
  const open = shared;
  const counter = open?.counters.get(name);
  if (open === null || open === undefined || counter === undefined || !open.collected) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const size = [buffer.length];
    const count = [0];
    const status = Number(open.array(counter, PDH_FORMAT, size, count, buffer)) >>> 0;
    if (status === PDH_MORE_DATA) {
      buffer = Buffer.alloc((size[0] ?? buffer.length) + 1024);
      continue;
    }
    if (status !== 0) return null;
    const base = koffi.address(buffer);
    const items: CounterItem[] = [];
    for (let index = 0; index < (count[0] ?? 0); index++) {
      const at = index * ITEM_SIZE;
      if (at + ITEM_SIZE > buffer.length) break;
      if (!VALID_STATUS.has(buffer.readUInt32LE(at + ITEM_STATUS))) continue;
      const value = buffer.readDoubleLE(at + ITEM_VALUE);
      if (skipZero && value === 0) continue;
      const item = wideAt(buffer, Number(buffer.readBigUInt64LE(at) - base));
      if (item !== "") items.push({ name: item, value });
    }
    return items;
  }
  return null;
}

/**
 * This function gives the value of a counter with one instance from the last collection. It gives `null` when the query
 * has no such counter, or the counter has no valid value.
 */
export function pdhValue(name: PdhCounterName): number | null {
  const open = shared;
  const counter = open?.counters.get(name);
  if (open === null || open === undefined || counter === undefined || !open.collected) return null;
  const status = Number(open.value(counter, PDH_FORMAT, null, valueBuffer)) >>> 0;
  if (status !== 0 || !VALID_STATUS.has(valueBuffer.readUInt32LE(0))) return null;
  return valueBuffer.readDoubleLE(VALUE_DOUBLE);
}

/** This function closes the query. The next read opens it again. */
export function closePdh(): void {
  if (shared) shared.close(shared.query);
  shared = undefined;
}
