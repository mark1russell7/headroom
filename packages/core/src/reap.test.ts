import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.ts";
import type { ProcessRecord } from "./orphans.ts";
import {
  liveSession,
  namesSessionFiles,
  ownSession,
  reapCandidates,
  reapNotice,
  reapStep,
  SHADOW_MIN_MS,
  ShadowTracker,
  stdoutKindOf,
  writesFile,
  type StdoutKind,
} from "./reap.ts";
import type { Sampler } from "./sampler.ts";
import { Store } from "./store.ts";
import type { ProcessInfo } from "./types.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = 1_800_000_000_000;
/** A transcript of a session, with made-up names. */
const TRANSCRIPT = "C:\\Users\\<you>\\.claude\\projects\\D--work-kestrel\\2b7e1c55-0d4f-4c1e-9a65-3f2f8f1d9c10.jsonl";
const GREP_LINE = `"C:\\Program Files\\Git\\usr\\bin\\grep.exe" -c "tool_use" ${TRANSCRIPT}`;
const GREP_COMMAND = `grep -c "tool_use" ${TRANSCRIPT}`;
const KESTREL = { name: "kestrel", id: "6f1c-kestrel" };
const OTTER = { name: "otter", id: "9a2d-otter" };

function node(pid: number, ppid: number, name: string, startedAt: number, privateMb = 10): ProcessInfo {
  return { pid, ppid, name, privateMb, workingMb: privateMb, startedAt };
}

/** The record of a process of the session kestrel, made while its parent 200 ran. */
function record(pid: number, created: number, command: string | null, parentCreated = T0 - 4 * HOUR): ProcessRecord {
  return { pid, created, ppid: 200, parentCreated, owner: "session:kestrel", session: "kestrel", sessionId: "6f1c-kestrel", command, firstSeen: T0 - 3 * HOUR };
}

