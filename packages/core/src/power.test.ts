import { describe, expect, it } from "vitest";
import {
  batteryParts,
  batteryState,
  BATTERY_STATE_SIZE,
  EcoTracker,
  GUID_ACDC_POWER_SOURCE,
  GUID_BATTERY_PERCENTAGE_REMAINING,
  GUID_LIDSWITCH_STATE_CHANGE,
  guidBytes,
  guidText,
  keepAwakeReason,
  minutesText,
  modeEvent,
  NO_POWER,
  ownersWattsText,
  parseBatteryState,
  parseMeters,
  powerLine,
  powerOwners,
  settingEvent,
  suspendEvent,
  systemWatts,
  cpuWatts,
} from "./power.ts";

/** This function gives a SYSTEM_BATTERY_STATE as CallNtPowerInformation writes it. */
function batteryBuffer(fields: { ac: boolean; present?: boolean; charging?: boolean; discharging?: boolean; max: number; remaining: number; rate: number; seconds: number }): Buffer {
  const buffer = Buffer.alloc(BATTERY_STATE_SIZE);
  buffer.writeUInt8(fields.ac ? 1 : 0, 0);
  buffer.writeUInt8(fields.present === false ? 0 : 1, 1);
  buffer.writeUInt8(fields.charging === true ? 1 : 0, 2);
  buffer.writeUInt8(fields.discharging === true ? 1 : 0, 3);
  buffer.writeUInt32LE(fields.max, 8);
  buffer.writeUInt32LE(fields.remaining, 12);
  buffer.writeInt32LE(fields.rate, 16);
  buffer.writeUInt32LE(fields.seconds, 20);
  return buffer;
}

describe("the battery reader", () => {
  it("reads the state of a battery that discharges", () => {
    // The values of the laptop of Mark on 10-24.
    const read = parseBatteryState(batteryBuffer({ ac: false, discharging: true, max: 51_850, remaining: 24_600, rate: -21_907, seconds: 4042 }));
    expect(read).toEqual({ ac: false, charging: false, discharging: true, maxMwh: 51_850, remainingMwh: 24_600, rateMw: -21_907, estimatedSeconds: 4042 });
    expect(read && batteryState(read)).toEqual({ ac: false, charging: false, percent: 47, rateW: -21.9, minutesLeft: 67 });
  });

  it("gives no battery for a computer with no battery, or with no capacity", () => {
    expect(parseBatteryState(batteryBuffer({ ac: true, present: false, max: 0, remaining: 0, rate: 0, seconds: 0 }))).toBeNull();
    expect(parseBatteryState(batteryBuffer({ ac: true, max: 0, remaining: 0, rate: 0, seconds: 0 }))).toBeNull();
    expect(parseBatteryState(Buffer.alloc(8))).toBeNull();
  });

  it("gives no rate and no time for the unknown values, and computes the time from the rate", () => {
    const read = parseBatteryState(batteryBuffer({ ac: false, max: 50_000, remaining: 25_000, rate: -0x80000000, seconds: 0xffffffff }));
    expect(read).toMatchObject({ rateMw: null, estimatedSeconds: null });
    const computed = parseBatteryState(batteryBuffer({ ac: false, max: 50_000, remaining: 25_000, rate: -12_500, seconds: 0 }));
    expect(computed && batteryState(computed).minutesLeft).toBe(120);
    const plugged = parseBatteryState(batteryBuffer({ ac: true, charging: true, max: 50_000, remaining: 46_000, rate: 15_000, seconds: 0xffffffff }));
    expect(plugged && batteryState(plugged)).toEqual({ ac: true, charging: true, percent: 92, rateW: 15, minutesLeft: null });
  });
});

describe("the Energy Meter reader", () => {
  it("keeps the meters in watts, and skips each core and the total", () => {
    const meters = parseMeters([
      { name: "System Power", milliwatts: 23_343.4 },
      { name: "CPU Power", milliwatts: 7120 },
      { name: "RAPL_Package0_PKG", milliwatts: 10_997 },
      { name: "RAPL_Package0_Core", milliwatts: 5000 },
      { name: "_Total", milliwatts: 60_000 },
      { name: "GPU", milliwatts: Number.NaN },
    ]);
    expect(meters).toEqual({ "system power": 23.343, "cpu power": 7.12, rapl_package0_pkg: 10.997 });
    expect(systemWatts(meters)).toBe(23.343);
    expect(cpuWatts(meters)).toBe(7.12);
    expect(cpuWatts({ rapl_package0_pkg: 11 })).toBe(11);
    expect(systemWatts(undefined)).toBeNull();
  });
});

