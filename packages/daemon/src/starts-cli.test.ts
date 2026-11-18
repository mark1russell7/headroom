import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { msFiletime, StartLogWriter, type StartRow } from "@headroom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keepStartsBeforeStop } from "./starts-before-stop.ts";
import { startsCommand, writeStartsBeforeStop, type StartsOutput } from "./starts-cli.ts";

const S = 1000;
const T0 = Date.UTC(2026, 10, 16, 7, 10, 16, 413);

function row(at: number, pid: number, ppid: number | null, image: string, command: string, extra: Partial<StartRow> = {}): StartRow {
  return { at, key: 1, pid, ppid, created: msFiletime(at - 30), image, command, parentCommand: null, reuseMs: null, ...extra };
}

function capture(): StartsOutput & { readonly lines: string[]; readonly errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (text) => lines.push(text), err: (text) => errors.push(text) };
}

let folder = "";
let path = "";
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "headroom-starts-cli-"));
  path = join(folder, "starts.db");
  const writer = new StartLogWriter(path, { now: () => T0 });
  writer.write([row(T0 - 60 * S, 15400, 1, "C:\\Program Files\\Git\\usr\\bin\\bash.exe", "bash -c 'node hook.mjs'")], []);
  // An adoption: explorer.exe ran for 3 hours before the trace put it in a job.
  writer.write([row(T0 - 59 * S, 4100, 1, "C:\\Windows\\explorer.exe", "explorer", { created: msFiletime(T0 - 3 * 3600 * S) })], []);
  writer.write(
    [row(T0 - 2 * S, 31368, 15400, "C:\\nodejs\\node.exe", "node old.mjs")],
    [{ at: T0 - S, key: 1, pid: 31368, exitCode: 0, created: msFiletime(T0 - 2 * S - 30) }],
  );
  writer.write([row(T0, 31368, 15400, "C:\\nodejs\\node.exe", "node hook.mjs", { parentCommand: "bash -c 'node hook.mjs'", reuseMs: 970 })], []);
  writer.close();
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

describe("headroom starts (H193)", () => {
  it("names the program, the parents and the pid reuse of the pid of a crash dump", () => {
    const output = capture();
    expect(startsCommand(["31368", "--at", new Date(T0 - 30).toISOString()], path, output)).toBe(0);
    const text = output.lines.join("\n");
    expect(text).toContain("Process 31368: in the log at 2026-11-16 07:10:16.413 UTC (created 2026-11-16 07:10:16.383 UTC). No exit is in the log.");
    expect(text).toContain("Command: node hook.mjs");
    expect(text).toContain("The pid was free for 970 ms");
    expect(text).toContain("Parent 15400: C:\\Program Files\\Git\\usr\\bin\\bash.exe");
    // The older start of the pid is 2 s before, inside the 10 minutes of --at, so it comes second.
    expect(text.indexOf("node hook.mjs")).toBeLessThan(text.indexOf("node old.mjs"));
    expect(text).toContain("It ended 2026-11-16 07:10:15.413 UTC with exit code 0.");
  });

  it("gives the starts as JSON, with the parents", () => {
    const output = capture();
    expect(startsCommand(["31368", "--json"], path, output)).toBe(0);
    const found = JSON.parse(output.lines.join("\n")) as { command: string; parents: { pid: number }[] }[];
    expect(found.map((start) => start.command)).toEqual(["node hook.mjs", "node old.mjs"]);
    expect(found[0]?.parents.map((parent) => parent.pid)).toEqual([15400]);
  });

  it("ranks the starters of the last hour", () => {
    const output = capture();
    expect(startsCommand(["--top"], path, output)).toBe(0);
    const text = output.lines.join("\n");
    expect(text).toContain("3 starts in the log");
    expect(text).toMatch(/By program:\n\s+1\.\s+2\.0 a minute {2}C:\\nodejs\\node\.exe/);
    expect(text).toContain("Pid reuse: 33.3 % of the starts got a pid that a traced process left less than 60 s before, 33.3 % less than 1 s before.");
    expect(text).toContain("The ranking does not count 1 process that ran before the trace put it in a job.");
    expect(text).not.toContain("explorer.exe");
  });

  it("names an adoption as no start", () => {
    const output = capture();
    expect(startsCommand(["4100"], path, output)).toBe(0);
    expect(output.lines.join("\n")).toContain("It ran before the trace put it in a job: it is an adoption, not a start.");
  });

  it("says when no start of the pid is in the log, and when the file is not there", () => {
    const output = capture();
    expect(startsCommand(["4784"], path, output)).toBe(0);
    expect(output.lines.join("\n")).toContain("No start of process 4784 is in the start log");
    expect(startsCommand(["--top"], join(folder, "none.db"), output)).toBe(1);
    expect(output.errors.join("\n")).toContain("The start log is not there");
  });

  it("refuses wrong arguments", () => {
    for (const args of [[], ["abc"], ["--top", "--hours", "25"], ["--top", "12"], ["12", "--at", "never"], ["--nope"]]) {
      const output = capture();
      expect(startsCommand(args, path, output)).toBe(2);
      expect(output.errors.join("\n")).toContain("Usage: headroom starts");
    }
  });
});

describe("the starts before an unclean stop (H193)", () => {
  it("keeps the starts of the 2 minutes before the last row of the daemon that stopped", () => {
    const kept = writeStartsBeforeStop(path, folder, T0 + 30 * S);
    expect(kept?.starts).toBe(4);
    const saved = JSON.parse(readFileSync(kept!.file, "utf8")) as { from: number; to: number; starts: { pid: number }[] };
    expect(saved.to).toBe(T0);
    expect(saved.starts.map((start) => start.pid)).toEqual([15400, 4100, 31368, 31368]);
    expect(writeStartsBeforeStop(path, folder, T0 - 120 * S)).toBeNull();
    expect(writeStartsBeforeStop(join(folder, "none.db"), folder, T0)).toBeNull();
  });

  it("writes the same file in a worker thread, after the bind of the daemon (H206)", async () => {
    const kept = await keepStartsBeforeStop({ path, folder, before: T0 + 30 * S });
    expect(kept?.starts).toBe(4);
    const saved = JSON.parse(readFileSync(kept!.file, "utf8")) as { to: number; starts: { pid: number }[] };
    expect(saved.to).toBe(T0);
    expect(saved.starts.map((start) => start.pid)).toEqual([15400, 4100, 31368, 31368]);
    await expect(keepStartsBeforeStop({ path: join(folder, "none.db"), folder, before: T0 })).resolves.toBeNull();
  });
});
