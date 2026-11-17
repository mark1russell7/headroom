import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { environmentBlock, startUnderShell } from "./enforce.ts";

/** This function gives the text of an environment block, with each NUL as "|". */
function blockText(env: Readonly<Record<string, string | undefined>>): string {
  return environmentBlock(env).toString("utf16le").replaceAll("\0", "|");
}

describe("the environment block of a Windows start (H190)", () => {
  it("sorts the names with no regard to case, and ends with an extra NUL", () => {
    expect(blockText({ b: "2", A: "1", c: "3" })).toBe("A=1|b=2|c=3||");
  });

  it("keeps the first of two names that differ only in case", () => {
    expect(blockText({ Path: "first", PATH: "second" })).toBe("Path=first||");
  });

  it("skips a value that is not set, an empty name, a name with = after its first character, and each NUL", () => {
    expect(blockText({ unset: undefined, "": "x", "A=B": "x", "=C:": "C:\\work", nul: "a\0b", ok: "yes" })).toBe("=C:=C:\\work|ok=yes||");
  });

  it("gives two NULs for an empty environment", () => {
    expect(environmentBlock({}).toString("hex")).toBe("00000000");
  });

  it("keeps the characters of a value outside ASCII", () => {
    expect(blockText({ NAME: "Größe ✓" })).toBe("NAME=Größe ✓||");
  });
});

describe("the start under the shell on another platform", () => {
  it("tells why it does not start, and starts nothing", async () => {
    const start = await startUnderShell("node -e 0", tmpdir(), {}, "linux");
    expect(start).toEqual({ kind: "unavailable", reason: "the start under the shell is for Windows, not linux" });
  });
});

describe.skipIf(process.platform !== "win32")("the start under the shell of Windows (H190)", () => {
  const dir = mkdtempSync(join(tmpdir(), "headroom-shell-start-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("gives the process the shell as its parent, with the folder and the environment of the call", { timeout: 30000 }, async (context) => {
    const out = join(dir, "seen.json");
    const script = join(dir, "seen.mjs");
    writeFileSync(
      script,
      // The file comes whole, with a rename, so the test never reads half of it.
      `import { renameSync, writeFileSync } from "node:fs";
writeFileSync(process.argv[2] + ".part", JSON.stringify({ ppid: process.ppid, cwd: process.cwd(), marker: process.env.HEADROOM_SHELL_MARKER ?? null }));
renameSync(process.argv[2] + ".part", process.argv[2]);
`,
    );
    const start = await startUnderShell(`"${process.execPath}" "${script}" "${out}"`, dir, { ...process.env, HEADROOM_SHELL_MARKER: "seen ✓" });
    // A computer with no desktop shell, or a test that runs elevated, cannot read this case. It shows as skipped, not as a pass.
    if (start.kind === "unavailable") {
      context.skip(`no start under the shell: ${start.reason}`);
      return;
    }
    const deadline = Date.now() + 20000;
    while (!existsSync(out) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const seen = JSON.parse(readFileSync(out, "utf8")) as { ppid: number; cwd: string; marker: string | null };
    expect(seen.ppid).toBe(start.shellPid);
    expect(realpathSync(seen.cwd).toLowerCase()).toBe(realpathSync(dir).toLowerCase());
    expect(seen.marker).toBe("seen ✓");
    expect(start.pid).toBeGreaterThan(0);
  });
});
