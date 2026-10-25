/**
 * The safe cleanup (H21): `headroom disk clean [--apply] [--json]`.
 *
 * The cleanup is a dry run. It deletes only with `--apply`, and it deletes only 3 kinds of data that are disposable by definition:
 *
 * 1. The temp folders of the jobs whose lease ended. The daemon tells the state of each lease. With no answer, this kind does nothing.
 * 2. The old trace files directly in the temp folder of the user and in the temp root: exact name patterns, 7 days or older.
 * 3. `pnpm store prune`, only when no lease is live, no pnpm process runs, and the store keeps hard links.
 *
 * Each other large place goes to the list for Mark, with its size. The cleanup refuses each path with `.before-devdrive` in it,
 * each disk image and each path in the folder of the repositories. The log `~/.headroom/disk-clean.log` gets one line for each delete.
 */

import { existsSync } from "node:fs";
import { appendFile, lstat, mkdir, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { diskSize, isDirectlyUnder, isLeaseId, KEEP_MARK, removeJobTemp, type JobPhase } from "@headroom/core";
import { walk } from "./disk-walk.ts";
import { BEFORE_DEVDRIVE, CLASS_TEXT, listFolder, runPnpm, runProgram, type DaemonFacts, type DiskReport, type PlaceClass } from "./disk-report.ts";

/** The age of an old trace file: 7 days. */
export const TRACE_AGE_MS: number = 7 * 24 * 3_600_000;

/** The time budget of the cleanup for its walks, in ms. */
export const CLEAN_BUDGET_MS = 30_000;

/** The smallest place in the list for Mark, in MB. */
export const ASK_MIN_MB = 1024;

/** Above this part of one-link bytes, `pnpm store prune` removes most of the store. Then the cleanup does not run it. */
export const PRUNE_ONE_LINK_LIMIT = 0.5;

/** The kinds of the cleanup. */
export type CleanKind = "job-temp" | "trace" | "pnpm-prune";

/** One item that the cleanup can delete. */
export interface CleanItem {
  readonly kind: CleanKind;
  readonly path: string;
  readonly mb: number;
  readonly files: number;
}

/** The result of the delete of one item, with `--apply`. */
export interface CleanDone {
  readonly path: string;
  readonly mb: number;
  readonly ok: boolean;
  /** Why the delete did not occur, for example a file that a process holds open. */
  readonly reason: string | null;
}

/** The plan of one kind. */
export interface KindPlan {
  readonly kind: CleanKind;
  readonly title: string;
  readonly items: readonly CleanItem[];
  readonly mb: number;
  readonly count: number;
  /** Why the kind does nothing, or `null`. */
  readonly skipped: string | null;
  readonly notes: readonly string[];
  /** The result of each delete, with `--apply`. */
  readonly done: readonly CleanDone[];
}

/** One place for Mark: the cleanup does not delete it. */
export interface AskItem {
  readonly label: string;
  readonly paths: readonly string[];
  readonly mb: number;
  readonly partial: boolean;
  readonly class: PlaceClass;
  readonly how: string | null;
}

/** The result of the cleanup. */
export interface CleanPlan {
  readonly at: string;
  readonly applied: boolean;
  readonly kinds: readonly KindPlan[];
  readonly ask: readonly AskItem[];
  /** The time of the report that gave the list for Mark, or `null`. */
  readonly reportAt: string | null;
  readonly log: string;
}

/** What the daemon tells the cleanup. */
export interface DaemonView {
  /** This function gives the temp root and the ids of the live leases, or `null` when the daemon does not answer. */
  facts(): Promise<DaemonFacts | null>;
  /** This function gives the state of one lease. `null`: the daemon does not know the lease. `undefined`: the daemon does not answer. */
  phase(id: string): Promise<JobPhase | null | undefined>;
}

/** One process of the process list. */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly command: string;
}

/** The start and the end of the name of a trace file of Node: `node_trace.<n>.log`. */
const NODE_TRACE = { start: "node_trace.", end: ".log" };

