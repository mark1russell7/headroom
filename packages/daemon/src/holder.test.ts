import { describe, expect, it } from "vitest";
import { sessionFromEnv, sessionRefFromEnv } from "./holder.ts";

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
