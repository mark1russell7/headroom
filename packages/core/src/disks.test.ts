import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { largeFileDirs, largeFiles } from "./disks.ts";
import { MB } from "./sampler.ts";

describe("largeFiles", () => {
  it("gives the new large files of the folders, the largest first, without the sub-folders", () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-files-"));
    const kb = (name: string, size: number): string => {
      const path = join(dir, name);
      writeFileSync(path, Buffer.alloc(size * 1024));
      return path;
    };
    kb("small.log", 1);
    const medium = kb("medium.etl", 40);
    const big = kb("big.etl", 80);
    const old = kb("old.iso", 120);
    utimesSync(old, new Date(2020, 0, 1), new Date(2020, 0, 1));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "deep.etl"), Buffer.alloc(200 * 1024));
    const since = Date.now() - 3_600_000;
    const found = largeFiles([dir, join(dir, "missing")], since, 16 / 1024);
    expect(found.map((file) => file.path)).toEqual([big, medium]);
    expect(found[0]?.mb).toBeCloseTo((80 * 1024) / MB);
    expect(largeFiles([dir], since, 16 / 1024, 1).map((file) => file.path)).toEqual([big]);
  });

  it("searches the home folder, the downloads, the temporary folders and the root of each drive", () => {
    const dirs = largeFileDirs(["C:", "D:"], "win32", "C:\\Users\\<you>");
    expect(dirs).toContain("C:\\Windows\\Temp");
    expect(dirs.slice(-2)).toEqual(["C:\\", "D:\\"]);
    expect(dirs.filter((dir) => dir.toLowerCase().endsWith("temp")).length).toBeLessThanOrEqual(3);
  });
});
