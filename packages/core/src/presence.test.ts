import { describe, expect, it } from "vitest";
import type { Lease } from "./broker.ts";
import { conditionsText, conditionWait, isConditionWait, leaseConditions, localClock, unmetCheck, waitsForRoom, type ConditionFacts } from "./conditions.ts";
import { Engine } from "./engine.ts";
import { POWER_SETTINGS, settingEvent } from "./power.ts";
import {
  CONSENT_STORE,
  DEFAULT_PRESENCE,
  GUID_SESSION_DISPLAY_STATUS,
  GUID_SESSION_USER_PRESENCE,
  callDevice,
  classify,
  isPresenceWait,
  presenceEco,
  presenceHistoryLines,
  presenceLine,
  presenceReserve,
  presenceStatus,
  PresenceTracker,
  presenceWait,
  readCall,
  sessionEvent,
  type CallRead,
  type ConsentRegistry,
  type PresenceFacts,
  type PresenceRead,
  type PresenceSnapshot,
  type PresenceStatus,
} from "./presence.ts";
import type { Sampler } from "./sampler.ts";
import { Store } from "./store.ts";

const NOW = Date.parse("2026-10-25T10:02:00Z");
const MINUTE = 60_000;
const NO_CALL: CallRead = { camera: false, microphone: false };

/** The facts of one classification: Mark typed 12 seconds ago, and no full-screen app runs. */
function facts(fields: Omit<Partial<PresenceFacts>, "read"> & { readonly read?: Partial<PresenceRead> } = {}): PresenceFacts {
  const { read, ...rest } = fields;
  return { now: NOW, call: NO_CALL, present: null, display: null, awayAfterMs: 5 * MINUTE, ...rest, read: { idleMs: 12_000, notification: 5, ...read } };
}

function lease(fields: Partial<Lease> = {}): Lease {
  return {
    id: "l1", holder: "graph", job: "pnpm e2e", amounts: { memory: 4096 }, priority: 0, pid: null, ttlMs: 300_000, state: "waiting",
    requestedAt: NOW, grantedAt: null, endedAt: null, heartbeatAt: NOW, reason: null, peakMb: null, ...fields,
  };
}

function snapshot(state: PresenceSnapshot["state"], busy: PresenceSnapshot["busy"] = null): PresenceSnapshot {
  return { state, since: NOW - 10 * MINUTE, reason: "a reason", busy, call: busy === "call" ? "microphone" : null, idleMs: 12_000 };
}

