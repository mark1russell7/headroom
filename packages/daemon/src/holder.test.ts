import { describe, expect, it } from "vitest";
import { sessionFromEnv } from "./holder.ts";

const sessions = [
  { pid: 100, name: "client", sessionId: "aaa", status: "busy", cwd: null },
  { pid: 200, name: "graph", sessionId: "bbb", status: "idle", cwd: null },
];

describe("sessionFromEnv", () => {
  it("finds the session by CLAUDE_PID", () => expect(sessionFromEnv({ CLAUDE_PID: "200" }, sessions)).toBe("graph"));
  it("finds the session by CLAUDE_CODE_SESSION_ID when the process is not known", () =>
    expect(sessionFromEnv({ CLAUDE_PID: "999", CLAUDE_CODE_SESSION_ID: "aaa" }, sessions)).toBe("client"));
  it("gives undefined outside Claude Code", () => expect(sessionFromEnv({}, sessions)).toBeUndefined());
});
