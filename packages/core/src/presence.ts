/**
 * Keep room for Mark (H33). While Mark works at the laptop or is on a call, heavy jobs wait or run slower. When Mark steps
 * away, they run at full speed. This file has no FFI, so the tests use fixed reads.
 *
 * - The measure: the power events of the session give the user presence and the display. Each tick reads the time since
 *   the last input and the notification state of the shell. The consent store of the registry gives the camera and the microphone.
 * - One state: `present`, `busy` (a call, a presentation or a full-screen app) or `away`.
 * - Admit: while Mark is busy, a new heavy lease waits, for at most `busyWaitMs`. The condition `away` waits for Mark to leave.
 * - Enforce: while Mark is present or busy, heavy jobs run in efficiency mode, and the CPU reserve grows. While Mark is
 *   away, the reserve is 0.
 * - Privacy: the read of the consent store keeps only "a call is on". It keeps no name of an app.
 */

import type { Lease } from "./broker.ts";
import { heavyWhy, localClock } from "./conditions.ts";

/** The state of Mark at the laptop. */
export type PresenceState = "present" | "busy" | "away";

/** Why Mark is busy: a call, a presentation or a full-screen app. */
export type BusyKind = "call" | "presentation" | "full screen";

/** The state of the display of the session, from `GUID_SESSION_DISPLAY_STATUS`. */
export type DisplayState = "off" | "on" | "dimmed";

/** The devices of a call. The read keeps no name of an app. */
export type CallDevice = "camera" | "microphone" | "camera and microphone";

/** `GUID_SESSION_USER_PRESENCE`: the presence of the user of the session. The data is 0 for present and 2 for inactive. */
export const GUID_SESSION_USER_PRESENCE = "3c0f4548-c03f-4c4d-b9f2-237ede686376";
/** `GUID_SESSION_DISPLAY_STATUS`: the display of the session. The data is 0 for off, 1 for on and 2 for dimmed. */
export const GUID_SESSION_DISPLAY_STATUS = "2b84c20e-ad23-4ddf-93db-05ffbd7e4b0f";

/** `QUNS_NOT_PRESENT` of `SHQueryUserNotificationState`: the session is locked, or the screen saver runs. */
export const QUNS_NOT_PRESENT = 1;
/** `QUNS_BUSY`: a full-screen app runs. */
export const QUNS_BUSY = 2;
/** `QUNS_RUNNING_D3D_FULL_SCREEN`: a full-screen Direct3D app runs, for example a game. */
export const QUNS_RUNNING_D3D_FULL_SCREEN = 3;
/** `QUNS_PRESENTATION_MODE`: the presentation mode of Windows is on. */
export const QUNS_PRESENTATION_MODE = 4;

/** The time with no input after which Mark is away, by default. `headroom config away-after <time>` changes it. */
export const AWAY_AFTER_DEFAULT_MS: number = 5 * 60_000;
/** The longest wait of a new heavy lease while Mark is busy, by default. `headroom config busy-wait <time>` changes it. */
export const BUSY_WAIT_DEFAULT_MS: number = 20 * 60_000;
/** The cores that the CPU reserve gets while Mark is present or busy, by default. `headroom config present-reserve <cores>` changes it. */
export const PRESENT_RESERVE_DEFAULT = 2;
/** The time between two reads of the consent store of the camera and the microphone. */
export const CALL_EVERY_MS = 30_000;
/** The count of state changes that the history keeps. */
export const PRESENCE_HISTORY = 20;
/** The start of the reason of a lease that waits while Mark is busy. */
export const PRESENCE_WAIT = "waits while Mark";

/** One read of the tick: the time since the last input, and the notification state of the shell. */
export interface PresenceRead {
  /** The milliseconds since the last input of the session, from `GetLastInputInfo`, or `null` when the read failed. */
  readonly idleMs: number | null;
  /** The value of `SHQueryUserNotificationState`, from 1 to 7, or `null` when the read failed. */
  readonly notification: number | null;
}

/** One read of the consent store: the camera or the microphone is in use. It has no name of an app. */
export interface CallRead {
  readonly camera: boolean;
  readonly microphone: boolean;
}

/** One event of the session, from the power settings. */
export type PresenceEvent = { readonly type: "presence"; readonly present: boolean } | { readonly type: "display"; readonly display: DisplayState };

/** The settings of the presence rules. */
export interface PresencePolicy {
  /** False: the daemon measures the state, but the state does not change the admission, the eco mode or the reserve. */
  readonly enabled: boolean;
  /** The time with no input after which Mark is away. */
  readonly awayAfterMs: number;
  /** The longest wait of a new heavy lease while Mark is busy. */
  readonly busyWaitMs: number;
  /** The cores that the CPU reserve gets while Mark is present or busy. */
  readonly presentReserve: number;
}

