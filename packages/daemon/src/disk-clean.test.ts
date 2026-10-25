import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEEP_MARK, type JobPhase } from "@headroom/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  askList,
  isPnpmProcess,
  isTraceFile,
  isTraceFolder,
  logDelete,
  planPrune,
  planTraces,
  pnpmProcesses,
  refusal,
  runClean,
  TRACE_AGE_MS,
  type CleanOptions,
  type DaemonView,
  type ProcessRow,
} from "./disk-clean.ts";
import type { DaemonFacts, DiskReport, ReportItem } from "./disk-report.ts";

const DAY = 24 * 3_600_000;

/** This function sets the time of change of a path to a number of days ago. */
function age(path: string, days: number): void {
  const at = new Date(Date.now() - days * DAY);
  utimesSync(path, at, at);
}

/** This function gives a fake daemon: its facts, and the state of each lease. With no facts, it does not answer. */
function fakeDaemon(facts: DaemonFacts | null, phases: Readonly<Record<string, JobPhase | null>> = {}): DaemonView {
  return {
    facts: async () => facts,
    phase: async (id) => (facts === null ? undefined : (phases[id] ?? null)),
  };
}

/** This function gives one place of a report. */
function item(id: string, mb: number, cls: ReportItem["class"], path = `C:\\${id}`): ReportItem {
  return { id, label: id, paths: [path], drive: "C:", class: cls, mb, files: 1, partial: false, missing: false, links: 0, errors: 0 };
}

/** This function gives a report with some places. */
function reportWith(items: readonly ReportItem[]): DiskReport {
  const at = new Date().toISOString();
  return {
    version: 1,
    at,
    mode: "quick",
    drive: null,
    ms: 1000,
    budgetMs: 30_000,
    drives: [],
    items,
    deep: [],
    notes: [],
    summary: { at, mode: "quick", ms: 1000, drives: [], top: [], partial: 0 },
  };
}

