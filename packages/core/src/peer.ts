/**
 * The peer of a local TCP connection (H46). The peer is the process at the client end of the connection. This file also
 * finds the nearest `claude.exe` above the peer, with the session and the fleet role of that `claude.exe`.
 * The fleet site uses `resources.peer` one time for each MCP session or each keep-alive connection.
 *
 * The limit: this attribution is as strong as "the same Windows user". It is not a security boundary. A process of that
 * user can choose its parent with `PROC_THREAD_ATTRIBUTE_PARENT_PROCESS`, and it can write a session file.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { programName } from "./owners.ts";
import type { ProcessLink, SessionInfo, TcpEndpoints } from "./types.ts";

/** The input of `resources.peer`: the two ports that the site sees on its loopback connection. */
export interface PeerInput {
  /** The local port of the site: the port of its listener. */
  readonly localPort: number;
  /** The remote port that the site sees: the port of the client. */
  readonly remotePort: number;
}

/** The peer of a connection, with the session and the role of its nearest `claude.exe`. */
export interface Peer {
  /** The process that holds the client end of the connection. */
  readonly pid: number;
  /** The image name of that process, for example `node.exe`. */
  readonly exe: string;
  /** The process IDs from the peer up to the nearest `claude.exe`, with the two ends. Without a live `claude.exe`, only the peer. */
  readonly via: readonly number[];
  /** The ID of the session of that `claude.exe`. It is absent when the `claude.exe` has no session file. */
  readonly sessionId?: string;
  /** The name of the session, as the owner `session:<name>` uses it. */
  readonly session?: string;
  /** The fleet role of the session, from the registry `roles.json`. It is absent when no role matches. */
  readonly role?: string;
}

/** The error codes of `resources.peer`. */
export type PeerErrorCode = "NO_CONNECTION" | "PEER_GONE" | "NOT_SUPPORTED";

/** An error of `resources.peer`. The procedure host sends its `code` to the caller. */
export class PeerError extends Error {
  readonly code: PeerErrorCode;

  constructor(code: PeerErrorCode, message: string) {
    super(message);
    this.name = "PeerError";
    this.code = code;
  }
}

/** One role of the fleet registry `roles.json`, with the fields that `roleOf()` uses. */
export interface FleetRole {
  readonly id: string;
  /** The status of the role, for example `active`, `parked` or `retired`. */
  readonly status: string | null;
  /** The ID of the session that holds the role. */
  readonly sessionId: string | null;
  /** The name of the session that holds the role. */
  readonly sessionName: string | null;
}

/** The fleet registry of the roles: `~/git/fleet/registry/roles.json`. */
export function rolesFile(): string {
  return join(homedir(), "git", "fleet", "registry", "roles.json");
}

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** This function reads the roles of the fleet registry. A role with no `id` is skipped. A text that is not JSON gives an error. */
export function parseRoles(json: string): FleetRole[] {
  const data = JSON.parse(json) as { roles?: unknown };
  if (!Array.isArray(data.roles)) return [];
  const roles: FleetRole[] = [];
  for (const item of data.roles as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const role = item as Record<string, unknown>;
    const id = text(role["id"]);
    if (id === null) continue;
    const session = typeof role["session"] === "object" && role["session"] !== null ? (role["session"] as Record<string, unknown>) : {};
    roles.push({ id, status: text(role["status"]), sessionId: text(session["id"]), sessionName: text(session["name"]) });
  }
  return roles;
}

/**
 * This function gives the role of a session. The registry ties each role to one session. A retired role does not match.
 *
 * 1. The role with the ID of the session wins.
 * 2. Then the role with the name of the session as its session name wins. The role `strategist` has the session name `strategies`.
 * 3. Then the role with the name of the session as its ID wins. A parked role has no session name.
 */
export function roleOf(session: Pick<SessionInfo, "sessionId" | "name">, roles: readonly FleetRole[]): string | undefined {
  const open = roles.filter((role) => role.status !== "retired");
  const byId = session.sessionId === "" ? undefined : open.find((role) => role.sessionId === session.sessionId);
  return (byId ?? open.find((role) => role.sessionName === session.name) ?? open.find((role) => role.id === session.name))?.id;
}

