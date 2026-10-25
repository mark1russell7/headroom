import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isLoopback, parseRoles, PeerError, PeerResolver, RoleBook, roleOf, type FleetRole, type PeerSources } from "./peer.ts";
import type { ProcessLink, SessionInfo, TcpEndpoints } from "./types.ts";

const SITE = 4731;
const CLIENT = 50_123;

const proc = (pid: number, ppid: number, name: string, startedAt: number | undefined): ProcessLink => ({ pid, ppid, name, startedAt });

/** The client row of a loopback connection from the port CLIENT to the port SITE, and the row of the site. */
const rows = (pid: number, address: string = "127.0.0.1", client: number = CLIENT): TcpEndpoints[] => [
  { localAddress: address, localPort: client, remoteAddress: address, remotePort: SITE, state: "established", pid },
  { localAddress: address, localPort: SITE, remoteAddress: address, remotePort: client, state: "established", pid: 999 },
];

const ROLES: FleetRole[] = [
  { id: "headroom", status: "active", sessionId: "19f84d12-aaaa", sessionName: "headroom" },
  { id: "strategist", status: "active", sessionId: "13a01f2a-bbbb", sessionName: "strategies" },
  { id: "bubble", status: "parked", sessionId: null, sessionName: null },
  { id: "jarvis-client", status: "retired", sessionId: "9e129985-cccc", sessionName: "jarvis-client" },
];

interface Fake {
  readonly sources: PeerSources;
  readonly calls: { fresh: number; freshSessions: number };
  setSnapshot(list: readonly ProcessLink[]): void;
}

/** This function makes the sources of a resolver: claude.exe (10) > bash.exe (11) > node.exe (12), and an orphan node.exe (20). */
function fake(options: {
  readonly tcp?: readonly TcpEndpoints[] | null;
  readonly snapshot?: readonly ProcessLink[];
  readonly fresh?: readonly ProcessLink[];
  readonly starts?: ReadonlyMap<number, number> | null;
  readonly sessions?: readonly SessionInfo[];
  readonly freshSessions?: readonly SessionInfo[];
}): Fake {
  const tree = [proc(1, 0, "explorer.exe", 100), proc(10, 1, "claude.exe", 200), proc(11, 10, "bash.exe", 300), proc(12, 11, "node.exe", 400), proc(20, 1, "node.exe", 500)];
  let snapshot = options.snapshot ?? tree;
  const fresh = options.fresh ?? snapshot;
  const sessions = options.sessions ?? [{ pid: 10, name: "headroom", sessionId: "19f84d12-aaaa", status: "busy", cwd: null, startedAt: 200 }];
  const calls = { fresh: 0, freshSessions: 0 };
  const tcp = options.tcp === undefined ? rows(12) : options.tcp;
  const starts = options.starts === undefined ? new Map([...fresh].map((info) => [info.pid, info.startedAt ?? 0])) : options.starts;
  const sources: PeerSources = {
    tcpEndpoints: tcp === null ? undefined : (local, remote) => tcp.filter((row) => row.localPort === local && row.remotePort === remote),
    processes: () => snapshot,
    freshProcesses: () => {
      calls.fresh += 1;
      return fresh;
    },
    processStart: starts === null ? undefined : (pid) => starts.get(pid),
    sessions: () => sessions,
    freshSessions: () => {
      calls.freshSessions += 1;
      return options.freshSessions ?? sessions;
    },
    roles: () => ROLES,
  };
  return { sources, calls, setSnapshot: (list) => (snapshot = list) };
}

const input = { localPort: SITE, remotePort: CLIENT };

/** This function gives the code of the error of a call. */
function codeOf(call: () => unknown): string | undefined {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(PeerError);
    return (error as PeerError).code;
  }
  return undefined;
}

