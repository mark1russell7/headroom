import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEEP_MARK } from "@headroom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diskAmounts, finishTemp, jobEnv, jobLimits, prepareTemp } from "./job.ts";

describe("diskAmounts", () => {
  it("names the drive of the current folder, or the named drive, and adds two amounts of one drive", () => {
    const here = () => "D:\\git\\headroom";
    expect(diskAmounts(["5g", "C:=1g", "d=500m"], [], { here, platform: "win32" })).toEqual({ "disk:D:": 5620, "disk:C:": 1024 });
    expect(diskAmounts(["2g"], ["/", "/home/mark"], { here: () => "/home/mark/git", platform: "linux" })).toEqual({ "disk:/home/mark": 2048 });
    expect(diskAmounts(["2g"], [], { here: () => "\\\\server\\share", platform: "win32" })).toMatch(/on no fixed drive/);
  });
});

describe("jobLimits (H23)", () => {
  it("gives a hard cap of the cores of the lease with --limit, and the default weight without it", () => {
    expect(jobLimits({ limit: true, leaseMb: 2048, leaseCores: 4 }, 50, 16)).toEqual({ memoryMb: 2048 + 50 + 64, cpuRate: 2500 });
    expect(jobLimits({ limit: true, leaseMb: null, leaseCores: 1 }, 50, 16)).toEqual({ cpuRate: 625 });
    // --limit with only --mem: the memory limit, and the weight for the processors.
    expect(jobLimits({ limit: true, leaseMb: 1024 }, 40, 16)).toEqual({ memoryMb: 1128, cpuWeight: 5 });
    expect(jobLimits({ limit: false, leaseMb: 1024, leaseCores: 4 }, 40, 16)).toEqual({ cpuWeight: 5 });
  });
});

describe("jobEnv", () => {
  it("replaces the temp variables of the parent, also with another case", () => {
    const env = jobEnv({ TEMP: "D:\\t\\l1", TMP: "D:\\t\\l1" }, { Temp: "C:\\old", tmp: "C:\\old", PATH: "C:\\bin" });
    expect(env).toEqual({ PATH: "C:\\bin", TEMP: "D:\\t\\l1", TMP: "D:\\t\\l1" });
  });
});

describe("the temp folder of a run", () => {
  let base = "";
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "headroom-run-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const daemon = (jobTemp: string | null) => ({ call: async <T>(): Promise<T> => ({ jobTemp }) as T });

  it("makes no folder without the setting, or with a daemon that has no settings", async () => {
    expect(await prepareTemp(daemon(null), "l1")).toBeNull();
    expect(await prepareTemp({ call: () => Promise.reject(new Error("no procedure")) }, "l1")).toBeNull();
  });

  it("makes the folder of the lease before the job, and removes it after the job", async () => {
    const root = join(base, "tmp");
    const temp = await prepareTemp(daemon(root), "l1");
    expect(temp?.env).toEqual({ TEMP: join(root, "l1"), TMP: join(root, "l1"), TMPDIR: join(root, "l1") });
    expect(existsSync(join(root, "l1"))).toBe(true);
    writeFileSync(join(root, "l1", "out.bin"), Buffer.alloc(1024 * 1024));
    expect(finishTemp(temp!, false)).toBe(1);
    expect(existsSync(join(root, "l1"))).toBe(false);
  });

  it("keeps the folder with --keep-temp, with the mark that the sweep respects", async () => {
    const root = join(base, "tmp");
    const temp = await prepareTemp(daemon(root), "l2");
    finishTemp(temp!, true);
    expect(existsSync(join(root, "l2", KEEP_MARK))).toBe(true);
  });
});