describe("the state of Mark (H33)", () => {
  it("is present with a recent input, and away after the time for away", () => {
    expect(classify(facts())).toEqual({ state: "present", reason: "last input 12 s ago", busy: null });
    expect(classify(facts({ read: { idleMs: 5 * MINUTE } }))).toEqual({ state: "away", reason: "no input for 5 min", busy: null });
    expect(classify(facts({ read: { idleMs: 3 * MINUTE }, awayAfterMs: 2 * MINUTE })).state).toBe("away");
    expect(classify(facts({ read: { idleMs: null } }))).toEqual({ state: "present", reason: "no read of the last input", busy: null });
  });

  it("is away when Windows tells that the user is inactive, until a new input comes", () => {
    expect(classify(facts({ present: { present: false, at: NOW - 5000 } }))).toEqual({ state: "away", reason: "Windows tells that the user is inactive", busy: null });
    // Mark typed 12 seconds ago, after the event of 60 seconds ago: the event is old.
    expect(classify(facts({ present: { present: false, at: NOW - MINUTE } })).state).toBe("present");
    expect(classify(facts({ present: { present: true, at: NOW - 5000 } })).state).toBe("present");
  });

  it("is away while the display is off or the session is locked, and present while the display is dimmed", () => {
    expect(classify(facts({ display: { display: "off", at: NOW - 5000 } }))).toEqual({ state: "away", reason: "the display is off", busy: null });
    expect(classify(facts({ display: { display: "off", at: NOW - MINUTE } })).state).toBe("present");
    expect(classify(facts({ display: { display: "dimmed", at: NOW - 5000 } })).state).toBe("present");
    expect(classify(facts({ read: { notification: 1 } }))).toEqual({ state: "away", reason: "the session is locked", busy: null });
  });

  it("is busy in a full-screen app or a presentation while Mark is present, and away with no input", () => {
    expect(classify(facts({ read: { notification: 2 } }))).toEqual({ state: "busy", reason: "a full-screen app runs", busy: "full screen" });
    expect(classify(facts({ read: { notification: 3 } })).busy).toBe("full screen");
    expect(classify(facts({ read: { notification: 4 } }))).toEqual({ state: "busy", reason: "a presentation runs", busy: "presentation" });
    expect(classify(facts({ read: { notification: 2, idleMs: 6 * MINUTE } })).state).toBe("away");
  });

  it("is busy on a call, also with no input, but away when the display is off or the session is locked", () => {
    const call: CallRead = { camera: true, microphone: true };
    expect(classify(facts({ call }))).toEqual({ state: "busy", reason: "a call is on (camera and microphone)", busy: "call" });
    expect(classify(facts({ call: { camera: false, microphone: true }, read: { idleMs: 30 * MINUTE } }))).toEqual({
      state: "busy",
      reason: "a call is on (microphone)",
      busy: "call",
    });
    expect(classify(facts({ call, read: { notification: 1 } })).state).toBe("away");
    expect(classify(facts({ call, display: { display: "off", at: NOW } })).state).toBe("away");
  });

  it("keeps the start of each state and a short history, and tells when the state changes", () => {
    const tracker = new PresenceTracker();
    expect(tracker.current).toBeNull();
    expect(tracker.update(NOW, { idleMs: 1000, notification: 5 }, NO_CALL, 5 * MINUTE)).toBe(true);
    expect(tracker.update(NOW + 2000, { idleMs: 3000, notification: 5 }, NO_CALL, 5 * MINUTE)).toBe(false);
    expect(tracker.current).toMatchObject({ state: "present", since: NOW, reason: "last input 3 s ago", idleMs: 3000 });
    expect(tracker.update(NOW + 4000, { idleMs: 1000, notification: 5 }, { camera: false, microphone: true }, 5 * MINUTE)).toBe(true);
    expect(tracker.current).toMatchObject({ state: "busy", busy: "call", call: "microphone", since: NOW + 4000 });
    // A presentation after the call is a new kind of busy state.
    expect(tracker.update(NOW + 6000, { idleMs: 1000, notification: 4 }, NO_CALL, 5 * MINUTE)).toBe(true);
    tracker.event({ type: "display", display: "off" }, NOW + 7000);
    expect(tracker.update(NOW + 8000, { idleMs: 9000, notification: 5 }, NO_CALL, 5 * MINUTE)).toBe(true);
    expect(tracker.history.map((change) => change.state)).toEqual(["present", "busy", "busy", "away"]);
    expect(presenceHistoryLines(tracker.history, () => "10:02")).toEqual([
      "10:02 present: last input 1 s ago",
      "10:02 on a call: a call is on (microphone)",
      "10:02 presenting: a presentation runs",
      "10:02 away: the display is off",
    ]);
    for (let index = 0; index < 30; index++) tracker.update(NOW + 10_000 + index, { idleMs: 0, notification: index % 2 === 0 ? 5 : 2 }, NO_CALL, 5 * MINUTE);
    expect(tracker.history).toHaveLength(20);
  });

  it("starts an away state at the first read from the last input, not from the start of the daemon", () => {
    const tracker = new PresenceTracker();
    tracker.update(NOW, { idleMs: 60 * MINUTE, notification: 5 }, NO_CALL, 5 * MINUTE);
    expect(tracker.current).toMatchObject({ state: "away", since: NOW - 55 * MINUTE });
    expect(tracker.history[0]?.at).toBe(NOW - 55 * MINUTE);
    // A later change to away starts at the read.
    tracker.update(NOW + 1000, { idleMs: 0, notification: 5 }, NO_CALL, 5 * MINUTE);
    tracker.update(NOW + 2000, { idleMs: 6 * MINUTE, notification: 5 }, NO_CALL, 5 * MINUTE);
    expect(tracker.current).toMatchObject({ state: "away", since: NOW + 2000 });
  });

  it("gives the events of the user presence and of the display from the power settings", () => {
    expect(POWER_SETTINGS).toContain(GUID_SESSION_USER_PRESENCE);
    expect(POWER_SETTINGS).toContain(GUID_SESSION_DISPLAY_STATUS);
    expect(settingEvent("3C0F4548-C03F-4C4D-B9F2-237EDE686376", 0)).toEqual({ type: "presence", present: true });
    expect(settingEvent(GUID_SESSION_USER_PRESENCE, 2)).toEqual({ type: "presence", present: false });
    expect(sessionEvent(GUID_SESSION_DISPLAY_STATUS, 0)).toEqual({ type: "display", display: "off" });
    expect(sessionEvent(GUID_SESSION_DISPLAY_STATUS, 1)).toEqual({ type: "display", display: "on" });
    expect(sessionEvent(GUID_SESSION_DISPLAY_STATUS, 2)).toEqual({ type: "display", display: "dimmed" });
    expect(sessionEvent("00000000-0000-0000-0000-000000000000", 0)).toBeNull();
  });
});

