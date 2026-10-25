/**
 * The network and the TCP ports (H24). This file has the pure functions of their reads. These are the parsers of the
 * tables of Windows and of the files of Linux, the throughput, and the use of the dynamic ports. The samplers do the reads.
 */

import { MB } from "./sampler.ts";
import type { NetAdapter, NetRead, OwnerKind, PortRange, ProcessInfo, TcpConnection, TcpEndpoints, TcpState, TcpTable } from "./types.ts";

/** The dynamic port range of Windows when `netsh` gives none: the ports 49152 to 65535. */
export const DEFAULT_DYNAMIC_PORTS: PortRange = { first: 49_152, count: 16_384 };

/** The throughput of one direction, in MB/s. */
export interface Flow {
  /** The sum of the link speeds of the adapters, or `null` when no adapter tells its speed. */
  readonly capacity: number | null;
  /** The MB/s between the two reads, or `null` before the second read. */
  readonly used: number | null;
}

/** The throughput of the adapters in each direction. */
export interface Flows {
  readonly in: Flow;
  readonly out: Flow;
}

/** The TCP connections at one read, as `headroom status` shows them. */
export interface TcpSummary {
  /** The connections in each state except LISTEN. */
  readonly connections: number;
  /** The connections in TIME_WAIT: they are closed, and their ports wait before Windows uses them again. */
  readonly timeWait: number;
  /** The listening ports of IPv4 and IPv6. */
  readonly listening: number;
}

/** The connections of one owner that use the dynamic ports. */
export interface OwnerConnections {
  readonly owner: string;
  readonly kind: OwnerKind;
  readonly connections: number;
  /** The processes of the owner with at least one of these connections. */
  readonly processes: number;
}

/** One listening TCP port with its process. A process that listens on IPv4 and on IPv6 gives one row with two addresses. */
export interface ListeningPort {
  readonly port: number;
  /** The local addresses, for example `0.0.0.0` and `::`. */
  readonly addresses: readonly string[];
  /** The process, or 0 when the read gives no process (Linux). */
  readonly pid: number;
  /** The name of the process, or "" without a process. */
  readonly name: string;
  /** The owner of the process, for example `session:graph`, or "" without a process. */
  readonly owner: string;
}

/** The listening TCP ports of the last read, and the dynamic port range. `resources.ports` gives it. */
export interface TcpPorts {
  /** The time of the read, or `null` before the first read and on a platform with no TCP read. */
  readonly at: number | null;
  readonly dynamic: PortRange | null;
  /** The listening ports, by port. */
  readonly listening: readonly ListeningPort[];
}

const round = (value: number, scale: number): number => Math.round(value * scale) / scale;

/** This function gives the sum of the link speeds of the adapters in MB/s, or `null` when no adapter tells its speed. */
function capacityOf(adapters: readonly NetAdapter[], bitsOf: (adapter: NetAdapter) => number | null): number | null {
  let bits = 0;
  let known = false;
  for (const adapter of adapters) {
    const speed = bitsOf(adapter);
    if (speed === null || speed <= 0) continue;
    bits += speed;
    known = true;
  }
  return known ? round(bits / 8 / MB, 10) : null;
}

/**
 * This function gives the throughput of the adapters in MB/s, from two reads. An adapter that the previous read does not
 * have counts 0. A counter that goes back shows a restart of the adapter, so that adapter counts 0.
 */
export function netFlows(previous: NetRead | undefined, current: NetRead): Flows {
  const seconds = previous === undefined ? 0 : (current.at - previous.at) / 1000;
  const before = new Map((previous?.adapters ?? []).map((adapter) => [adapter.name, adapter]));
  let inBytes = 0;
  let outBytes = 0;
  for (const adapter of current.adapters) {
    const old = before.get(adapter.name);
    if (old === undefined) continue;
    const received = adapter.inBytes - old.inBytes;
    const sent = adapter.outBytes - old.outBytes;
    if (received < 0 || sent < 0) continue;
    inBytes += received;
    outBytes += sent;
  }
  const rate = (bytes: number): number | null => (seconds > 0 ? round(bytes / MB / seconds, 1000) : null);
  return {
    in: { capacity: capacityOf(current.adapters, (adapter) => adapter.inBitsPerSecond), used: rate(inBytes) },
    out: { capacity: capacityOf(current.adapters, (adapter) => adapter.outBitsPerSecond), used: rate(outBytes) },
  };
}

/** This function tells if a port is in a range. */
export function inRange(port: number, range: PortRange): boolean {
  return port >= range.first && port < range.first + range.count;
}