describe("the power events", () => {
  it("round-trips a GUID in the layout of Windows", () => {
    const bytes = guidBytes(GUID_ACDC_POWER_SOURCE);
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x59, 0x9a, 0x3e, 0x5d]));
    expect(guidText(bytes)).toBe(GUID_ACDC_POWER_SOURCE);
  });

  it("turns the settings, the suspend types and the modes into events", () => {
    expect(settingEvent(GUID_ACDC_POWER_SOURCE, 0)).toEqual({ type: "source", ac: true });
    expect(settingEvent(GUID_ACDC_POWER_SOURCE, 1)).toEqual({ type: "source", ac: false });
    // A UPS counts as AC power.
    expect(settingEvent(GUID_ACDC_POWER_SOURCE, 2)).toEqual({ type: "source", ac: true });
    expect(settingEvent(GUID_BATTERY_PERCENTAGE_REMAINING, 68)).toEqual({ type: "percent", percent: 68 });
    expect(settingEvent(GUID_LIDSWITCH_STATE_CHANGE, 0)).toEqual({ type: "lid", open: false });
    expect(settingEvent("00000000-0000-0000-0000-000000000000", 1)).toBeNull();
    expect(suspendEvent(4)).toEqual({ type: "suspend" });
    expect(suspendEvent(7)).toEqual({ type: "resume" });
    expect(suspendEvent(18)).toEqual({ type: "resume" });
    expect(suspendEvent(10)).toBeNull();
    expect(modeEvent(1)).toEqual({ type: "mode", mode: "better battery" });
    expect(modeEvent(99)).toBeNull();
  });
});

describe("the power texts", () => {
  it("writes the battery for a person", () => {
    expect(minutesText(118)).toBe("1 h 58 min");
    expect(minutesText(120)).toBe("2 h");
    expect(minutesText(9)).toBe("9 min");
    expect(batteryParts({ ac: false, charging: false, percent: 68, rateW: -18, minutesLeft: 118 })).toEqual(["on battery", "68%", "18.0 W", "1 h 58 min left"]);
    expect(batteryParts({ ac: true, charging: true, percent: 92, rateW: 15, minutesLeft: null })).toEqual(["plugged in", "charging", "92%"]);
  });

  it("estimates the power of each owner from its share of the processor time", () => {
    const owners = powerOwners(
      [
        { owner: "session:server-stack", kind: "session", cores: 1.5 },
        { owner: "session:graph", kind: "session", cores: 0.5 },
        { owner: "docker", kind: "docker", cores: 0 },
      ],
      8,
    );
    expect(owners).toEqual([
      { owner: "session:server-stack", kind: "session", watts: 6 },
      { owner: "session:graph", kind: "session", watts: 2 },
    ]);
    expect(ownersWattsText(owners)).toBe("session:server-stack 6.0 W, session:graph 2.0 W");
    expect(powerOwners(undefined, 8)).toEqual([]);
    expect(powerOwners([{ owner: "a", kind: "other", cores: 1 }], null)).toEqual([]);
  });

  it("writes the power line of the status", () => {
    const battery = { id: "battery", used: 15, battery: { ac: false, charging: false, percent: 68, rateW: -18, minutesLeft: 118 }, owners: [] };
    const power = { id: "power", used: 18, owners: [{ owner: "session:server-stack", value: 3.1 }, { owner: "session:graph", value: 2.4 }, { owner: "docker", value: 0.05 }] };
    expect(powerLine([battery, power], { ...NO_POWER, powerMode: "balanced" })).toBe(
      "Power: on battery, 68%, 18.0 W, 1 h 58 min left (power mode: balanced). Most (estimate): session:server-stack 3.1 W, session:graph 2.4 W.",
    );
    const plugged = { ...battery, battery: { ac: true, charging: true, percent: 92, rateW: 15, minutesLeft: null } };
    expect(powerLine([plugged], undefined)).toBe("Power: plugged in, charging, 92%.");
    expect(powerLine([{ id: "power", used: 31.5, owners: [] }], undefined)).toBe("Power: 31.5 W.");
    expect(powerLine([{ id: "memory", used: 1, owners: [] }], undefined)).toBeNull();
  });
});

describe("the power request and the efficiency mode", () => {
  it("keeps the computer awake on AC power while a job runs", () => {
    expect(keepAwakeReason(true, 2)).toBe("headroom: 2 jobs run");
    expect(keepAwakeReason(null, 1)).toBe("headroom: 1 job runs");
    expect(keepAwakeReason(false, 3)).toBeNull();
    expect(keepAwakeReason(true, 0)).toBeNull();
  });

  it("sets the efficiency mode once for each process, and takes it away on AC power", () => {
    const calls: string[] = [];
    const set = (pid: number, on: boolean): boolean => {
      calls.push(`${pid}:${on ? "on" : "off"}`);
      // The process 13 ended, so the change fails.
      return pid !== 13;
    };
    const tracker = new EcoTracker();
    expect(tracker.update(false, [11, 12], set)).toBe(0);
    expect(tracker.update(true, [11, 12, 13], set)).toBe(2);
    expect(tracker.on).toBe(true);
    // A new process of the job gets the mode. The process 12 left the job, so the tracker forgets it.
    expect(tracker.update(true, [11, 14], set)).toBe(1);
    expect(tracker.update(false, [11, 14], set)).toBe(2);
    expect(tracker.on).toBe(false);
    expect(calls).toEqual(["11:on", "12:on", "13:on", "14:on", "11:off", "14:off"]);
  });
});
