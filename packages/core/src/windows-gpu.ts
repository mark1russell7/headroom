/**
 * The GPU of Windows (H36), through the FFI of koffi. It starts no process and no timer.
 *
 * - The PDH query of `windows-pdh.ts` gives the GPU memory of each adapter and of each process, and the use of each engine.
 * - DXGI gives the name and the memory limits of each adapter, one time at the first read. `IDXGIAdapter1::GetDesc1`
 *   gives the dedicated memory and the shared limit. `IDXGIAdapter3::QueryVideoMemoryInfo` gives the budget for one process.
 *
 * Only `windows.ts` imports this file.
 */

import koffi from "koffi";
import type { GpuAdapterInfo, GpuSample } from "./gpu.ts";
import { collectPdh, pdhItems } from "./windows-pdh.ts";

/** The COM methods of DXGI that the read calls. Each name is new in the process, because koffi registers each name once. */
const EnumAdapters1 = koffi.proto("int32 __stdcall HEADROOM_DXGI_ENUM_ADAPTERS1(void *self, uint32 index, _Out_ void **adapter)");
const GetDesc1 = koffi.proto("int32 __stdcall HEADROOM_DXGI_GET_DESC1(void *self, _Out_ uint8_t *desc)");
const QueryInterface = koffi.proto("int32 __stdcall HEADROOM_DXGI_QUERY_INTERFACE(void *self, const uint8_t *riid, _Out_ void **object)");
const QueryVideoMemoryInfo = koffi.proto("int32 __stdcall HEADROOM_DXGI_QUERY_VIDEO_MEMORY_INFO(void *self, uint32 node, int32 group, _Out_ uint8_t *info)");
const Release = koffi.proto("uint32 __stdcall HEADROOM_DXGI_RELEASE(void *self)");

/** The places of the methods in the tables of the COM interfaces. */
const RELEASE = 2;
const QUERY_INTERFACE = 0;
const ENUM_ADAPTERS1 = 12;
const GET_DESC1 = 10;
const QUERY_VIDEO_MEMORY_INFO = 14;

/** `DXGI_ADAPTER_DESC1` on 64-bit Windows: the description, 4 IDs, 3 sizes, the LUID and the flags. */
const DESC1_SIZE = 312;
const DESC1_NAME_BYTES = 256;
const DESC1_DEDICATED_VIDEO = 272;
const DESC1_DEDICATED_SYSTEM = 280;
const DESC1_SHARED_SYSTEM = 288;
const DESC1_LUID_LOW = 296;
const DESC1_LUID_HIGH = 300;
const DESC1_FLAGS = 304;
const DXGI_ADAPTER_FLAG_SOFTWARE = 2;
/** `DXGI_QUERY_VIDEO_MEMORY_INFO`: the budget, the use, and two more sizes. */
const MEMORY_INFO_SIZE = 32;
/** The groups of memory segments: local and non-local. A GPU that uses the main memory has only the local group. */
const SEGMENT_GROUPS = [0, 1] as const;
/** The adapters that the read examines at most. */
const MAX_ADAPTERS = 16;
const BYTES_PER_MB = 1024 * 1024;

/** This function gives the bytes of a GUID in the order of Windows. */
function guid(text: string): Buffer {
  const hex = text.replaceAll("-", "");
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(Number.parseInt(hex.slice(0, 8), 16), 0);
  bytes.writeUInt16LE(Number.parseInt(hex.slice(8, 12), 16), 4);
  bytes.writeUInt16LE(Number.parseInt(hex.slice(12, 16), 16), 6);
  Buffer.from(hex.slice(16), "hex").copy(bytes, 8);
  return bytes;
}

const IID_IDXGI_FACTORY1 = guid("770aae78-f26f-4dba-a829-253c83d1b387");
const IID_IDXGI_ADAPTER3 = guid("645967a4-1392-4310-a798-8053ce3e93fd");

/** This function gives the address of a method of a COM object from the table of the object. */
function method(object: unknown, index: number): unknown {
  return koffi.decode(koffi.decode(object, "void *"), index * 8, "void *");
}

/** This function releases a COM object. */
function release(object: unknown): void {
  koffi.call(method(object, RELEASE), Release, object);
}

/** This function gives the LUID in the form of the counter names, in lowercase: `0x00000000_0x0001665f`. */
export function luidText(high: number, low: number): string {
  return `0x${(high >>> 0).toString(16).padStart(8, "0")}_0x${(low >>> 0).toString(16).padStart(8, "0")}`;
}

