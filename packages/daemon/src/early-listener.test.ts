import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { EARLY_NOTE, earlyAnswer, openEarlyListener, type EarlyListener } from "./early-listener.ts";
import { HOOK_CLIENT, HOOK_HEADER, HOOK_PATH } from "./hook-face.ts";

const NOTE = { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: EARLY_NOTE } };

async function open(port = 0): Promise<EarlyListener> {
  const early = await openEarlyListener({ port, host: "127.0.0.1" });
  if (early instanceof Error) throw early;
  return early;
}

function hook(port: number, body: unknown, headers: Record<string, string> = { [HOOK_HEADER]: HOOK_CLIENT }): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${HOOK_PATH}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

describe("earlyAnswer (H206)", () => {
  it("gives the note once to each session, and no decision after it or with no session", () => {
    const noted = new Set<string>();
    expect(JSON.parse(earlyAnswer(JSON.stringify({ session_id: "a" }), noted))).toEqual(NOTE);
    expect(earlyAnswer(JSON.stringify({ session_id: "a" }), noted)).toBe("{}");
    expect(JSON.parse(earlyAnswer(JSON.stringify({ session_id: "b" }), noted))).toEqual(NOTE);
    expect(earlyAnswer("{}", noted)).toBe("{}");
    expect(earlyAnswer("not json", noted)).toBe("{}");
    expect(earlyAnswer("", noted)).toBe("{}");
  });
});

describe("the early listener (H206)", () => {
  it("answers the hook with no decision, and each other request with 503", async () => {
    const early = await open();
    try {
      const first = await hook(early.port, { session_id: "s1", tool_input: { command: "pnpm test" } });
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual(NOTE);
      expect(await (await hook(early.port, { session_id: "s1" })).json()).toEqual({});
      // A request with no header of the hook, or to another path, gets 503: the client reads it as a restart.
      const other = await hook(early.port, { session_id: "s1" }, {});
      expect(other.status).toBe(503);
      expect(other.headers.get("retry-after")).toBe("2");
      const api = await fetch(`http://127.0.0.1:${early.port}/api/resources/status`, { method: "POST", body: "{}" });
      expect(api.status).toBe(503);
      expect(early.answered()).toBe(2);
    } finally {
      await early.close();
    }
  });

  it("frees the port at the close, with a connection open, so the procedure host can bind it", async () => {
    const early = await open();
    await hook(early.port, { session_id: "s2" }, { [HOOK_HEADER]: HOOK_CLIENT, connection: "keep-alive" });
    await early.close();
    const next = createServer();
    await new Promise<void>((resolve, reject) => {
      next.once("error", reject);
      next.listen(early.port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve) => next.close(() => resolve()));
  });

  it("gives the error of the bind when another process has the port", async () => {
    const early = await open();
    try {
      const second = await openEarlyListener({ port: early.port, host: "127.0.0.1" });
      expect(second).toBeInstanceOf(Error);
      expect((second as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
    } finally {
      await early.close();
    }
  });
});