/** The name ends of the profiles and the heap snapshots of Node and of the browsers. */
const PROFILE_ENDS: readonly string[] = [".cpuprofile", ".heapsnapshot", ".heapprofile"];

/** The name starts of the temp folders of Playwright: the artifacts of a test run, and the temp profiles of the browsers. */
const PLAYWRIGHT_STARTS: readonly string[] = ["playwright-artifacts-", "playwright_chromiumdev_profile-", "playwright_firefoxdev_profile-"];

/** This function tells if a file name is an old trace or crash file: `node_trace.*.log`, `*.cpuprofile`, `*.heapsnapshot` or `*.heapprofile`. */
export function isTraceFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.includes(BEFORE_DEVDRIVE)) return false;
  const trace = lower.startsWith(NODE_TRACE.start) && lower.endsWith(NODE_TRACE.end) && lower.length > NODE_TRACE.start.length + NODE_TRACE.end.length;
  return trace || PROFILE_ENDS.some((end) => lower.endsWith(end) && lower.length > end.length);
}

/** This function tells if a folder name is a temp folder of Playwright: `playwright-artifacts-*`, or a temp profile of a browser. */
export function isTraceFolder(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.includes(BEFORE_DEVDRIVE)) return false;
  return PLAYWRIGHT_STARTS.some((start) => lower.startsWith(start) && lower.length > start.length);
}

/** This function tells if a path is a folder or a path inside it. */
export function isInside(root: string, path: string): boolean {
  const part = relative(resolve(root), resolve(path));
  return part === "" || (!part.startsWith("..") && !isAbsolute(part));
}

/**
 * This function gives the reason why the cleanup refuses a path, or `null`. It refuses a path with `.before-devdrive` in it
 * and a disk image. It also refuses a path in a fenced folder, and a path that is not directly in a folder of the cleanup.
 */
export function refusal(path: string, parents: readonly string[], fenced: readonly string[]): string | null {
  const lower = path.toLowerCase();
  if (lower.includes(BEFORE_DEVDRIVE)) return "it is a *.before-devdrive copy";
  if (lower.endsWith(".vhdx") || lower.endsWith(".vhd")) return "it is a disk image";
  const fence = fenced.find((root) => isInside(root, path));
  if (fence !== undefined) return `it is in ${fence}`;
  if (!parents.some((parent) => isDirectlyUnder(parent, path))) return "it is not directly in a temp folder of the cleanup";
  return null;
}

/** This function adds one line to the log of the cleanup: the time, the kind, the size and the path. */
export async function logDelete(log: string, kind: CleanKind, path: string, mb: number, at: Date = new Date()): Promise<void> {
  await mkdir(dirname(log), { recursive: true });
  await appendFile(log, `${at.toISOString()}\t${kind}\t${mb.toFixed(1)} MB\t${path}\n`);
}

/** This function gives the MB of a count of bytes. */
const mbOf = (bytes: number): number => bytes / (1024 * 1024);

/** This function gives the sum of the sizes of a list of items. */
const sumMb = (items: readonly { readonly mb: number }[]): number => items.reduce((sum, item) => sum + item.mb, 0);

/** This function gives the plan of a kind from its items. */
function planOf(kind: CleanKind, title: string, items: CleanItem[], skipped: string | null, notes: string[] = []): KindPlan {
  return { kind, title, items, mb: sumMb(items), count: items.length, skipped, notes, done: [] };
}

/** This function gives the error code of an error, for example `EBUSY`, or its message. */
function reasonOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.message : String(error);
}

/** The facts of the daemon, as `DaemonView.facts()` gives them. */
type Facts = Awaited<ReturnType<DaemonView["facts"]>>;

