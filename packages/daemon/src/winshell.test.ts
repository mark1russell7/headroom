import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cmdArgument, findCommand, quoteArgument, windowsCommand } from "./winshell.mjs";

/** The arguments that cmd changed before: a split at `&` and `|`, a redirect, a variable, a caret, a quote and an empty argument. */
const TRICKY = ["a&b", "x|y", "out>file", "%PATH%", "c^d", 'q"uote', "", "sp ace", "back\\", "http://host/?a=1&b=2", "!bang!", "(paren)"];

describe("quoteArgument", () => {
  it("quotes with the rules of the C runtime", () => {
    expect(quoteArgument("plain")).toBe('"plain"');
    expect(quoteArgument("")).toBe('""');
    expect(quoteArgument('a"b')).toBe('"a\\"b"');
    expect(quoteArgument('a\\"b')).toBe('"a\\\\\\"b"');
    expect(quoteArgument("dir\\")).toBe('"dir\\\\"');
    expect(quoteArgument("a\\b")).toBe('"a\\b"');
  });
});

describe("cmdArgument", () => {
  it("escapes each special character of cmd once, and two times for a batch file", () => {
    expect(cmdArgument("a&b", false)).toBe('^"a^&b^"');
    expect(cmdArgument("a&b", true)).toBe('^^^"a^^^&b^^^"');
    expect(cmdArgument("%PATH%", false)).toBe('^"^%PATH^%^"');
  });
});

describe("windowsCommand", () => {
  const files = new Set(["C:\\tools\\pnpm.cmd", "C:\\tools\\node.exe", "C:\\work\\local.bat"]);
  const options = { env: { Path: "C:\\nothing;\"C:\\tools\"", PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\cmd.exe" }, cwd: "C:\\work", isFile: (path: string) => files.has(path) };

  it("finds a command in the current folder first, then in PATH, with each extension", () => {
    expect(findCommand("pnpm", options)).toBe("C:\\tools\\pnpm.cmd");
    expect(findCommand("node", options)).toBe("C:\\tools\\node.exe");
    expect(findCommand("local", options)).toBe("C:\\work\\local.bat");
    expect(findCommand("C:\\tools\\node.exe", options)).toBe("C:\\tools\\node.exe");
    expect(findCommand("echo", options)).toBeUndefined();
  });

  it("starts a program directly, with no shell", () => {
    expect(windowsCommand(["node", "-e", "a&b"], options)).toEqual({ file: "C:\\tools\\node.exe", args: ["-e", "a&b"], verbatim: false });
  });

  it("starts a batch file in cmd, with two carets before each special character", () => {
    expect(windowsCommand(["pnpm", "test", "a&b"], options)).toEqual({
      file: "C:\\Windows\\cmd.exe",
      args: ["/d", "/s", "/c", '"pnpm ^^^"test^^^" ^^^"a^^^&b^^^""'],
      verbatim: true,
    });
  });

  it("starts a command that is not found in cmd, with one caret before each special character", () => {
    expect(windowsCommand(["echo", "a|b"], options).args).toEqual(["/d", "/s", "/c", '"echo ^"a^|b^""']);
  });

  // The real cmd of Windows: each argument comes to the program with no change.
  it.runIf(process.platform === "win32")("gives each argument with no change to a program and to a batch file", () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom winshell "));
    try {
      const script = join(dir, "args.mjs");
      writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)));\n");
      const batch = join(dir, "echo args.cmd");
      writeFileSync(batch, `@"${process.execPath}" "%~dp0args.mjs" %*\r\n`);
      for (const command of [[process.execPath, script, ...TRICKY], [batch, ...TRICKY]]) {
        const win = windowsCommand(command);
        const run = spawnSync(win.file, win.args, { encoding: "utf8", windowsVerbatimArguments: win.verbatim, windowsHide: true });
        expect(run.stderr).toBe("");
        expect(JSON.parse(run.stdout) as unknown).toEqual(TRICKY);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
