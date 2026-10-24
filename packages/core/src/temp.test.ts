import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkJobTemp, folderSizeMb, isDirectlyUnder, jobTempSetup, KEEP_MARK, keepJobTemp, removeJobTemp, sweepJobTemp } from "./temp.ts";

describe("the temp folder of each job (H19)", () => {
  let base = "";
  let root = "";
  let outside = "";

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "headroom-temp-"));
    root = join(base, "tmp");
    outside = join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "precious.txt"), "data of the user");
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("gives the job TEMP, TMP and TMPDIR in the folder of its lease, and refuses a lease id that is not a folder name", () => {
    const folder = join(root, "3f2a-lease_1");
    expect(jobTempSetup(root, "3f2a-lease_1")).toEqual({ env: { TEMP: folder, TMP: folder, TMPDIR: folder }, folders: [folder] });
    for (const id of ["..", "a/b", "a\\b", "C:", "", "x.y"]) expect(() => jobTempSetup(root, id)).toThrow(/not a folder name/);
  });

  it("refuses a relative temp root and the root of a drive", () => {
    expect(() => checkJobTemp("tmp")).toThrow(/absolute path/);
    expect(() => checkJobTemp(process.platform === "win32" ? "D:\\" : "/")).toThrow(/root of a drive/);
    expect(checkJobTemp(join(root, "."))).toBe(root);
  });

  it("removes only a real folder directly under the root", () => {
    expect(isDirectlyUnder(root, join(root, "l1"))).toBe(true);
    expect(isDirectlyUnder(root, root)).toBe(false);
    expect(isDirectlyUnder(root, join(root, "l1", "deeper"))).toBe(false);
    expect(isDirectlyUnder(root, join(root, "..", "outside"))).toBe(false);
    expect(removeJobTemp(root, join(root, "..", "outside"))).toBe(false);
    mkdirSync(join(root, "l1", "deeper"), { recursive: true });
    expect(removeJobTemp(root, join(root, "l1", "deeper"))).toBe(false);
    expect(existsSync(join(root, "l1", "deeper"))).toBe(true);
    expect(removeJobTemp(root, join(root, "l1"))).toBe(true);
    expect(existsSync(join(root, "l1"))).toBe(false);
    expect(existsSync(join(outside, "precious.txt"))).toBe(true);
  });

  it("sweeps only the folders of ended leases, and follows no link or junction", () => {
    const ended = new Set(["l-ended", "l-kept", "l-link", "l-file"]);
    mkdirSync(join(root, "l-ended", "sub"), { recursive: true });
    writeFileSync(join(root, "l-ended", "sub", "trace.bin"), "x".repeat(1000));
    // A junction inside a folder of an ended lease: the sweep removes the junction, not its target.
    symlinkSync(outside, join(root, "l-ended", "inner"), "junction");
    mkdirSync(join(root, "l-active"));
    mkdirSync(join(root, "l-unknown"));
    mkdirSync(join(root, "not.a.lease"));
    mkdirSync(join(root, "l-kept"));
    keepJobTemp(join(root, "l-kept"));
    writeFileSync(join(root, "l-file"), "a file, not a folder");
    // A junction named as an ended lease: the sweep does not follow it and does not remove it.
    symlinkSync(outside, join(root, "l-link"), "junction");

    expect(sweepJobTemp(root, (id) => ended.has(id))).toEqual(["l-ended"]);
    expect(existsSync(join(root, "l-ended"))).toBe(false);
    for (const name of ["l-active", "l-unknown", "not.a.lease", "l-kept", "l-file", "l-link"]) expect(existsSync(join(root, name))).toBe(true);
    expect(existsSync(join(root, "l-kept", KEEP_MARK))).toBe(true);
    expect(existsSync(join(outside, "precious.txt"))).toBe(true);
  });

  it("sweeps nothing without a usable temp root", () => {
    expect(sweepJobTemp("relative", () => true)).toEqual([]);
    expect(sweepJobTemp(join(base, "missing"), () => true)).toEqual([]);
  });

  it("gives the size of a folder without the targets of its links", () => {
    const folder = join(root, "l1");
    mkdirSync(join(folder, "sub"), { recursive: true });
    writeFileSync(join(folder, "a.bin"), Buffer.alloc(512 * 1024));
    writeFileSync(join(folder, "sub", "b.bin"), Buffer.alloc(512 * 1024));
    writeFileSync(join(outside, "big.bin"), Buffer.alloc(4 * 1024 * 1024));
    symlinkSync(outside, join(folder, "link"), "junction");
    expect(folderSizeMb(folder)).toBe(1);
    // With a limit of 1 entry, the size is a lower limit.
    expect(folderSizeMb(folder, 1)).toBeLessThan(1);
  });
});
