/**
 * The battery and the power of the computer (H30). This file has no FFI, so the tests use fixed reads.
 *
 * - The battery: `CallNtPowerInformation(SystemBatteryState)` gives the power source, the charge and the rate.
 * - The power: the counter set "Energy Meter" gives the power of the computer, of the processors and of the GPU.
 * - Windows has no energy counter for each process without admin rights. The power of an owner is an estimate: the power of
 *   the processors times the part of the processor time of the owner.
 * - The power events: the power source, the charge, the lid, the power mode, and the sleep and the wake.
 * - Efficiency mode: on battery, the client of `headroom run` puts the processes of its job in EcoQoS.
 * - Keep awake: on AC power, while a lease runs, the daemon keeps the computer out of sleep.
 */

import type { OwnerCores } from "./counters.ts";
import { GUID_SESSION_DISPLAY_STATUS, GUID_SESSION_USER_PRESENCE, sessionEvent, type PresenceEvent } from "./presence.ts";
import type { BatteryRead, OwnerKind, PowerMeters } from "./types.ts";

/** The effective power mode of Windows, in the order of `EFFECTIVE_POWER_MODE`. */
export type PowerMode = "battery saver" | "better battery" | "balanced" | "high performance" | "max performance" | "game mode" | "mixed reality";

/** The power modes by their value in `EFFECTIVE_POWER_MODE`. */
export const POWER_MODES: readonly PowerMode[] = ["battery saver", "better battery", "balanced", "high performance", "max performance", "game mode", "mixed reality"];

/**
 * One power event of Windows (H30). The handler of an event only sets the state and asks for a sample. The user presence
 * and the display of the session (H33) come through the same power settings.
 */
export type PowerEvent =
  | { readonly type: "source"; readonly ac: boolean }
  | { readonly type: "percent"; readonly percent: number }
  | { readonly type: "lid"; readonly open: boolean }
  | { readonly type: "mode"; readonly mode: PowerMode }
  | { readonly type: "suspend" }
  | { readonly type: "resume" }
  | PresenceEvent;

/** `GUID_ACDC_POWER_SOURCE`: the power source changed. The data is 0 for AC, 1 for the battery and 2 for a UPS. */
export const GUID_ACDC_POWER_SOURCE = "5d3e9a59-e9d5-4b00-a6bd-ff34ff516548";
/** `GUID_BATTERY_PERCENTAGE_REMAINING`: the charge changed. The data is the percent, from 0 to 100. */
export const GUID_BATTERY_PERCENTAGE_REMAINING = "a7ad8041-b45a-4cae-87a3-eecbb468a9e1";
/** `GUID_LIDSWITCH_STATE_CHANGE`: the lid opened or closed. The data is 0 for closed and 1 for open. */
export const GUID_LIDSWITCH_STATE_CHANGE = "ba3e0f4d-b817-4094-a2d1-d56379e6a0f3";
/** The power settings that the daemon watches: the power source, the charge, the lid, and the user presence and the display (H33). */
export const POWER_SETTINGS: readonly string[] = [
  GUID_ACDC_POWER_SOURCE,
  GUID_BATTERY_PERCENTAGE_REMAINING,
  GUID_LIDSWITCH_STATE_CHANGE,
  GUID_SESSION_USER_PRESENCE,
  GUID_SESSION_DISPLAY_STATUS,
];

/** The suspend event of `PowerRegisterSuspendResumeNotification`: `PBT_APMSUSPEND`. */
export const PBT_APMSUSPEND = 4;
/** The resume event after a sleep that a person started: `PBT_APMRESUMESUSPEND`. */
export const PBT_APMRESUMESUSPEND = 7;
/** The resume event after each sleep: `PBT_APMRESUMEAUTOMATIC`. */
export const PBT_APMRESUMEAUTOMATIC = 18;

/**
 * This function gives the 16 bytes of a GUID from its text. The first three groups are little-endian numbers, and the
 * last two groups are bytes in their order.
 */
