/**
 * The hook of headroom (H8): a PreToolUse hook for the Bash and PowerShell tools of Claude Code.
 *
 * - A heavy command (tests, builds, Playwright, Docker builds, recursive pnpm) that does not run under
 *   `headroom run` goes on only when the memory has room for it.
 * - When the memory is tight, the hook refuses the command and tells the session the form under a
 *   lease: `headroom run --mem auto -- <command>`. The session sends that form, and the permission
 *   rules of the user apply to it as to each command. The hook does not approve a command itself.
 * - When the daemon does not answer, or the command is light, the hook writes nothing: the command goes on.
 * - The rating reads the command words of each part of the line, not the text (H55). The text of a quoted string or of
 *   a comment does not count, unless the part is a shell that runs its argument (`bash -c`). A text reader (`grep`,
 *   `cat`, `echo`) is not heavy, whatever its arguments say.
 *
 * It uses no package, and it gives up after 1 second, so a session does not wait for it. Node starts this file
 * directly, so it uses only the types that Node can remove.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The status of the daemon that the hook reads: the free memory and the leases. */
export interface Status {
  free?: { memory?: number };
  leases?: { state: string; reason?: string | null }[];
}

/** The commands that need a lease: the test runners, the builds, the browsers and the container builds. */
export const HEAVY: RegExp[] = [
  /\b(?:pnpm|npm|yarn|bun)\s+(?:-[\w-]+\s+)*(?:run\s+)?(?:test|tests|build|e2e|typecheck|check|coverage)\b/,
  /\b(?:pnpm|npm|yarn)\s+(?:-r|--recursive|-ws|--workspaces)\b/,
  /\bvitest\b(?!\s+--version)/,
  /\bjest\b/,
  /\bplaywright\s+test\b/,
  /\btsc\s+(?:-b|--build)\b/,
  /\bturbo\s+run\b/,
  /\bnx\s+(?:run-many|affected)\b/,
  /\bdocker\s+(?:build|buildx\s+build|compose\s+(?:up|build))\b/,
  /\bcargo\s+(?:build|test)\b/,
  /\bgo\s+test\b/,
  /\bpytest\b/,
];

/** Below this amount free for a lease, in MB, the hook asks for a lease. */
export const TIGHT_MB = 4096;

/** The programs that only read or write text. A part with such a program is not heavy, whatever its arguments say. */
const READERS: ReadonlySet<string> = new Set(["grep", "rg", "sed", "cat", "echo", "head", "tail", "ls", "select-string", "get-content"]);

/** The shells that run their argument as a command, with the option that tells them to do this. */
const SHELLS: ReadonlyMap<string, RegExp> = new Map([
  ["bash", /^-[A-Za-z]*c$/],
  ["sh", /^-[A-Za-z]*c$/],
  ["powershell", /^-c(?:ommand)?$/i],
  ["pwsh", /^-c(?:ommand)?$/i],
  ["cmd", /^\/c$/i],
]);

/** The shell divides a line at these separators. The `&` of a redirection, as in `2>&1`, is not one. */
const SEPARATOR = /&&|\|\||;|\||\r?\n|(?<!>)&(?!>)/g;

/** The start of a part before its program: brackets, the words of a shell loop or test, and variables (`CI=1`). */
const LEAD = /^\s*(?:[({!]\s*|(?:if|then|elif|else|while|until|do)\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/;

/** One part of a command line. `text` has the same length as `raw`, without the text of quoted strings and comments. */
interface Part {
  readonly start: number;
  readonly raw: string;
  readonly text: string;
}

/** This function finds the closing quote of the string at `open`, or gives -1. A double quoted string can hold an escaped quote. */
function closingQuote(command: string, open: number): number {
  const quote = command[open];
  for (let at = open + 1; at < command.length; at++) {
    if (command[at] === quote) return at;
    if (quote === '"' && command[at] === "\\") at++;
  }
  return -1;
}

/**
 * This function gives a command line of the same length, without the text of quoted strings and comments. Thus each
 * position stays the same. A quote with no closing quote stays as text, so a heavy command cannot hide behind it.
 * A comment goes too, because an apostrophe in a comment does not start a string.
 */
function withoutText(command: string): string {
  let out = "";
  let at = 0;
  while (at < command.length) {
    const char = command[at] ?? "";
    const next = command[at + 1] ?? "";
    const closing = char === '"' || char === "'" ? closingQuote(command, at) : -1;
    let end = at + 1;
    if (char === "#" && /^\s?$/.test(command[at - 1] ?? "")) {
      const newline = command.indexOf("\n", at);
      end = newline < 0 ? command.length : newline;
      out += " ".repeat(end - at);
    } else if (char === "\\" && (next === "\n" || next === "\r")) {
      // A line that continues on the next line stays one part.
      end = at + (next === "\r" ? 3 : 2);
      out += " ".repeat(end - at);
    } else if (char === "\\" && (next === '"' || next === "'")) {
      end = at + 2;
      out += "__";
    } else if (closing > at) {
      end = closing + 1;
      out += `${char}${"_".repeat(end - at - 2)}${char}`;
    } else {
      out += char;
    }
    at = end;
  }
  return out;
}

/** This function divides a command line into its parts. A separator in a quoted string does not divide the line. */
function partsOf(command: string): Part[] {
  const text = withoutText(command);
  const parts: Part[] = [];
  let start = 0;
  for (const match of [...text.matchAll(SEPARATOR), null]) {
    const end = match ? (match.index ?? 0) : command.length;
    parts.push({ start, raw: command.slice(start, end), text: text.slice(start, end) });
    if (match) start = end + match[0].length;
  }
  return parts;
}

/** This function gives the length of the start of a part before its program. */
function leadOf(part: Part): number {
  return LEAD.exec(part.text)?.[0].length ?? 0;
}

/** This function gives the words of a part after its start. A quoted word is one word, without its quotes. */
function wordsOf(part: Part): string[] {
  return [...part.raw.slice(leadOf(part)).matchAll(/"[^"]*"|'[^']*'|\S+/g)].map((match) => match[0].replace(/^["']|["']$/g, ""));
}

/** This function gives the name of a program from its path, in lower case, without the folder and the extension. */
function programName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? "").replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
}

