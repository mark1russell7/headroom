import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The hook of the plugin, started as Claude Code starts it: a process with the event as JSON on stdin.
const hook = join(import.meta.dirname, "..", "..", "..", "plugins", "headroom", "hooks", "route.ts");

describe("the hook of the plugin", () => {
  let server: Server;
  let home = "";
  let status = { free: { memory: 8000 }, leases: [] as { state: string; reason?: string }[] };

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(req.headers.authorization === "Bearer t" ? JSON.stringify(status) : "{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    home = mkdtempSync(join(tmpdir(), "headroom-hook-"));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    writeFileSync(join(home, "daemon.json"), JSON.stringify({ pid: 1, endpoint, token: "t", startedAt: "" }));
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  // An asynchronous start: the fake daemon in this process must answer while the hook runs.
  const run = (command: string, headroomHome = home): Promise<string> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [hook], { env: { ...process.env, HEADROOM_HOME: headroomHome } });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
      child.on("close", () => resolve(out.trim()));
      child.stdin.end(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
    });

  it("lets a light command go on", async () => {
    status = { free: { memory: 100 }, leases: [{ state: "waiting" }] };
    expect(await run("git status")).toBe("");
  });

  it("lets a heavy command go on when the memory has room", async () => {
    status = { free: { memory: 8000 }, leases: [] };
    expect(await run("pnpm test")).toBe("");
  });

  it("refuses a heavy command when the memory is tight, with the form under a lease", async () => {
    status = { free: { memory: 1200 }, leases: [] };
    const output = JSON.parse(await run("cd packages/core && pnpm exec vitest run")) as { hookSpecificOutput: Record<string, string> };
    expect(output.hookSpecificOutput["permissionDecision"]).toBe("deny");
    expect(output.hookSpecificOutput["permissionDecisionReason"]).toContain("only 1200 MB is free for a lease");
    expect(output.hookSpecificOutput["permissionDecisionReason"]).toContain("Send it again as: cd packages/core && headroom run --mem auto -- pnpm exec vitest run");
  });

  it("refuses a heavy command when other jobs wait for memory", async () => {
    status = { free: { memory: 9000 }, leases: [{ state: "granted" }, { state: "waiting", reason: "waits for memory: needs 2048, 900 free" }] };
    expect(await run("npx playwright test e2e")).toContain("1 job already wait");
  });

  it("lets a heavy command go on when the other jobs wait only for a slot", async () => {
    status = { free: { memory: 9000 }, leases: [{ state: "waiting", reason: "waits for browser: needs 1, 0 free" }] };
    expect(await run("pnpm test")).toBe("");
  });

  it("lets a command under headroom run go on, and lets each command go on without a daemon", async () => {
    status = { free: { memory: 100 }, leases: [] };
    expect(await run("headroom run --mem 2g -- pnpm test")).toBe("");
    expect(await run("pnpm test", mkdtempSync(join(tmpdir(), "headroom-none-")))).toBe("");
  });

  it("lets the false cases of H55 go on when the memory is tight", async () => {
    status = { free: { memory: 100 }, leases: [] };
    expect(await run('git grep -E "vitest|jest" origin/main')).toBe("");
    expect(await run('git commit -m "fix the vitest config"')).toBe("");
    expect(await run("echo vitest")).toBe("");
  });

  it("refuses the heavy part beside a text reader, with the prefix on that part", async () => {
    status = { free: { memory: 100 }, leases: [] };
    const output = JSON.parse(await run('git grep -E "vitest|jest" origin/main && pnpm test')) as { hookSpecificOutput: Record<string, string> };
    expect(output.hookSpecificOutput["permissionDecisionReason"]).toContain('Send it again as: git grep -E "vitest|jest" origin/main && headroom run --mem auto -- pnpm test');
  });
});

