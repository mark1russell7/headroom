/**
 * The owners of memory: it gives each process tree to a Claude Code session, Docker, the browser,
 * the editor or the system.
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
      sessions.push({
        pid,
        name,
        sessionId,
        status: typeof data["status"] === "string" ? data["status"] : null,
        cwd: typeof data["cwd"] === "string" ? data["cwd"] : null,
      });
    } catch {
      // The session ended while the file was read.
    }
  }
  return sessions;
}

/** This function gives the name of a program in lower case, with no `.exe`. */
export function programName(name: string): string {
  return name.toLowerCase().replace(/\.exe$/, "");
}

/** The result of an attribution. */
export interface Attribution {
  /** The owners, the largest private memory first. */
  readonly owners: OwnerUsage[];
  /** The owner of each process, by process id. */
  readonly ownerOf: ReadonlyMap<number, string>;
}

/**
 * This function gives each process to an owner. A process that has a session as an ancestor
 * belongs to that session. A process under a server of the MCP gateway belongs to `mcp:<name>`.
 * Otherwise the first rule that matches the process or an ancestor wins. The kernel pools become
 * the owner `kernel`.
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
    const seen = new Set<number>();
    for (let at: ProcessInfo | undefined = info; at && !seen.has(at.pid) && seen.size < 64; at = byPid.get(at.ppid)) {
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
    }
    owner ??= rule ? { name: rule.owner, kind: rule.kind } : { name: "other", kind: "other" };
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
  if (memory) {
    const kernelMb = memory.kernelNonpagedMb + memory.kernelPagedMb;
    owners.push({ owner: "kernel", kind: "kernel", privateMb: Math.round(kernelMb), workingMb: Math.round(kernelMb), processes: 0 });
  }
  owners.sort((a, b) => b.privateMb - a.privateMb);
  return { owners, ownerOf };
}

function round(sum: { privateMb: number; workingMb: number; processes: number }): { privateMb: number; workingMb: number; processes: number } {
  return { privateMb: Math.round(sum.privateMb), workingMb: Math.round(sum.workingMb), processes: sum.processes };
}

/** This function gives the private memory, in MB, of a process and all of its descendants. */
export function treeMb(pid: number, processes: readonly ProcessInfo[]): number {
  const children = new Map<number, ProcessInfo[]>();
  for (const info of processes) {
    if (info.pid === info.ppid) continue;
    const list = children.get(info.ppid) ?? [];
    list.push(info);
    children.set(info.ppid, list);
  }
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