export function guidBytes(text: string): Buffer {
  const hex = text.replace(/[{}-]/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new RangeError(`${text} is not a GUID`);
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(Number.parseInt(hex.slice(0, 8), 16), 0);
  bytes.writeUInt16LE(Number.parseInt(hex.slice(8, 12), 16), 4);
  bytes.writeUInt16LE(Number.parseInt(hex.slice(12, 16), 16), 6);
  Buffer.from(hex.slice(16), "hex").copy(bytes, 8);
  return bytes;
}

/** This function gives the text of a GUID in lower case from its 16 bytes. */
export function guidText(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, 16);
  const hex = (value: number, digits: number): string => value.toString(16).padStart(digits, "0");
  const tail = buffer.subarray(8, 16).toString("hex");
  return `${hex(buffer.readUInt32LE(0), 8)}-${hex(buffer.readUInt16LE(4), 4)}-${hex(buffer.readUInt16LE(6), 4)}-${tail.slice(0, 4)}-${tail.slice(4)}`;
}

/** This function gives the event of a change of a power setting, or `null` for a setting that headroom does not watch. */
export function settingEvent(guid: string, value: number): PowerEvent | null {
  switch (guid.toLowerCase()) {
    case GUID_ACDC_POWER_SOURCE:
      // A UPS (2) is not the battery of the laptop, so only 1 is the battery.
      return { type: "source", ac: value !== 1 };
    case GUID_BATTERY_PERCENTAGE_REMAINING:
      return { type: "percent", percent: Math.max(0, Math.min(100, value)) };
    case GUID_LIDSWITCH_STATE_CHANGE:
      return { type: "lid", open: value !== 0 };
    default:
      return sessionEvent(guid, value);
  }
}

/** This function gives the event of a suspend or resume notification, or `null` for another notification. */
export function suspendEvent(type: number): PowerEvent | null {
  if (type === PBT_APMSUSPEND) return { type: "suspend" };
  if (type === PBT_APMRESUMESUSPEND || type === PBT_APMRESUMEAUTOMATIC) return { type: "resume" };
  return null;
}

/** This function gives the event of an effective power mode, or `null` for a mode that headroom does not know. */
export function modeEvent(mode: number): PowerEvent | null {
  const name = POWER_MODES[mode];
  return name === undefined ? null : { type: "mode", mode: name };
}

/** The size of `SYSTEM_BATTERY_STATE`. */
export const BATTERY_STATE_SIZE = 32;
/** `BATTERY_UNKNOWN_TIME` and `BATTERY_UNKNOWN_RATE`. */
const UNKNOWN_TIME = 0xffff_ffff;
const UNKNOWN_RATE = -0x8000_0000;

/**
 * This function reads a `SYSTEM_BATTERY_STATE`: 4 flags (AC, battery, charging, discharging), 3 spare bytes and a tag.
 * Then come the full capacity and the charge in mWh, the rate in mW and the time left in seconds. A negative rate discharges.
 * It gives `null` without a battery.
 */
export function parseBatteryState(buffer: Buffer): BatteryRead | null {
  if (buffer.length < 24) return null;
  const present = buffer.readUInt8(1) !== 0;
  const maxMwh = buffer.readUInt32LE(8);
  if (!present || maxMwh === 0) return null;
  const rate = buffer.readInt32LE(16);
  const seconds = buffer.readUInt32LE(20);
  return {
    ac: buffer.readUInt8(0) !== 0,
    charging: buffer.readUInt8(2) !== 0,
    discharging: buffer.readUInt8(3) !== 0,
    maxMwh,
    remainingMwh: Math.min(buffer.readUInt32LE(12), maxMwh),
    rateMw: rate === UNKNOWN_RATE ? null : rate,
    estimatedSeconds: seconds === UNKNOWN_TIME || seconds === 0 ? null : seconds,
  };
}

/**
 * This function gives the meters of the counter set "Energy Meter" in W from the values in mW, by instance name. It
 * skips the meter of each core, because the sum of the package has them, and the instance `_Total`.
 */
export function parseMeters(items: readonly { readonly name: string; readonly milliwatts: number }[]): PowerMeters {
  const meters: Record<string, number> = {};
  for (const { name, milliwatts } of items) {
    if (!Number.isFinite(milliwatts) || milliwatts < 0 || /_core$/i.test(name) || name.toLowerCase() === "_total") continue;
    meters[name.toLowerCase()] = Math.round(milliwatts) / 1000;
  }
  return meters;
}

