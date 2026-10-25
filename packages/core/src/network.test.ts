import { describe, expect, it } from "vitest";
import {
  DEFAULT_DYNAMIC_PORTS,
  dynamicUse,
  ipv6Text,
  listeningPorts,
  netFlows,
  parseDynamicPorts,
  parseIfTable,
  parseNetDev,
  parsePortRange,
  parseProcTcp,
  parseTcpEndpoints,
  parseTcpTable,
  tcpByOwner,
  tcpSummary,
} from "./network.ts";
import { MB } from "./sampler.ts";
import type { NetAdapter, OwnerKind, ProcessInfo, TcpTable } from "./types.ts";

/** This function writes a table of `GetExtendedTcpTable` for IPv4: the state, the address, the port and the process of each row. */
function tcp4(rows: readonly (readonly [number, readonly number[], number, number])[]): Buffer {
  const buffer = Buffer.alloc(4 + rows.length * 24);
  buffer.writeUInt32LE(rows.length, 0);
  rows.forEach(([state, address, port, pid], index) => {
    const at = 4 + index * 24;
    buffer.writeUInt32LE(state, at);
    buffer.set(address, at + 4);
    buffer.writeUInt16BE(port, at + 8);
    buffer.writeUInt32LE(pid, at + 20);
  });
  return buffer;
}

/** This function writes a table of `GetExtendedTcpTable` for IPv6. */
function tcp6(rows: readonly (readonly [number, readonly number[], number, number])[]): Buffer {
  const buffer = Buffer.alloc(4 + rows.length * 56);
  buffer.writeUInt32LE(rows.length, 0);
  rows.forEach(([state, address, port, pid], index) => {
    const at = 4 + index * 56;
    buffer.set(address, at);
    buffer.writeUInt16BE(port, at + 20);
    buffer.writeUInt32LE(state, at + 48);
    buffer.writeUInt32LE(pid, at + 52);
  });
  return buffer;
}

interface IfRow {
  readonly alias: string;
  readonly type: number;
  readonly flags: number;
  readonly oper: number;
  readonly speed: bigint;
  readonly inBytes: bigint;
  readonly outBytes: bigint;
}

/** This function writes a table of `GetIfTable2` with the fields that the parser reads. */
function ifTable(rows: readonly IfRow[]): Buffer {
  const buffer = Buffer.alloc(8 + rows.length * 1352);
  buffer.writeUInt32LE(rows.length, 0);
  rows.forEach((row, index) => {
    const at = 8 + index * 1352;
    buffer.write(row.alias, at + 28, "utf16le");
    buffer.writeUInt32LE(row.type, at + 1128);
    buffer[at + 1152] = row.flags;
    buffer.writeUInt32LE(row.oper, at + 1156);
    buffer.writeBigUInt64LE(row.speed, at + 1192);
    buffer.writeBigUInt64LE(row.speed, at + 1200);
    buffer.writeBigUInt64LE(row.inBytes, at + 1208);
    buffer.writeBigUInt64LE(row.outBytes, at + 1280);
  });
  return buffer;
}

const adapter = (name: string, inBytes: number, outBytes: number, bits: number | null): NetAdapter => ({
  name, inBytes, outBytes, inBitsPerSecond: bits, outBitsPerSecond: bits,
});

