/**
 * The owners of memory. Each process tree goes to a Claude Code session, an MCP server, a service, Docker, the browser,
 * the editor or the system. The kernel owners hold the memory that no process holds.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OwnerKind, OwnerUsage, ProcessInfo, SessionInfo, SystemMemory } from "./types.ts";

/** A rule that gives a process to an owner by the name of its program. */
export interface OwnerRule {
  readonly owner: string;
  readonly kind: OwnerKind;
  readonly names: readonly string[];
}

/** The default rules. The names are lower case, with no `.exe`. */
export const DEFAULT_RULES: readonly OwnerRule[] = [
  { owner: "docker", kind: "docker", names: ["vmmem", "vmmemwsl", "com.docker.backend", "com.docker.build", "docker desktop", "dockerd", "containerd"] },
  { owner: "browser", kind: "browser", names: ["chrome", "msedge", "firefox", "msedgewebview2"] },
  { owner: "editor", kind: "editor", names: ["code", "cursor"] },
  { owner: "steam", kind: "other", names: ["steam", "steamwebhelper"] },
  { owner: "system", kind: "system", names: ["system", "registry", "memory compression", "msmpeng", "searchindexer", "svchost", "explorer", "dwm"] },
];

/** The folder where Claude Code writes one file for each live session. */
export function sessionsDir(): string {
  return join(homedir(), ".claude", "sessions");
}

/** This function reads the live Claude Code sessions. A file that it cannot read is skipped. */
export function readSessions(dir: string = sessionsDir()): SessionInfo[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  const sessions: SessionInfo[] = [];
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
      const pid = Number(data["pid"]);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const sessionId = typeof data["sessionId"] === "string" ? data["sessionId"] : "";
      const name = typeof data["name"] === "string" && data["name"] !== "" ? data["name"] : sessionId.slice(0, 8) || `pid-${pid}`;
      const startedAt = sessionStart(data);
      sessions.push({
        pid,
        name,
        sessionId,
        status: typeof data["status"] === "string" ? data["status"] : null,
        cwd: typeof data["cwd"] === "string" ? data["cwd"] : null,
        ...(startedAt === undefined ? {} : { startedAt }),
      });
    } catch {
      // The session ended while the file was read.
    }
  }
  return sessions;
}

/** The time between 1601-01-01, the start of a FILETIME, and 1970-01-01, in milliseconds. */
const FILETIME_EPOCH_MS = 11_644_473_600_000;

/**
 * This function changes a FILETIME of Windows to milliseconds since the epoch. A FILETIME counts units of 100
 * nanoseconds from 1601-01-01. The sampler and the session files use this one function, so their starts agree.
 */
export function fileTimeMs(ticks: bigint): number {
  return Math.round(Number(ticks) / 10_000 - FILETIME_EPOCH_MS);
}

/**
 * This function gives the start of the process of a session file. Claude Code writes `procStart` as a FILETIME in
 * decimal digits on Windows (`pidDomain` "win32:..."). Another file gives no start.
 */
function sessionStart(data: Record<string, unknown>): number | undefined {
  const raw = data["procStart"];
  const domain = data["pidDomain"];
  if (typeof raw !== "string" || !/^\d{1,20}$/.test(raw) || typeof domain !== "string" || !domain.startsWith("win32:")) return undefined;
  return fileTimeMs(BigInt(raw));
}

/** This function gives the name of a program in lower case, with no `.exe`. */
export function programName(name: string): string {
  return name.toLowerCase().replace(/\.exe$/, "");
}

/**
 * This function tells if a process can be the parent of another process. The parent must start at or before the child.
 * A parent that started later is a new process with the ID of the real parent, which ended (H29).
 * Without a start, the link counts.
 */
export function isParent(parent: ProcessInfo, child: ProcessInfo): boolean {
  return parent.pid !== child.pid && (parent.startedAt === undefined || child.startedAt === undefined || parent.startedAt <= child.startedAt);
}

/** This function gives the parent of a process, or `undefined` when the parent ended or its ID is in use again. */
export function parentOf(info: ProcessInfo, byPid: ReadonlyMap<number, ProcessInfo>): ProcessInfo | undefined {
  const parent = byPid.get(info.ppid);
  return parent !== undefined && isParent(parent, info) ? parent : undefined;
}

/** This function gives the children of each process ID. A child of a process ID that is in use again is absent (H29). */
export function childrenOf(processes: readonly ProcessInfo[]): Map<number, ProcessInfo[]> {
  const byPid = new Map(processes.map((info) => [info.pid, info]));
  const children = new Map<number, ProcessInfo[]>();
  for (const info of processes) {
    if (parentOf(info, byPid) === undefined) continue;
    const list = children.get(info.ppid) ?? [];
    list.push(info);
    children.set(info.ppid, list);
  }
  return children;
}

/** The result of an attribution. */
export interface Attribution {
  /** The owners, the largest private memory first. */
  readonly owners: OwnerUsage[];
  /** The owner of each process, by process id. */
  readonly ownerOf: ReadonlyMap<number, string>;
}

/** The longest title that becomes the name of a service. */
const TITLE_MAX = 64;

/**
 * This function gives the name in the option `--title=<name>` or `--title <name>` of a Node command line. Without the
 * option, it gives `null`.
 */
