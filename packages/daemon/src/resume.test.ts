import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "@headroom/core";
import { describe, expect, it } from "vitest";
import { resumePlanFile, resumePlanLines, resumePlanMarkdown, writeResumePlan } from "./resume.ts";

const sessions: SessionInfo[] = [
  { pid: 11, name: "vex", sessionId: "e189", status: null, cwd: "C:\\Users\\<you>\\git\\Vex" },
  { pid: 12, name: "organizer", sessionId: "e283", status: null, cwd: "C:\\Users\\<you>" },
  { pid: 13, name: "graph", sessionId: "79a9", status: null, cwd: null },
];

describe("the resume plan (H13, H34)", () => {
  it("prints the organizer first, then the sessions by name", () => {
    expect(resumePlanLines(sessions)).toEqual([
      "# The resume plan: one line for each live Claude Code session, the organizer first",
      "",
      "# organizer",
      'Set-Location "C:\\Users\\<you>"; claude --resume e283',
      "",
      "# graph",
      'Set-Location "."; claude --resume 79a9',
      "",
      "# vex",
      'Set-Location "C:\\Users\\<you>\\git\\Vex"; claude --resume e189',
      "",
    ]);
  });

  it("writes the plan as a Markdown table, and gives the file with the time of its write", () => {
    const dir = mkdtempSync(join(tmpdir(), "headroom-resume-"));
    try {
      const path = join(dir, "plans", "resume-plan.md");
      expect(resumePlanFile(path)).toBeNull();
      const at = new Date(2026, 9, 25, 1, 40).getTime();
      const file = writeResumePlan(path, sessions, at);
      expect(file.path).toBe(path);
      expect(resumePlanFile(path)?.at).toBe(file.at);
      const text = readFileSync(path, "utf8");
      expect(text).toBe(resumePlanMarkdown(sessions, at));
      expect(text.split("\n")[0]).toBe("# The resume plan (2026-10-25 01:40, 3 sessions)");
      expect(text).toContain('| 1 | organizer | `Set-Location "C:\\Users\\<you>"; claude --resume e283` |');
      expect(text).toContain('| 3 | vex | `Set-Location "C:\\Users\\<you>\\git\\Vex"; claude --resume e189` |');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