describe("the rule of the shadow log (H183)", () => {
  it("finds a transcript or a scratchpad folder of a session in a command line", () => {
    expect(namesSessionFiles(GREP_COMMAND)).toBe(true);
    expect(namesSessionFiles("rg -n x ~/.claude/projects/-work-kestrel/")).toBe(true);
    expect(namesSessionFiles("cat C:\\Users\\<you>\\AppData\\Local\\Temp\\claude\\0a1b\\5c6d\\scratchpad\\out.txt")).toBe(true);
    expect(namesSessionFiles("grep -r x D:\\work\\kestrel\\src")).toBe(false);
    expect(namesSessionFiles("grep -r x D:\\work\\scratchpad")).toBe(false);
  });

  it("finds an output file in the arguments of sort only", () => {
    expect(writesFile(`sort -o D:\\out.txt ${TRANSCRIPT}`)).toBe(true);
    expect(writesFile(`sort -uo D:\\out.txt ${TRANSCRIPT}`)).toBe(true);
    expect(writesFile(`sort --output=D:\\out.txt ${TRANSCRIPT}`)).toBe(true);
    expect(writesFile(`sort -n ${TRANSCRIPT}`)).toBe(false);
    expect(writesFile(`grep -o tool_use ${TRANSCRIPT}`)).toBe(false);
  });

  it("reads the kind of a standard output from its link on Linux", () => {
    const kinds: Record<string, StdoutKind> = {
      "pipe:[40213]": "pipe",
      "socket:[40214]": "socket",
      "/dev/null": "null",
      "/dev/pts/3": "terminal",
      "/srv/data/out.txt": "file",
      "/tmp/out.txt (deleted)": "file",
      "anon_inode:[eventfd]": "unknown",
      "/dev/sda1": "unknown",
      "": "unknown",
    };
    for (const [link, kind] of Object.entries(kinds)) expect(stdoutKindOf(link)).toBe(kind);
  });

  it("puts the real case in the log after 30 minutes above 500 MB, and keeps a writer out", () => {
    const tracker = new ShadowTracker();
    let grepMb = 1536;
    let stdout: StdoutKind = "unknown";
    const processes = (): ProcessInfo[] => [
      node(100, 4, "claude.exe", T0 - 5 * HOUR),
      // The shell 200 ended. grep.exe holds 1.5 GB and started 3.5 hours ago.
      node(27308, 200, "grep.exe", T0 - 3.5 * HOUR, grepMb),
      // A writer: sort writes its output to a file.
      node(27400, 200, "sort.exe", T0 - 3.5 * HOUR, 900),
      // A reader with a live parent is no orphan.
      node(27500, 100, "rg.exe", T0 - 3.5 * HOUR, 900),
      // An orphan reader of a folder that is not a session folder.
      node(27600, 200, "cat.exe", T0 - 3.5 * HOUR, 900),
    ];
    const records = new Map<number, ProcessRecord>([
      [27308, record(27308, T0 - 3.5 * HOUR, GREP_COMMAND)],
      [27400, record(27400, T0 - 3.5 * HOUR, `sort -o D:\\work\\sorted.txt ${TRANSCRIPT}`)],
      [27500, { ...record(27500, T0 - 3.5 * HOUR, `rg tool_use ${TRANSCRIPT}`), ppid: 100, parentCreated: T0 - 5 * HOUR }],
      [27600, record(27600, T0 - 3.5 * HOUR, "cat D:\\work\\kestrel\\big.log")],
    ]);
    const recordOf = (info: ProcessInfo) => records.get(info.pid);
    const sample = (at: number) => tracker.sample(at, processes(), recordOf, () => stdout);
    expect(sample(T0)).toEqual([]);
    expect(sample(T0 + SHADOW_MIN_MS)).toEqual([]);
    const [match, ...rest] = sample(T0 + SHADOW_MIN_MS + MIN);
    expect(rest).toEqual([]);
    expect(match).toMatchObject({ pid: 27308, name: "grep.exe", privateMb: 1536, ageMs: 3.5 * HOUR + SHADOW_MIN_MS + MIN, session: "kestrel", sessionId: "6f1c-kestrel", aboveSince: T0, stdout: "unknown" });
    expect(match?.command).toBe(GREP_COMMAND);
    // A standard output to a file makes grep a writer.
    stdout = "file";
    expect(sample(T0 + SHADOW_MIN_MS + 2 * MIN)).toEqual([]);
    stdout = "pipe";
    expect(sample(T0 + SHADOW_MIN_MS + 3 * MIN).map((each) => each.pid)).toEqual([27308]);
    // A read below the line starts the time again.
    grepMb = 400;
    expect(sample(T0 + SHADOW_MIN_MS + 4 * MIN)).toEqual([]);
    grepMb = 1536;
    expect(sample(T0 + SHADOW_MIN_MS + 5 * MIN)).toEqual([]);
    expect(sample(T0 + 2 * SHADOW_MIN_MS + 6 * MIN).map((each) => each.aboveSince)).toEqual([T0 + SHADOW_MIN_MS + 5 * MIN]);
  });
});