/** This function gives the power of the whole computer in W from the meter `system power`, or `null` without it. */
export function systemWatts(meters: PowerMeters | undefined): number | null {
  return meters?.["system power"] ?? null;
}

/** This function gives the power of the processors in W: the meter `cpu power`, else the package of RAPL, else `null`. */
export function cpuWatts(meters: PowerMeters | undefined): number | null {
  return meters?.["cpu power"] ?? meters?.["rapl_package0_pkg"] ?? null;
}

/** The state of the battery at one read, for a person. `Measurement.battery` gives it. */
export interface BatteryState {
  /** True: the computer runs on AC power. False: it runs on its battery. */
  readonly ac: boolean;
  readonly charging: boolean;
  /** The charge, from 0 to 100. */
  readonly percent: number;
  /** The rate of the battery in W: negative while it discharges, positive while it charges. It is `null` when Windows does not know it. */
  readonly rateW: number | null;
  /** The minutes left on battery, or `null` on AC power or when Windows does not know it. */
  readonly minutesLeft: number | null;
}

/** This function gives the state of the battery for a person from a read. Windows gives the time left, else the charge and the rate give it. */
export function batteryState(read: BatteryRead): BatteryState {
  const percent = Math.max(0, Math.min(100, Math.round((read.remainingMwh / read.maxMwh) * 100)));
  const rateW = read.rateMw === null ? null : Math.round(read.rateMw / 100) / 10;
  let minutesLeft: number | null = null;
  if (!read.ac) {
    if (read.estimatedSeconds !== null) minutesLeft = Math.round(read.estimatedSeconds / 60);
    else if (read.rateMw !== null && read.rateMw < 0) minutesLeft = Math.round((read.remainingMwh / -read.rateMw) * 60);
  }
  return { ac: read.ac, charging: read.charging, percent, rateW, minutesLeft };
}