/** The roles of the fleet registry. It reads the file again only after a change of its time or its size. */
export class RoleBook {
  readonly #file: string;
  #stamp = "";
  #roles: readonly FleetRole[] = [];

  constructor(file: string = rolesFile()) {
    this.#file = file;
  }

  /** This function gives the roles. A missing file or a file that is not JSON gives no roles. */
  roles(): readonly FleetRole[] {
    let stamp: string;
    try {
      const stats = statSync(this.#file);
      stamp = `${stats.mtimeMs}:${stats.size}`;
    } catch {
      this.#stamp = "";
      this.#roles = [];
      return this.#roles;
    }
    if (stamp === this.#stamp) return this.#roles;
    try {
      this.#roles = parseRoles(readFileSync(this.#file, "utf8"));
      this.#stamp = stamp;
    } catch {
      // The organizer writes the file at this time. The next call reads it again.
      this.#roles = [];
      this.#stamp = "";
    }
    return this.#roles;
  }
}

/** The sources of a peer resolver. The engine gives the sampler, its process snapshot and its sessions. */
export interface PeerSources {
  /** The TCP rows with a local port and a remote port. Without it, the platform has no peer read: `NOT_SUPPORTED`. */
  readonly tcpEndpoints?: ((localPort: number, remotePort: number) => readonly TcpEndpoints[]) | undefined;
  /** The process snapshot of the daemon, from its last read of the processes. A new read gives a new array. */
  readonly processes: () => readonly ProcessLink[];
  /** One fresh read of the processes, for a peer that is younger than the snapshot. */
  readonly freshProcesses: () => readonly ProcessLink[];
  /** The start of a live process, or `undefined` when it ended or is protected. Without it, the snapshot decides. */
  readonly processStart?: ((pid: number) => number | undefined) | undefined;
  /** The sessions of the daemon, from its last read of the session files. A new read gives a new array. */
  readonly sessions: () => readonly SessionInfo[];
  /** One fresh read of the session files, for a session that is younger than the last read. */
  readonly freshSessions: () => readonly SessionInfo[];
  /** The roles of the fleet registry. */
  readonly roles: () => readonly FleetRole[];
}

/** The walk from one peer process, which stays the same for the life of that process. */
interface Chain {
  readonly pid: number;
  readonly startedAt: number | undefined;
  readonly exe: string;
  /** The process IDs from the peer up to the `claude.exe`, or only the peer. */
  readonly via: readonly number[];
  /** The nearest `claude.exe`, or `undefined` when the walk found none. */
  readonly claude: { readonly pid: number; readonly startedAt: number | undefined } | undefined;
}

/** The most steps of a walk from the peer up to a `claude.exe`. */
export const PEER_MAX_DEPTH = 8;
/** The most walks in the cache. A full cache removes its oldest walk. */
const MAX_CHAINS = 256;

/** This function tells if an address is a loopback address: `127.0.0.0/8`, `::1`, or `127.0.0.0/8` mapped into IPv6. */
export function isLoopback(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(address) || /^::ffff:127\./.test(address);
}

/** This function tells if two starts are the same start. An unknown start matches each start. */
function sameStart(a: number | undefined, b: number | undefined): boolean {
  return a === undefined || b === undefined || Math.abs(a - b) <= 1;
}

/**
 * This function tells if a process can be the parent of a child. The parent must start at or before the child. A later
 * start shows a process ID that is in use again. An unknown start stops the walk, because the walk fails closed.
 */
function startedFirst(parent: ProcessLink, child: ProcessLink): boolean {
  return parent.pid !== child.pid && parent.startedAt !== undefined && child.startedAt !== undefined && parent.startedAt <= child.startedAt;
}

/** This function finds a process with its start. An entry with no start gets the live start. */
function find(list: readonly ProcessLink[], pid: number, start: number | undefined): ProcessLink | undefined {
  const entry = list.find((info) => info.pid === pid);
  if (entry === undefined || start === undefined) return entry;
  if (entry.startedAt === undefined) return { ...entry, startedAt: start };
  return sameStart(entry.startedAt, start) ? entry : undefined;
}

/** This function tells if a process is a `claude.exe`. */
function isClaude(info: ProcessLink): boolean {
  return programName(info.name) === "claude";
}

/**
 * The resolver of `resources.peer`. Each call reads the TCP tables one time. The walk uses the process snapshot of the
 * daemon, and one fresh read of the processes for a peer that is younger than the snapshot.
 *
 * - The cache keeps the walk of each peer by its process ID and start. A new process snapshot removes the walks of ended peers.
 * - The cache keeps the session of each `claude.exe` until the next read of the session files.
 * - The attribution is as strong as "the same Windows user", not a security boundary. A process can choose its parent.
 */
export class PeerResolver {
  readonly #sources: PeerSources;
  readonly #chains = new Map<string, Chain>();
  #snapshot: readonly ProcessLink[] | undefined;
  #sessionList: readonly SessionInfo[] | undefined;
  #sessionByPid = new Map<number, SessionInfo>();
  /** The `claude.exe` processes with no session file in the fresh read, until the next read of the session files. */
  #noSession = new Set<string>();

  constructor(sources: PeerSources) {
    this.#sources = sources;
  }

  /** The count of walks in the cache. */
  get cached(): number {
    return this.#chains.size;
  }

  /**
   * This function gives the peer of the loopback connection from the port `remotePort` to the port `localPort`. The site
   * sees these two ports. The client row of the connection has the local port `remotePort` and the remote port `localPort`.
   *
   * 1. It finds the client row in the IPv4 and the IPv6 table: loopback at the two ends, with a process. No row gives
   *    `NO_CONNECTION`. Rows of two processes also give `NO_CONNECTION`, because the call fails closed.
   * 2. It finds the peer process with its live start. A peer that ended gives `PEER_GONE`.
   * 3. It walks up at most 8 parents to the nearest `claude.exe`. Each parent must start at or before its child.
   * 4. It gives the session of that `claude.exe` and the role of the session. Without a `claude.exe`, the peer is anonymous.
   *
   * A platform with no read of the TCP processes gives `NOT_SUPPORTED`. Linux gives no process in `/proc/net/tcp`.
   */
  resolve(input: PeerInput): Peer {
    const read = this.#sources.tcpEndpoints;
    if (read === undefined) throw new PeerError("NOT_SUPPORTED", "This platform gives no process for a TCP connection, so headroom finds no peer");
    const pid = ownerOf(read(input.remotePort, input.localPort), input);
    const snapshot = this.#sources.processes();
    if (snapshot !== this.#snapshot) {
      this.#prune(snapshot);
      this.#snapshot = snapshot;
    }
    const verify = this.#sources.processStart;
    const start = verify?.(pid);
    const key = start === undefined ? undefined : `${pid}@${start}`;
    let chain = key === undefined ? undefined : this.#chains.get(key);
    if (chain === undefined) {
      chain = this.#walk(pid, start, verify !== undefined, snapshot);
      if (key !== undefined) this.#remember(key, chain);
    }
    return this.#answer(chain);
  }

  /** This function walks from the peer up to the nearest `claude.exe`. */
  #walk(pid: number, start: number | undefined, verified: boolean, snapshot: readonly ProcessLink[]): Chain {
    // A verified start that is unknown shows a process that ended or is protected. Only a fresh read can find it.
    let list: readonly ProcessLink[] = snapshot;
    let peer = verified && start === undefined ? undefined : find(list, pid, start);
    if (peer === undefined) {
      list = this.#sources.freshProcesses();
      peer = find(list, pid, start);
    }
    if (peer === undefined) throw new PeerError("PEER_GONE", `The process ${pid} of the connection ended before the walk`);
    const byPid = new Map(list.map((info) => [info.pid, info]));
    const via = [peer.pid];
    let at = peer;
    let claude = isClaude(peer) ? peer : undefined;
    for (let depth = 0; claude === undefined && depth < PEER_MAX_DEPTH; depth++) {
      const parent = byPid.get(at.ppid);
      if (parent === undefined || !startedFirst(parent, at)) break;
      via.push(parent.pid);
      at = parent;
      if (isClaude(at)) claude = at;
    }
    return {
      pid,
      startedAt: peer.startedAt,
      exe: peer.name,
      via: claude === undefined ? [pid] : via,
      claude: claude === undefined ? undefined : { pid: claude.pid, startedAt: claude.startedAt },
    };
  }

  /** This function gives the answer of a walk, with the session and the role of a live `claude.exe`. */
  #answer(chain: Chain): Peer {
    const claude = chain.claude;
    if (claude === undefined || !this.#alive(claude)) return { pid: chain.pid, exe: chain.exe, via: [chain.pid] };
    const peer: Peer = { pid: chain.pid, exe: chain.exe, via: [...chain.via] };
    const session = this.#sessionOf(claude);
    if (session === undefined) return peer;
    const role = roleOf(session, this.#sources.roles());
    return { ...peer, ...(session.sessionId === "" ? {} : { sessionId: session.sessionId }), session: session.name, ...(role === undefined ? {} : { role }) };
  }

  /** This function tells if the `claude.exe` of a walk still runs, with the same start. Without a live start read, it counts as live. */
  #alive(claude: { readonly pid: number; readonly startedAt: number | undefined }): boolean {
    const verify = this.#sources.processStart;
    if (verify === undefined) return true;
    const start = verify(claude.pid);
    return start !== undefined && sameStart(start, claude.startedAt);
  }

  /** This function gives the session of a `claude.exe`: from the last read of the session files, then from a fresh read. */
  #sessionOf(claude: { readonly pid: number; readonly startedAt: number | undefined }): SessionInfo | undefined {
    const list = this.#sources.sessions();
    if (list !== this.#sessionList) {
      this.#sessionList = list;
      this.#sessionByPid = new Map(list.map((session) => [session.pid, session]));
      this.#noSession = new Set();
    }
    const known = this.#sessionByPid.get(claude.pid);
    if (known !== undefined && sameStart(known.startedAt, claude.startedAt)) return known;
    const key = `${claude.pid}@${claude.startedAt}`;
    if (this.#noSession.has(key)) return undefined;
    const fresh = this.#sources.freshSessions().find((session) => session.pid === claude.pid && sameStart(session.startedAt, claude.startedAt));
    if (fresh === undefined) this.#noSession.add(key);
    else this.#sessionByPid.set(claude.pid, fresh);
    return fresh;
  }

  /** This function keeps a walk. A full cache removes its oldest walk. */
  #remember(key: string, chain: Chain): void {
    if (this.#chains.size >= MAX_CHAINS) {
      const oldest = this.#chains.keys().next();
      if (oldest.done !== true) this.#chains.delete(oldest.value);
    }
    this.#chains.set(key, chain);
  }

  /** This function removes the walks of the peers that are not in a new process snapshot. */
  #prune(snapshot: readonly ProcessLink[]): void {
    if (this.#chains.size === 0) return;
    const live = new Map(snapshot.map((info) => [info.pid, info.startedAt]));
    for (const [key, chain] of this.#chains) {
      if (!live.has(chain.pid) || !sameStart(live.get(chain.pid), chain.startedAt)) this.#chains.delete(key);
    }
  }
}

/** This function gives the process of the client row of a connection, or an error that fails closed. */
function ownerOf(rows: readonly TcpEndpoints[], input: PeerInput): number {
  const pids = new Set<number>();
  for (const row of rows) {
    if (row.pid !== 0 && row.state !== "listen" && isLoopback(row.localAddress) && isLoopback(row.remoteAddress)) pids.add(row.pid);
  }
  const [pid] = pids;
  if (pid === undefined) throw new PeerError("NO_CONNECTION", `No loopback connection from the port ${input.remotePort} to the port ${input.localPort} has a process`);
  if (pids.size > 1) throw new PeerError("NO_CONNECTION", `The processes ${[...pids].join(", ")} each hold a connection from the port ${input.remotePort} to the port ${input.localPort}`);
  return pid;
}
