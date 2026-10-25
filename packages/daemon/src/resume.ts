/**
 * The resume plan (H13): one command for each live Claude Code session, to start it again after a reboot. The organizer
 * comes first, because it tells the other sessions to continue.
 *
 * `headroom resume-plan` prints the plan and writes it to a file. The daemon writes the file again when a planned drain
 * starts (H34), and `headroom reboot-plan` tells where the file is and its age.
 */

import { mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readSessions, type ResumePlanFile, type SessionInfo } from "@headroom/core";
import { resumePlanPath } from "./paths.ts";

/** This function gives the sessions in the order of the plan: the organizer first, then by name. */
export function planOrder(sessions: readonly SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => (a.name === "organizer" ? -1 : b.name === "organizer" ? 1 : a.name.localeCompare(b.name)));
}

/** This function gives the PowerShell command that starts one session again. */
export function resumeCommand(session: SessionInfo): string {
  return `Set-Location "${session.cwd ?? "."}"; claude --resume ${session.sessionId}`;
}

/** This function gives the lines that `headroom resume-plan` prints: a comment with the name of each session, then its command. */
export function resumePlanLines(sessions: readonly SessionInfo[]): string[] {
  const lines = ["# The resume plan: one line for each live Claude Code session, the organizer first", ""];
  for (const session of planOrder(sessions)) lines.push(`# ${session.name}`, resumeCommand(session), "");
  return lines;
}

/** This function writes a time as the local date and clock: "2026-10-25 01:40". */
function localTime(at: number): string {
  const date = new Date(at);
  const two = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** This function gives the text of the file of the resume plan, in Markdown. */
export function resumePlanMarkdown(sessions: readonly SessionInfo[], at: number): string {
  const ordered = planOrder(sessions);
  const cell = (text: string): string => text.replaceAll("|", "\\|");
  const rows = ordered.map((session, index) => `| ${index + 1} | ${cell(session.name)} | \`${cell(resumeCommand(session))}\` |`);
  return [
    `# The resume plan (${localTime(at)}, ${ordered.length} ${ordered.length === 1 ? "session" : "sessions"})`,
    "",
    "headroom wrote this plan from the session files of Claude Code. After the reboot, open one terminal for each session and paste its line.",
    "Start the organizer first: it tells the other sessions to continue. The scheduled task `headroom` starts the daemon at login.",
    "",
    "| # | Session | PowerShell command |",
    "|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

/** This function gives the file of the resume plan and the time of its last write, or `null` when the file does not exist. */
export function resumePlanFile(path: string = resumePlanPath()): ResumePlanFile | null {
  try {
    return { path, at: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * This function writes the resume plan of the live sessions to its file, and gives the file. It writes a temporary file
 * first and then moves it, so a reader does not see half a plan.
 */
export function writeResumePlan(path: string = resumePlanPath(), sessions: readonly SessionInfo[] = readSessions(), at: number = Date.now()): ResumePlanFile {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, resumePlanMarkdown(sessions, at));
  renameSync(temporary, path);
  return resumePlanFile(path) ?? { path, at };
}