describe("the network reads", () => {
  it("keeps the adapters that are up with a hardware interface, and drops the filters, the loopback and the tunnels", () => {
    const wifi = { type: 71, oper: 1, speed: 1_201_000_000n, inBytes: 2_294_328_916n, outBytes: 1_000_000n };
    const table = ifTable([
      { ...wifi, alias: "Wi-Fi-QoS Packet Scheduler-0000", flags: 0x2 },
      { ...wifi, alias: "Wi-Fi", flags: 0x5 },
      { ...wifi, alias: "Ethernet", type: 6, flags: 0x15, oper: 2 },
      { ...wifi, alias: "Loopback Pseudo-Interface 1", type: 24, flags: 0x1 },
      { ...wifi, alias: "Tailscale", type: 53, flags: 0x0 },
      { ...wifi, alias: "Teredo", type: 131, flags: 0x1 },
      { ...wifi, alias: "Wired", type: 6, flags: 0x5, speed: 0n },
    ]);
    expect(parseIfTable(table)).toEqual([
      { name: "Wi-Fi", inBytes: 2_294_328_916, outBytes: 1_000_000, inBitsPerSecond: 1_201_000_000, outBitsPerSecond: 1_201_000_000 },
      { name: "Wired", inBytes: 2_294_328_916, outBytes: 1_000_000, inBitsPerSecond: null, outBitsPerSecond: null },
    ]);
  });

  it("gives the MB/s between two reads, and the sum of the link speeds as the capacity", () => {
    const before = { at: 0, adapters: [adapter("Wi-Fi", 0, 0, 1_000_000_000), adapter("Ethernet", 5 * MB, 0, null)] };
    const after = {
      at: 10_000,
      adapters: [adapter("Wi-Fi", 12 * MB, 3 * MB, 1_000_000_000), adapter("Ethernet", 1 * MB, 0, null), adapter("USB", 9 * MB, 9 * MB, null)],
    };
    // Ethernet restarted (its counter went back), and USB is new: they count 0.
    expect(netFlows(before, after)).toEqual({ in: { capacity: 119.2, used: 1.2 }, out: { capacity: 119.2, used: 0.3 } });
    expect(netFlows(undefined, after)).toEqual({ in: { capacity: 119.2, used: null }, out: { capacity: 119.2, used: null } });
    expect(netFlows(before, { at: 10_000, adapters: [adapter("Ethernet", 6 * MB, 0, null)] })).toEqual({
      in: { capacity: null, used: 0.1 },
      out: { capacity: null, used: 0 },
    });
  });

  it("reads the IPv4 and IPv6 tables of GetExtendedTcpTable, with the address of each listening port", () => {
    const v4 = parseTcpTable(tcp4([[2, [127, 0, 0, 1], 3000, 812], [5, [10, 0, 0, 2], 50_123, 812], [11, [10, 0, 0, 2], 50_124, 0], [8, [0, 0, 0, 0], 445, 4]]), false);
    expect(v4).toEqual([
      { localPort: 3000, state: "listen", pid: 812, address: "127.0.0.1" },
      { localPort: 50_123, state: "established", pid: 812 },
      { localPort: 50_124, state: "time-wait", pid: 0 },
      { localPort: 445, state: "other", pid: 4 },
    ]);
    const loopback = [...Array<number>(15).fill(0), 1];
    const v6 = parseTcpTable(tcp6([[2, Array<number>(16).fill(0), 3000, 812], [2, loopback, 5173, 900], [5, loopback, 60_000, 900]]), true);
    expect(v6).toEqual([
      { localPort: 3000, state: "listen", pid: 812, address: "::" },
      { localPort: 5173, state: "listen", pid: 900, address: "::1" },
      { localPort: 60_000, state: "established", pid: 900 },
    ]);
    // A table with fewer bytes than its count stops at the last full row.
    expect(parseTcpTable(tcp4([[2, [0, 0, 0, 0], 80, 4]]).subarray(0, 20), false)).toEqual([]);
  });

  it("reads the rows of one connection with their two ends (H46)", () => {
    // IPv4: the state, the local address and port, the remote address and port, and the process.
    const v4 = Buffer.alloc(4 + 3 * 24);
    v4.writeUInt32LE(3, 0);
    const row4 = (index: number, local: number, remote: number, remotePort: number, pid: number): void => {
      const at = 4 + index * 24;
      v4.writeUInt32LE(5, at);
      v4.set([127, 0, 0, 1], at + 4);
      v4.writeUInt16BE(local, at + 8);
      v4.set([127, 0, 0, remote], at + 12);
      v4.writeUInt16BE(remotePort, at + 16);
      v4.writeUInt32LE(pid, at + 20);
    };
    row4(0, 50_123, 1, 4731, 812);
    row4(1, 4731, 1, 50_123, 999);
    row4(2, 50_123, 2, 4000, 813);
    expect(parseTcpEndpoints(v4, false, 50_123, 4731)).toEqual([
      { localAddress: "127.0.0.1", localPort: 50_123, remoteAddress: "127.0.0.1", remotePort: 4731, state: "established", pid: 812 },
    ]);
    // IPv6: the local address, its scope, the local port, the remote address, its scope, the remote port, the state and the process.
    const v6 = Buffer.alloc(4 + 56);
    v6.writeUInt32LE(1, 0);
    v6[4 + 15] = 1;
    v6.writeUInt16BE(50_124, 4 + 20);
    v6[4 + 24 + 15] = 1;
    v6.writeUInt16BE(4731, 4 + 44);
    v6.writeUInt32LE(5, 4 + 48);
    v6.writeUInt32LE(900, 4 + 52);
    expect(parseTcpEndpoints(v6, true, 50_124, 4731)).toEqual([
      { localAddress: "::1", localPort: 50_124, remoteAddress: "::1", remotePort: 4731, state: "established", pid: 900 },
    ]);
    expect(parseTcpEndpoints(v6, true, 4731, 50_124)).toEqual([]);
  });

  it("writes IPv6 addresses in their short form", () => {
    expect(ipv6Text(Array<number>(16).fill(0))).toBe("::");
    expect(ipv6Text([0xfe, 0x80, ...Array<number>(13).fill(0), 1])).toBe("fe80::1");
    expect(ipv6Text([0x20, 0x01, 0x0d, 0xb8, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1])).toBe("2001:db8:1::1:0:1");
    expect(ipv6Text([0x20, 0x01, 0x0d, 0xb8, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6])).toBe("2001:db8:1:2:3:4:5:6");
  });

  it("reads the dynamic port range of netsh and of Linux, with the default for a text with no range", () => {
    const netsh = "\nProtocol tcp Dynamic Port Range\n---------------------------------\nStart Port      : 10000\nNumber of Ports : 55535\n";
    expect(parseDynamicPorts(netsh)).toEqual({ first: 10_000, count: 55_535 });
    expect(parseDynamicPorts("The requested operation requires elevation.")).toEqual(DEFAULT_DYNAMIC_PORTS);
    expect(parseDynamicPorts("Start Port : 60000\nNumber of Ports : 16384\n")).toEqual(DEFAULT_DYNAMIC_PORTS);
    expect(parsePortRange("32768\t60999\n")).toEqual({ first: 32_768, count: 28_232 });
    expect(parsePortRange("")).toBeNull();
  });

  it("reads /proc/net/dev and /proc/net/tcp", () => {
    const dev = [
      "Inter-|   Receive                                                |  Transmit",
      " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
      "    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0",
      "  eth0: 52428800 900 0 0 0 0 0 0 10485760 800 0 0 0 0 0 0",
    ].join("\n");
    expect(parseNetDev(dev)).toEqual([{ name: "lo", inBytes: 1000, outBytes: 1000 }, { name: "eth0", inBytes: 52_428_800, outBytes: 10_485_760 }]);
    const tcp = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0",
      "   1: 0200000A:C350 0300000A:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 12346 1 0000000000000000 100 0 0 10 0",
      "   2: 0200000A:C351 0300000A:01BB 06 00000000:00000000 00:00000000 00000000     0        0 0 1 0000000000000000 100 0 0 10 0",
    ].join("\n");
    expect(parseProcTcp(tcp)).toEqual([
      { localPort: 3000, state: "listen", pid: 0, address: "127.0.0.1" },
      { localPort: 50_000, state: "established", pid: 0 },
      { localPort: 50_001, state: "time-wait", pid: 0 },
    ]);
    const tcp6 = "header\n   0: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 0 0 0 0 0 0\n";
    expect(parseProcTcp(tcp6)).toEqual([{ localPort: 5173, state: "listen", pid: 0, address: "::1" }]);
  });
});

