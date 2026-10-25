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
  /** The part of the paged pool in physical memory. Only Windows gives it: `\Memory\Pool Paged Resident Bytes`. */
  readonly kernelPagedResidentMb?: number | undefined;
  /**
   * The system file cache in physical memory: the working set of the system cache. It is not available memory. Only
   * Windows gives it: `\Memory\System Cache Resident Bytes`. The standby pages of the cache are in `availableMb`.
   */
  readonly cacheMb?: number | undefined;
  /**
   * The code of the kernel and of the drivers in physical memory. Only Windows gives it: `\Memory\System Driver Resident
   * Bytes` and `\Memory\System Code Resident Bytes`.
   */
  readonly driversMb?: number | undefined;
  /**
   * The PFN database in physical memory: the record of each physical page (H49). Only Windows 11 22H2 and later give it:
   * `PfnDatabaseCommittedPages` of `SystemPerformanceInformation`.
   */
  readonly pfnDatabaseMb?: number | undefined;
  /**
   * The pages that drivers allocate and lock in physical memory (H49), for example for the GPU. Only Windows 11 22H2 and
   * later give it: `MdlPagesAllocated` of `SystemPerformanceInformation`.
   */
  readonly driverLockedMb?: number | undefined;
  /**
   * The page tables of the system address space (H49). Only Windows 11 22H2 and later give it:
   * `SystemPageTableCommittedPages` of `SystemPerformanceInformation`.
   */
  readonly pageTablesMb?: number | undefined;
}

/** One process, with its parent and its memory in MB. */
export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  /**
   * The private memory of the process: the part that no other process shares, in RAM or in the page file. Windows:
   * `PagefileUsage` of `SystemProcessInformation` (H49). Linux: `RssAnon` of `/proc/<pid>/status`.
   */
  readonly privateMb: number;
  /**
   * The memory of the process in RAM at this time. Windows: the private working set, `WorkingSetPrivateSize` of
   * `SystemProcessInformation` (H49). A page that processes share is in no process, so the sum of the processes is not
   * more than the memory in use. Linux: the resident set, `VmRSS`.
   */
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
  /**
   * The name that a Node process gives itself with the option `--title=<name>`, from its command line. Only the Windows
   * sampler reads it, and only for `node.exe`. A titled process that the system starts, for example with Task Scheduler,
   * is the owner `service:<name>`.
   */
  readonly title?: string | undefined;
  /**
   * The count of the open handles of the process (H48): files, registry keys, events and other kernel objects. Each handle
   * holds kernel memory. Only the Windows sampler reads it, from `HandleCount` of `SystemProcessInformation`.
   */
  readonly handles?: number | undefined;
}

/** One sample of the computer. The process list is empty when the sample did not read the processes. */
export interface Sample {
  /** The time of the sample, in milliseconds since the epoch. */
  readonly at: number;
  readonly memory: SystemMemory;
  readonly processes: readonly ProcessInfo[];
}

/**
 * The kind of an owner of memory. A `service` is a Node process with a title that the system starts, for example the
 * daemon of headroom from Task Scheduler. A `kernel` owner has no process: the kernel pools, the file cache or the drivers.
 */
export type OwnerKind = "session" | "mcp" | "service" | "docker" | "browser" | "editor" | "kernel" | "system" | "other";

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
  /**
   * The start of the session process, in milliseconds since the epoch, from the field `procStart` of a Windows session
   * file. It is absent in an older file and on Linux. `resources.peer` uses it to find a process ID that is in use again (H46).
   */
  readonly startedAt?: number | undefined;
}

/** The process ID, the parent, the name and the start of one process: the part of `ProcessInfo` that a walk up the tree uses (H46). */
export type ProcessLink = Pick<ProcessInfo, "pid" | "ppid" | "name" | "startedAt">;

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

/** One TCP row of IPv4 or IPv6 with its two ends and its process (H46). `resources.peer` reads only the rows of one connection. */
export interface TcpEndpoints {
  /** The local address, for example "127.0.0.1" or "::1". */
  readonly localAddress: string;
  readonly localPort: number;
  readonly remoteAddress: string;
  readonly remotePort: number;
  readonly state: TcpState;
  /** The process that holds the connection, or 0 without a process: TIME_WAIT on Windows. */
  readonly pid: number;
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

/** One read of the battery (H30), from `CallNtPowerInformation(SystemBatteryState)`. A computer with no battery has no read. */
export interface BatteryRead {
  /** True: the computer runs on AC power. */
  readonly ac: boolean;
  readonly charging: boolean;
  readonly discharging: boolean;
  /** The full charge capacity, in mWh. */
  readonly maxMwh: number;
  /** The charge, in mWh. */
  readonly remainingMwh: number;
  /** The rate of the battery in mW: negative while it discharges, positive while it charges. It is `null` when Windows does not know it. */
  readonly rateMw: number | null;
  /** The time left on battery that Windows estimates, in seconds, or `null` when Windows does not know it. */
  readonly estimatedSeconds: number | null;
}

/**
 * One read of the counter set "Energy Meter" (H30): the power of each meter in W, by instance name in lower case. Examples
 * are `system power`, `cpu power` and `gpu power`. The meters of each core are absent.
 */
export type PowerMeters = Readonly<Record<string, number>>;

/** The free space of one fixed drive, in MB. A full drive stops the builds, the tests and git for all the sessions. */
export interface DiskSpace {
  /** The name of the drive, for example "C:" on Windows, or its mount point on Linux. */
  readonly mount: string;
  /** The space that this user can use, in MB. */
  readonly freeMb: number;
  readonly totalMb: number;
}