/** This function tells if the words start a text reader: a program of `READERS`, or `git grep`, also with options of git before `grep`. */
function readsText(words: readonly string[]): boolean {
  const program = programName(words[0] ?? "");
  if (READERS.has(program)) return true;
  if (program !== "git") return false;
  for (let at = 1; at < words.length; at++) {
    const word = words[at] ?? "";
    if (word === "-C" || word === "-c") at++;
    else if (!word.startsWith("-")) return word === "grep";
  }
  return false;
}

/** This function tells if the words start a shell that runs its argument as a command. */
function runsArgument(words: readonly string[]): boolean {
  const option = SHELLS.get(programName(words[0] ?? ""));
  return option !== undefined && words.slice(1).some((word) => option.test(word));
}

/** This function rates one part of a line. */
function isHeavyPart(part: Part): boolean {
  const words = wordsOf(part);
  if (readsText(words)) return false;
  const text = runsArgument(words) ? part.raw : part.text;
  return HEAVY.some((pattern) => pattern.test(text));
}

/** This function tells if a command line has a heavy part. */
export function isHeavy(command: string): boolean {
  return partsOf(command).some(isHeavyPart);
}

/**
 * This function puts `headroom run --mem auto --` in front of the heavy part of a command line. It uses the rating of
 * `isHeavy`, so the prefix does not go in front of a `grep`. The prefix goes at the start of the heavy part, after its
 * variables (`CI=1 pnpm test`). Thus `cd app && pnpm test` gives `cd app && headroom run --mem auto -- pnpm test`.
 */
export function leased(command: string): string {
  const heavy = partsOf(command).find(isHeavyPart);
  if (heavy === undefined) return `headroom run --mem auto -- ${command}`;
  const at = heavy.start + leadOf(heavy);
  return `${command.slice(0, at)}headroom run --mem auto -- ${command.slice(at)}`;
}

/** This function makes the decision for one command. It gives the reason to refuse the command, or `null` to let it go on. */
export function decide(command: string, status: Status | null): string | null {
  if (!command || /\bheadroom(?:\.cmd)?\s+run\b/.test(command)) return null;
  if (!isHeavy(command)) return null;
  if (!status) return null;
  const free = Math.max(0, Math.round(status.free?.memory ?? 0));
  // Only a lease that waits for memory counts. A lease that waits for a slot, for example the browser, does not stop other jobs.
  const waiting = (status.leases ?? []).filter((lease) => lease.state === "waiting" && /^waits for memory\b/.test(lease.reason ?? "")).length;
  if (free >= TIGHT_MB && waiting === 0) return null;
  const why = waiting > 0 ? `${waiting} job${waiting === 1 ? "" : "s"} already wait for memory` : `only ${free} MB is free for a lease`;
  return (
    `headroom: this is a heavy command, and ${why}. Run it under a lease, so it waits for room and does not push ` +
    `other sessions out of memory. Send it again as: ${leased(command)}`
  );
}

/** This function reads the status of the daemon, or gives `null` when no daemon answers in time. */
async function status(): Promise<Status | null> {
  try {
    const home = process.env["HEADROOM_HOME"] ?? join(homedir(), ".headroom");
    const { endpoint, token } = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as { endpoint: string; token: string };
    const res = await fetch(`${new URL(endpoint).origin}/api/resources/status`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{}",
      signal: AbortSignal.timeout(1000),
    });
    return res.ok ? ((await res.json()) as Status) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input || "{}") as { tool_name?: string; tool_input?: { command?: string } };
  const command = String(event.tool_input?.command ?? "");
  // A light command goes on at once, with no request to the daemon.
  if (!isHeavy(command) || /\bheadroom(?:\.cmd)?\s+run\b/.test(command)) return;
  const reason = decide(command, await status());
  if (!reason) return;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }),
  );
}

if (import.meta.main) await main().catch(() => undefined);