describe("the candidates of headroom reap (H183)", () => {
  it("lists a process whose parent ID is in use by a younger process, and not a process whose parent is not proven gone", () => {
    const processes = [
      node(100, 4, "claude.exe", T0 - 5 * HOUR),
      // A new process has the ID of the ended shell 200. It started after grep, so it is not the parent.
      node(200, 4, "node.exe", T0 - MIN),
      node(27308, 200, "grep.exe", T0 - 3.5 * HOUR, 1536),
      // The parent of this process started at an unknown time, so the parent is not proven gone.
      node(27700, 300, "grep.exe", T0 - HOUR, 700),
      { pid: 300, ppid: 4, name: "bash.exe", privateMb: 5, workingMb: 5 },
      // A process with no record is not listed, because no record proves its owner.
      node(27800, 999, "grep.exe", T0 - HOUR, 700),
    ];
    const records = new Map<number, ProcessRecord>([
      [27308, record(27308, T0 - 3.5 * HOUR, GREP_COMMAND)],
      [27700, { ...record(27700, T0 - HOUR, GREP_COMMAND), ppid: 300, parentCreated: 0 }],
    ]);
    const list = reapCandidates(processes, (info) => records.get(info.pid), T0);
    expect(list.map((each) => each.pid)).toEqual([27308]);
    expect(list[0]).toMatchObject({ privateMb: 1536, ageMs: 3.5 * HOUR, session: "kestrel", command: GREP_COMMAND });
  });

  it("lists the orphans with no session only with all", () => {
    const processes = [node(27308, 200, "grep.exe", T0 - HOUR, 600)];
    const plain = { ...record(27308, T0 - HOUR, "grep x y"), owner: "other", session: null, sessionId: null };
    expect(reapCandidates(processes, () => plain, T0)).toEqual([]);
    expect(reapCandidates(processes, () => plain, T0, true).map((each) => each.pid)).toEqual([27308]);
  });

  it("does not list the process of a session, also when the parent of the session ended", () => {
    const processes = [node(100, 50, "claude.exe", T0 - HOUR, 600)];
    const own = { ...record(100, T0 - HOUR, "claude"), ppid: 50 };
    expect(reapCandidates(processes, () => own, T0).map((each) => each.pid)).toEqual([100]);
    expect(reapCandidates(processes, () => own, T0, true, new Set([100]))).toEqual([]);
  });

  it("stops only a process of the session that asks, and needs the owner of the machine when no session runs", () => {
    const live = { pid: 100, name: "kestrel", sessionId: "6f1c-kestrel", status: null, cwd: null };
    const kestrel = record(27308, T0, GREP_COMMAND);
    expect(ownSession(kestrel, KESTREL)).toBe(true);
    expect(ownSession(kestrel, OTTER)).toBe(false);
    // The IDs decide over the names.
    expect(ownSession(kestrel, { name: "kestrel", id: "0000-other" })).toBe(false);
    // A record of an older version has no ID. When the caller has an ID, the names do not prove the session: a new
    // session can have the name of an ended session.
    expect(ownSession({ session: "kestrel", sessionId: null }, OTTER)).toBe(false);
    expect(ownSession({ session: "kestrel", sessionId: null }, { name: "kestrel", id: "6f1c-kestrel" })).toBe(false);
    // Only when the caller has no ID either, the names decide.
    expect(ownSession({ session: "kestrel", sessionId: null }, { name: "kestrel", id: "" })).toBe(true);
    expect(ownSession(kestrel, null)).toBe(false);
    expect(reapStep(kestrel, KESTREL, live)).toBe("stop");
    expect(reapStep(kestrel, OTTER, live)).toBe("ask");
    expect(reapStep(kestrel, OTTER, undefined)).toBe("needs-owner");
    expect(reapStep(kestrel, null, live)).toBe("ask");
  });

  it("stops only when the running session of the record is the caller (H183)", () => {
    const kestrel = record(27308, T0, GREP_COMMAND);
    // The session kestrel ended. A caller with its name and its ID gets no stop: the process needs the owner of the machine.
    expect(reapStep(kestrel, KESTREL, undefined)).toBe("needs-owner");
  });

  it("finds the running session of a record with no ID only when the session started before the process (H183)", () => {
    const older = { session: "kestrel", sessionId: null, created: T0 - 3 * HOUR };
    const processes = [node(100, 4, "claude.exe", T0 - 5 * HOUR), node(120, 4, "claude.exe", T0 - HOUR)];
    const first = { pid: 100, name: "kestrel", sessionId: "6f1c-kestrel", status: null, cwd: null };
    const restarted = { pid: 120, name: "kestrel", sessionId: "7e3a-kestrel", status: null, cwd: null };
    // The session that ran before the process can be its session.
    expect(liveSession(older, [first], processes)?.pid).toBe(100);
    // A new session with the same name started after the process, so it is not the session of the process.
    expect(liveSession(older, [restarted], processes)).toBeUndefined();
    expect(reapStep(older, { name: "kestrel", id: "7e3a-kestrel" }, liveSession(older, [restarted], processes))).toBe("needs-owner");
    // A record with no start cannot prove the order.
    expect(liveSession({ ...older, created: 0 }, [first], processes)).toBeUndefined();
    // The ID of a record decides with no order of the starts.
    expect(liveSession({ session: "kestrel", sessionId: "7e3a-kestrel", created: T0 - 3 * HOUR }, [restarted], processes)?.pid).toBe(120);
  });

  it("gives the text of a request with the memory, the age and the end of the command line", () => {
    const [candidate] = reapCandidates([node(27308, 200, "grep.exe", T0 - 3.5 * HOUR, 1536)], () => record(27308, T0 - 3.5 * HOUR, GREP_COMMAND), T0);
    if (candidate === undefined) throw new Error("no candidate");
    const ask = reapNotice(candidate, "ask", OTTER);
    expect(ask).toContain("grep.exe (pid 27308) holds 1.5 GB of private memory, and its parent ended. It started 3 h 30 min ago.");
    expect(ask).toContain("2b7e1c55-0d4f-4c1e-9a65-3f2f8f1d9c10.jsonl");
    expect(ask).toContain("The session otter asks the session kestrel to stop it with: headroom reap 27308");
    expect(reapNotice(candidate, "needs-owner", null)).toContain("Its session kestrel does not run, so it needs the owner of the machine.");
  });
});

