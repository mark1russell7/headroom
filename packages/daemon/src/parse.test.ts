import { describe, expect, it } from "vitest";
import { mountOf, normalizeMount, parseDisk, parseMemory, parseTime } from "./parse.ts";

describe("parseMemory", () => {
  it("reads GB, MB and bare numbers as MB", () => {
    expect(parseMemory("2g")).toBe(2048);
    expect(parseMemory("1.5GB")).toBe(1536);
    expect(parseMemory("1500m")).toBe(1500);
    expect(parseMemory("700")).toBe(700);
    expect(() => parseMemory("lots")).toThrow(/Not a memory amount/);
  });
});

describe("parseDisk", () => {
  it("reads an amount for the drive of the current folder, or for a named drive", () => {
    expect(parseDisk("5g")).toEqual({ mount: null, mb: 5120 });
    expect(parseDisk("D:=5g")).toEqual({ mount: "D:", mb: 5120 });
    expect(parseDisk("d=500m")).toEqual({ mount: "D:", mb: 500 });
    expect(parseDisk("/home=1g")).toEqual({ mount: "/home", mb: 1024 });
    expect(() => parseDisk("D:")).toThrow(/Not a disk amount/);
    expect(() => parseDisk("=5g")).toThrow(/Not a disk amount/);
  });

  it("gives the drive of a path: the drive letter on Windows, the longest mount point on Linux", () => {
    expect(normalizeMount("d:\\")).toBe("D:");
    expect(mountOf("d:\\git\\headroom", [], "win32")).toBe("D:");
    expect(mountOf("\\\\server\\share", [], "win32")).toBeNull();
    expect(mountOf("/home/mark/git", ["/", "/home/mark"], "linux")).toBe("/home/mark");
    expect(mountOf("/home/markus", ["/", "/home/mark"], "linux")).toBe("/");
    expect(mountOf("/srv", [], "linux")).toBeNull();
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