/** This function gives the use of the dynamic ports: the rows with a local port in the range, and the part of them in TIME_WAIT. */
export function dynamicUse(tcp: TcpTable): { readonly used: number; readonly timeWait: number } {
  let used = 0;
  let timeWait = 0;
  for (const row of tcp.connections) {
    if (!inRange(row.localPort, tcp.dynamic)) continue;
    used += 1;
    if (row.state === "time-wait") timeWait += 1;
  }
  return { used, timeWait };
}

/** This function counts the connections, the connections in TIME_WAIT and the listening ports. */
export function tcpSummary(tcp: TcpTable): TcpSummary {
  let listening = 0;
  let timeWait = 0;
  for (const row of tcp.connections) {
    if (row.state === "listen") listening += 1;
    else if (row.state === "time-wait") timeWait += 1;
  }
  return { connections: tcp.connections.length - listening, timeWait, listening };
}

/**
 * This function gives the connections of each owner that use a dynamic port, the largest first. A row with no process
 * (TIME_WAIT on Windows, each row on Linux) has no owner, so it does not count.
 */
export function tcpByOwner(tcp: TcpTable, ownerOf: ReadonlyMap<number, string>, kindOf: ReadonlyMap<string, OwnerKind>): OwnerConnections[] {
  const sums = new Map<string, { connections: number; pids: Set<number> }>();
  for (const row of tcp.connections) {
    if (row.pid === 0 || !inRange(row.localPort, tcp.dynamic)) continue;
    const owner = ownerOf.get(row.pid) ?? "other";
    const sum = sums.get(owner) ?? { connections: 0, pids: new Set<number>() };
    sum.connections += 1;
    sum.pids.add(row.pid);
    sums.set(owner, sum);
  }
  return [...sums]
    .map(([owner, sum]) => ({ owner, kind: kindOf.get(owner) ?? "other", connections: sum.connections, processes: sum.pids.size }))
    .sort((a, b) => b.connections - a.connections || a.owner.localeCompare(b.owner));
}

/** This function gives the listening ports with their processes and owners, by port. */
export function listeningPorts(tcp: TcpTable, processes: readonly ProcessInfo[], ownerOf: ReadonlyMap<number, string>): ListeningPort[] {
  const names = new Map(processes.map((info) => [info.pid, info.name]));
  const rows = new Map<string, { port: number; pid: number; addresses: string[] }>();
  for (const row of tcp.connections) {
    if (row.state !== "listen") continue;
    const key = `${row.localPort}/${row.pid}`;
    const entry = rows.get(key) ?? { port: row.localPort, pid: row.pid, addresses: [] };
    if (row.address !== undefined && !entry.addresses.includes(row.address)) entry.addresses.push(row.address);
    rows.set(key, entry);
  }
  return [...rows.values()]
    .sort((a, b) => a.port - b.port || a.pid - b.pid)
    .map((entry) => ({
      port: entry.port,
      addresses: entry.addresses,
      pid: entry.pid,
      name: names.get(entry.pid) ?? "",
      owner: entry.pid === 0 ? "" : (ownerOf.get(entry.pid) ?? "other"),
    }));
}

/** This function tells if a first port and a count make a valid range of TCP ports. */
function validRange(first: number | undefined, count: number | undefined): boolean {
  return first !== undefined && count !== undefined && Number.isInteger(first) && Number.isInteger(count) && first >= 1 && count >= 1 && first + count - 1 <= 65_535;
}

/**
 * This function reads the dynamic port range from the output of `netsh int ipv4 show dynamicport tcp`. The output gives
 * the first port and the count after a colon. A text with no valid range gives the default.
 */
export function parseDynamicPorts(text: string): PortRange {
  const [first, count] = [...text.matchAll(/:\s*(\d+)/g)].map((match) => Number(match[1]));
  return first !== undefined && count !== undefined && validRange(first, count) ? { first, count } : DEFAULT_DYNAMIC_PORTS;
}

/** This function reads the dynamic port range of Linux from `/proc/sys/net/ipv4/ip_local_port_range`: the first and the last port. */
export function parsePortRange(text: string): PortRange | null {
  const [first, last] = text.trim().split(/\s+/).map(Number);
  if (first === undefined || last === undefined) return null;
  return validRange(first, last - first + 1) ? { first, count: last - first + 1 } : null;
}