describe("the camera and the microphone (H33)", () => {
  /** A fake registry: the subkeys and the QWORD values of each key. */
  function registry(keys: Record<string, Record<string, bigint>>): ConsentRegistry {
    return {
      subkeys: (path) => {
        const prefix = `${path}\\`;
        const names = Object.keys(keys).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length).split("\\")[0] ?? "");
        return [...new Set(names)];
      },
      qword: (path, name) => keys[path]?.[name] ?? null,
    };
  }
  const webcam = `${CONSENT_STORE}\\webcam`;
  const microphone = `${CONSENT_STORE}\\microphone`;

  it("finds a packaged app and a desktop app that use a device now, and keeps no name of an app", () => {
    const fake = registry({
      [`${webcam}\\Microsoft.WindowsCamera_8wekyb3d8bbwe`]: { LastUsedTimeStart: 133_000_000_000_000_000n, LastUsedTimeStop: 0n },
      [`${microphone}\\NonPackaged\\C:#Program Files#Teams#ms-teams.exe`]: { LastUsedTimeStart: 133_000_000_000_000_000n, LastUsedTimeStop: 0n },
      [`${microphone}\\Microsoft.SoundRecorder_8wekyb3d8bbwe`]: { LastUsedTimeStart: 132_000_000_000_000_000n, LastUsedTimeStop: 132_000_000_100_000_000n },
    });
    const call = readCall(fake);
    expect(call).toEqual({ camera: true, microphone: true });
    expect(JSON.stringify(call)).not.toContain("Teams");
    expect(callDevice(call)).toBe("camera and microphone");
  });

  it("finds no call when each app stopped, never started, or has no values", () => {
    const fake = registry({
      [`${webcam}\\NonPackaged\\C:#app.exe`]: { LastUsedTimeStart: 133_000_000_000_000_000n, LastUsedTimeStop: 133_000_000_200_000_000n },
      [`${webcam}\\Microsoft.Other_1`]: { LastUsedTimeStart: 0n, LastUsedTimeStop: 0n },
      [`${microphone}\\Microsoft.Empty_1`]: {},
    });
    expect(readCall(fake)).toEqual({ camera: false, microphone: false });
    expect(readCall(registry({}))).toEqual({ camera: false, microphone: false });
    expect(callDevice({ camera: true, microphone: false })).toBe("camera");
    expect(callDevice({ camera: false, microphone: true })).toBe("microphone");
    expect(callDevice(NO_CALL)).toBeNull();
    expect(callDevice(null)).toBeNull();
  });
});