/** This function plans the kind `job-temp`: the folders directly under the temp root whose lease ended. */
export async function planJobTemp(view: DaemonView, facts: Facts, deadline: number, now: () => number = Date.now): Promise<KindPlan> {
  const title = "Temp folders of ended jobs";
  if (facts === null) return planOf("job-temp", title, [], "The daemon does not answer, so the cleanup cannot tell the live jobs. It removes no temp folder.");
  const root = facts.tempRoot;
  if (root === null) return planOf("job-temp", title, [], "No temp root is set (headroom config job-temp).");
  const items: CleanItem[] = [];
  let live = 0;
  let kept = 0;
  let unknown = 0;
  for (const entry of await listFolder(root)) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isLeaseId(entry.name)) continue;
    const path = join(root, entry.name);
    if (existsSync(join(path, KEEP_MARK))) {
      kept++;
      continue;
    }
    if (facts.live.has(entry.name)) {
      live++;
      continue;
    }
    const phase = await view.phase(entry.name);
    if (phase === undefined) return planOf("job-temp", title, [], "The daemon stopped its answers, so the cleanup removes no temp folder.");
    if (phase === null) {
      unknown++;
      continue;
    }
    if (phase !== "exited") {
      live++;
      continue;
    }
    const result = await walk(path, { deadline, now });
    items.push({ kind: "job-temp", path, mb: mbOf(result.bytes), files: result.files });
  }
  const notes = [
    ...(live > 0 ? [`Folders of live jobs, not touched: ${live}.`] : []),
    ...(kept > 0 ? [`Folders with the mark of --keep-temp, not touched: ${kept}.`] : []),
    ...(unknown > 0 ? [`Folders with a lease that the daemon does not know, for Mark: ${unknown}.`] : []),
  ];
  return planOf("job-temp", `${title} (${root})`, items, null, notes);
}

/** This function plans the kind `trace`: the old trace files and Playwright folders directly in each folder. */
export async function planTraces(folders: readonly string[], deadline: number, now: () => number = Date.now): Promise<KindPlan> {
  const items: CleanItem[] = [];
  const cutoff = now() - TRACE_AGE_MS;
  let young = 0;
  let unsure = 0;
  const unique = [...new Map(folders.map((folder) => [resolve(folder).toLowerCase(), folder])).values()];
  for (const folder of unique) {
    for (const entry of await listFolder(folder)) {
      if (entry.isSymbolicLink()) continue;
      const path = join(folder, entry.name);
      if (entry.isFile() && isTraceFile(entry.name)) {
        try {
          const stats = await lstat(path);
          if (stats.mtimeMs <= cutoff) items.push({ kind: "trace", path, mb: mbOf(stats.size), files: 1 });
          else young++;
        } catch {
          // The file is gone.
        }
      } else if (entry.isDirectory() && isTraceFolder(entry.name)) {
        const result = await walk(path, { deadline, now });
        // A folder counts as old only when the walk read each entry, and each one is 7 days or older.
        if (result.partial || result.errors > 0 || result.links > 0) unsure++;
        else if (result.newestMs <= cutoff) items.push({ kind: "trace", path, mb: mbOf(result.bytes), files: result.files });
        else young++;
      }
    }
  }
  const notes = [
    ...(young > 0 ? [`Trace items younger than 7 days, not touched: ${young}.`] : []),
    ...(unsure > 0 ? [`Playwright folders with an entry that the walk did not read, or with a link, not touched: ${unsure}.`] : []),
  ];
  return planOf("trace", `Old trace files, 7 days or older (${unique.join(", ")})`, items, null, notes);
}

/** This function tells if a process is pnpm: `pnpm.exe`, or Node with the script of pnpm. */
export function isPnpmProcess(row: ProcessRow): boolean {
  const name = row.name.toLowerCase();
  if (name === "pnpm.exe" || name === "pnpm") return true;
  if (name !== "node.exe" && name !== "node") return false;
  const command = row.command.toLowerCase().replaceAll("\\", "/");
  return command.includes("pnpm.cjs") || command.includes("pnpm.mjs") || command.includes("/pnpm/bin/") || command.includes("/pnpm/dist/");
}

/** This function gives the pnpm processes of a list, except this process and its parents. A `pnpm headroom disk clean` does not stop the gate. */
export function pnpmProcesses(rows: readonly ProcessRow[], self: number): ProcessRow[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const mine = new Set<number>();
  let pid: number | undefined = self;
  while (pid !== undefined && pid > 0 && !mine.has(pid)) {
    mine.add(pid);
    pid = byPid.get(pid)?.ppid;
  }
  return rows.filter((row) => !mine.has(row.pid) && isPnpmProcess(row));
}

