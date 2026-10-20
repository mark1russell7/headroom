/**
 * The data types of headroom: the amounts, the memory of the computer, the processes and the owners.
 */

/** The amounts of a request or of a capacity, by resource name. `memory` is in MB, `cpu` in processors. */
export type Amounts = Readonly<Record<string, number>>;

/** The resource name of the memory. Its capacity is measured, not configured. */
export const MEMORY = "memory";

/** The memory of the computer, in MB. */
export interface SystemMemory {
  readonly totalMb: number;
  readonly availableMb: number;
  /** The commit charge: the memory that the processes and the kernel reserved. */
  readonly commitMb: number;
  /** The limit of the commit charge: the physical memory plus the page file. */
  readonly commitLimitMb: number;
  readonly kernelPagedMb: number;
  readonly kernelNonpagedMb: number;
}

/** One process, with its parent and its memory in MB. */
export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  /** The private memory of the process: the part that no other process shares. */
  readonly privateMb: number;
  /** The working set of the process: the part in physical memory at this time. */
  readonly workingMb: number;
}

/** One sample of the computer. The process list is empty when the sample did not read the processes. */
export interface Sample {
  /** The time of the sample, in milliseconds since the epoch. */
  readonly at: number;
  readonly memory: SystemMemory;
  readonly processes: readonly ProcessInfo[];
}

/** The kind of an owner of memory. */
export type OwnerKind = "session" | "mcp" | "docker" | "browser" | "editor" | "kernel" | "system" | "other";

/**
 * A local MCP server that the gateway starts one time for all sessions. The fields have the meaning
 * of a stdio server of a Claude Code `.mcp.json` file.
 */
export interface McpServerSpec {
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** The gateway stops the server after this time with no request. The default is 30 minutes. 0 keeps it. */
  readonly idleMinutes?: number | undefined;
}

/** The memory of one owner: the sum over the processes that it owns. */
export interface OwnerUsage {
  /** The name of the owner, for example `session:graph` or `docker`. */
  readonly owner: string;
  readonly kind: OwnerKind;
  readonly privateMb: number;
  readonly workingMb: number;
  readonly processes: number;
}

/** One live Claude Code session, from its file in `~/.claude/sessions`. */
export interface SessionInfo {
  readonly pid: number;
  readonly name: string;
  readonly sessionId: string;
  readonly status: string | null;
  readonly cwd: string | null;
}

/**
 * The use of the kernel pools by one pool tag. A driver marks each of its kernel allocations with a tag
 * of 4 characters, so the tag that grows names the driver that leaks.
 */
export interface PoolTag {
  readonly tag: string;
  readonly nonPagedMb: number;
  readonly pagedMb: number;
}

/**
 * The load of the desktop session: the processes, and the USER and GDI objects of all its processes. Each process
 * with a window takes part of the desktop heap. When the heap runs out, a new process stops at its start with
 * 0xC0000142, also with free memory. Windows gives no counter of the heap itself, so these numbers stand for it.
 */
export interface SessionLoad {
  readonly processes: number;
  readonly userObjects: number | null;
  readonly gdiObjects: number | null;
}
