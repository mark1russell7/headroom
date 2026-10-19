import { describe, expect, it } from "vitest";
import { parseMemory, parseTime } from "./parse.ts";

describe("parseMemory", () => {
  it("reads GB, MB and bare numbers as MB", () => {
    expect(parseMemory("2g")).toBe(2048);
    expect(parseMemory("1.5GB")).toBe(1536);
    expect(parseMemory("1500m")).toBe(1500);
    expect(parseMemory("700")).toBe(700);
    expect(() => parseMemory("lots")).toThrow(/Not a memory amount/);
  });
});

describe("parseTime", () => {
  it("reads ms, s, m and h", () => {
    expect(parseTime("250")).toBe(250);
    expect(parseTime("30s")).toBe(30_000);
    expect(parseTime("10m")).toBe(600_000);
    expect(parseTime("2h")).toBe(7_200_000);
    expect(() => parseTime("soon")).toThrow(/Not a time/);
  });
});