/** This function writes an IPv6 address of 16 bytes in its short form, for example `::1`. The longest run of zero groups becomes `::`. */
export function ipv6Text(bytes: ArrayLike<number>): string {
  const groups: number[] = [];
  for (let index = 0; index < 16; index += 2) groups.push(((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0));
  let start = -1;
  let length = 0;
  for (let index = 0; index < 8; ) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < 8 && groups[end] === 0) end += 1;
    if (end - index >= 2 && end - index > length) {
      start = index;
      length = end - index;
    }
    index = end;
  }
  const hex = groups.map((group) => group.toString(16));
  return start < 0 ? hex.join(":") : `${hex.slice(0, start).join(":")}::${hex.slice(start + length).join(":")}`;
}

// The states of MIB_TCP_STATE that headroom counts. The other states are "other".
const WINDOWS_STATES: Readonly<Record<number, TcpState>> = { 2: "listen", 5: "established", 11: "time-wait" };
// One MIB_TCPROW_OWNER_PID: the state, the local address, the local port, the remote address, the remote port and the process.
const TCP4_ROW = 24;
// One MIB_TCP6ROW_OWNER_PID: the local address (16 bytes), its scope, the local port, the remote address, its scope, the remote port, the state and the process.
const TCP6_ROW = 56;

/**
 * This function reads a table of `GetExtendedTcpTable` with `TCP_TABLE_OWNER_PID_ALL`. The table starts with the count
 * of rows. A port is in network byte order in the low 2 bytes of its field.
 */
export function parseTcpTable(buffer: Buffer, v6: boolean): TcpConnection[] {
  const size = v6 ? TCP6_ROW : TCP4_ROW;
  const count = buffer.length < 4 ? 0 : buffer.readUInt32LE(0);
  const list: TcpConnection[] = [];
  for (let index = 0; index < count; index++) {
    const at = 4 + index * size;
    if (at + size > buffer.length) break;
    const state = WINDOWS_STATES[buffer.readUInt32LE(at + (v6 ? 48 : 0))] ?? "other";
    const localPort = buffer.readUInt16BE(at + (v6 ? 20 : 8));
    const pid = buffer.readUInt32LE(at + (v6 ? 52 : 20));
    if (state !== "listen") list.push({ localPort, state, pid });
    else list.push({ localPort, state, pid, address: v6 ? ipv6Text(buffer.subarray(at, at + 16)) : buffer.subarray(at + 4, at + 8).join(".") });
  }
  return list;
}

/**
 * This function reads the rows of one connection from a table of `GetExtendedTcpTable` with `TCP_TABLE_OWNER_PID_ALL`
 * (H46). It keeps the rows with this local port and this remote port, with their two addresses. The other rows make no object.
 */
export function parseTcpEndpoints(buffer: Buffer, v6: boolean, localPort: number, remotePort: number): TcpEndpoints[] {
  const size = v6 ? TCP6_ROW : TCP4_ROW;
  const count = buffer.length < 4 ? 0 : buffer.readUInt32LE(0);
  const list: TcpEndpoints[] = [];
  for (let index = 0; index < count; index++) {
    const at = 4 + index * size;
    if (at + size > buffer.length) break;
    if (buffer.readUInt16BE(at + (v6 ? 20 : 8)) !== localPort || buffer.readUInt16BE(at + (v6 ? 44 : 16)) !== remotePort) continue;
    list.push({
      localAddress: v6 ? ipv6Text(buffer.subarray(at, at + 16)) : buffer.subarray(at + 4, at + 8).join("."),
      localPort,
      remoteAddress: v6 ? ipv6Text(buffer.subarray(at + 24, at + 40)) : buffer.subarray(at + 12, at + 16).join("."),
      remotePort,
      state: WINDOWS_STATES[buffer.readUInt32LE(at + (v6 ? 48 : 0))] ?? "other",
      pid: buffer.readUInt32LE(at + (v6 ? 52 : 20)),
    });
  }
  return list;
}

// The offsets in MIB_IF_ROW2 on 64-bit Windows. The table starts with the count, and its rows start at 8.
const IF_ROW = 1352;
const IF_ALIAS = 28;
const IF_ALIAS_BYTES = 514;
const IF_TYPE = 1128;
const IF_FLAGS = 1152;
const IF_OPER_STATUS = 1156;
const IF_TRANSMIT_SPEED = 1192;
const IF_RECEIVE_SPEED = 1200;
const IF_IN_OCTETS = 1208;
const IF_OUT_OCTETS = 1280;
const IF_TYPE_SOFTWARE_LOOPBACK = 24;
const IF_TYPE_TUNNEL = 131;
const IF_OPER_STATUS_UP = 1;
// The bits of InterfaceAndOperStatusFlags.
const HARDWARE_INTERFACE = 0x1;
const FILTER_INTERFACE = 0x2;

