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

/**
 * The default rules. The names are lower case, with no `.exe`.
 *
 * The minimal processes of Windows have their own owners (H49).
 * `system:memory compression` holds the compressed pages of the other processes. `system:registry` holds the registry.
 * `system:secure system` holds the memory of the secure kernel. The VM processes go to `docker`, and the split of H38
 * gives that memory to the containers and to `docker (VM)`.
 *
 * The file readers of Windows have their own owners (H50). `system:search` is the indexer of Windows Search and its
 * filter hosts. `system:defender` is the scanner of Microsoft Defender. Both read each file that a job writes. On
 * 2026-10-25 they filled the system file cache to 10 GB, and the reaper of Claude Code stopped jobs.
 */
export const DEFAULT_RULES: readonly OwnerRule[] = [
  { owner: "docker", kind: "docker", names: ["vmmem", "vmmemwsl", "com.docker.backend", "com.docker.build", "docker desktop", "dockerd", "containerd"] },
  { owner: "browser", kind: "browser", names: ["chrome", "msedge", "firefox", "msedgewebview2"] },
  { owner: "editor", kind: "editor", names: ["code", "cursor"] },
  { owner: "steam", kind: "other", names: ["steam", "steamwebhelper"] },
  { owner: "system:memory compression", kind: "system", names: ["memory compression"] },
  { owner: "system:registry", kind: "system", names: ["registry"] },
  { owner: "system:secure system", kind: "system", names: ["secure system"] },
  { owner: "system:search", kind: "system", names: ["searchindexer", "searchprotocolhost", "searchfilterhost"] },
  { owner: "system:defender", kind: "system", names: ["msmpeng", "mpdefendercoreservice", "nissrv", "mpcmdrun"] },
  { owner: "system", kind: "system", names: ["system", "svchost", "explorer", "dwm"] },
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

/**
 * The parent of a process at its first read (H182): its ID and its start. The owner record of the process keeps them, so
 * a later read can prove that the parent ended.
 */
export interface ParentRecord {
  /** The parent process ID at the first read. It is 0 when the record has no parent, for example a record of an older version. */
  readonly ppid: number;
  /**
   * The start of the parent at the first read, in whole milliseconds since the epoch. It is 0 when the parent was not alive
   * at the first read, or when the read had no start.
   */
  readonly parentCreated: number;
}

/**
 * This function tells if a live process is the parent of a record (H182). The parent must have the ID and the start of the
 * record. When the read has no start of the live process, the function cannot compare, so the link counts.
 */
function isRecordedParent(parent: ProcessInfo, record: ParentRecord): boolean {
  return parent.pid === record.ppid && (parent.startedAt === undefined || Math.round(parent.startedAt) === record.parentCreated);
}

/**
 * This function tells if the parent ID of a process is not the parent ID of its record (H182). Windows does not change the
 * parent ID of a process. Linux changes it only when the parent ends: the orphan gets `init` or a subreaper as its parent.
 */
function parentMoved(info: ProcessInfo, record: ParentRecord | undefined): boolean {
  return record !== undefined && record.ppid > 0 && record.ppid !== info.ppid;
}

/**
 * This function gives the parent of a process, or `undefined` when the parent ended or its ID is in use again.
 *
 * - The parent must start at or before the child (H29).
 * - With the record of the child (H182), the parent must also have the start of the record. A process with the same ID and
 *   a different start is a different process. This rule also holds when the read has no start of the child.
 * - With the record of the child, a new parent ID shows that the first parent ended.
 */
export function parentOf(info: ProcessInfo, byPid: ReadonlyMap<number, ProcessInfo>, record?: ParentRecord): ProcessInfo | undefined {
  if (parentMoved(info, record)) return undefined;
  const parent = byPid.get(info.ppid);
  if (parent === undefined || !isParent(parent, info)) return undefined;
  if (record !== undefined && record.ppid > 0 && record.parentCreated > 0 && !isRecordedParent(parent, record)) return undefined;
  return parent;
}

/**
 * This function tells if a process is an orphan: its parent is proven gone. A process with the parent ID 0 is not an
 * orphan, because the idle process and the kernel have no parent.
 *
 * - Without a record, the parent is gone when no process has its ID, or when the process with its ID started after the
 *   child (H29).
 * - With the record of the child (H182), the start of the parent at the first read decides. A process with the ID of the
 *   parent and a different start is a new process, so the parent is gone. A new parent ID (Linux) also shows it.
 * - When the read has no start of the process with the ID of the parent, the function cannot compare the starts. Then the
 *   parent is not proven gone.
 */
export function isOrphan(info: ProcessInfo, byPid: ReadonlyMap<number, ProcessInfo>, record?: ParentRecord): boolean {
  if (parentMoved(info, record)) return true;
  return info.ppid > 0 && parentOf(info, byPid, record) === undefined;
}

/** The label of an owner that comes from the record of an orphan (H48): `session:shop (orphan)`. */
export const ORPHAN_LABEL = " (orphan)";

/**
 * This function gives the name of the owner of a process for the text of an alert (H48). An orphan gets the label
 * `(orphan)` one time: `other` gives `other (orphan)`, and `session:shop (orphan)` stays as it is.
 */
export function orphanName(owner: string, orphan: boolean): string {
  return orphan && !owner.endsWith(ORPHAN_LABEL) ? `${owner}${ORPHAN_LABEL}` : owner;
}

/** The prefixes of the owners that start a tree of processes: a session, a server of the MCP gateway, a service (H185). */
const STARTER_PREFIXES = ["session:", "mcp:", "service:"] as const;

/**
 * This function tells if an owner started its tree of processes (H185): a session, an MCP server or a service. The other
 * owners come from a rule for the name of a program (`system`, `browser`, `editor`) and tell only what a program is.
 *
 * The record of an orphan keeps its owner after the parent ends. Only the owner of a starter can go to the processes under
 * the orphan. On 2026-11-15, the record of Explorer (`system`) went to each program that the desktop started. Thus 106
 * processes and 4.9 GB got the owner `system (orphan)`. The processes whose parent ended had only 1.0 GB.
 */
export function isStarter(owner: string): boolean {
  const base = baseOwner(owner);
  return STARTER_PREFIXES.some((prefix) => base.startsWith(prefix));
}

/** This function gives an owner without the label of an orphan: `session:shop (orphan)` gives `session:shop`. */
export function baseOwner(owner: string): string {
  return owner.endsWith(ORPHAN_LABEL) ? owner.slice(0, -ORPHAN_LABEL.length) : owner;
}

/**
 * This function gives the key of a process (H48): its ID and its start in whole milliseconds, for example `27056:1792900000000`.
 * A new process with the ID of an ended process has a different key. A read with no start gives the start 0.
 */
export function processKey(info: Pick<ProcessInfo, "pid" | "startedAt">): string {
  return `${info.pid}:${Math.round(info.startedAt ?? 0)}`;
}

/** The session of a process (H182): the Claude Code session whose process is an ancestor of the process. */
export interface SessionRef {
  /** The name of the session, as in the owner `session:<name>`. */
  readonly name: string;
  /** The ID of the session from its session file. It is empty when the file has no ID. */
  readonly id: string;
}

/** The owner that the record of a process keeps (H48). `attribute()` reads it for an orphan. */
export interface KeptOwner extends Partial<ParentRecord> {
  /** The owner of the process while its parent was alive, without the label of an orphan. */
  readonly owner: string;
  /** The name of the session of the process while its parent was alive (H182), or `null`. */
  readonly session?: string | null | undefined;
  /** The ID of that session (H182), or `null`. */
  readonly sessionId?: string | null | undefined;
}

/** This function gives the parent facts of a kept record (H182), or `undefined` when the record has none. */
export function parentRecordOf(kept: KeptOwner | undefined): ParentRecord | undefined {
  const ppid = kept?.ppid;
  const parentCreated = kept?.parentCreated;
  return ppid === undefined || parentCreated === undefined ? undefined : { ppid, parentCreated };
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
  /**
   * The session of each process, by process id (H182). It comes from the session process that is an ancestor, or for an
   * orphan from its kept record. A process with no session is absent.
   */
  readonly sessionOf: ReadonlyMap<number, SessionRef>;
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
 * - `kernel:driver locked` is the pages that drivers lock in RAM, for example for the GPU (H49).
 * - `kernel:pfn database` is the record of each physical page (H49).
 * - `kernel:page tables` is the page tables of the system address space (H49).
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
  resident("kernel:driver locked", memory.driverLockedMb);
  resident("kernel:pfn database", memory.pfnDatabaseMb);
  resident("kernel:page tables", memory.pageTablesMb);
  return owners;
}

/**
 * This function gives the memory in use that no owner holds, in MB (H49). The memory in use is the total less the
 * available memory. The function subtracts the memory in RAM of each owner, also of the kernel owners.
 *
 * On Windows, the memory in RAM of a process is its private working set. Thus the rest is mostly the pages that processes
 * share: the code of programs and DLLs, mapped files and shared memory. It also holds the page tables of the processes and
 * the pages that wait for a write to the page file. A negative value tells that the owners count more than the memory in use.
 */
export function unattributedMb(memory: Pick<SystemMemory, "totalMb" | "availableMb">, owners: readonly Pick<OwnerUsage, "workingMb">[]): number {
  const inUseMb = memory.totalMb - memory.availableMb;
  return Math.round(inUseMb - owners.reduce((sum, owner) => sum + owner.workingMb, 0));
}

/**
 * This function gives the row `unattributed` of the table of the owners in `headroom status` (H49), or `null` with no
 * amount. The row has no private memory, because it compares the memory in RAM with the memory in use. `mbText` writes
 * an amount in MB, as in the other rows.
 */
export function unattributedRow(unattributed: number | null | undefined, mbText: (mb: number) => string): string | null {
  if (unattributed === null || unattributed === undefined) return null;
  const note = unattributed < 0 ? "the owners count more than the memory in use" : "in use, in no owner: mostly the pages that processes share";
  return `  ${"unattributed".padEnd(32)} ${"-".padStart(9)} ${mbText(unattributed).padStart(9)}  ${note}`;
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
 *
 * When the search stops at an orphan, its record in `kept` gives the owner that it had while its parent was alive (H48).
 * That owner wins when it started the tree (`isStarter()`: a session, an MCP server or a service) and is different, with
 * the label `(orphan)` and the kind `other` (H185). The owner of a rule does not win: the record of Explorer (`system`)
 * does not go to a browser that Explorer started. The key of `kept` is `processKey()`. Thus a command that a session
 * started keeps the name of the session after its shell ends.
 *
 * The search also compares the start of each parent with the start in its record (H182). The session of each process
 * comes from the same search: the session file of the ancestor, or the kept record of an orphan.
 */
export function attribute(
  processes: readonly ProcessInfo[],
  sessions: readonly SessionInfo[],
  memory?: SystemMemory,
  rules: readonly OwnerRule[] = DEFAULT_RULES,
  servers: ReadonlyMap<number, string> = new Map(),
  kept: ReadonlyMap<string, KeptOwner> = new Map(),
): Attribution {
  const byPid = new Map(processes.map((info) => [info.pid, info]));
  const sessionByPid = new Map(sessions.map((session) => [session.pid, session]));
  const ruleOf = new Map<string, OwnerRule>();
  for (const rule of rules) for (const name of rule.names) ruleOf.set(name, rule);

  const ownerOf = new Map<number, string>();
  const sessionOf = new Map<number, SessionRef>();
  const kindOf = new Map<string, OwnerKind>();
  for (const info of processes) {
    let owner: { name: string; kind: OwnerKind } | null = null;
    let rule: OwnerRule | null = null;
    // The nearest title below the nearest rule.
    let title: string | null = null;
    const seen = new Set<number>();
    // The last process of the search: an orphan, a process with no parent, or the end of a long chain.
    let top = info;
    for (let at: ProcessInfo | undefined = info; at && !seen.has(at.pid) && seen.size < 64; at = parentOf(at, byPid, parentRecordOf(kept.get(processKey(at))))) {
      seen.add(at.pid);
      top = at;
      const session = sessionByPid.get(at.pid);
      if (session !== undefined) {
        owner = { name: `session:${session.name}`, kind: "session" };
        sessionOf.set(info.pid, { name: session.name, id: session.sessionId });
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
    if (owner === null) {
      const plain: { name: string; kind: OwnerKind } =
        rule === null ? { name: "other", kind: "other" } : title !== null && rule.kind === "system" ? { name: `service:${title}`, kind: "service" } : { name: rule.owner, kind: rule.kind };
      // H48: an orphan keeps the owner of its record. The kind is `other`, because no live session or server holds it.
      // H185: only an owner that started the tree (a session, an MCP server or a service) wins over the rules.
      const record = kept.get(processKey(top));
      const orphan = record !== undefined && isOrphan(top, byPid, parentRecordOf(record)) ? record : undefined;
      const remembered = orphan?.owner;
      owner = remembered !== undefined && isStarter(remembered) && remembered !== plain.name ? { name: `${remembered}${ORPHAN_LABEL}`, kind: "other" } : plain;
      // H182: an orphan also keeps the session of its record.
      const keptSession = orphan?.session;
      if (typeof keptSession === "string") sessionOf.set(info.pid, { name: keptSession, id: orphan?.sessionId ?? "" });
    }
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
  return { owners, ownerOf, sessionOf };
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

/**
 * The programs that start containers. The memory of a container is in the VM of Docker, not in the tree of its client.
 * Thus the tree of such a job does not measure the job (H187), until a container gives its memory to its lease (h62).
 */
const CONTAINER_CLIENTS: ReadonlySet<string> = new Set(["docker", "docker-compose", "com.docker.cli", "podman", "nerdctl", "kubectl"]);

/**
 * This function gives the private memory, in MB, of the job of a process: the process and all of its descendants (H187).
 * It gives `null` when the processes do not measure the job. Then the process is not in the read, or a process of the
 * tree starts containers.
 */
export function jobTreeMb(pid: number, processes: readonly ProcessInfo[]): number | null {
  const root = processes.find((info) => info.pid === pid);
  if (root === undefined) return null;
  const children = childrenOf(processes);
  const seen = new Set<number>();
  const stack = [root];
  while (stack.length > 0) {
    const at = stack.pop();
    if (at === undefined || seen.has(at.pid)) continue;
    seen.add(at.pid);
    if (CONTAINER_CLIENTS.has(programName(at.name))) return null;
    stack.push(...(children.get(at.pid) ?? []));
  }
  return treeMb(pid, processes);
}
