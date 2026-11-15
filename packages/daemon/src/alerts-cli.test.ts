import { describe, expect, it } from "vitest";
import { alertsChange, alertsLines } from "./alerts-cli.ts";

describe("headroom config alerts (H179)", () => {
  it("shows the limits that differ, with their defaults", () => {
    expect(alertsLines({})).toEqual(["alerts: (the defaults)"]);
    expect(alertsLines({ availableMb: 3072, availableCriticalMb: 2048 })).toEqual([
      "alerts:",
      "  availableMb              3072 (default 1024)",
      "  availableCriticalMb      2048 (default 0)",
    ]);
  });

  it("gives the change of the arguments", () => {
    expect(alertsChange(undefined, undefined, false)).toBe("show");
    expect(alertsChange(undefined, undefined, true)).toBeNull();
    expect(alertsChange("availableCriticalMb", "2048", false)).toEqual({ availableCriticalMb: 2048 });
    expect(alertsChange("cpuWarnRatio", "0.8", false)).toEqual({ cpuWarnRatio: 0.8 });
    expect(alertsChange("availableCriticalMb", undefined, true)).toEqual({ availableCriticalMb: null });
    // A name with no number, a number with --clear, or a text that is not a number gives the usage.
    expect(alertsChange("availableCriticalMb", undefined, false)).toBeUndefined();
    expect(alertsChange("availableCriticalMb", "2048", true)).toBeUndefined();
    expect(alertsChange("availableCriticalMb", "2GB", false)).toBeUndefined();
    expect(alertsChange("availableCriticalMb", " ", false)).toBeUndefined();
  });
});