/** The default settings of the presence rules. */
export const DEFAULT_PRESENCE: PresencePolicy = {
  enabled: true,
  awayAfterMs: AWAY_AFTER_DEFAULT_MS,
  busyWaitMs: BUSY_WAIT_DEFAULT_MS,
  presentReserve: PRESENT_RESERVE_DEFAULT,
};

/** The state at one time, with its reason. */
export interface PresenceSnapshot {
  readonly state: PresenceState;
  /** The start of this state, or of this kind of busy state. */
  readonly since: number;
  /** The reason for a person, for example "no input for 7 min" or "a call is on (microphone)". */
  readonly reason: string;
  /** Why Mark is busy, or `null` in another state. */
  readonly busy: BusyKind | null;
  /** The devices of a call, or `null` with no call. */
  readonly call: CallDevice | null;
  /** The milliseconds since the last input at the last read, or `null` without a read. */
  readonly idleMs: number | null;
}

/** One change of the state, for the history. */
export interface PresenceChange {
  readonly state: PresenceState;
  readonly busy: BusyKind | null;
  readonly at: number;
  readonly reason: string;
}

/** The presence of Mark in the status (H33). `Status.presence` gives it. */
export interface PresenceStatus {
  /** True: the state changes the admission, the eco mode and the reserve. False: `headroom config presence off`. */
  readonly enabled: boolean;
  /** The state, or `null` on a computer with no read of the presence. */
  readonly state: PresenceState | null;
  readonly since: number | null;
  /** The seconds since the last input, or `null` without a read. */
  readonly idleSeconds: number | null;
  readonly reason: string | null;
  readonly busy: BusyKind | null;
  /** The devices of a call, or `null` with no call. It has no name of an app. */
  readonly call: CallDevice | null;
  /** True: the clients of `headroom run` put the heavy jobs in efficiency mode, because Mark is at the laptop. */
  readonly eco: boolean;
  /** The time with no input after which Mark is away, and the longest wait of a heavy lease while Mark is busy. */
  readonly awayAfterMs: number;
  readonly busyWaitMs: number;
  /** The last changes of the state, the oldest first. */
  readonly history: readonly PresenceChange[];
}

/** The keys of the registry that a call read uses, under `HKEY_CURRENT_USER`. A fake registry takes their place in the tests. */
export interface ConsentRegistry {
  /** This function gives the names of the subkeys of a key, or an empty list for a key that does not open. */
  subkeys(path: string): readonly string[];
  /** This function gives a `REG_QWORD` value of a key, or `null` for a value or a key that does not open. */
  qword(path: string, name: string): bigint | null;
}

/** The consent store of the capabilities, under `HKEY_CURRENT_USER`. */
export const CONSENT_STORE = "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore";

/**
 * This function tells if an app uses a device of the consent store at this time: `webcam` or `microphone`. An app uses
 * it when `LastUsedTimeStop` is 0 and `LastUsedTimeStart` is above 0. The desktop apps are under the key `NonPackaged`.
 */
export function deviceInUse(registry: ConsentRegistry, device: "webcam" | "microphone"): boolean {
  const root = `${CONSENT_STORE}\\${device}`;
  const inUse = (path: string): boolean => {
    const stop = registry.qword(path, "LastUsedTimeStop");
    if (stop !== 0n) return false;
    const start = registry.qword(path, "LastUsedTimeStart");
    return start !== null && start > 0n;
  };
  for (const name of registry.subkeys(root)) {
    if (name.toLowerCase() !== "nonpackaged") {
      if (inUse(`${root}\\${name}`)) return true;
      continue;
    }
    for (const app of registry.subkeys(`${root}\\${name}`)) if (inUse(`${root}\\${name}\\${app}`)) return true;
  }
  return false;
}

/** This function reads the camera and the microphone from the consent store. It keeps no name of an app. */
export function readCall(registry: ConsentRegistry): CallRead {
  return { camera: deviceInUse(registry, "webcam"), microphone: deviceInUse(registry, "microphone") };
}

/** This function gives the devices of a call, or `null` with no call. */
export function callDevice(call: CallRead | null): CallDevice | null {
  if (call === null) return null;
  if (call.camera && call.microphone) return "camera and microphone";
  if (call.camera) return "camera";
  return call.microphone ? "microphone" : null;
}

/** This function gives the event of a change of a power setting of the session, or `null` for another setting. */
export function sessionEvent(guid: string, value: number): PresenceEvent | null {
  switch (guid.toLowerCase()) {
    case GUID_SESSION_USER_PRESENCE:
      return { type: "presence", present: value === 0 };
    case GUID_SESSION_DISPLAY_STATUS:
      return { type: "display", display: value === 0 ? "off" : value === 2 ? "dimmed" : "on" };
    default:
      return null;
  }
}

