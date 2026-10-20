import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { driversOf } from "./drivers.ts";

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
