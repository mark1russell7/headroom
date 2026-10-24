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
  /** The start of the process, in milliseconds since the epoch. A new process with the ID of an ended process has a different start. */
  readonly startedAt?: number | undefined;
  /** The processor time of the process since its start, in milliseconds: the user time and the kernel time. */
  readonly cpuMs?: number | undefined;
  /**
   * The bytes that the process read since its start. Windows: `ReadTransferCount`, each read, also from a pipe or a device.
   * Linux: `read_bytes` of `/proc/<pid>/io`. It is absent when the counter is not readable.
   */
  readonly readBytes?: number | undefined;
  /**
   * The bytes that the process wrote since its start (H20). Windows: `WriteTransferCount`, each write, also to a pipe or a
   * device. Linux: `write_bytes` of `/proc/<pid>/io`. It is absent when the counter is not readable.
   */
  readonly writeBytes?: number | undefined;
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

/**
 * The byte counters of one network adapter since its start (H24). Only the physical adapters and the Wi-Fi adapters
 * count. A loopback, a tunnel or a filter of an adapter does not count.
 */
export interface NetAdapter {
  /** The name of the adapter, for example "Ethernet" or "Wi-Fi". */
  readonly name: string;
  readonly inBytes: number;
  readonly outBytes: number;
  /** The receive speed of the link in bits per second, or `null` when the adapter does not tell it. */
  readonly inBitsPerSecond: number | null;
  /** The transmit speed of the link in bits per second, or `null` when the adapter does not tell it. */
  readonly outBitsPerSecond: number | null;
}

/** One read of the network adapters: its time, in milliseconds since the epoch, and the counters of each adapter. */
export interface NetRead {
  readonly at: number;
  readonly adapters: readonly NetAdapter[];
}

/** The state of a TCP connection. Only the states that headroom counts have a name. */
export type TcpState = "listen" | "established" | "time-wait" | "other";

/** One TCP connection or listening port of IPv4 or IPv6 (H24). */
export interface TcpConnection {
  readonly localPort: number;
  readonly state: TcpState;
  /** The process that holds the connection, or 0 without a process: TIME_WAIT on Windows, and each row on Linux. */
  readonly pid: number;
  /** The local address of a listening port, for example "127.0.0.1" or "::". The other rows have no address, so a read stays small. */
  readonly address?: string | undefined;
}

/** The dynamic (ephemeral) TCP ports: the first port and the count of ports. The Windows default is 49152 and 16384. */
export interface PortRange {
  readonly first: number;
  readonly count: number;
}

/** The TCP connections of IPv4 and IPv6 at one read, and the dynamic port range. */
export interface TcpTable {
  readonly dynamic: PortRange;
  readonly connections: readonly TcpConnection[];
}

/** The free space of one fixed drive, in MB. A full drive stops the builds, the tests and git for all the sessions. */
export interface DiskSpace {
  /** The name of the drive, for example "C:" on Windows, or its mount point on Linux. */
  readonly mount: string;
  /** The space that this user can use, in MB. */
  readonly freeMb: number;
  readonly totalMb: number;
}
