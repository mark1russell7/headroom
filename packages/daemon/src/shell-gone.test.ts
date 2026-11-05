import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commandFile, processExists, shellWatch, writeCommandFile } from "./shell-gone.ts";

const ENV = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));

describe("the watch of the shell of a waiting client (H64)", () => {
  it("does not watch with no shell, or with a value that is not a process", () => {
    const never = (): boolean => {
      throw new Error("no process to examine");
    };
    for (const value of [undefined, "", "0", "-3", "abc", "1.5"]) expect(shellWatch({ HEADROOM_SHELL: value }, never)()).toBe(false);
  });

  it("tells when the process of the shell does not exist", () => {
    let exists = true;
    const gone = shellWatch({ HEADROOM_SHELL: "4242" }, (pid) => pid === 4242 && exists);
    expect(gone()).toBe(false);
    exists = false;
    expect(gone()).toBe(true);
  });

  it("finds this process, and does not find a process that ended", () => {
    expect(processExists(process.pid)).toBe(true);
    const ended = spawnSync(process.execPath, ["-e", ""]).pid;
    expect(processExists(ended)).toBe(false);
  });

  it("writes a command file that gives the shell and starts the client", () => {
    expect(commandFile("C:\\repo\\cli.ts")).toContain('exec node --title=headroom-cli "C:/repo/cli.ts" "$@"');
    expect(commandFile("/repo/cli.ts")).toContain('read -r HEADROOM_SHELL 2>/dev/null < "/proc/$PPID/winpid"');
    const dir = mkdtempSync(join(tmpdir(), "headroom-command-"));
    try {
      const file = join(dir, "bin", "headroom");
      writeCommandFile(file, "/repo/cli.ts");
      expect(readFileSync(file, "utf8")).toBe(commandFile("/repo/cli.ts"));
      expect(readdirSync(join(dir, "bin"))).toEqual(["headroom"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds through the real commands: the place goes, and the job does not start, when the shell ends", async () => {
    const home = mkdtempSync(join(tmpdir(), "headroom-shell-"));
    const cli = join(import.meta.dirname, "cli.ts");
    const env = { ...ENV, HEADROOM_HOME: home, HEADROOM_SHELL: "" };
    const headroom = (...args: string[]): string => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", cwd: home, timeout: 30_000 }).stdout;
    const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const leases = (): { job: string; state: string }[] => (JSON.parse(headroom("status", "--json")) as { leases: { job: string; state: string }[] }).leases;
    const port = String(48_000 + (process.pid % 1000));
    const mark = join(home, "the-job-ran");
    const children: ChildProcess[] = [];
    const start = (args: string[], more: Record<string, string> = {}): ChildProcess => {
      const child = spawn(process.execPath, args, { env: { ...env, ...more }, stdio: "ignore", cwd: home });
      children.push(child);
      return child;
    };
    try {
      start([cli, "serve", "--port", port, "--reserve", "1"]);
      for (let tries = 0; tries < 60 && readdirSync(home).every((name) => name !== "daemon.json"); tries++) await pause(500);
      headroom("run", "--detach", "--job", "first", "--slot", "docker", "--holder", "t", "--", process.execPath, "-e", "setTimeout(()=>{},40000)");
      const shell = start(["-e", "setTimeout(()=>{},60000)"]);
      const write = `require("node:fs").writeFileSync(${JSON.stringify(mark)},"")`;
      const client = start([cli, "run", "--job", "second", "--slot", "docker", "--holder", "t", "--", process.execPath, "-e", write], { HEADROOM_SHELL: String(shell.pid) });
      const ended = new Promise<number | null>((resolve) => client.once("exit", resolve));
      for (let tries = 0; tries < 40 && !leases().some((each) => each.job === "second"); tries++) await pause(250);
      expect(leases().find((each) => each.job === "second")?.state).toBe("waiting");
      shell.kill();
      expect(await ended).not.toBe(0);
      expect(leases().some((each) => each.job === "second")).toBe(false);
      expect(readdirSync(home)).not.toContain("the-job-ran");
      expect(headroom("job", "second")).toMatch(/shell/);
    } finally {
      for (const child of children) child.kill();
      await pause(500);
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  }, 90_000);
});
