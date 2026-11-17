import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { filetimeMs } from "./start-log.ts";

// The reads use kernel32 and ntdll, so this test runs only on Windows. The CI runners are Linux: it runs on the PC.
const windows = process.platform === "win32";

describe.runIf(windows)("the facts of a Windows process (H193)", () => {
  it("reads the program, the parent, the command line and the create time of a child", async () => {
    const facts = await import("./windows-process-facts.ts");
    const marker = `headroom-marker-${process.pid}-ünï`;
    const before = Date.now();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)", marker], { stdio: "ignore" });
    try {
      const pid = child.pid;
      if (pid === undefined) throw new Error("the child did not start");
      const handle = facts.openQuery(pid);
      expect(handle).not.toBe(0);
      try {
        // Windows gives the path of the program after the links, for example of nvm.
        expect(facts.imagePath(handle)?.toLowerCase()).toBe(realpathSync.native(process.execPath).toLowerCase());
        expect(facts.parentPid(handle)).toBe(process.pid);
        const command = facts.commandLine(handle);
        expect(command).toContain(marker);
        expect(command).toContain("setTimeout");
        const created = facts.createTime(handle);
        expect(created).not.toBeNull();
        const createdAt = filetimeMs(created!);
        expect(createdAt).toBeGreaterThanOrEqual(before - 20);
        expect(createdAt).toBeLessThanOrEqual(Date.now());
        expect(facts.exitCode(handle)).toBe(259);
      } finally {
        facts.closeProcess(handle);
      }
    } finally {
      child.kill();
    }
  });

  it("gives 0 for a pid with no process", async () => {
    const facts = await import("./windows-process-facts.ts");
    // A pid of Windows is a multiple of 4, so 3 is never a process.
    expect(facts.openQuery(3)).toBe(0);
  });
});