export function titleOf(commandLine: string): string | null {
  const match = /(?:^|\s)"?--title(?:=|\s+)(?:"([^"]*)"|([^\s"]+))/.exec(commandLine);
  const title = (match?.[1] ?? match?.[2] ?? "").trim();
  return title === "" ? null : title.slice(0, TITLE_MAX);
}

/**
 * This function gives the owners of the memory that no process holds. They have the kind `kernel`.
 *
 * - `kernel` is the kernel pools. Its private memory is the size of the two pools, as before. Its memory in RAM is the
 *   non-paged pool and the part of the paged pool in RAM.
 * - `kernel:cache` is the system file cache in RAM. Its private memory is the same amount.
 * - `kernel:drivers` is the code of the kernel and of the drivers in RAM. Its private memory is the same amount.
 *
 * A platform that does not give an amount gives no owner for it. Without the paged pool in RAM, the memory in RAM of
 * `kernel` is the size of the two pools.
 */
export function kernelOwners(memory: SystemMemory): OwnerUsage[] {
  const poolsMb = memory.kernelNonpagedMb + memory.kernelPagedMb;
  const inRamMb = memory.kernelPagedResidentMb === undefined ? poolsMb : memory.kernelNonpagedMb + memory.kernelPagedResidentMb;
  const owners: OwnerUsage[] = [{ owner: "kernel", kind: "kernel", privateMb: Math.round(poolsMb), workingMb: Math.round(inRamMb), processes: 0 }];
  const resident = (owner: string, mb: number | undefined): void => {
    if (mb !== undefined) owners.push({ owner, kind: "kernel", privateMb: Math.round(mb), workingMb: Math.round(mb), processes: 0 });
  };
  resident("kernel:cache", memory.cacheMb);
  resident("kernel:drivers", memory.driversMb);
  return owners;
}

/**
 * This function gives each process to an owner. A process that has a session as an ancestor belongs to that session.
 * A process under a server of the MCP gateway belongs to `mcp:<name>`. Otherwise the first rule that matches the
 * process or an ancestor wins.
 *
 * A title replaces the rule `system` farther up. Thus a Node process with the title `<name>` that Task Scheduler, a
 * service or Explorer starts belongs to `service:<name>`, with its descendants. A title with no rule farther up gives no
 * owner, so an orphan stays `other`. The memory that no process holds goes to the owners of `kernelOwners()`.
 *
 * The search goes up only to a parent that started at or before its child (H29). A later start shows a parent ID that
 * is in use again. The search then stops, and the process and the ancestors below that point decide the owner.
 */
export function attribute(
  processes: readonly ProcessInfo[],
  sessions: readonly SessionInfo[],
  memory?: SystemMemory,
  rules: readonly OwnerRule[] = DEFAULT_RULES,
  servers: ReadonlyMap<number, string> = new Map(),
): Attribution {
  const byPid = new Map(processes.map((info) => [info.pid, info]));
  const sessionOf = new Map(sessions.map((session) => [session.pid, session.name]));
  const ruleOf = new Map<string, OwnerRule>();
  for (const rule of rules) for (const name of rule.names) ruleOf.set(name, rule);

  const ownerOf = new Map<number, string>();
  const kindOf = new Map<string, OwnerKind>();
  for (const info of processes) {
    let owner: { name: string; kind: OwnerKind } | null = null;
    let rule: OwnerRule | null = null;
    // The nearest title below the nearest rule.
    let title: string | null = null;
    const seen = new Set<number>();
    for (let at: ProcessInfo | undefined = info; at && !seen.has(at.pid) && seen.size < 64; at = parentOf(at, byPid)) {
      seen.add(at.pid);
      const session = sessionOf.get(at.pid);
      if (session !== undefined) {
        owner = { name: `session:${session}`, kind: "session" };
        break;
      }
      const server = servers.get(at.pid);
      if (server !== undefined) {
        owner = { name: `mcp:${server}`, kind: "mcp" };
        break;
      }
      rule ??= ruleOf.get(programName(at.name)) ?? null;
      if (rule === null && title === null && at.title !== undefined) title = at.title;
    }
    if (owner === null && rule !== null) owner = title !== null && rule.kind === "system" ? { name: `service:${title}`, kind: "service" } : { name: rule.owner, kind: rule.kind };
    owner ??= { name: "other", kind: "other" };
    ownerOf.set(info.pid, owner.name);
    kindOf.set(owner.name, owner.kind);
  }

  const sums = new Map<string, { privateMb: number; workingMb: number; processes: number }>();
  for (const info of processes) {
    const owner = ownerOf.get(info.pid) ?? "other";
    const sum = sums.get(owner) ?? { privateMb: 0, workingMb: 0, processes: 0 };
    sum.privateMb += info.privateMb;
    sum.workingMb += info.workingMb;
    sum.processes += 1;
    sums.set(owner, sum);
  }
  const owners: OwnerUsage[] = [...sums].map(([owner, sum]) => ({ owner, kind: kindOf.get(owner) ?? "other", ...round(sum) }));
  if (memory) owners.push(...kernelOwners(memory));
  owners.sort((a, b) => b.privateMb - a.privateMb);
  return { owners, ownerOf };
}

function round(sum: { privateMb: number; workingMb: number; processes: number }): { privateMb: number; workingMb: number; processes: number } {
  return { privateMb: Math.round(sum.privateMb), workingMb: Math.round(sum.workingMb), processes: sum.processes };
}

/** This function gives the private memory, in MB, of a process and all of its descendants. */
export function treeMb(pid: number, processes: readonly ProcessInfo[]): number {
  const children = childrenOf(processes);
  const root = processes.find((info) => info.pid === pid);
  if (!root) return 0;
  let total = 0;
  const seen = new Set<number>();
  const stack = [root];
  while (stack.length > 0) {
    const at = stack.pop();
    if (!at || seen.has(at.pid)) continue;
    seen.add(at.pid);
    total += at.privateMb;
    stack.push(...(children.get(at.pid) ?? []));
  }
  return total;
}