/** This function writes minutes for a person: "25 min", "2 h" or "1 h 58 min". */
export function minutesText(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} min`;
  const rest = total % 60;
  return rest === 0 ? `${Math.floor(total / 60)} h` : `${Math.floor(total / 60)} h ${rest} min`;
}

/** This function writes a power in W with one decimal: "18.0 W". */
export function wattsText(watts: number): string {
  return `${Math.abs(watts).toFixed(1)} W`;
}

/**
 * This function gives the parts of the text of a battery, for example "on battery", "68%", "18.0 W" and "1 h 58 min left",
 * or "plugged in", "charging" and "92%".
 */
export function batteryParts(state: BatteryState): string[] {
  if (state.ac) return ["plugged in", ...(state.charging ? ["charging"] : []), `${state.percent}%`];
  const parts = ["on battery", `${state.percent}%`];
  if (state.rateW !== null && state.rateW !== 0) parts.push(wattsText(state.rateW));
  if (state.minutesLeft !== null) parts.push(`${minutesText(state.minutesLeft)} left`);
  return parts;
}

/** The power of one owner in W: an estimate from the power of the processors and the processor time of the owner. */
export interface OwnerWatts {
  readonly owner: string;
  readonly kind: OwnerKind;
  readonly watts: number;
}

/**
 * This function gives the power of each owner, the largest first. It is an estimate: the power of the processors times
 * the part of the cores of the owner. Windows gives no energy counter for each process without admin rights.
 */
export function powerOwners(cores: readonly OwnerCores[] | undefined, cpuW: number | null): OwnerWatts[] {
  if (cores === undefined || cpuW === null) return [];
  const total = cores.reduce((sum, each) => sum + each.cores, 0);
  if (total <= 0) return [];
  return cores
    .map((each) => ({ owner: each.owner, kind: each.kind, watts: (cpuW * each.cores) / total }))
    .filter((each) => each.watts > 0)
    .sort((a, b) => b.watts - a.watts);
}

/** This function writes the owners with the most power, for example "session:graph 3.1 W, docker 1.0 W", or "" when none uses 0.1 W. */
export function ownersWattsText(owners: readonly { readonly owner: string; readonly watts: number }[], limit = 3): string {
  return owners
    .filter((each) => each.watts >= 0.1)
    .slice(0, limit)
    .map((each) => `${each.owner} ${wattsText(each.watts)}`)
    .join(", ");
}

/**
 * This function gives the reason of the power request that keeps the computer awake, or `null` for no request. A request
 * holds only on AC power and while a lease is granted. A computer with no battery read counts as on AC power.
 */
export function keepAwakeReason(ac: boolean | null, jobs: number): string | null {
  if (ac === false || jobs <= 0) return null;
  return `headroom: ${jobs} ${jobs === 1 ? "job runs" : "jobs run"}`;
}

/** The power state of the computer (H30). `Status.power` gives it. */
export interface PowerStatus {
  /** True on AC power, false on battery. It is `null` when headroom has no battery read and no event of the power source. */
  readonly ac: boolean | null;
  /** The effective power mode of Windows, from its event, or `null` before the first event. */
  readonly powerMode: PowerMode | null;
  /** True: the lid is open. It is `null` on a computer with no lid, or before the first event. */
  readonly lidOpen: boolean | null;
  /** True: the clients of `headroom run` put their jobs in efficiency mode (EcoQoS), because the computer runs on battery. */
  readonly eco: boolean;
  /** The reason of the power request that keeps the computer awake, or `null` without a request. */
  readonly keepAwake: string | null;
  /** The last sleep that the daemon saw, with its start and its end, or `null` before the first sleep. */
  readonly lastSleep: { readonly from: number; readonly to: number } | null;
}

/** The power state before the first read and the first event. */
export const NO_POWER: PowerStatus = { ac: null, powerMode: null, lidOpen: null, eco: false, keepAwake: null, lastSleep: null };

/** The parts of a resource status that `powerLine()` reads. */
interface PowerLineResource {
  readonly id: string;
  readonly used: number | null;
  readonly battery?: BatteryState | undefined;
  readonly owners: readonly { readonly owner: string; readonly value: number }[];
}

/**
 * This function gives the line of `headroom status`, for example "Power: on battery, 68%, 18.0 W, 1 h 58 min left (power mode:
 * balanced). Most (estimate): session:graph 3.1 W." It gives `null` with no battery and no Energy Meter.
 */
export function powerLine(resources: readonly PowerLineResource[], power: PowerStatus | undefined): string | null {
  const battery = resources.find((each) => each.id === "battery")?.battery;
  const draw = resources.find((each) => each.id === "power");
  if (battery === undefined && draw === undefined) return null;
  const parts = battery === undefined ? [] : batteryParts(battery);
  // On battery, the rate of the battery gives the power. On AC power, the Energy Meter gives it.
  if (draw?.used != null && (battery === undefined || battery.ac)) parts.push(wattsText(draw.used));
  const mode = power?.powerMode == null ? "" : ` (power mode: ${power.powerMode})`;
  const most = ownersWattsText((draw?.owners ?? []).map((each) => ({ owner: each.owner, watts: each.value })));
  return `Power: ${parts.join(", ")}${mode}.${most === "" ? "" : ` Most (estimate): ${most}.`}`;
}

/**
 * The efficiency mode of the processes of one job (H30), in the client of `headroom run`. The client gives it the state
 * from the daemon and the processes of its job object at each heartbeat. It changes only the processes that need a change.
 */
export class EcoTracker {
  /** The processes in efficiency mode. A process that left the job leaves the set. */
  readonly #applied = new Set<number>();
  #on = false;

  /** True: the last update asked for efficiency mode. */
  get on(): boolean {
    return this.#on;
  }

  /**
   * This function puts the processes in efficiency mode, or takes them out of it. `set` changes one process and tells if
   * the change worked. It gives the count of processes that changed.
   */
  update(on: boolean, pids: readonly number[], set: (pid: number, on: boolean) => boolean): number {
    const live = new Set(pids);
    for (const pid of this.#applied) if (!live.has(pid)) this.#applied.delete(pid);
    let changed = 0;
    if (on) {
      for (const pid of pids) {
        if (this.#applied.has(pid) || !set(pid, true)) continue;
        this.#applied.add(pid);
        changed += 1;
      }
    } else {
      for (const pid of this.#applied) if (set(pid, false)) changed += 1;
      this.#applied.clear();
    }
    this.#on = on;
    return changed;
  }
}
