import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.ts";
import type { ProcessRecord } from "./orphans.ts";
import {
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
    // A record of an older version has no ID: the names decide.
    expect(ownSession({ session: "kestrel", sessionId: null }, OTTER)).toBe(false);
    expect(ownSession({ session: "kestrel", sessionId: null }, { name: "kestrel", id: "6f1c-kestrel" })).toBe(true);
    expect(ownSession(kestrel, null)).toBe(false);
    expect(reapStep(kestrel, KESTREL, live)).toBe("stop");
    expect(reapStep(kestrel, OTTER, live)).toBe("ask");
    expect(reapStep(kestrel, OTTER, undefined)).toBe("needs-owner");
    expect(reapStep(kestrel, null, live)).toBe("ask");
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
  let grep: ProcessInfo | null;
  let liveStart: (pid: number) => number | undefined;
  let stops: number[];
  let engine: Engine;

  const list = (): ProcessInfo[] => [
    node(4, 0, "System", 0),
    ...(kestrelRuns ? [node(100, 4, "claude.exe", T0 - 5 * HOUR)] : []),
    node(110, 4, "claude.exe", T0 - HOUR),
    ...(shell ? [node(200, 100, "bash.exe", T0 - 3.5 * HOUR - MIN)] : []),
    ...(grep === null ? [] : [grep]),
  ];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "headroom-reap-"));
    sessions = join(dir, "sessions");
    mkdirSync(sessions);
    writeFileSync(join(sessions, "kestrel.json"), JSON.stringify({ pid: 100, name: "kestrel", sessionId: "6f1c-kestrel" }));
    writeFileSync(join(sessions, "otter.json"), JSON.stringify({ pid: 110, name: "otter", sessionId: "9a2d-otter" }));
    now = T0;
    shell = true;
    kestrelRuns = true;
    // The real case: grep.exe over a transcript, 1.5 GB private, 3.5 hours old.
    grep = node(27308, 200, "grep.exe", T0 - 3.5 * HOUR, 1536);
    liveStart = (pid) => list().find((each) => each.pid === pid)?.startedAt;
    stops = [];
    const sampler: Sampler = {
      memory: () => ({ totalMb: 28_000, availableMb: 9000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 }),
      processes: list,
      commandLine: (pid) => (pid === 27308 ? GREP_LINE : null),
      processStart: (pid) => liveStart(pid),
      stdoutKind: () => "pipe",
      close: () => undefined,
    };
    engine = new Engine({ sampler, store: new Store(":memory:"), now: () => now, sessionsDir: sessions, stopProcess: (pid) => stops.push(pid) });
    engine.tick();
    // The shell ends, and grep.exe stays.
    shell = false;
    now += 10_000;
    engine.tick();
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
});