describe("the presence rules (H33)", () => {
  const busy = snapshot("busy", "call");

  it("holds a new heavy lease while Mark is busy, for at most the busy wait", () => {
    const clock = (at: number): string => (at === NOW + 20 * MINUTE ? "10:22" : "??");
    expect(presenceWait(lease(), busy, DEFAULT_PRESENCE, NOW + MINUTE, clock)).toBe("waits while Mark is on a call (at most until 10:22, then in eco mode)");
    expect(presenceWait(lease(), snapshot("busy", "presentation"), DEFAULT_PRESENCE, NOW, clock)).toMatch(/^waits while Mark presents/);
    expect(presenceWait(lease(), snapshot("busy", "full screen"), DEFAULT_PRESENCE, NOW, clock)).toMatch(/^waits while Mark uses a full-screen app/);
    expect(presenceWait(lease(), busy, DEFAULT_PRESENCE, NOW + 20 * MINUTE)).toBeNull();
    expect(presenceWait(lease({ amounts: { memory: 512 } }), busy, DEFAULT_PRESENCE, NOW)).toBeNull();
    expect(presenceWait(lease({ amounts: { browser: 1 } }), busy, DEFAULT_PRESENCE, NOW)).not.toBeNull();
    expect(presenceWait(lease({ conditions: { when: [], ignorePresence: true } }), busy, DEFAULT_PRESENCE, NOW)).toBeNull();
    expect(presenceWait(lease(), snapshot("present"), DEFAULT_PRESENCE, NOW)).toBeNull();
    expect(presenceWait(lease(), busy, { ...DEFAULT_PRESENCE, enabled: false }, NOW)).toBeNull();
    expect(presenceWait(lease(), null, DEFAULT_PRESENCE, NOW)).toBeNull();
    const reason = presenceWait(lease(), busy, DEFAULT_PRESENCE, NOW);
    // The wait is a condition wait: the hook of the plugin and a restart for an idle queue do not count it.
    expect(isPresenceWait(reason)).toBe(true);
    expect(isConditionWait(reason)).toBe(true);
    expect(waitsForRoom({ state: "waiting", reason })).toBe(false);
  });

  it("puts heavy jobs in eco mode while Mark is present or busy, and not while Mark is away", () => {
    expect(presenceEco(lease(), snapshot("present"), DEFAULT_PRESENCE)).toBe(true);
    expect(presenceEco(lease(), busy, DEFAULT_PRESENCE)).toBe(true);
    expect(presenceEco(lease(), snapshot("away"), DEFAULT_PRESENCE)).toBe(false);
    expect(presenceEco(lease({ amounts: { memory: 512 } }), snapshot("present"), DEFAULT_PRESENCE)).toBe(false);
    expect(presenceEco(lease({ conditions: { when: [], ignorePresence: true } }), snapshot("present"), DEFAULT_PRESENCE)).toBe(false);
    expect(presenceEco(lease(), snapshot("present"), { ...DEFAULT_PRESENCE, enabled: false })).toBe(false);
    expect(presenceEco(lease(), null, DEFAULT_PRESENCE)).toBe(false);
  });

  it("grows the CPU reserve while Mark is present or busy, and drops it to 0 while Mark is away", () => {
    expect(presenceReserve(2, snapshot("present"), DEFAULT_PRESENCE, 16)).toBe(4);
    expect(presenceReserve(2, busy, { ...DEFAULT_PRESENCE, presentReserve: 3 }, 16)).toBe(5);
    expect(presenceReserve(15, busy, DEFAULT_PRESENCE, 16)).toBe(16);
    expect(presenceReserve(2, snapshot("away"), DEFAULT_PRESENCE, 16)).toBe(0);
    expect(presenceReserve(2, snapshot("away"), { ...DEFAULT_PRESENCE, enabled: false }, 16)).toBe(2);
    expect(presenceReserve(2, null, DEFAULT_PRESENCE, 16)).toBe(2);
  });

  it("gives the condition away: it holds while Mark is away, and on a computer with no read of the presence", () => {
    const facts = (presence: ConditionFacts["presence"]): ConditionFacts => ({ now: NOW, ac: true, percent: 90, usage: { state: "missing", path: "u.json" }, starts: 10, presence });
    const away = lease({ amounts: {}, conditions: { when: ["away"] } });
    expect(conditionWait(away, facts("present"), null)).toBe("waits until Mark is away from the laptop (now at the laptop)");
    expect(conditionWait(away, facts("busy"), null)).toBe("waits until Mark is away from the laptop (now busy at the laptop)");
    expect(conditionWait(away, facts("away"), null)).toBeNull();
    expect(conditionWait(away, facts(null), null)).toBeNull();
    expect(unmetCheck({ ...away, state: "granted" }, facts("present"))).toEqual({ condition: "away", state: "Mark is at the laptop" });
  });

  it("keeps --ignore-presence on the lease", () => {
    expect(leaseConditions(undefined, false, false, false, true)).toEqual({ when: [], ignorePresence: true });
    expect(conditionsText({ when: ["away"], ignorePresence: true })).toBe("when away, --ignore-presence");
  });
});