describe("the use of the TCP ports", () => {
  const tcp: TcpTable = {
    dynamic: { first: 49_152, count: 16_384 },
    connections: [
      { localPort: 3000, state: "listen", pid: 10, address: "0.0.0.0" },
      { localPort: 3000, state: "listen", pid: 10, address: "::" },
      { localPort: 135, state: "listen", pid: 4, address: "0.0.0.0" },
      { localPort: 3000, state: "established", pid: 10 },
      { localPort: 50_000, state: "established", pid: 10 },
      { localPort: 50_001, state: "established", pid: 11 },
      { localPort: 50_002, state: "established", pid: 20 },
      { localPort: 50_003, state: "time-wait", pid: 0 },
      { localPort: 49_151, state: "established", pid: 20 },
      { localPort: 65_535, state: "other", pid: 30 },
    ],
  };
  const ownerOf = new Map([[10, "session:graph"], [11, "session:graph"], [20, "mcp:vex"], [4, "system"]]);
  const kindOf = new Map<string, OwnerKind>([["session:graph", "session"], ["mcp:vex", "mcp"], ["system", "system"]]);
  const p = (pid: number, name: string): ProcessInfo => ({ pid, ppid: 1, name, privateMb: 0, workingMb: 0 });

  it("counts the rows in the dynamic range in each state, and the part in TIME_WAIT", () => {
    expect(dynamicUse(tcp)).toEqual({ used: 5, timeWait: 1 });
    expect(tcpSummary(tcp)).toEqual({ connections: 7, timeWait: 1, listening: 3 });
  });

  it("gives the dynamic connections of each owner, the largest first, with no owner for a row with no process", () => {
    expect(tcpByOwner(tcp, ownerOf, kindOf)).toEqual([
      { owner: "session:graph", kind: "session", connections: 2, processes: 2 },
      { owner: "mcp:vex", kind: "mcp", connections: 1, processes: 1 },
      { owner: "other", kind: "other", connections: 1, processes: 1 },
    ]);
  });

  it("gives the listening ports by port, one row for each process with its addresses", () => {
    expect(listeningPorts(tcp, [p(10, "node.exe"), p(4, "System")], ownerOf)).toEqual([
      { port: 135, addresses: ["0.0.0.0"], pid: 4, name: "System", owner: "system" },
      { port: 3000, addresses: ["0.0.0.0", "::"], pid: 10, name: "node.exe", owner: "session:graph" },
    ]);
    // Linux gives no process.
    expect(listeningPorts({ ...tcp, connections: [{ localPort: 22, state: "listen", pid: 0, address: "0.0.0.0" }] }, [], ownerOf)).toEqual([
      { port: 22, addresses: ["0.0.0.0"], pid: 0, name: "", owner: "" },
    ]);
  });
});
