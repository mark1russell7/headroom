import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEEP_MARK } from "@headroom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDrive } from "./disk-cli.ts";
import {
  driveMatches,
  driveOf,
  findBeforeDevdrive,
  knownPlaces,
  parseWslImages,
  readReport,
  readSummary,
  reportLines,
  runReport,
  saveReport,
  storeRootOf,
  type Place,
} from "./disk-report.ts";

const LXSS = [
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss",
  "    DefaultDistribution    REG_SZ    {7e230e2c}",
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{7e230e2c}",
  "    DistributionName    REG_SZ    docker-desktop",
  "    BasePath    REG_SZ    \\\\?\\C:\\Users\\<you>\\AppData\\Local\\Docker\\wsl\\main",
  "    VhdFileName    REG_SZ    ext4.vhdx",
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{11111111}",
  "    DistributionName    REG_SZ    Ubuntu",
  "    BasePath    REG_SZ    D:\\wsl\\Ubuntu Main",
  "",
].join("\r\n");

describe("the disk report (H21)", () => {
  let base = "";

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "headroom-report-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("reads the disk images of the WSL distributions from the registry output", () => {
    expect(parseWslImages(LXSS)).toEqual(["C:\\Users\\<you>\\AppData\\Local\\Docker\\wsl\\main\\ext4.vhdx", "D:\\wsl\\Ubuntu Main\\ext4.vhdx"]);
    expect(parseWslImages("")).toEqual([]);
  });

  it("gives the drive of a path and of --drive, and the store folder of a store version", () => {
    expect(driveOf("d:\\git\\headroom", "win32")).toBe("D:");
    expect(driveOf("/home/mark", "linux")).toBeNull();
    expect(driveMatches("D:", "d")).toBe(true);
    expect(driveMatches("C:", "D:")).toBe(false);
    expect(driveMatches(null, null)).toBe(true);
    expect(parseDrive(undefined)).toBeNull();
    for (const value of ["d", "D", "D:", "d:\\"]) expect(parseDrive(value)).toBe("D:");
    for (const value of ["DD", "1", ":", "D:/x"]) expect(parseDrive(value)).toBeUndefined();
    expect(storeRootOf("D:\\packages\\pnpm-store\\v11")).toBe("D:\\packages\\pnpm-store");
    expect(storeRootOf("/home/u/.local/share/pnpm/store/v10")).toBe("/home/u/.local/share/pnpm/store");
    expect(storeRootOf("D:\\packages\\pnpm-store")).toBe("D:\\packages\\pnpm-store");
    expect(storeRootOf("D:\\vault")).toBe("D:\\vault");
  });

  it("finds the *.before-devdrive copies, in any case of the name", () => {
    mkdirSync(join(base, "git.before-devdrive"));
    mkdirSync(join(base, "Jarvis.BEFORE-DEVDRIVE"));
    mkdirSync(join(base, "git"));
    expect(findBeforeDevdrive([base, join(base, "absent")])).toEqual([join(base, "Jarvis.BEFORE-DEVDRIVE"), join(base, "git.before-devdrive")].sort());
  });

  it("gives the known places with their classes: kept copies, live and ended job folders, images, the store and node_modules", () => {
    const local = join(base, "Local");
    const roaming = join(base, "Roaming");
    mkdirSync(join(local, "Docker", "wsl", "disk"), { recursive: true });
    writeFileSync(join(local, "Docker", "wsl", "disk", "docker_data.vhdx"), Buffer.alloc(2048));
    mkdirSync(join(base, "git.before-devdrive"));
    mkdirSync(join(base, "git", "repo", "node_modules"), { recursive: true });
    const tempRoot = join(base, "tmp");
    for (const id of ["lease-a", "lease-b", "lease-c"]) mkdirSync(join(tempRoot, id), { recursive: true });
    writeFileSync(join(tempRoot, "lease-c", KEEP_MARK), "keep");
    const places = knownPlaces({
      platform: "win32",
      env: { LOCALAPPDATA: local, APPDATA: roaming, SystemRoot: join(base, "Windows") },
      home: base,
      drives: [],
      daemon: { tempRoot, live: new Set(["lease-a"]) },
      pnpmStore: join(base, "store", "v11"),
      wslImages: [join(local, "Docker", "wsl", "disk", "docker_data.vhdx"), "D:\\wsl\\Ubuntu\\ext4.vhdx"],
    });
    const byId = new Map(places.map((place) => [place.id, place]));
    expect(byId.get(`docker:${join(local, "Docker", "wsl", "disk", "docker_data.vhdx")}`)?.class).toBe("image");
    // The image of Docker is in the list of WSL too. The report names it one time.
    expect(places.filter((place) => place.class === "image").map((place) => place.paths[0])).toEqual([join(local, "Docker", "wsl", "disk", "docker_data.vhdx"), "D:\\wsl\\Ubuntu\\ext4.vhdx"]);
    expect(byId.get(`before-devdrive:${join(base, "git.before-devdrive")}`)?.class).toBe("kept");
    expect(byId.get("job-temp:live")?.paths).toEqual([join(tempRoot, "lease-a")]);
    expect(byId.get("job-temp:ended")).toMatchObject({ class: "clean", paths: [join(tempRoot, "lease-b")] });
    expect(byId.get("job-temp:kept")).toMatchObject({ class: "kept", paths: [join(tempRoot, "lease-c")] });
    expect(byId.get("pnpm-store")).toMatchObject({ class: "clean", paths: [join(base, "store")] });
    expect(byId.get("node_modules:repo")).toMatchObject({ class: "ask", paths: [join(base, "git", "repo", "node_modules")] });
    expect(byId.get("temp")?.class).toBe("part");
  });

  it("sizes the places in the time budget, marks the kept copies, and touches no file", async () => {
    mkdirSync(join(base, "cache"));
    writeFileSync(join(base, "cache", "a.bin"), Buffer.alloc(3 * 1024 * 1024));
    mkdirSync(join(base, "git.before-devdrive"));
    writeFileSync(join(base, "git.before-devdrive", "b.bin"), Buffer.alloc(1024 * 1024));
    const places: Place[] = [
      { id: "cache", label: "A cache", paths: [join(base, "cache")], class: "ask", how: "Remove it." },
      { id: `before-devdrive:${join(base, "git.before-devdrive")}`, label: "Copy", paths: [join(base, "git.before-devdrive")], class: "kept" },
      { id: "absent", label: "Absent", paths: [join(base, "absent")], class: "ask" },
    ];
    const report = await runReport({ mode: "quick", drive: null, places, drives: [{ mount: "C:", freeMb: 1000, totalMb: 5000 }], deepRoots: [], platform: "linux", budgetMs: 10_000 });
    expect(report.items.map((each) => [each.id, Math.round(each.mb), each.partial, each.missing])).toEqual([
      ["cache", 3, false, false],
      [`before-devdrive:${join(base, "git.before-devdrive")}`, 1, false, false],
      ["absent", 0, false, true],
    ]);
    expect(report.summary.top.map((each) => each.label)).toEqual(["A cache", "Copy"]);
    const lines = reportLines(report, null).join("\n");
    expect(lines).toContain("Drive C: has 1000 MB free of 4.9 GB.");
    expect(lines).toContain(`Kept until Mark decides: ${join(base, "git.before-devdrive")} (1 MB).`);
    expect(existsSync(join(base, "git.before-devdrive", "b.bin"))).toBe(true);
    expect(existsSync(join(base, "cache", "a.bin"))).toBe(true);
  });

  it("gives a partial result with a note when the time budget runs out", async () => {
    mkdirSync(join(base, "many"));
    for (let index = 0; index < 30; index++) writeFileSync(join(base, "many", `f${index}`), "x");
    let tick = 0;
    const report = await runReport({
      mode: "quick",
      drive: null,
      places: [{ id: "many", label: "Many files", paths: [join(base, "many")], class: "ask" }],
      drives: [],
      deepRoots: [],
      platform: "linux",
      budgetMs: 20,
      now: () => tick++,
    });
    expect(report.items[0]?.partial).toBe(true);
    expect(report.summary.partial).toBe(1);
    expect(reportLines(report, null).join("\n")).toContain("Partial places: 1. The time ran out");
  });

  it("gives the largest folders under a root to depth 3 in the deep mode", async () => {
    mkdirSync(join(base, "a", "b"), { recursive: true });
    writeFileSync(join(base, "a", "b", "big.bin"), Buffer.alloc(2 * 1024 * 1024));
    const report = await runReport({ mode: "deep", drive: null, places: [], drives: [], deepRoots: [base], platform: "linux", budgetMs: 60_000 });
    expect(report.deep[0]?.folders.map((each) => [each.path, Math.round(each.mb)])).toEqual([
      [join(base, "a"), 2],
      [join(base, "a", "b"), 2],
    ]);
  });

  it("saves the report, and the daemon reads its summary", async () => {
    const report = await runReport({ mode: "quick", drive: null, places: [], drives: [], deepRoots: [], platform: "linux" });
    const path = join(base, "home", "disk-report.json");
    await saveReport(path, report);
    expect(readReport(path)?.at).toBe(report.at);
    expect(readSummary(path)).toEqual(report.summary);
    expect(readSummary(join(base, "absent.json"))).toBeNull();
    writeFileSync(join(base, "bad.json"), "{");
    expect(readSummary(join(base, "bad.json"))).toBeNull();
  });
});