describe("the line of headroom status (H33)", () => {
  const base: PresenceStatus = {
    enabled: true, state: "present", since: NOW, idleSeconds: 12, reason: "last input 12 s ago", busy: null, call: null, eco: true,
    awayAfterMs: 5 * MINUTE, busyWaitMs: 20 * MINUTE, history: [],
  };
  const clock = (): string => "10:02";

  it("tells the state, the eco mode and the heavy jobs that wait", () => {
    expect(presenceLine(base, [], clock)).toBe("You: present (last input 12 s ago). Heavy jobs run in eco mode.");
    const call: PresenceStatus = { ...base, state: "busy", busy: "call", call: "microphone" };
    const waits = { state: "waiting" as const, reason: "waits while Mark is on a call (at most until 10:22, then in eco mode)" };
    expect(presenceLine(call, [waits, waits, { state: "waiting", reason: "waits for memory: needs 4096, 100 free" }], clock)).toBe("You: on a call since 10:02. 2 heavy jobs wait.");
    expect(presenceLine(call, [], clock)).toBe("You: on a call since 10:02. New heavy jobs wait up to 20 min.");
    expect(presenceLine({ ...base, state: "away", eco: false }, [], clock)).toBe("You: away since 10:02.");
    expect(presenceLine({ ...base, enabled: false }, [], clock)).toBe("You: present (last input 12 s ago). The presence rules are off.");
    expect(presenceLine({ ...base, state: null, since: null }, [], clock)).toBeNull();
    expect(presenceLine(undefined, [], clock)).toBeNull();
  });
});