/** This function writes a time span for a person: "12 s", "7 min" or "2 h 5 min". */
export function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} min`;
}

/** The facts of one classification: the reads of the tick, the last call read, the last events and the time for away. */
export interface PresenceFacts {
  readonly now: number;
  readonly read: PresenceRead;
  readonly call: CallRead | null;
  /** The last event of the user presence, with its time, or `null`. */
  readonly present: { readonly present: boolean; readonly at: number } | null;
  /** The last event of the display, with its time, or `null`. */
  readonly display: { readonly display: DisplayState; readonly at: number } | null;
  readonly awayAfterMs: number;
}

/**
 * This function gives the state from the facts. An event that came before the last input is old: the input tells that
 * Mark came back. The rules, in their order:
 *
 * 1. The display is off, or the session is locked: away.
 * 2. The camera or the microphone is in use: busy, also with no input, because Mark talks and listens without the keyboard.
 * 3. Windows tells that the user is inactive, or no input came for `awayAfterMs`: away.
 * 4. A presentation or a full-screen app: busy.
 * 5. Otherwise: present.
 */
export function classify(facts: PresenceFacts): { readonly state: PresenceState; readonly reason: string; readonly busy: BusyKind | null } {
  const { now, read } = facts;
  const inputAt = read.idleMs === null ? null : now - read.idleMs;
  const current = (at: number): boolean => inputAt === null || inputAt <= at;
  if (facts.display !== null && facts.display.display === "off" && current(facts.display.at)) return { state: "away", reason: "the display is off", busy: null };
  if (read.notification === QUNS_NOT_PRESENT) return { state: "away", reason: "the session is locked", busy: null };
  const call = callDevice(facts.call);
  if (call !== null) return { state: "busy", reason: `a call is on (${call})`, busy: "call" };
  if (facts.present !== null && !facts.present.present && current(facts.present.at)) return { state: "away", reason: "Windows tells that the user is inactive", busy: null };
  if (read.idleMs !== null && read.idleMs >= facts.awayAfterMs) return { state: "away", reason: `no input for ${elapsedText(read.idleMs)}`, busy: null };
  if (read.notification === QUNS_PRESENTATION_MODE) return { state: "busy", reason: "a presentation runs", busy: "presentation" };
  if (read.notification === QUNS_BUSY || read.notification === QUNS_RUNNING_D3D_FULL_SCREEN) return { state: "busy", reason: "a full-screen app runs", busy: "full screen" };
  return { state: "present", reason: read.idleMs === null ? "no read of the last input" : `last input ${elapsedText(read.idleMs)} ago`, busy: null };
}

/**
 * The state of Mark over time (H33). The engine gives it the events and the reads of each tick. It keeps the last events,
 * the current state and a short history in memory.
 */
export class PresenceTracker {
  #present: { readonly present: boolean; readonly at: number } | null = null;
  #display: { readonly display: DisplayState; readonly at: number } | null = null;
  #current: PresenceSnapshot | null = null;
  #history: PresenceChange[] = [];

  /** The state at the last update, or `null` before the first read. */
  get current(): PresenceSnapshot | null {
    return this.#current;
  }

  /** The last changes of the state, the oldest first. */
  get history(): readonly PresenceChange[] {
    return this.#history;
  }

  /** This function keeps one event of the session. The next update uses it. */
  event(event: PresenceEvent, at: number): void {
    if (event.type === "presence") this.#present = { present: event.present, at };
    else this.#display = { display: event.display, at };
  }

  /**
   * This function classifies the reads of a tick. It gives true when the state or the kind of busy state changed. A new
   * state starts a new entry of the history.
   */
  update(now: number, read: PresenceRead, call: CallRead | null, awayAfterMs: number): boolean {
    const next = classify({ now, read, call, present: this.#present, display: this.#display, awayAfterMs });
    const last = this.#current;
    const changed = last === null || last.state !== next.state || last.busy !== next.busy;
    // At the first read, an away state started at the last input plus the time for away, not at the start of the daemon.
    const idleMs = read.idleMs;
    const start = last === null && next.state === "away" && idleMs !== null && idleMs >= awayAfterMs ? now - idleMs + awayAfterMs : now;
    this.#current = {
      state: next.state,
      since: changed ? start : last.since,
      reason: next.reason,
      busy: next.busy,
      call: callDevice(call),
      idleMs: read.idleMs,
    };
    if (changed) this.#history = [...this.#history, { state: next.state, busy: next.busy, at: start, reason: next.reason }].slice(-PRESENCE_HISTORY);
    return changed;
  }
}

/** This function tells if a lease takes the presence rules: it is heavy, and it has no `--ignore-presence`. */
function followsPresence(lease: Lease): boolean {
  return lease.conditions?.ignorePresence !== true && heavyWhy(lease) !== null;
}

/** This function gives the words of a busy state for a reason: "is on a call", "presents" or "uses a full-screen app". */
export function busyText(busy: BusyKind | null): string {
  if (busy === "call") return "is on a call";
  if (busy === "presentation") return "presents";
  return "uses a full-screen app";
}

/**
 * This function tells why a new heavy lease waits while Mark is busy, or gives `null`. The wait ends `busyWaitMs` after the
 * request: then the lease starts, and the job runs in efficiency mode. `--ignore-presence` starts it at once.
 */
export function presenceWait(lease: Lease, presence: PresenceSnapshot | null, policy: PresencePolicy, now: number, clock: (at: number) => string = localClock): string | null {
  if (!policy.enabled || presence === null || presence.state !== "busy" || !followsPresence(lease)) return null;
  const until = lease.requestedAt + policy.busyWaitMs;
  if (now >= until) return null;
  return `${PRESENCE_WAIT} ${busyText(presence.busy)} (at most until ${clock(until)}, then in eco mode)`;
}

/** This function tells if a lease waits while Mark is busy (H33). */
export function isPresenceWait(reason: string | null): boolean {
  return reason !== null && reason.startsWith(`${PRESENCE_WAIT} `);
}

/** This function tells if the job of a lease runs in efficiency mode for Mark: Mark is present or busy, and the job is heavy. */
export function presenceEco(lease: Lease, presence: PresenceSnapshot | null, policy: PresencePolicy): boolean {
  return policy.enabled && presence !== null && presence.state !== "away" && followsPresence(lease);
}

/**
 * This function gives the CPU reserve for Mark at this time. While Mark is present or busy, the reserve grows by
 * `presentReserve`, up to the count of processors. While Mark is away, it is 0. With the rules off or no read, it is `base`.
 */
export function presenceReserve(base: number, presence: PresenceSnapshot | null, policy: PresencePolicy, processors: number): number {
  if (!policy.enabled || presence === null) return base;
  if (presence.state === "away") return 0;
  return Math.min(processors, base + policy.presentReserve);
}

/** This function gives the status of the presence from the tracker and the settings. */
export function presenceStatus(tracker: PresenceTracker, policy: PresencePolicy): PresenceStatus {
  const current = tracker.current;
  return {
    enabled: policy.enabled,
    state: current?.state ?? null,
    since: current?.since ?? null,
    idleSeconds: current === null || current.idleMs === null ? null : Math.round(current.idleMs / 1000),
    reason: current?.reason ?? null,
    busy: current?.busy ?? null,
    call: current?.call ?? null,
    eco: policy.enabled && current !== null && current.state !== "away",
    awayAfterMs: policy.awayAfterMs,
    busyWaitMs: policy.busyWaitMs,
    history: tracker.history,
  };
}

/** This function writes a state for a person: "present", "on a call", "presenting", "in a full-screen app" or "away". */
export function stateText(state: PresenceState, busy: BusyKind | null): string {
  if (state !== "busy") return state;
  if (busy === "call") return "on a call";
  if (busy === "presentation") return "presenting";
  return "in a full-screen app";
}

/**
 * This function gives the line of `headroom status` (H33), for example "You: present (last input 12 s ago). Heavy jobs run
 * in eco mode." It gives `null` on a computer with no read of the presence, and for a daemon of an older version.
 */
export function presenceLine(presence: PresenceStatus | undefined, leases: readonly Pick<Lease, "state" | "reason">[], clock: (at: number) => string = localClock): string | null {
  if (presence === undefined || presence.state === null || presence.since === null) return null;
  const off = presence.enabled ? "" : " The presence rules are off.";
  if (presence.state === "present") {
    const input = presence.idleSeconds === null ? "" : ` (last input ${elapsedText(presence.idleSeconds * 1000)} ago)`;
    return `You: present${input}.${presence.enabled ? " Heavy jobs run in eco mode." : off}`;
  }
  const head = `You: ${stateText(presence.state, presence.busy)} since ${clock(presence.since)}.`;
  if (presence.state === "away" || !presence.enabled) return `${head}${off}`;
  const waiting = leases.filter((lease) => lease.state === "waiting" && isPresenceWait(lease.reason)).length;
  if (waiting > 0) return `${head} ${waiting} heavy ${waiting === 1 ? "job waits" : "jobs wait"}.`;
  return `${head} New heavy jobs wait up to ${elapsedText(presence.busyWaitMs)}.`;
}

/** This function writes the history of the presence, one line for each change: "09:40 away: no input for 5 min". */
export function presenceHistoryLines(history: readonly PresenceChange[], clock: (at: number) => string = localClock): string[] {
  return history.map((change) => `${clock(change.at)} ${stateText(change.state, change.busy)}: ${change.reason}`);
}
