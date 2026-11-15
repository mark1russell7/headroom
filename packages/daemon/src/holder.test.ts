import { describe, expect, it } from "vitest";
import { sessionFromEnv, sessionRefFromEnv, sessionRefFromTree } from "./holder.ts";

const sessions = [
  { pid: 100, name: "client", sessionId: "aaa", status: "busy", cwd: null },
  { pid: 200, name: "shop", sessionId: "bbb", status: "idle", cwd: null },
];

describe("sessionFromEnv", () => {
  it("finds the session by CLAUDE_PID", () => expect(sessionFromEnv({ CLAUDE_PID: "200" }, sessions)).toBe("shop"));
  it("finds the session by CLAUDE_CODE_SESSION_ID when the process is not known", () =>
    expect(sessionFromEnv({ CLAUDE_PID: "999", CLAUDE_CODE_SESSION_ID: "aaa" }, sessions)).toBe("client"));
  it("gives undefined outside Claude Code", () => expect(sessionFromEnv({}, sessions)).toBeUndefined());
});

const named = [
  { pid: 300, name: "kestrel", sessionId: "6f1c-kestrel", status: "busy", cwd: null },
  { pid: 400, name: "otter", sessionId: "9a2d-otter", status: "idle", cwd: null },
];

describe("sessionRefFromEnv (H183)", () => {
  it("gives the name and the ID of the session file", () => expect(sessionRefFromEnv({ CLAUDE_PID: "300" }, named)).toEqual({ name: "kestrel", id: "6f1c-kestrel" }));
  it("finds the session by CLAUDE_CODE_SESSION_ID when the process is not known", () =>
    expect(sessionRefFromEnv({ CLAUDE_PID: "999", CLAUDE_CODE_SESSION_ID: "9a2d-otter" }, named)).toEqual({ name: "otter", id: "9a2d-otter" }));
  it("does not read HEADROOM_HOLDER, because it is a free label", () => expect(sessionRefFromEnv({ HEADROOM_HOLDER: "kestrel" }, named)).toBeUndefined());
});

describe("the proof of the caller of headroom reap (H183)", () => {
  const started = [
    { pid: 300, name: "kestrel", sessionId: "6f1c-kestrel", status: "busy", cwd: null, startedAt: 1_000 },
    { pid: 400, name: "otter", sessionId: "9a2d-otter", status: "idle", cwd: null, startedAt: 2_000 },
  ];
  const liveStarts = new Map([
    [300, 1_000],
    [400, 2_000],
  ]);
  const startOf = (pid: number): number | undefined => liveStarts.get(pid);

  it("prefers CLAUDE_CODE_SESSION_ID to CLAUDE_PID, because a process ID can be in use again", () =>
    expect(sessionRefFromEnv({ CLAUDE_PID: "300", CLAUDE_CODE_SESSION_ID: "9a2d-otter" }, named)).toEqual({ name: "otter", id: "9a2d-otter" }));

  it("refuses a session file whose process has another start or does not run", () => {
    expect(sessionRefFromEnv({ CLAUDE_CODE_SESSION_ID: "6f1c-kestrel" }, started, startOf)).toEqual({ name: "kestrel", id: "6f1c-kestrel" });
    // A new process has the ID of the session process.
    expect(sessionRefFromEnv({ CLAUDE_CODE_SESSION_ID: "6f1c-kestrel" }, started, () => 5_000)).toBeUndefined();
    expect(sessionRefFromEnv({ CLAUDE_PID: "300" }, started, () => 5_000)).toBeUndefined();
    // The session process ended.
    expect(sessionRefFromEnv({ CLAUDE_PID: "300" }, started, () => undefined)).toBeUndefined();
  });

  it("refuses a CLAUDE_PID whose session file names another session ID", () =>
    expect(sessionRefFromEnv({ CLAUDE_PID: "300", CLAUDE_CODE_SESSION_ID: "0000-ended" }, started, startOf)).toBeUndefined());

  it("walks up the process tree with the start of each parent", () => {
    const tree = [
      { pid: 300, ppid: 4, name: "claude.exe", startedAt: 1_000 },
      { pid: 800, ppid: 300, name: "bash.exe", startedAt: 3_000 },
      { pid: 900, ppid: 800, name: "node.exe", startedAt: 4_000 },
    ];
    expect(sessionRefFromTree(900, tree, started)).toEqual({ name: "kestrel", id: "6f1c-kestrel" });
    // The shell 800 ended, and a new process has its ID. It started after the caller, so it is not the parent.
    const reused = tree.map((each) => (each.pid === 800 ? { ...each, startedAt: 5_000 } : each));
    expect(sessionRefFromTree(900, reused, started)).toBeUndefined();
    // The session file names a process with another start.
    expect(sessionRefFromTree(900, tree, started.map((each) => ({ ...each, startedAt: 7 })))).toBeUndefined();
    // The caller is not in the read.
    expect(sessionRefFromTree(999, tree, started)).toBeUndefined();
  });
});