/** The PowerShell script that lists the processes with their command lines, one process for each line. */
const PROCESS_SCRIPT = "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.CommandLine)\" }";

/** This function reads the process list with the command lines, or gives `null` when it cannot. */
export async function listProcesses(platform: NodeJS.Platform = process.platform): Promise<ProcessRow[] | null> {
  if (platform === "win32") {
    const encoded = Buffer.from(PROCESS_SCRIPT, "utf16le").toString("base64");
    const output = await runProgram("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { timeoutMs: 30_000 });
    if (output === null) return null;
    return output.split("\n").flatMap((line) => {
      const [pid, ppid, name, ...rest] = line.replace("\r", "").split("\t");
      const id = Number(pid);
      return Number.isInteger(id) && id > 0 && name !== undefined ? [{ pid: id, ppid: Number(ppid), name, command: rest.join("\t") }] : [];
    });
  }
  const output = await runProgram("ps", ["-eo", "pid=,ppid=,comm=,args="]);
  if (output === null) return null;
  return output.split("\n").flatMap((line) => {
    const parts = line.trim().split(" ").filter((part) => part !== "");
    const [pid, ppid, name, ...rest] = parts;
    const id = Number(pid);
    return Number.isInteger(id) && id > 0 && name !== undefined ? [{ pid: id, ppid: Number(ppid), name, command: rest.join(" ") }] : [];
  });
}

/**
 * This function plans `pnpm store prune`. pnpm removes each file of the store with one hard link (pnpm.io/cli/store, and
 * `storePrune` of pnpm). An install that runs at the same time can lose a file that it added a moment before. Thus the gate needs
 * no live lease, no pnpm process, and a store where most files have more than one link.
 */
export async function planPrune(
  facts: Facts,
  rows: readonly ProcessRow[] | null,
  store: string | null,
  deadline: number,
  options: { readonly now?: () => number; readonly self?: number } = {},
): Promise<KindPlan> {
  const reasons: string[] = [];
  if (store === null) return planOf("pnpm-prune", "pnpm store prune", [], "`pnpm store path` gave no answer.");
  if (facts === null) reasons.push("The daemon does not answer, so the cleanup cannot see the live jobs.");
  else if (facts.live.size > 0) reasons.push(`Live leases: ${facts.live.size}. An install can run in one of them.`);
  if (rows === null) reasons.push("The process list cannot be read.");
  else {
    const pnpm = pnpmProcesses(rows, options.self ?? process.pid);
    if (pnpm.length > 0) reasons.push(`pnpm runs (process ${pnpm.slice(0, 3).map((row) => row.pid).join(", ")}).`);
  }
  const result = await walk(store, { deadline, now: options.now });
  const share = result.bytes > 0 ? result.oneLinkBytes / result.bytes : 0;
  const percent = Math.round(share * 100);
  if (share >= PRUNE_ONE_LINK_LIMIT) {
    reasons.push(
      `${percent}% of the store has one link. pnpm store prune removes each such file. With block clones on a Dev Drive, that is almost the whole store, and each install then downloads it again.`,
    );
  }
  const estimate = `${result.partial ? "An estimate from a part of the store" : "The walk of the store"}: prune removes approximately ${diskSize(mbOf(result.oneLinkBytes))} of ${diskSize(mbOf(result.bytes))} (${percent}%).`;
  const items = [{ kind: "pnpm-prune" as const, path: store, mb: mbOf(result.oneLinkBytes), files: result.files }];
  return planOf("pnpm-prune", `pnpm store prune (${store})`, items, reasons.length === 0 ? null : reasons.join(" "), [estimate]);
}

/** This function gives the list for Mark from a report: each large place that the cleanup does not delete. */
export function askList(report: DiskReport | null): AskItem[] {
  if (report === null) return [];
  return report.items
    .filter((item) => !item.missing && item.class !== "clean" && item.class !== "live" && (item.mb >= ASK_MIN_MB || item.class === "kept"))
    .sort((a, b) => b.mb - a.mb)
    .map((item) => ({ label: item.label, paths: item.paths, mb: item.mb, partial: item.partial, class: item.class, how: item.how ?? null }));
}

/** The options of the cleanup. The command gives the real ones, and the tests give fakes. */
export interface CleanOptions {
  readonly apply: boolean;
  readonly view: DaemonView;
  /** The temp folder of the user. */
  readonly userTemp: string;
  /** The folders where the cleanup deletes nothing, for example the folder of the repositories. */
  readonly fenced: readonly string[];
  readonly store: string | null;
  readonly processes: () => Promise<ProcessRow[] | null>;
  /** This function runs `pnpm store prune` and gives its output, or `null` on an error. */
  readonly prune: () => Promise<string | null>;
  /** The report for the list for Mark. */
  readonly report: DiskReport | null;
  readonly log: string;
  readonly now?: (() => number) | undefined;
  readonly budgetMs?: number | undefined;
  readonly self?: number | undefined;
}

/** This function deletes the temp folders of the ended jobs. It asks the daemon again before each delete. */
async function applyJobTemp(plan: KindPlan, options: CleanOptions, now: () => number): Promise<KindPlan> {
  const done: CleanDone[] = [];
  for (const item of plan.items) {
    const facts = await options.view.facts();
    const root = facts?.tempRoot ?? null;
    const id = basename(item.path);
    const phase = facts === null || root === null ? undefined : await options.view.phase(id);
    const refused = root === null ? "no temp root" : refusal(item.path, [root], options.fenced);
    if (facts === null || root === null || facts.live.has(id) || phase !== "exited" || refused !== null) {
      done.push({ path: item.path, mb: item.mb, ok: false, reason: refused ?? "the lease is not ended, or the daemon does not answer" });
      continue;
    }
    const ok = removeJobTemp(root, item.path);
    if (ok) await logDelete(options.log, "job-temp", item.path, item.mb, new Date(now()));
    done.push({ path: item.path, mb: item.mb, ok, reason: ok ? null : "a process holds a file open" });
  }
  return { ...plan, done };
}

/** This function deletes the old trace files and folders. It examines each path again before the delete. */
async function applyTraces(plan: KindPlan, parents: readonly string[], options: CleanOptions, now: () => number): Promise<KindPlan> {
  const done: CleanDone[] = [];
  for (const item of plan.items) {
    const refused = refusal(item.path, parents, options.fenced);
    if (refused !== null) {
      done.push({ path: item.path, mb: item.mb, ok: false, reason: refused });
      continue;
    }
    try {
      const stats = await lstat(item.path);
      if (stats.isSymbolicLink()) throw Object.assign(new Error("it is a link"), { code: "ELINK" });
      if (stats.isFile() && stats.mtimeMs > now() - TRACE_AGE_MS) throw Object.assign(new Error("it changed"), { code: "ECHANGED" });
      // rm does not follow a link inside a folder. It removes the link itself.
      await rm(item.path, { recursive: stats.isDirectory(), force: false, maxRetries: 2 });
      await logDelete(options.log, "trace", item.path, item.mb, new Date(now()));
      done.push({ path: item.path, mb: item.mb, ok: true, reason: null });
    } catch (error) {
      done.push({ path: item.path, mb: item.mb, ok: false, reason: reasonOf(error) });
    }
  }
  return { ...plan, done };
}

/** This function runs `pnpm store prune` after one more look at the gate. */
async function applyPrune(plan: KindPlan, options: CleanOptions, now: () => number): Promise<KindPlan> {
  const item = plan.items[0];
  if (item === undefined) return plan;
  const facts = await options.view.facts();
  const rows = await options.processes();
  const busy = facts === null || facts.live.size > 0 || rows === null || pnpmProcesses(rows, options.self ?? process.pid).length > 0;
  if (busy) return { ...plan, done: [{ path: item.path, mb: item.mb, ok: false, reason: "a lease or a pnpm process started" }] };
  const output = await options.prune();
  if (output === null) return { ...plan, done: [{ path: item.path, mb: item.mb, ok: false, reason: "pnpm store prune failed" }] };
  await logDelete(options.log, "pnpm-prune", item.path, item.mb, new Date(now()));
  return { ...plan, done: [{ path: item.path, mb: item.mb, ok: true, reason: null }] };
}

/** This function runs the cleanup: the plan of each kind, then the deletes with `apply`, then the list for Mark. */
export async function runClean(options: CleanOptions): Promise<CleanPlan> {
  const now = options.now ?? Date.now;
  const start = now();
  const end = start + (options.budgetMs ?? CLEAN_BUDGET_MS);
  const share = (left: number): number => now() + Math.max(0, end - now()) / left;
  const facts = await options.view.facts();
  let jobTemp = await planJobTemp(options.view, facts, share(3), now);
  const parents = [options.userTemp, ...(facts?.tempRoot ? [facts.tempRoot] : [])];
  let traces = await planTraces(parents, share(2), now);
  const rows = await options.processes();
  let prune = await planPrune(facts, rows, options.store, share(1), { now, ...(options.self === undefined ? {} : { self: options.self }) });
  if (options.apply) {
    jobTemp = await applyJobTemp(jobTemp, options, now);
    traces = await applyTraces(traces, parents, options, now);
    if (prune.skipped === null) prune = await applyPrune(prune, options, now);
  }
  return {
    at: new Date(start).toISOString(),
    applied: options.apply,
    kinds: [jobTemp, traces, prune],
    ask: askList(options.report),
    reportAt: options.report?.at ?? null,
    log: options.log,
  };
}

/** This function gives the lines of the text output of the cleanup. */
export function cleanLines(plan: CleanPlan): string[] {
  const lines = [
    plan.applied
      ? "Disk cleanup with --apply. The log of each delete is in the log file."
      : "Disk cleanup: a dry run. headroom deleted nothing. With --apply, it deletes the items of the kinds below.",
  ];
  for (const [index, kind] of plan.kinds.entries()) {
    lines.push("", `${index + 1}. ${kind.title}`);
    if (kind.skipped !== null) lines.push(`   Skipped: ${kind.skipped}`);
    else lines.push(`   Items: ${kind.count}, ${diskSize(kind.mb)}.`);
    const shown = kind.done.length > 0 ? kind.done : kind.items.map((item) => ({ path: item.path, mb: item.mb, ok: null as boolean | null, reason: null as string | null }));
    if (kind.kind !== "pnpm-prune" || kind.done.length > 0) {
      for (const each of shown.slice(0, 10)) {
        const state = each.ok === null ? "" : each.ok ? "  deleted" : `  not deleted: ${each.reason ?? ""}`;
        lines.push(`   ${diskSize(each.mb).padStart(8)}  ${each.path}${state}`);
      }
      if (shown.length > 10) lines.push(`   ${shown.length - 10} more. --json gives each one.`);
    }
    for (const note of kind.notes) lines.push(`   ${note}`);
  }
  lines.push("", "Ask Mark. The cleanup deletes none of these:");
  if (plan.reportAt === null) lines.push("   No disk report. Run `headroom disk report` first.");
  else if (plan.ask.length === 0) lines.push(`   No place of ${diskSize(ASK_MIN_MB)} or more in the report of ${plan.reportAt.slice(0, 16).replace("T", " ")} UTC.`);
  for (const item of plan.ask) {
    lines.push(`   ${diskSize(item.mb).padStart(8)}  ${item.label}: ${item.paths.join(", ")} (${CLASS_TEXT[item.class]}${item.partial ? ", partial" : ""})`);
    if (item.how !== null) lines.push(`             ${item.how}`);
  }
  lines.push("", `The log of the deletes: ${plan.log}`);
  return lines;
}

/** This function runs `pnpm store prune` with a time limit of 10 minutes. */
export function pnpmStorePrune(): Promise<string | null> {
  return runPnpm("store prune", 600_000);
}
