import type { ReapCandidate, ReapEntry, ReapResult, ShadowView } from "@headroom/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { Connection } from "./client.ts";
import { NO_PROCESS, reapCommand, reapExit, reapListLines, reapLogLines, shadowLines, type ReapOutput } from "./reap-cli.ts";

const T0 = 1_800_000_000_000;
const COMMAND = "grep -c tool_use C:\\Users\\<you>\\.claude\\projects\\D--work-kestrel\\2b7e1c55-0d4f-4c1e-9a65-3f2f8f1d9c10.jsonl";
const KESTREL = { name: "kestrel", id: "6f1c-kestrel" };
const OTTER = { name: "otter", id: "9a2d-otter" };

const GREP: ReapCandidate = {
  pid: 27308,
  created: T0 - 12_600_000,
  name: "grep.exe",
  privateMb: 1536,
  ageMs: 12_600_000,
  owner: "session:kestrel",
  session: "kestrel",
  sessionId: "6f1c-kestrel",
  command: COMMAND,
};

const SHADOW: ShadowView = {
  auto: false,
  minMb: 500,
  minMs: 1_800_000,
  readers: ["grep", "rg", "sort", "findstr", "cat"],
  stdoutKnown: false,
  rows: [{ ...GREP, firstAt: T0, lastAt: T0 + 600_000, aboveSince: T0 - 1_900_000, samples: 61, peakMb: 1600, stdout: "unknown" }],
};

const ASKED: ReapResult = {
  pid: 27308,
  outcome: "asked",
  process: GREP,
  message: "grep.exe (pid 27308) belongs to the session kestrel. headroom does not stop the process of another session.",
  notice: "grep.exe (pid 27308) holds 1.5 GB of private memory. The session otter asks the session kestrel to stop it with: headroom reap 27308",
};

describe("headroom reap (H183)", () => {
  let calls: { path: readonly string[]; input: unknown }[];
  let lines: string[];
  let errors: string[];
  let answer: unknown;
  let connection: Connection;
  const io = (): ReapOutput => ({ out: (text) => lines.push(text), err: (text) => errors.push(text) });

  beforeEach(() => {
    calls = [];
    lines = [];
    errors = [];
    answer = undefined;
    connection = {
      endpoint: "http://127.0.0.1:0",
      call: async <T>(path: readonly string[], input: unknown): Promise<T> => {
        calls.push({ path, input });
        return answer as T;
      },
    };
  });

  it("refuses a wrong use with exit 2, and gives exit 1 when the daemon does not run", async () => {
    for (const argv of [["1", "2"], ["--shadow", "--log"], ["27308", "--shadow"], ["--all", "27308"], ["--all", "--log"], ["x"], ["0"], ["-5"], ["--force"]]) {
      expect(await reapCommand(argv, connection, KESTREL, io())).toBe(2);
    }
    expect(calls).toEqual([]);
    expect(await reapCommand([], null, KESTREL, io())).toBe(1);
    expect(errors.at(-1)).toContain("headroom does not run");
  });

  it("lists the orphans and marks the processes of the caller", async () => {
    answer = [GREP, { ...GREP, pid: 27400, privateMb: 600, session: "otter", sessionId: "9a2d-otter" }];
    expect(await reapCommand([], connection, KESTREL, io())).toBe(0);
    expect(calls).toEqual([{ path: ["resources", "reapList"], input: { all: false } }]);
    expect(lines[0]).toBe("2 processes have a parent that is proven gone. headroom reap <pid> stops a process of your session.");
    expect(lines[2]).toMatch(/^ {2}27308 +1\.5 GB {2}3 h 30 min +kestrel \(yours\) +grep -c tool_use /);
    expect(lines[2]).toContain("2b7e1c55-0d4f-4c1e-9a65-3f2f8f1d9c10.jsonl");
    expect(lines[3]).toMatch(/^ {2}27400 +600 MB .* otter +grep/);
    expect(lines[3]).not.toContain("(yours)");
    await reapCommand(["--all"], connection, null, io());
    expect(calls.at(-1)).toEqual({ path: ["resources", "reapList"], input: { all: true } });
  });

  it("says when the list is empty", () => {
    expect(reapListLines([], null, false)).toEqual(["No process of a session has a parent that is proven gone."]);
    expect(reapListLines([], null, true)).toEqual(["No process has a parent that is proven gone."]);
  });

  it("does not stop the process of another session: it prints the request that headroom recorded", async () => {
    answer = ASKED;
    expect(await reapCommand(["27308"], connection, OTTER, io())).toBe(0);
    expect(calls).toEqual([{ path: ["resources", "reap"], input: { pid: 27308, caller: OTTER } }]);
    expect(lines).toEqual([
      ASKED.message,
      "headroom has no path that sends a notice to one session. It recorded the request in the reap log. The text that it sends:",
      `  ${ASKED.notice}`,
    ]);
  });

  it("gives the exit code of each outcome", async () => {
    answer = { pid: 4242, outcome: "not-found", process: null, message: "No process has the ID 4242 at the last read.", notice: null } satisfies ReapResult;
    expect(await reapCommand(["4242"], connection, KESTREL, io())).toBe(NO_PROCESS);
    expect(errors).toEqual(["No process has the ID 4242 at the last read."]);
    const result = (outcome: ReapResult["outcome"]): ReapResult => ({ ...ASKED, outcome, notice: null });
    expect(reapExit(result("stopped"))).toBe(0);
    expect(reapExit(result("needs-owner"))).toBe(0);
    for (const outcome of ["not-orphan", "session", "ended", "failed"] as const) expect(reapExit(result(outcome))).toBe(1);
  });

  it("shows the shadow log with its rule, and says when the writer test reads only the arguments", async () => {
    answer = SHADOW;
    expect(await reapCommand(["--shadow"], connection, KESTREL, io())).toBe(0);
    expect(calls).toEqual([{ path: ["resources", "reapShadow"], input: {} }]);
    expect(lines[0]).toContain("Automatic reap: off. In this version no rule stops a process.");
    expect(lines.join("\n")).toContain("a reader (grep, rg, sort, findstr, cat)");
    expect(lines.join("\n")).toContain("more than 500 MB of private memory for more than 30 min");
    expect(lines.join("\n")).toContain("the writer test reads only the arguments");
    expect(lines.join("\n")).toContain("27308    peak   1.6 GB  61 samples, 2027-01-15 08:00Z to 2027-01-15 08:10Z  kestrel  stdout unknown");
    expect(shadowLines({ ...SHADOW, stdoutKnown: true, rows: [] }).at(-1)).toBe("The shadow log is empty.");
  });

  it("shows the reap log, and the JSON of each view", async () => {
    const entry: ReapEntry = { at: T0, pid: 27308, created: GREP.created, name: "grep.exe", session: "kestrel", sessionId: "6f1c-kestrel", by: "otter", byId: "9a2d-otter", action: "asked", privateMb: 1536, command: COMMAND, result: "the text" };
    expect(reapLogLines([entry])).toEqual(["  2027-01-15 08:00Z  asked       grep.exe (27308)         1.5 GB  session kestrel, by otter: the text"]);
    expect(reapLogLines([])).toEqual(["The reap log is empty."]);
    answer = [entry];
    expect(await reapCommand(["--log", "--json"], connection, KESTREL, io())).toBe(0);
    expect(calls).toEqual([{ path: ["resources", "reapLog"], input: {} }]);
    expect(JSON.parse(lines.join("\n"))).toEqual([entry]);
  });
});
