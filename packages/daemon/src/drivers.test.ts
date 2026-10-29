import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { driversOf, sysFiles } from "./drivers.ts";

describe("driversOf", () => {
  it("names the driver files that contain each tag", () => {
    const root = mkdtempSync(join(tmpdir(), "headroom-drivers-"));
    mkdirSync(join(root, "repo", "amd"), { recursive: true });
    writeFileSync(join(root, "repo", "amd", "amdkmdag.sys"), Buffer.from("\x00\x01DAL3\x00DAL2\x00", "latin1"));
    writeFileSync(join(root, "wifi.sys"), Buffer.from("MKCx", "latin1"));
    writeFileSync(join(root, "notes.txt"), "DAL3");
    const found = driversOf(["DAL3", "MKCx", "Zzzz"], [root]);
    expect(Object.fromEntries(found)).toEqual({ DAL3: ["amdkmdag.sys"], MKCx: ["wifi.sys"], Zzzz: [] });
  });
});

describe("sysFiles", () => {
  it("skips a subfolder that it cannot read, and still gives the other driver files", () => {
    const entry = (name: string, dir = false) => ({ name, isDirectory: () => dir });
    const tree: Record<string, ReturnType<typeof entry>[]> = {
      root: [entry("DriverData", true), entry("refs.sys"), entry("sub", true), entry("notes.txt")],
      [join("root", "sub")]: [entry("FLTMGR.SYS")],
    };
    const list = (dir: string) => {
      const entries = tree[dir];
      if (!entries) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      return entries;
    };
    expect(sysFiles("root", list)).toEqual(["refs.sys", join("sub", "FLTMGR.SYS")]);
    expect(sysFiles("none", list)).toEqual([]);
  });
});