describe("the safe cleanup (H21)", () => {
  let base = "";
  let temp = "";
  let root = "";
  let log = "";

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "headroom-clean-"));
    temp = join(base, "user-temp");
    root = join(base, "job-temp");
    log = join(base, "home", "disk-clean.log");
    mkdirSync(temp);
    mkdirSync(root);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** This function gives the options of a cleanup in the test folders. */
  function options(view: DaemonView, more: Partial<CleanOptions> = {}): CleanOptions {
    return {
      apply: false,
      view,
      userTemp: temp,
      fenced: [join(base, "git")],
      store: null,
      processes: async () => [],
      prune: vi.fn(async () => "pruned"),
      report: null,
      log,
      ...more,
    };
  }

  it("matches the trace files and the Playwright folders by their exact name patterns", () => {
    for (const name of ["node_trace.1.log", "NODE_TRACE.12.LOG", "CPU.20261001.cpuprofile", "Heap.heapsnapshot", "x.heapprofile"]) expect(isTraceFile(name)).toBe(true);
    for (const name of ["node_trace.log", "notes.log", "trace.json", ".cpuprofile", "a.before-devdrive.cpuprofile", "report.json"]) expect(isTraceFile(name)).toBe(false);
    for (const name of ["playwright-artifacts-AbC", "playwright_chromiumdev_profile-x1", "playwright_firefoxdev_profile-y"]) expect(isTraceFolder(name)).toBe(true);
    for (const name of ["playwright-artifacts-", "playwright-transform-cache", "ms-playwright", "playwright-artifacts-1.before-devdrive"]) expect(isTraceFolder(name)).toBe(false);
  });

  it("plans only the old trace items directly in each folder", async () => {
    writeFileSync(join(temp, "old.cpuprofile"), Buffer.alloc(300));
    age(join(temp, "old.cpuprofile"), 10);
    writeFileSync(join(temp, "node_trace.3.log"), Buffer.alloc(200));
    age(join(temp, "node_trace.3.log"), 8);
    writeFileSync(join(temp, "young.heapsnapshot"), Buffer.alloc(100));
    writeFileSync(join(temp, "notes.txt"), "old notes of the user");
    age(join(temp, "notes.txt"), 30);
    mkdirSync(join(temp, "sub"));
    writeFileSync(join(temp, "sub", "deeper.cpuprofile"), "x");
    age(join(temp, "sub", "deeper.cpuprofile"), 30);
    // An old Playwright folder: each entry is old.
    mkdirSync(join(temp, "playwright-artifacts-old"));
    writeFileSync(join(temp, "playwright-artifacts-old", "trace.zip"), Buffer.alloc(400));
    age(join(temp, "playwright-artifacts-old", "trace.zip"), 9);
    age(join(temp, "playwright-artifacts-old"), 9);
    // A Playwright folder with an old time, but a new file inside: a run still uses it.
    mkdirSync(join(temp, "playwright-artifacts-new"));
    writeFileSync(join(temp, "playwright-artifacts-new", "trace.zip"), "x");
    age(join(temp, "playwright-artifacts-new"), 9);

    const plan = await planTraces([temp], Number.POSITIVE_INFINITY);
    expect(plan.items.map((each) => each.path).sort()).toEqual([join(temp, "node_trace.3.log"), join(temp, "old.cpuprofile"), join(temp, "playwright-artifacts-old")].sort());
    expect(plan.mb * 1024 * 1024).toBeCloseTo(900);
    expect(plan.notes.join(" ")).toContain("Trace items younger than 7 days, not touched: 2.");
  });

  it("deletes nothing in a dry run, and with --apply deletes only the planned items and logs each one", async () => {
    writeFileSync(join(temp, "old.cpuprofile"), Buffer.alloc(300));
    age(join(temp, "old.cpuprofile"), 10);
    for (const id of ["lease-ended", "lease-live", "lease-running", "lease-unknown", "lease-kept"]) {
      mkdirSync(join(root, id));
      writeFileSync(join(root, id, "data.bin"), Buffer.alloc(1000));
    }
    writeFileSync(join(root, "lease-kept", KEEP_MARK), "keep");
    mkdirSync(join(root, "not.a.lease"));
    const view = fakeDaemon({ tempRoot: root, live: new Set(["lease-live"]) }, { "lease-ended": "exited", "lease-running": "running", "lease-kept": "exited", "lease-live": "running" });

    const dry = await runClean(options(view));
    expect(dry.applied).toBe(false);
    const jobTemp = dry.kinds.find((kind) => kind.kind === "job-temp");
    expect(jobTemp?.items.map((each) => each.path)).toEqual([join(root, "lease-ended")]);
    expect(jobTemp?.notes.join(" ")).toMatch(/live jobs, not touched: 2.*--keep-temp, not touched: 1.*does not know, for Mark: 1/);
    expect(dry.kinds.find((kind) => kind.kind === "trace")?.count).toBe(1);
    expect(existsSync(join(root, "lease-ended"))).toBe(true);
    expect(existsSync(join(temp, "old.cpuprofile"))).toBe(true);
    expect(existsSync(log)).toBe(false);

    const applied = await runClean(options(view, { apply: true }));
    expect(applied.kinds.flatMap((kind) => kind.done).filter((done) => done.ok)).toHaveLength(2);
    expect(existsSync(join(root, "lease-ended"))).toBe(false);
    expect(existsSync(join(temp, "old.cpuprofile"))).toBe(false);
    for (const id of ["lease-live", "lease-running", "lease-unknown", "lease-kept", "not.a.lease"]) expect(existsSync(join(root, id))).toBe(true);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.some((line) => line.endsWith(`\tjob-temp\t0.0 MB\t${join(root, "lease-ended")}`))).toBe(true);
    expect(lines.some((line) => line.endsWith(`\ttrace\t0.0 MB\t${join(temp, "old.cpuprofile")}`))).toBe(true);
  });

  it("removes no temp folder of a job when the daemon does not answer", async () => {
    mkdirSync(join(root, "lease-ended"));
    const plan = await runClean(options(fakeDaemon(null), { apply: true }));
    const jobTemp = plan.kinds.find((kind) => kind.kind === "job-temp");
    expect(jobTemp?.skipped).toMatch(/does not answer/);
    expect(existsSync(join(root, "lease-ended"))).toBe(true);
    expect(plan.kinds.find((kind) => kind.kind === "pnpm-prune")?.skipped).toBe("`pnpm store path` gave no answer.");
  });

  it("refuses a *.before-devdrive copy, a disk image, a fenced folder and a path that is not directly in a temp folder", () => {
    const fenced = [join(base, "git")];
    expect(refusal(join(temp, "git.before-devdrive"), [temp], fenced)).toMatch(/before-devdrive/);
    expect(refusal(join(temp, "Jarvis.BEFORE-DEVDRIVE"), [temp], fenced)).toMatch(/before-devdrive/);
    expect(refusal(join(temp, "docker_data.vhdx"), [temp], fenced)).toMatch(/disk image/);
    expect(refusal(join(base, "git", "repo", "x.cpuprofile"), [join(base, "git", "repo")], fenced)).toMatch(/it is in/);
    expect(refusal(join(temp, "sub", "x.cpuprofile"), [temp], fenced)).toMatch(/not directly/);
    expect(refusal(join(temp, "x.cpuprofile"), [temp], fenced)).toBeNull();
  });

  it("does not delete a *.before-devdrive copy or a trace file in a fenced folder, also with --apply", async () => {
    mkdirSync(join(temp, "git.before-devdrive"));
    writeFileSync(join(temp, "git.before-devdrive", "old.cpuprofile"), "x");
    age(join(temp, "git.before-devdrive", "old.cpuprofile"), 30);
    age(join(temp, "git.before-devdrive"), 30);
    mkdirSync(join(temp, "playwright-artifacts-1.before-devdrive"));
    age(join(temp, "playwright-artifacts-1.before-devdrive"), 30);
    writeFileSync(join(temp, "x.before-devdrive.heapsnapshot"), "x");
    age(join(temp, "x.before-devdrive.heapsnapshot"), 30);
    const fencedTemp = join(base, "git", "temp");
    mkdirSync(fencedTemp, { recursive: true });
    writeFileSync(join(fencedTemp, "old.cpuprofile"), "x");
    age(join(fencedTemp, "old.cpuprofile"), 30);

    const plan = await runClean(options(fakeDaemon({ tempRoot: null, live: new Set() }), { apply: true }));
    expect(plan.kinds.find((kind) => kind.kind === "trace")?.count).toBe(0);
    for (const name of ["git.before-devdrive", "playwright-artifacts-1.before-devdrive", "x.before-devdrive.heapsnapshot"]) expect(existsSync(join(temp, name))).toBe(true);

    const fenced = await runClean(options(fakeDaemon({ tempRoot: null, live: new Set() }), { apply: true, userTemp: fencedTemp }));
    const traces = fenced.kinds.find((kind) => kind.kind === "trace");
    expect(traces?.count).toBe(1);
    expect(traces?.done[0]).toMatchObject({ ok: false });
    expect(traces?.done[0]?.reason).toMatch(/it is in/);
    expect(existsSync(join(fencedTemp, "old.cpuprofile"))).toBe(true);
  });

  it("finds the pnpm processes, but not this process and its parents", () => {
    const rows: ProcessRow[] = [
      { pid: 10, ppid: 1, name: "node.exe", command: "node C:\\nvm4w\\nodejs\\node_modules\\pnpm\\bin\\pnpm.cjs headroom disk clean" },
      { pid: 20, ppid: 10, name: "node.exe", command: "node packages/daemon/src/cli.ts disk clean" },
      { pid: 30, ppid: 1, name: "node.exe", command: "node D:\\tools\\pnpm\\dist\\pnpm.cjs install" },
      { pid: 40, ppid: 1, name: "pnpm.exe", command: "pnpm test" },
      { pid: 50, ppid: 1, name: "node.exe", command: "node server.js" },
    ];
    expect(isPnpmProcess(rows[0] as ProcessRow)).toBe(true);
    expect(isPnpmProcess(rows[4] as ProcessRow)).toBe(false);
    expect(pnpmProcesses(rows, 20).map((row) => row.pid)).toEqual([30, 40]);
  });

  it("runs pnpm store prune only when no lease is live, no pnpm runs, and the store keeps hard links", async () => {
    const store = join(base, "store");
    const project = join(base, "project");
    mkdirSync(join(store, "files", "00"), { recursive: true });
    mkdirSync(project);
    for (let index = 0; index < 4; index++) {
      writeFileSync(join(store, "files", "00", `used${index}`), Buffer.alloc(1000));
      linkSync(join(store, "files", "00", `used${index}`), join(project, `used${index}`));
    }
    writeFileSync(join(store, "files", "00", "unused"), Buffer.alloc(500));
    const idle = { tempRoot: null, live: new Set<string>() };

    const busy = await planPrune({ tempRoot: null, live: new Set(["l1", "l2"]) }, [], store, Number.POSITIVE_INFINITY);
    expect(busy.skipped).toMatch(/Live leases: 2./);
    const running = await planPrune(idle, [{ pid: 77, ppid: 1, name: "pnpm.exe", command: "pnpm install" }], store, Number.POSITIVE_INFINITY, { self: 5 });
    expect(running.skipped).toMatch(/pnpm runs \(process 77\)/);
    const unread = await planPrune(idle, null, store, Number.POSITIVE_INFINITY);
    expect(unread.skipped).toMatch(/process list cannot be read/);
    const clear = await planPrune(idle, [], store, Number.POSITIVE_INFINITY);
    expect(clear.skipped).toBeNull();
    expect(clear.items[0]?.mb).toBeCloseTo(500 / (1024 * 1024));

    const prune = vi.fn(async () => "Removed 1 file");
    const dry = await runClean(options(fakeDaemon(idle), { store, prune }));
    expect(dry.kinds.find((kind) => kind.kind === "pnpm-prune")?.skipped).toBeNull();
    expect(prune).not.toHaveBeenCalled();
    await runClean(options(fakeDaemon(idle), { store, prune, apply: true }));
    expect(prune).toHaveBeenCalledTimes(1);
    expect(readFileSync(log, "utf8")).toContain(`\tpnpm-prune\t`);
  });

  it("skips pnpm store prune when most of the store has one link, as with the block clones of a Dev Drive", async () => {
    const store = join(base, "store");
    mkdirSync(join(store, "files", "00"), { recursive: true });
    for (let index = 0; index < 3; index++) writeFileSync(join(store, "files", "00", `clone${index}`), Buffer.alloc(1000));
    const prune = vi.fn(async () => "Removed everything");
    const plan = await runClean(options(fakeDaemon({ tempRoot: null, live: new Set() }), { store, prune, apply: true }));
    const kind = plan.kinds.find((each) => each.kind === "pnpm-prune");
    expect(kind?.skipped).toMatch(/100% of the store has one link/);
    expect(prune).not.toHaveBeenCalled();
  });

  it("gives Mark each large place that the cleanup does not delete, and each kept copy", () => {
    const report = reportWith([
      item("docker", 55_000, "image"),
      item("before-devdrive:C:\\Users\\markt\\git.before-devdrive", 10, "kept"),
      item("pnpm-store", 9000, "clean"),
      item("job-temp:live", 5000, "live"),
      item("small", 100, "ask"),
      item("playwright", 3700, "ask"),
    ]);
    expect(askList(report).map((each) => each.label)).toEqual(["docker", "playwright", "before-devdrive:C:\\Users\\markt\\git.before-devdrive"]);
    expect(askList(null)).toEqual([]);
  });

  it("logs the time, the kind, the size and the path of a delete", async () => {
    await logDelete(log, "trace", "C:\\Temp\\x.cpuprofile", 12.345, new Date("2026-10-25T06:00:00.000Z"));
    expect(readFileSync(log, "utf8")).toBe("2026-10-25T06:00:00.000Z\ttrace\t12.3 MB\tC:\\Temp\\x.cpuprofile\n");
  });

  it("keeps the age of an old trace file at 7 days", () => {
    expect(TRACE_AGE_MS).toBe(7 * DAY);
  });
});