describe("Engine presence (H33)", () => {
  function setup(options: { readonly read?: PresenceRead; readonly call?: CallRead; readonly processors?: number } = {}) {
    let now = NOW;
    let read: PresenceRead = options.read ?? { idleMs: 1000, notification: 5 };
    let call: CallRead = options.call ?? NO_CALL;
    let callReads = 0;
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 20_000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
      processes: () => [],
      presence: () => read,
      calls: () => {
        callReads += 1;
        return call;
      },
      close: () => undefined,
    };
    const engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, sessionsDir: "/nowhere", processors: options.processors ?? 16 });
    return {
      engine,
      advance: (ms: number) => (now += ms),
      now: () => now,
      setRead: (next: PresenceRead) => (read = next),
      setCall: (next: CallRead) => (call = next),
      callReads: () => callReads,
    };
  }
  const heavy = { holder: "graph", job: "pnpm e2e", amounts: { memory: 4096 }, ttlMs: 3_600_000 };

  it("holds a new heavy lease while Mark is on a call, starts it after the busy wait in eco mode, and lets a light lease run", () => {
    const { engine, advance } = setup({ call: { camera: false, microphone: true } });
    engine.tick();
    expect(engine.status().presence).toMatchObject({ enabled: true, state: "busy", busy: "call", call: "microphone", idleSeconds: 1, eco: true });
    const waiting = engine.request(heavy);
    expect(waiting).toMatchObject({ state: "waiting", reason: `waits while Mark is on a call (at most until ${localClock(NOW + 20 * MINUTE)}, then in eco mode)` });
    expect(engine.request({ holder: "graph", job: "tsc", amounts: { memory: 512 }, ttlMs: 3_600_000 }).state).toBe("granted");
    expect(engine.request({ ...heavy, ignorePresence: true }).state).toBe("granted");
    advance(20 * MINUTE);
    engine.tick();
    const started = engine.get(waiting.id);
    expect(started?.state).toBe("granted");
    expect(started === undefined ? null : engine.ecoOf(started)).toEqual({ on: true, reason: "Mark is on a call" });
    engine.close();
  });

  it("starts a lease with --when away within one tick after Mark leaves", () => {
    const { engine, advance, setRead } = setup();
    engine.tick();
    const lease = engine.request({ ...heavy, amounts: {}, when: ["away"] });
    expect(lease).toMatchObject({ state: "waiting", reason: "waits until Mark is away from the laptop (now at the laptop)" });
    advance(2000);
    setRead({ idleMs: 5 * MINUTE, notification: 5 });
    engine.tick();
    expect(engine.get(lease.id)).toMatchObject({ state: "granted", conditionsMetAt: NOW + 2000 });
    // Mark comes back: the job continues, and records the condition that stopped.
    advance(2000);
    setRead({ idleMs: 0, notification: 5 });
    engine.tick();
    expect(engine.get(lease.id)).toMatchObject({ state: "granted", unmet: { condition: "away", state: "Mark is at the laptop", until: null } });
    engine.close();
  });

  it("gives eco mode to heavy jobs and a larger reserve while Mark is present, and full speed with no reserve while Mark is away", () => {
    const { engine, advance, setRead } = setup();
    engine.tick();
    const job = engine.request(heavy);
    const light = engine.request({ holder: "graph", job: "tsc", amounts: { memory: 512, cpu: 2 }, ttlMs: 3_600_000 });
    expect(engine.ecoOf(job)).toEqual({ on: true, reason: "Mark works at the laptop" });
    expect(engine.ecoOf(light)).toEqual({ on: false, reason: null });
    expect(engine.status()).toMatchObject({ cpuReserve: 4, free: { cpu: 10 } });
    // A lease above the reserve of this time waits for Mark to leave. It is not cancelled.
    const wide = engine.request({ holder: "graph", job: "bench", amounts: { cpu: 13 }, ttlMs: 3_600_000 });
    expect(wide).toMatchObject({ state: "waiting", reason: "waits for cpu: needs 13, 10 free" });
    advance(2000);
    setRead({ idleMs: 6 * MINUTE, notification: 5 });
    engine.tick();
    expect(engine.status()).toMatchObject({ cpuReserve: 0, presence: { state: "away", reason: "no input for 6 min", eco: false } });
    expect(engine.get(wide.id)?.state).toBe("granted");
    expect(engine.ecoOf(job)).toEqual({ on: false, reason: null });
    engine.close();
  });

  it("measures the presence but changes nothing with the rules off", () => {
    const { engine } = setup({ call: { camera: true, microphone: true } });
    engine.tick();
    expect(engine.setConfig({ presence: false })).toMatchObject({ presence: false });
    const job = engine.request(heavy);
    expect(job.state).toBe("granted");
    expect(engine.ecoOf(job)).toEqual({ on: false, reason: null });
    expect(engine.status()).toMatchObject({ cpuReserve: 2, presence: { enabled: false, state: "busy", call: "camera and microphone", eco: false } });
    expect(presenceLine(engine.status().presence, [], () => "10:02")).toBe("You: on a call since 10:02. The presence rules are off.");
    engine.setConfig({ presence: null });
    expect(engine.config().presence).toBe(true);
    engine.close();
  });

  it("re-runs the admission when a setting changes the state, and refuses wrong settings", () => {
    const { engine, advance, setRead } = setup();
    engine.tick();
    const lease = engine.request({ ...heavy, amounts: {}, when: ["away"] });
    advance(2000);
    setRead({ idleMs: 3 * MINUTE, notification: 5 });
    engine.tick();
    expect(engine.get(lease.id)?.state).toBe("waiting");
    expect(engine.setConfig({ awayAfterMs: 2 * MINUTE })).toMatchObject({ awayAfterMs: 2 * MINUTE });
    expect(engine.get(lease.id)?.state).toBe("granted");
    expect(() => engine.setConfig({ awayAfterMs: 1000 })).toThrow(RangeError);
    expect(() => engine.setConfig({ busyWaitMs: -1 })).toThrow(RangeError);
    expect(() => engine.setConfig({ presentReserve: 17 })).toThrow(RangeError);
    expect(engine.setConfig({ busyWaitMs: 0, presentReserve: 3 })).toMatchObject({ busyWaitMs: 0, presentReserve: 3 });
    engine.close();
  });

  it("reads the camera and the microphone at most one time in 30 seconds", () => {
    const { engine, advance, setCall, callReads } = setup();
    engine.tick();
    expect(callReads()).toBe(1);
    setCall({ camera: true, microphone: false });
    for (let index = 0; index < 14; index++) {
      advance(2000);
      engine.tick();
    }
    expect(callReads()).toBe(1);
    expect(engine.status().presence.state).toBe("present");
    advance(2000);
    engine.tick();
    expect(callReads()).toBe(2);
    expect(engine.status().presence).toMatchObject({ state: "busy", call: "camera", history: [{ state: "present" }, { state: "busy", busy: "call" }] });
    engine.close();
  });

  it("takes the events of the user presence and of the display", () => {
    const { engine, advance } = setup({ read: { idleMs: 60_000, notification: 5 } });
    engine.tick();
    engine.powerEvent({ type: "display", display: "off" });
    advance(1000);
    engine.tick();
    expect(engine.status().presence).toMatchObject({ state: "away", reason: "the display is off" });
    expect(presenceStatus(new PresenceTracker(), DEFAULT_PRESENCE)).toMatchObject({ state: null, eco: false, history: [] });
    engine.close();
  });

  it("reads the presence settings of the store, and gives the default for a wrong value", () => {
    const store = new Store(":memory:");
    expect(store.config()).toMatchObject({ presence: true, awayAfterMs: 5 * MINUTE, busyWaitMs: 20 * MINUTE, presentReserve: 2 });
    store.setConfig("presence", "off");
    store.setConfig("awayAfterMs", "10");
    store.setConfig("busyWaitMs", "0");
    store.setConfig("presentReserve", "-1");
    expect(store.config()).toMatchObject({ presence: false, awayAfterMs: 5 * MINUTE, busyWaitMs: 0, presentReserve: 2 });
    store.close();
  });

  it("gives no presence and changes nothing on a computer with no read of the presence", () => {
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 20_000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
      processes: () => [],
      close: () => undefined,
    };
    const engine = new Engine({ sampler, store: new Store(":memory:"), sessionsDir: "/nowhere", processors: 16 });
    engine.tick();
    expect(engine.status()).toMatchObject({ cpuReserve: 2, presence: { state: null } });
    expect(engine.request({ ...heavy, when: ["away"] }).state).toBe("granted");
    engine.close();
  });
});