/** The commands that a word in their text rated as heavy (H55). */
const FALSE_CASES = [
  // The false case of 2026-11-04: the refusal also told the session to put headroom run in front of a grep.
  'git grep -E "vitest|jest" origin/main',
  "git grep -E 'vitest|jest' origin/main",
  "git -C packages/core grep vitest",
  // A word in a quoted string.
  'git commit -m "fix the vitest config"',
  "git commit -m 'pnpm test passes now'",
  'gh pr create --title "docker build fix" --body "pnpm test passes"',
  // A word in a comment.
  "git status # do not start vitest here",
  // A text reader, whatever its arguments say.
  "grep -rn vitest packages",
  "rg vitest packages",
  "sed -n 1,5p vitest.config.ts",
  "cat vitest.config.ts",
  "echo vitest",
  "echo pnpm test",
  "head -5 jest.config.js",
  "tail -5 pytest.log",
  "ls vitest.config.ts",
  "Select-String -Path a.txt -Pattern vitest",
  "Get-Content vitest.config.ts",
  "get-content vitest.config.ts",
  "cd app && git grep vitest | head -5",
  "grep.exe vitest a.txt",
  'FOO=1 grep "pnpm test" a.txt',
  "if grep -q vitest a.txt; then echo vitest; fi",
  // A line that continues on the next line stays one part.
  "echo a \\\n  vitest",
];

/** The commands that stay heavy. */
const HEAVY_CASES = [
  "pnpm test",
  "npx playwright test e2e/x.spec.ts",
  // A shell runs its argument, so the quoted text counts.
  'bash -c "pnpm test"',
  "sh -c 'vitest run'",
  'bash -lc "cd app && pnpm test"',
  'powershell -Command "pnpm test"',
  'powershell.exe -NoProfile -Command "pnpm test"',
  "pwsh -Command 'vitest run'",
  'cmd /c "pnpm test"',
  'cmd.exe /s /c "pnpm test"',
  '"C:/Program Files/Git/bin/bash.exe" -c "pnpm test"',
  // Each part has its own rating.
  "grep vitest a.txt && pnpm test",
  "echo vitest; pnpm test",
  "cat a.txt | xargs vitest run",
  "echo start\npnpm test",
  "echo start & pnpm test",
  "(cd app && pnpm test)",
  "if pnpm test; then echo ok; fi",
  // A quote with no closing quote does not hide a command.
  "git status it's && pnpm test",
  // A comment with an apostrophe does not hide the next line.
  "# do not stop, it's a gate\npnpm test\n# it's the end",
  // A program that is not a text reader keeps its unquoted words.
  "git log --grep vitest",
];

describe("the rating of a command line (H55)", () => {
  const isHeavy = async (command: string): Promise<boolean> =>
    ((await import(pathToFileURL(hook).href)) as { isHeavy: (command: string) => boolean }).isHeavy(command);

  it.each(FALSE_CASES)("does not rate %j as heavy", async (command) => {
    expect(await isHeavy(command)).toBe(false);
  });

  it.each(HEAVY_CASES)("rates %j as heavy", async (command) => {
    expect(await isHeavy(command)).toBe(true);
  });
});

describe("the lease form of a command line", () => {
  it("puts headroom run in front of the heavy part, after its variables", async () => {
    const { leased } = (await import(pathToFileURL(hook).href)) as { leased: (command: string) => string };
    expect(leased("pnpm test")).toBe("headroom run --mem auto -- pnpm test");
    expect(leased("cd app && CI=1 pnpm exec vitest run | tail -5")).toBe("cd app && CI=1 headroom run --mem auto -- pnpm exec vitest run | tail -5");
    expect(leased("git pull; npx playwright test e2e/x.spec.ts")).toBe("git pull; headroom run --mem auto -- npx playwright test e2e/x.spec.ts");
  });

  it("uses the rating of isHeavy, so a text reader or a quoted word gets no prefix", async () => {
    const { leased } = (await import(pathToFileURL(hook).href)) as { leased: (command: string) => string };
    expect(leased('git grep -E "vitest|jest" origin/main && pnpm test')).toBe('git grep -E "vitest|jest" origin/main && headroom run --mem auto -- pnpm test');
    expect(leased('git commit -m "pnpm test; vitest" && CI=1 pnpm build')).toBe('git commit -m "pnpm test; vitest" && CI=1 headroom run --mem auto -- pnpm build');
    expect(leased('grep vitest a.txt | bash -c "pnpm test"')).toBe('grep vitest a.txt | headroom run --mem auto -- bash -c "pnpm test"');
    expect(leased('NAME="a b" pnpm test 2>&1 | tail -5')).toBe('NAME="a b" headroom run --mem auto -- pnpm test 2>&1 | tail -5');
    expect(leased("(cd app && pnpm test)")).toBe("(cd app && headroom run --mem auto -- pnpm test)");
  });
});