/** This function gives the budget of DXGI for one process on an adapter, in MB, or `null` when the adapter has no `IDXGIAdapter3`. */
function budgetOf(adapter: unknown): number | null {
  const third: unknown[] = [null];
  if (koffi.call(method(adapter, QUERY_INTERFACE), QueryInterface, adapter, IID_IDXGI_ADAPTER3, third) !== 0) return null;
  try {
    let bytes = 0;
    for (const group of SEGMENT_GROUPS) {
      const info = Buffer.alloc(MEMORY_INFO_SIZE);
      if (koffi.call(method(third[0], QUERY_VIDEO_MEMORY_INFO), QueryVideoMemoryInfo, third[0], 0, group, info) !== 0) return null;
      bytes += Number(info.readBigUInt64LE(0));
    }
    return Math.round(bytes / BYTES_PER_MB);
  } finally {
    release(third[0]);
  }
}

/**
 * This function reads the adapters of DXGI: the name, the LUID, the memory limits and the budget of each adapter. It gives
 * `null` when DXGI is absent or the read fails. On this computer on 2026-10-25, the read took 12 ms.
 */
export function readDxgiAdapters(): GpuAdapterInfo[] | null {
  try {
    const dxgi = koffi.load("dxgi.dll");
    const createFactory = dxgi.func("int32 __stdcall CreateDXGIFactory1(const uint8_t *riid, _Out_ void **factory)");
    const factory: unknown[] = [null];
    if (createFactory(IID_IDXGI_FACTORY1, factory) !== 0) return null;
    const adapters: GpuAdapterInfo[] = [];
    try {
      for (let index = 0; index < MAX_ADAPTERS; index++) {
        const adapter: unknown[] = [null];
        if (koffi.call(method(factory[0], ENUM_ADAPTERS1), EnumAdapters1, factory[0], index, adapter) !== 0) break;
        try {
          const desc = Buffer.alloc(DESC1_SIZE);
          if (koffi.call(method(adapter[0], GET_DESC1), GetDesc1, adapter[0], desc) !== 0) continue;
          const name = desc.toString("utf16le", 0, DESC1_NAME_BYTES);
          const end = name.indexOf("\0");
          adapters.push({
            luid: luidText(desc.readInt32LE(DESC1_LUID_HIGH), desc.readUInt32LE(DESC1_LUID_LOW)),
            index,
            name: (end < 0 ? name : name.slice(0, end)).trim(),
            dedicatedMb: Math.round((Number(desc.readBigUInt64LE(DESC1_DEDICATED_VIDEO)) + Number(desc.readBigUInt64LE(DESC1_DEDICATED_SYSTEM))) / BYTES_PER_MB),
            sharedMb: Math.round(Number(desc.readBigUInt64LE(DESC1_SHARED_SYSTEM)) / BYTES_PER_MB),
            budgetMb: budgetOf(adapter[0]),
            software: (desc.readUInt32LE(DESC1_FLAGS) & DXGI_ADAPTER_FLAG_SOFTWARE) !== 0,
          });
        } finally {
          release(adapter[0]);
        }
      }
    } finally {
      release(factory[0]);
    }
    return adapters;
  } catch {
    return null;
  }
}

/** The adapters of DXGI: `undefined` before the first read. The limits do not change while Windows runs. */
let adapters: readonly GpuAdapterInfo[] | null | undefined;

/**
 * This function reads the GPU counters from the collection of this read of the processes. It gives `null` on a computer
 * with no GPU counters and when the read fails. The use of the engines is a rate, so the first collection gives none.
 */
export function readGpu(): GpuSample | null {
  const collections = collectPdh();
  if (collections === 0) return null;
  const adapterDedicated = pdhItems("gpuAdapterDedicated");
  const adapterShared = pdhItems("gpuAdapterShared");
  if (adapterDedicated === null && adapterShared === null) return null;
  if (adapters === undefined) adapters = readDxgiAdapters();
  return {
    counters: {
      adapterDedicated,
      adapterShared,
      processDedicated: pdhItems("gpuProcessDedicated", true),
      processShared: pdhItems("gpuProcessShared", true),
      // Most engines are idle, so the read skips the zeros and decodes fewer names.
      engines: collections < 2 ? null : pdhItems("gpuEngines", true),
    },
    adapters,
  };
}