describe("PeerResolver", () => {
  it("gives the session and the role of a direct claude.exe peer", () => {
    const { sources } = fake({ tcp: rows(10) });
    expect(new PeerResolver(sources).resolve(input)).toEqual({ pid: 10, exe: "claude.exe", via: [10], sessionId: "19f84d12-aaaa", session: "headroom", role: "headroom" });
  });

  it("walks from a node child two levels down to its claude.exe", () => {
    const { sources } = fake({});
    expect(new PeerResolver(sources).resolve(input)).toEqual({ pid: 12, exe: "node.exe", via: [12, 11, 10], sessionId: "19f84d12-aaaa", session: "headroom", role: "headroom" });
  });

  it("finds the connection on the IPv6 loopback and on a mapped IPv4 address", () => {
    expect(new PeerResolver(fake({ tcp: rows(12, "::1") }).sources).resolve(input).pid).toBe(12);
    expect(new PeerResolver(fake({ tcp: rows(12, "::ffff:7f00:1") }).sources).resolve(input).pid).toBe(12);
  });

  it("gives an anonymous peer with no claude.exe above it, and no error", () => {
    const { sources } = fake({ tcp: rows(20) });
    expect(new PeerResolver(sources).resolve(input)).toEqual({ pid: 20, exe: "node.exe", via: [20] });
  });

  it("stops the walk at a parent that started after its child: a process ID in use again", () => {
    // The real parent 11 ended. A new bash.exe got its ID after node.exe started.
    const snapshot = [proc(10, 1, "claude.exe", 200), proc(11, 10, "bash.exe", 900), proc(12, 11, "node.exe", 400)];
    const { sources } = fake({ snapshot });
    expect(new PeerResolver(sources).resolve(input)).toEqual({ pid: 12, exe: "node.exe", via: [12] });
  });

  it("stops the walk at a parent with no start, because it fails closed", () => {
    const snapshot = [proc(10, 1, "claude.exe", 200), proc(11, 10, "bash.exe", undefined), proc(12, 11, "node.exe", 400)];
    const { sources } = fake({ snapshot, starts: new Map([[12, 400]]) });
    expect(new PeerResolver(sources).resolve(input).via).toEqual([12]);
  });

  it("walks at most 16 parents", () => {
    const deep = [proc(10, 1, "claude.exe", 200)];
    for (let pid = 30; pid <= 46; pid++) deep.push(proc(pid, pid === 30 ? 10 : pid - 1, "node.exe", 300 + pid));
    // The peer 46 has 16 node.exe parents (45 to 30) before claude.exe.
    expect(new PeerResolver(fake({ tcp: rows(46), snapshot: deep }).sources).resolve(input).session).toBeUndefined();
    expect(new PeerResolver(fake({ tcp: rows(45), snapshot: deep }).sources).resolve(input)).toMatchObject({
      via: [45, 44, 43, 42, 41, 40, 39, 38, 37, 36, 35, 34, 33, 32, 31, 30, 10],
      session: "headroom",
    });
  });

  it("gives NO_CONNECTION without a client row with a process on the loopback", () => {
    expect(codeOf(() => new PeerResolver(fake({ tcp: [] }).sources).resolve(input))).toBe("NO_CONNECTION");
    expect(codeOf(() => new PeerResolver(fake({ tcp: rows(12) }).sources).resolve({ localPort: SITE, remotePort: CLIENT + 5 }))).toBe("NO_CONNECTION");
    expect(codeOf(() => new PeerResolver(fake({ tcp: rows(12, "192.168.1.5") }).sources).resolve(input))).toBe("NO_CONNECTION");
    expect(codeOf(() => new PeerResolver(fake({ tcp: [{ ...rows(12)[0]!, state: "time-wait", pid: 0 }] }).sources).resolve(input))).toBe("NO_CONNECTION");
  });

  it("gives NO_CONNECTION when two processes hold rows of the same ports", () => {
    const tcp = [...rows(12), ...rows(20, "::1")];
    expect(codeOf(() => new PeerResolver(fake({ tcp }).sources).resolve(input))).toBe("NO_CONNECTION");
  });

  it("gives PEER_GONE when the peer ended before the walk", () => {
    const starts = new Map([[10, 200]]);
    const { sources, calls } = fake({ starts, fresh: [proc(10, 1, "claude.exe", 200)] });
    expect(codeOf(() => new PeerResolver(sources).resolve(input))).toBe("PEER_GONE");
    expect(calls.fresh).toBe(1);
  });

  it("gives PEER_GONE without a live start read when no read has the peer", () => {
    const { sources } = fake({ snapshot: [], fresh: [], starts: null });
    expect(codeOf(() => new PeerResolver(sources).resolve(input))).toBe("PEER_GONE");
  });

  it("gives NOT_SUPPORTED on a platform with no process for a TCP row", () => {
    expect(codeOf(() => new PeerResolver(fake({ tcp: null }).sources).resolve(input))).toBe("NOT_SUPPORTED");
  });

  it("reads the processes again for a peer that is younger than the snapshot", () => {
    const young = [proc(10, 1, "claude.exe", 200), proc(13, 10, "node.exe", 700)];
    const { sources, calls } = fake({ tcp: rows(13), snapshot: [proc(10, 1, "claude.exe", 200)], fresh: young });
    expect(new PeerResolver(sources).resolve(input)).toMatchObject({ pid: 13, via: [13, 10], session: "headroom" });
    expect(calls.fresh).toBe(1);
  });

  it("reads the processes again when the snapshot has an older process with the ID of the peer", () => {
    const snapshot = [proc(10, 1, "claude.exe", 200), proc(12, 1, "node.exe", 50)];
    const fresh = [proc(10, 1, "claude.exe", 200), proc(11, 10, "bash.exe", 300), proc(12, 11, "node.exe", 400)];
    const { sources, calls } = fake({ snapshot, fresh });
    expect(new PeerResolver(sources).resolve(input).via).toEqual([12, 11, 10]);
    expect(calls.fresh).toBe(1);
  });

  it("keeps the walk in the cache, and removes it when a new snapshot does not have the peer", () => {
    const young = [proc(10, 1, "claude.exe", 200), proc(13, 10, "node.exe", 700)];
    // The node.exe 13 connects from the port CLIENT, and the claude.exe 10 from the port CLIENT + 1.
    const tcp = [...rows(13), ...rows(10, "127.0.0.1", CLIENT + 1)];
    const { sources, calls, setSnapshot } = fake({ tcp, snapshot: [proc(10, 1, "claude.exe", 200)], fresh: young });
    const resolver = new PeerResolver(sources);
    resolver.resolve(input);
    resolver.resolve(input);
    expect(calls.fresh).toBe(1);
    expect(resolver.cached).toBe(1);
    // The next snapshot has the peer, so the walk stays.
    setSnapshot([...young]);
    resolver.resolve(input);
    expect(resolver.cached).toBe(1);
    expect(calls.fresh).toBe(1);
    // A snapshot without the peer removes its walk. Thus the next call for the peer walks again with a fresh read.
    setSnapshot([proc(10, 1, "claude.exe", 200)]);
    expect(resolver.resolve({ localPort: SITE, remotePort: CLIENT + 1 }).session).toBe("headroom");
    expect(resolver.cached).toBe(1);
    resolver.resolve(input);
    expect(calls.fresh).toBe(2);
    expect(resolver.cached).toBe(2);
  });

  it("keeps no walk without a live start", () => {
    const resolver = new PeerResolver(fake({ starts: null }).sources);
    expect(resolver.resolve(input).session).toBe("headroom");
    expect(resolver.cached).toBe(0);
  });

  it("gives no session when the claude.exe of a cached walk ended", () => {
    const starts = new Map([[10, 200], [11, 300], [12, 400]]);
    const { sources } = fake({ starts });
    const resolver = new PeerResolver(sources);
    expect(resolver.resolve(input).session).toBe("headroom");
    starts.delete(10);
    expect(resolver.resolve(input)).toEqual({ pid: 12, exe: "node.exe", via: [12] });
  });

  it("reads the session files again for a session that is younger than the last read, one time until the next read", () => {
    const fresh = [{ pid: 10, name: "strategies", sessionId: "13a01f2a-bbbb", status: null, cwd: null }];
    const { sources, calls } = fake({ sessions: [], freshSessions: fresh });
    const resolver = new PeerResolver(sources);
    expect(resolver.resolve(input)).toMatchObject({ session: "strategies", sessionId: "13a01f2a-bbbb", role: "strategist" });
    resolver.resolve(input);
    expect(calls.freshSessions).toBe(1);
  });

  it("gives a claude.exe with no session file no session, and reads the files one time", () => {
    const { sources, calls } = fake({ sessions: [], freshSessions: [] });
    const resolver = new PeerResolver(sources);
    expect(resolver.resolve(input)).toEqual({ pid: 12, exe: "node.exe", via: [12, 11, 10] });
    resolver.resolve(input);
    expect(calls.freshSessions).toBe(1);
  });

  it("does not take the session file of an older claude.exe with the same process ID", () => {
    const sessions = [{ pid: 10, name: "headroom", sessionId: "19f84d12-aaaa", status: null, cwd: null, startedAt: 150 }];
    expect(new PeerResolver(fake({ sessions }).sources).resolve(input).session).toBeUndefined();
  });
});