/** This function gives a link speed in bits per second, or `null` when the adapter does not tell it. */
function linkSpeed(value: bigint): number | null {
  return value === 0n || value > 1_000_000_000_000_000n ? null : Number(value);
}

/**
 * This function reads the table of `GetIfTable2`. It keeps the adapters that are up, with a hardware interface. A
 * loopback, a tunnel and each filter row of an adapter go, because they count the bytes of the adapter again.
 */
export function parseIfTable(buffer: Buffer): NetAdapter[] {
  const count = buffer.length < 4 ? 0 : buffer.readUInt32LE(0);
  const list: NetAdapter[] = [];
  for (let index = 0; index < count; index++) {
    const at = 8 + index * IF_ROW;
    if (at + IF_ROW > buffer.length) break;
    const flags = buffer[at + IF_FLAGS] ?? 0;
    const type = buffer.readUInt32LE(at + IF_TYPE);
    if ((flags & HARDWARE_INTERFACE) === 0 || (flags & FILTER_INTERFACE) !== 0) continue;
    if (type === IF_TYPE_SOFTWARE_LOOPBACK || type === IF_TYPE_TUNNEL || buffer.readUInt32LE(at + IF_OPER_STATUS) !== IF_OPER_STATUS_UP) continue;
    const alias = buffer.toString("utf16le", at + IF_ALIAS, at + IF_ALIAS + IF_ALIAS_BYTES);
    const end = alias.indexOf("\0");
    list.push({
      name: end < 0 ? alias : alias.slice(0, end),
      inBytes: Number(buffer.readBigUInt64LE(at + IF_IN_OCTETS)),
      outBytes: Number(buffer.readBigUInt64LE(at + IF_OUT_OCTETS)),
      inBitsPerSecond: linkSpeed(buffer.readBigUInt64LE(at + IF_RECEIVE_SPEED)),
      outBitsPerSecond: linkSpeed(buffer.readBigUInt64LE(at + IF_TRANSMIT_SPEED)),
    });
  }
  return list;
}

/** This function reads the received and the sent bytes of each interface from the text of `/proc/net/dev`. */
export function parseNetDev(text: string): { readonly name: string; readonly inBytes: number; readonly outBytes: number }[] {
  const list: { name: string; inBytes: number; outBytes: number }[] = [];
  // Two lines of headers come first. Each other line is the name, a colon, 8 receive fields and 8 transmit fields.
  for (const line of text.split("\n").slice(2)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const fields = line.slice(colon + 1).trim().split(/\s+/).map(Number);
    const inBytes = fields[0];
    const outBytes = fields[8];
    if (inBytes === undefined || outBytes === undefined || !Number.isFinite(inBytes) || !Number.isFinite(outBytes)) continue;
    list.push({ name: line.slice(0, colon).trim(), inBytes, outBytes });
  }
  return list;
}

// The states of `/proc/net/tcp` that headroom counts, in hexadecimal.
const LINUX_STATES: Readonly<Record<string, TcpState>> = { "01": "established", "06": "time-wait", "0A": "listen" };

/** This function writes an address of `/proc/net/tcp`. Each group of 8 hexadecimal digits is a 32-bit word, with its low byte first. */
function linuxAddress(hex: string): string {
  const bytes: number[] = [];
  for (let word = 0; word + 8 <= hex.length; word += 8) {
    for (let byte = 3; byte >= 0; byte--) bytes.push(Number.parseInt(hex.slice(word + byte * 2, word + byte * 2 + 2), 16));
  }
  return bytes.length === 4 ? bytes.join(".") : ipv6Text(bytes);
}

/** This function reads the rows of `/proc/net/tcp` or `/proc/net/tcp6`. Linux gives no process in these files, so each row has the process 0. */
export function parseProcTcp(text: string): TcpConnection[] {
  const list: TcpConnection[] = [];
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const local = fields[1];
    const st = fields[3];
    if (local === undefined || st === undefined) continue;
    const [address, port] = local.split(":");
    if (address === undefined || port === undefined) continue;
    const localPort = Number.parseInt(port, 16);
    if (!Number.isInteger(localPort)) continue;
    const state = LINUX_STATES[st.toUpperCase()] ?? "other";
    list.push(state === "listen" ? { localPort, state, pid: 0, address: linuxAddress(address) } : { localPort, state, pid: 0 });
  }
  return list;
}