describe("Engine reap (H183)", () => {
  let dir: string;
  let sessions: string;
  let now: number;
  let shell: boolean;
  let kestrelRuns: boolean;
  /** The name of the process of the session kestrel. On Linux a session can run as `node`. */
  let kestrelName: string;
  /** The terminal 50 is the parent of the process of the session kestrel. */
  let terminal: boolean;
  /** A new session with the name kestrel: the process 120 that started after grep.exe. */
  let restarted: boolean;
  let extra: ProcessInfo[];
  let grep: ProcessInfo | null;
  let liveStart: (pid: number) => number | undefined;
  let stops: number[];
  let engine: Engine;

  const list = (): ProcessInfo[] => [
    node(4, 0, "System", 0),
    ...(terminal ? [node(50, 4, "WindowsTerminal.exe", T0 - 6 * HOUR)] : []),
    ...(kestrelRuns ? [node(100, 50, kestrelName, T0 - 5 * HOUR)] : []),
    node(110, 4, "claude.exe", T0 - HOUR),
    ...(restarted ? [node(120, 4, "claude.exe", T0 + 5_000)] : []),
    ...(shell ? [node(200, 100, "bash.exe", T0 - 3.5 * HOUR - MIN)] : []),
    ...(grep === null ? [] : [grep]),
    ...extra,
  ];

  const makeSampler = (withStart = true): Sampler => ({
    memory: () => ({ totalMb: 28_000, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
    processes: list,
    commandLine: (pid) => (pid === 27308 ? GREP_LINE : null),
    ...(withStart ? { processStart: (pid: number) => liveStart(pid) } : {}),
    stdoutKind: () => "pipe",
    close: () => undefined,
  });

  /** This function makes an engine that reads the processes while the shell runs, and again after the shell ended. */
  const start = (sampler: Sampler = makeSampler(), stopProcess: (pid: number) => void = (pid) => stops.push(pid), store: Store = new Store(":memory:")): Engine => {
    now = T0;
    shell = true;
    const made = new Engine({ sampler, store, now: () => now, sessionsDir: sessions, stopProcess });
    made.tick();
    // The shell ends, and grep.exe stays.
    shell = false;
    now += 10_000;
    made.tick();
    return made;
  };

  /** This function closes the engine of `beforeEach` and makes a new one. */
  const restart = (sampler?: Sampler, stopProcess?: (pid: number) => void, store?: Store): void => {
    engine.close();
    engine = start(sampler, stopProcess, store);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "headroom-reap-"));
    sessions = join(dir, "sessions");
    mkdirSync(sessions);
    writeFileSync(join(sessions, "kestrel.json"), JSON.stringify({ pid: 100, name: "kestrel", sessionId: "6f1c-kestrel" }));
    writeFileSync(join(sessions, "otter.json"), JSON.stringify({ pid: 110, name: "otter", sessionId: "9a2d-otter" }));
    kestrelRuns = true;
    kestrelName = "claude.exe";
    terminal = true;
    restarted = false;
    extra = [];
    // The real case: grep.exe over a transcript, 1.5 GB private, 3.5 hours old.
    grep = node(27308, 200, "grep.exe", T0 - 3.5 * HOUR, 1536);
    liveStart = (pid) => list().find((each) => each.pid === pid)?.startedAt;
    stops = [];
    engine = start();
  });

  afterEach(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists the real case and puts it in the shadow log, with the automatic reap off", () => {
    expect(engine.reapList()).toEqual([
      {
        pid: 27308,
        created: T0 - 3.5 * HOUR,
        name: "grep.exe",
        privateMb: 1536,
        ageMs: 3.5 * HOUR + 10_000,
        owner: "session:kestrel",
        session: "kestrel",
        sessionId: "6f1c-kestrel",
        command: GREP_COMMAND,
      },
    ]);
    expect(engine.reapShadow()).toMatchObject({ auto: false, minMb: 500, minMs: SHADOW_MIN_MS, stdoutKnown: true, rows: [] });
    now = T0 + SHADOW_MIN_MS + MIN;
    engine.tick();
    now += 10_000;
    engine.tick();
    const view = engine.reapShadow();
    expect(view.rows).toEqual([
      {
        pid: 27308,
        created: T0 - 3.5 * HOUR,
        name: "grep.exe",
        firstAt: T0 + SHADOW_MIN_MS + MIN,
        lastAt: T0 + SHADOW_MIN_MS + MIN + 10_000,
        aboveSince: T0,
        samples: 2,
        privateMb: 1536,
        peakMb: 1536,
        owner: "session:kestrel",
        session: "kestrel",
        sessionId: "6f1c-kestrel",
        command: GREP_COMMAND,
        stdout: "pipe",
      },
    ]);
    // The shadow log stops no process, also with the setting on.
    expect(engine.setConfig({ reapAuto: true }).reapAuto).toBe(true);
    now += 10_000;
    engine.tick();
    expect(stops).toEqual([]);
    expect(engine.reapShadow().auto).toBe(true);
    expect(() => engine.setConfig({ reapAuto: "yes" as unknown as boolean })).toThrow(RangeError);
  });

  it("does not stop the process of another session: it records a request and shows an alert until the process ends", () => {
    const result = engine.reap(27308, OTTER);
    expect(result).toMatchObject({ pid: 27308, outcome: "asked" });
    expect(result.notice).toContain("The session otter asks the session kestrel to stop it with: headroom reap 27308");
    expect(stops).toEqual([]);
    expect(engine.reapLog()).toMatchObject([{ pid: 27308, action: "asked", session: "kestrel", sessionId: "6f1c-kestrel", by: "otter", byId: "9a2d-otter", privateMb: 1536 }]);
    expect(engine.alerts().active.find((each) => each.kind === "reap")).toMatchObject({ id: `reap:27308:${T0 - 3.5 * HOUR}`, pid: 27308, mb: 1536, severity: "warning" });
    // A caller with no session gets no stop either.
    expect(engine.reap(27308, null).outcome).toBe("asked");
    expect(stops).toEqual([]);
    // The process ends: the alert ends.
    grep = null;
    now += 10_000;
    engine.tick();
    expect(engine.alerts().active.some((each) => each.kind === "reap")).toBe(false);
    expect(engine.alerts().ended.some((each) => each.kind === "reap")).toBe(true);
  });

  it("records a process of a session that ended as a process that needs the owner of the machine", () => {
    kestrelRuns = false;
    now += 10_000;
    engine.tick();
    const result = engine.reap(27308, OTTER);
    expect(result.outcome).toBe("needs-owner");
    expect(result.message).toContain("needs the owner of the machine");
    expect(stops).toEqual([]);
    expect(engine.reapLog()[0]).toMatchObject({ action: "needs-owner", by: "otter" });
  });

  it("stops a process of the session that asks, and logs the stop", () => {
    const result = engine.reap(27308, KESTREL);
    expect(result).toMatchObject({ outcome: "stopped", notice: null });
    expect(stops).toEqual([27308]);
    expect(engine.reapLog()).toMatchObject([{ pid: 27308, action: "stopped", by: "kestrel", result: "ok" }]);
  });

  it("does not stop a new process with a reused ID: the start decides, and the new process is no orphan", () => {
    // A new process took the ID after the last read. The live start differs from the start of the orphan.
    liveStart = () => T0 + 15_000;
    expect(engine.reap(27308, KESTREL)).toMatchObject({ outcome: "ended" });
    expect(stops).toEqual([]);
    // At the next read, the new process has a live parent: the session otter. It is no orphan.
    grep = node(27308, 110, "grep.exe", T0 + 15_000, 1536);
    liveStart = (pid) => list().find((each) => each.pid === pid)?.startedAt;
    now += 10_000;
    engine.tick();
    expect(engine.reapList()).toEqual([]);
    expect(engine.reap(27308, KESTREL)).toMatchObject({ outcome: "not-orphan" });
    expect(engine.reap(27308, OTTER)).toMatchObject({ outcome: "not-orphan" });
    expect(stops).toEqual([]);
    expect(engine.reap(4242, KESTREL)).toMatchObject({ outcome: "not-found" });
    expect(engine.reap(100, KESTREL)).toMatchObject({ outcome: "session" });
    expect(engine.reapLog()).toEqual([]);
  });

  it("stops nothing when the sampler cannot read the start of a live process", () => {
    restart(makeSampler(false));
    expect(engine.reap(27308, KESTREL)).toMatchObject({ outcome: "ended" });
    expect(stops).toEqual([]);
    expect(engine.reapLog()).toEqual([]);
  });

  it("stops nothing when the live start is unknown", () => {
    liveStart = () => undefined;
    expect(engine.reap(27308, KESTREL)).toMatchObject({ outcome: "ended" });
    expect(stops).toEqual([]);
  });

  it("stops nothing when the read has no start of the process", () => {
    // The read gives no start of grep.exe, but the live process has one. No known start can prove that it is the same process.
    grep = { pid: 27308, ppid: 200, name: "grep.exe", privateMb: 1536, workingMb: 1536 };
    liveStart = (pid) => (pid === 27308 ? T0 - 3.5 * HOUR : list().find((each) => each.pid === pid)?.startedAt);
    restart();
    expect(engine.reapList().map((each) => each.pid)).toEqual([27308]);
    expect(engine.reap(27308, KESTREL)).toMatchObject({ outcome: "ended" });
    expect(stops).toEqual([]);
  });

  it("writes a failed stop to the reap log", () => {
    restart(undefined, () => {
      throw new Error("access denied");
    });
    const result = engine.reap(27308, KESTREL);
    expect(result).toMatchObject({ outcome: "failed", notice: null });
    expect(result.message).toContain("access denied");
    expect(engine.reapLog()).toMatchObject([{ pid: 27308, action: "stopped", by: "kestrel", result: "failed: access denied" }]);
  });

  it("does not stop for a caller whose session no longer runs", () => {
    kestrelRuns = false;
    now += 10_000;
    engine.tick();
    expect(engine.reap(27308, KESTREL)).toMatchObject({ outcome: "needs-owner" });
    expect(stops).toEqual([]);
  });

  it("does not stop an orphan of an ended session for a new session with the same name", () => {
    // A session file of an older version has no ID, so the record of grep.exe has the session name only.
    writeFileSync(join(sessions, "kestrel.json"), JSON.stringify({ pid: 100, name: "kestrel" }));
    restart();
    expect(engine.reapList()).toMatchObject([{ pid: 27308, session: "kestrel", sessionId: null }]);
    // The session kestrel ends. A new session with the same name and a new ID starts.
    kestrelRuns = false;
    restarted = true;
    writeFileSync(join(sessions, "kestrel.json"), JSON.stringify({ pid: 120, name: "kestrel", sessionId: "7e3a-kestrel" }));
    now += 10_000;
    engine.tick();
    expect(engine.reap(27308, { name: "kestrel", id: "7e3a-kestrel" })).toMatchObject({ outcome: "needs-owner" });
    expect(stops).toEqual([]);
  });

  it("does not stop the process of a session when its session file is not readable at one read", () => {
    // The terminal of the session kestrel ends, so the process of the session is an orphan.
    terminal = false;
    now += 10_000;
    engine.tick();
    expect(engine.reapList()).toEqual([expect.objectContaining({ pid: 27308 })]);
    // Claude Code writes the session file again, and the read finds half of it.
    writeFileSync(join(sessions, "kestrel.json"), "{");
    now += 10_000;
    engine.tick();
    expect(engine.reapList().map((each) => each.pid)).toEqual([27308]);
    expect(engine.reap(100, KESTREL)).toMatchObject({ outcome: "session" });
    expect(engine.reap(100, OTTER)).toMatchObject({ outcome: "session" });
    expect(stops).toEqual([]);
    expect(engine.reapLog()).toEqual([]);
  });

  it("does not stop a session that runs as node when its session file is not readable at one read", () => {
    kestrelName = "node";
    restart();
    terminal = false;
    now += 10_000;
    engine.tick();
    writeFileSync(join(sessions, "kestrel.json"), "{");
    now += 10_000;
    engine.tick();
    expect(engine.reapList().map((each) => each.pid)).toEqual([27308]);
    expect(engine.reap(100, KESTREL)).toMatchObject({ outcome: "session" });
    expect(stops).toEqual([]);
  });

  it("does not stop a process named claude", () => {
    // A claude.exe that a shell of the session started. Its shell ended.
    extra = [node(27900, 200, "claude.exe", T0 - 2 * HOUR, 300)];
    restart();
    expect(engine.reapList().map((each) => each.pid)).toEqual([27308]);
    expect(engine.reap(27900, KESTREL)).toMatchObject({ outcome: "session" });
    expect(stops).toEqual([]);
  });

  it("does not list or stop the client of an active lease of headroom run", () => {
    // A client of headroom run --detach whose shell ended. The lease ends when its process ends, so the test uses a live
    // process ID: the parent of this test process.
    extra = [node(process.ppid, 200, "node.exe", T0 - 2 * HOUR, 700)];
    restart();
    expect(engine.reapList().map((each) => each.pid)).toEqual([27308, process.ppid]);
    engine.request({ holder: "kestrel", job: "pnpm test", amounts: { memory: 100 }, pid: process.ppid });
    expect(engine.reapList().map((each) => each.pid)).toEqual([27308]);
    expect(engine.reap(process.ppid, KESTREL)).toMatchObject({ outcome: "headroom" });
    expect(stops).toEqual([]);
    expect(engine.reapLog()).toEqual([]);
  });

  it("does not list or stop the daemon", () => {
    // The daemon is this test process. Its parent ended, so it is an orphan of the session kestrel.
    extra = [node(process.pid, 200, "node.exe", T0 - 2 * HOUR, 400)];
    restart();
    expect(engine.reapList().map((each) => each.pid)).toEqual([27308]);
    expect(engine.reap(process.pid, KESTREL)).toMatchObject({ outcome: "headroom" });
    expect(stops).toEqual([]);
  });

  it("keeps the caveat of the writer test when the read of a standard output fails", () => {
    // The sampler has the read, but the read of the link of grep.exe fails: the process belongs to another user.
    restart({ ...makeSampler(), stdoutKind: () => "unknown" });
    now = T0 + SHADOW_MIN_MS + MIN;
    engine.tick();
    expect(engine.reapShadow()).toMatchObject({ stdoutKnown: false, rows: [{ pid: 27308, stdout: "unknown" }] });
  });

  it("starts a new period above the line in the shadow log after a read below the line", () => {
    now = T0 + SHADOW_MIN_MS + MIN;
    engine.tick();
    expect(engine.reapShadow().rows).toMatchObject([{ pid: 27308, aboveSince: T0 }]);
    // grep.exe goes below the line for one read, then above it again.
    grep = node(27308, 200, "grep.exe", T0 - 3.5 * HOUR, 100);
    now += 10_000;
    engine.tick();
    grep = node(27308, 200, "grep.exe", T0 - 3.5 * HOUR, 1536);
    now += 10_000;
    engine.tick();
    const again = now;
    now += SHADOW_MIN_MS + MIN;
    engine.tick();
    expect(engine.reapShadow().rows).toMatchObject([{ pid: 27308, aboveSince: again, samples: 2 }]);
  });

  it("shows the alert of a reap request again after a restart of the daemon, until the process ends", () => {
    const file = join(dir, "headroom.db");
    restart(undefined, undefined, new Store(file));
    expect(engine.reap(27308, OTTER).outcome).toBe("asked");
    const at = now;
    restart(undefined, undefined, new Store(file));
    const alert = engine.alerts().active.find((each) => each.kind === "reap");
    expect(alert).toMatchObject({ id: `reap:27308:${T0 - 3.5 * HOUR}`, since: at, pid: 27308, mb: 1536, severity: "warning" });
    expect(alert?.message).toContain("The session otter asks the session kestrel to stop it with: headroom reap 27308");
    // The process ends: the alert ends.
    grep = null;
    now += 10_000;
    engine.tick();
    expect(engine.alerts().active.some((each) => each.kind === "reap")).toBe(false);
  });
});