describe("roleOf", () => {
  it("matches the session ID first, then the session name, then the role ID", () => {
    expect(roleOf({ sessionId: "19f84d12-aaaa", name: "renamed" }, ROLES)).toBe("headroom");
    expect(roleOf({ sessionId: "other", name: "strategies" }, ROLES)).toBe("strategist");
    expect(roleOf({ sessionId: "", name: "bubble" }, ROLES)).toBe("bubble");
    expect(roleOf({ sessionId: "other", name: "nobody" }, ROLES)).toBeUndefined();
  });

  it("does not match a retired role", () => {
    expect(roleOf({ sessionId: "9e129985-cccc", name: "jarvis-client" }, ROLES)).toBeUndefined();
  });
});

describe("parseRoles and RoleBook", () => {
  const json = JSON.stringify({
    roles: [
      { id: "organizer", status: "active", session: { name: "organizer", id: "e283aec6" } },
      { id: "bubble", status: "parked", session: { name: null, id: "763a6c34" } },
      { title: "no id" },
    ],
  });

  it("reads the roles with their sessions", () => {
    expect(parseRoles(json)).toEqual([
      { id: "organizer", status: "active", sessionId: "e283aec6", sessionName: "organizer" },
      { id: "bubble", status: "parked", sessionId: "763a6c34", sessionName: null },
    ]);
    expect(parseRoles("{}")).toEqual([]);
  });

  it("reads the file again after a change, and gives no roles for a missing or bad file", () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-roles-"));
    try {
      const file = join(dir, "roles.json");
      const book = new RoleBook(file);
      expect(book.roles()).toEqual([]);
      writeFileSync(file, json);
      expect(book.roles().map((role) => role.id)).toEqual(["organizer", "bubble"]);
      writeFileSync(file, "{ not json, and longer than before");
      expect(book.roles()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isLoopback", () => {
  it("knows the loopback addresses of IPv4 and IPv6", () => {
    for (const address of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:7f00:1", "::ffff:127.0.0.1"]) expect(isLoopback(address)).toBe(true);
    for (const address of ["0.0.0.0", "::", "192.168.1.5", "::ffff:c0a8:105", "fe80::1"]) expect(isLoopback(address)).toBe(false);
  });
});
