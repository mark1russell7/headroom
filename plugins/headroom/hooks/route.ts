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
 * - The body of a here-document is text when its program only writes text (`cat > a.md <<'EOF'`, `gh pr create
 *   --body-file -`) and the shell does not run a part of it. A body that a shell reads (`bash <<'EOF'`) stays in the rating.
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

/**
 * The shells that read the body of a here-document as commands. A prefix in such a body is a command of the shell. Each
 * other program that reads a body reads it as its own code or data, so a prefix goes in front of that program (H52).
 */
const BODY_SHELLS: ReadonlySet<string> = new Set([...SHELLS.keys(), "zsh", "dash", "ksh", "ash"]);

/** The shell divides a line at these separators. The `&` of a redirection, as in `2>&1`, is not one. */
const SEPARATOR = /&&|\|\||;|\||\r?\n|(?<!>)&(?!>)/g;

/**
 * The start of a part before its program. It can hold brackets, the start of a command substitution (`$(` or a
 * backquote), the words of a shell loop or test, and variables (`CI=1`). Thus a prefix goes after the `$(` of a command
 * substitution (H52).
 */
const LEAD = /^\s*(?:(?:[({!`]|\$\()\s*|(?:if|then|elif|else|while|until|do)\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/;

/**
 * The programs that only take the body of a here-document as text: the text readers, `tee`, `git` (`commit -F -`) and
 * `gh` (`--body-file -`). A shell or another interpreter runs its body, so its body stays in the rating.
 */
const TEXT_SINKS: ReadonlySet<string> = new Set([...READERS, "tee", "git", "gh"]);

/** The operator of a here-document and its delimiter: `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"` or `<<\EOF`. */
const HEREDOC = /<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|(\\?)([A-Za-z0-9_.-]+))/y;

/** The operator of a here-document. Its body starts after the end of the line of the operator. */
interface Heredoc {
  /** The length of the operator with its delimiter. */
  readonly length: number;
  readonly delimiter: string;
  /** The delimiter is quoted (`'EOF'`, `"EOF"`, `\EOF`), so the shell does not expand the body. */
  readonly quoted: boolean;
  /** `<<-`: the shell removes the tabs at the start of each line of the body and of the delimiter line. */
  readonly tabs: boolean;
}

/** A here-document of the current line, with the part that holds its operator. */
interface Waiting {
  readonly heredoc: Heredoc;
  /** The start of the part that holds the operator. */
  readonly from: number;
  /** The program of that part, in lower case. */
  readonly owner: string;
}

/** One part of a command line. `text` has the same length as `raw`, without the text of quoted strings and comments. */
interface Part {
  readonly start: number;
  readonly raw: string;
  readonly text: string;
  /**
   * The start of the part that reads this part as its input, or `null` (H52). A part has an owner when it is in the
   * body of a here-document, and a program other than a shell reads that body.
   */
  readonly owner: number | null;
}

/** The body of a here-document that a program other than a shell reads (H52). `reader` is the start of the part of that program. */
interface Body {
  readonly start: number;
  readonly end: number;
  readonly reader: number;
}

/** This function reads the operator of a here-document at `at`, or gives null. A here-string (`<<<`) is not one. */
function heredocAt(command: string, at: number): Heredoc | null {
  if (command[at] !== "<" || command[at + 1] !== "<" || command[at + 2] === "<" || command[at - 1] === "<") return null;
  HEREDOC.lastIndex = at;
  const operator = HEREDOC.exec(command);
  if (operator === null) return null;
  return {
    length: operator[0].length,
    delimiter: operator[2] ?? operator[3] ?? operator[5] ?? "",
    quoted: operator[2] !== undefined || operator[3] !== undefined || operator[4] === "\\",
    tabs: operator[1] === "-",
  };
}

/**
 * This function finds the closing quote of the string at `open`, or gives -1. A double quoted string can hold an escaped quote.
 * It can also hold a command substitution with a here-document (`"$(cat <<'EOF'` … `EOF` … `)"`). A quote in its body does not
 * close the string. Thus the search goes over the body to the line of its delimiter.
 */
function closingQuote(command: string, open: number): number {
  const quote = command[open];
  let substitution = false;
  const waiting: Heredoc[] = [];
  for (let at = open + 1; at < command.length; at++) {
    if (command[at] === quote) return at;
    if (quote !== '"') continue;
    if (command[at] === "\\") {
      at++;
      continue;
    }
    if (command[at] === "$" && command[at + 1] === "(") substitution = true;
    const heredoc = substitution ? heredocAt(command, at) : null;
    if (heredoc !== null) {
      waiting.push(heredoc);
      at += heredoc.length - 1;
    } else if (command[at] === "\n" && waiting.length > 0) {
      let stop = at + 1;
      for (const each of waiting.splice(0)) {
        const close = bodyEnd(command, stop, each);
        if (close < 0) return -1;
        stop = close + 1;
      }
      // The next step reads the end of the line of the last delimiter.
      at = stop - 2;
    }
  }
  return -1;
}

/** This function gives the start of the part that holds the position `at`. `text` is the line without its quoted strings. */
function partStart(text: string, at: number): number {
  let start = 0;
  for (const match of text.slice(0, at).matchAll(SEPARATOR)) start = (match.index ?? 0) + match[0].length;
  return start;
}

/** This function gives the program of the part from `start` to `end`: its first word after the lead, in lower case. */
function programAt(command: string, text: string, start: number, end: number): string {
  const lead = LEAD.exec(text.slice(start, end))?.[0].length ?? 0;
  const word = /"[^"]*"|'[^']*'|\S+/.exec(command.slice(start + lead, end))?.[0] ?? "";
  return programName(word.replace(/^["']|["']$/g, ""));
}

/**
 * This function tells if each program that gets the output of the part at `from` through a pipe is in `TEXT_SINKS`.
 * `to` is the end of the line. Thus `cat <<'EOF' | tee a.md` passes, and `cat <<'EOF' | bash` does not.
 */
function pipesToText(command: string, text: string, from: number, to: number): boolean {
  const separators = [...text.slice(from, to).matchAll(SEPARATOR)];
  for (const [index, separator] of separators.entries()) {
    if (separator[0] !== "|") return true;
    const start = from + (separator.index ?? 0) + 1;
    const after = separators[index + 1];
    const end = after === undefined ? to : from + (after.index ?? 0);
    if (!TEXT_SINKS.has(programAt(command, text, start, end))) return false;
  }
  return true;
}

/**
 * This function gives the part that reads the body of a here-document (H52). Usually, this is the part of its operator.
 * When that program is one of `TEXT_SINKS`, it is the first program after it in the pipe that is not one of
 * `TEXT_SINKS`. Thus `cat <<'EOF' | node` gives the part of `node`. `to` is the end of the line.
 */
function readerOf(command: string, text: string, waiting: Waiting, to: number): { start: number; program: string } {
  if (!TEXT_SINKS.has(waiting.owner)) return { start: waiting.from, program: waiting.owner };
  const separators = [...text.slice(waiting.from, to).matchAll(SEPARATOR)];
  for (const [index, separator] of separators.entries()) {
    if (separator[0] !== "|") break;
    const start = waiting.from + (separator.index ?? 0) + 1;
    const after = separators[index + 1];
    const end = after === undefined ? to : waiting.from + (after.index ?? 0);
    const program = programAt(command, text, start, end);
    if (!TEXT_SINKS.has(program)) return { start, program };
  }
  return { start: waiting.from, program: waiting.owner };
}

/** This function tells if the position `at` is in an arithmetic expression `((…))` of its part, where `<<` is a shift. */
function inArithmetic(text: string, from: number, at: number): boolean {
  const before = text.slice(from, at);
  return (before.match(/\(\(/g)?.length ?? 0) > (before.match(/\)\)/g)?.length ?? 0);
}

/**
 * This function gives the end of the body of a here-document that starts at `start`: the end of its delimiter line, before
 * the newline. It gives -1 when no line closes the body.
 */
function bodyEnd(command: string, start: number, heredoc: Heredoc): number {
  let line = start;
  while (line <= command.length) {
    const newline = command.indexOf("\n", line);
    const end = newline < 0 ? command.length : newline;
    let text = command.slice(line, end).replace(/\r$/, "");
    if (heredoc.tabs) text = text.replace(/^\t+/, "");
    if (text === heredoc.delimiter) return end;
    if (newline < 0) return -1;
    line = newline + 1;
  }
  return -1;
}

/**
 * This function gives a command line of the same length, without the text of quoted strings and comments. Thus each
 * position stays the same. A quote with no closing quote stays as text, so a heavy command cannot hide behind it.
 * A comment goes too, because an apostrophe in a comment does not start a string.
 *
 * The body of a here-document goes too, with its delimiter line, when the body is only text. These are the conditions:
 * - Its program is one of `TEXT_SINKS`, and a pipe sends its output only to `TEXT_SINKS`.
 * - A line closes it.
 * - The shell does not run a part of it: a quoted delimiter, or no `$(` and no backquote in it.
 *
 * The body then becomes one blank stretch with no newline, so it gives no part of its own. Each other body stays in the
 * rating, as before. When a program other than a shell reads such a body, the body goes into `bodies` (H52).
 */
function withoutText(command: string, bodies: Body[] = []): string {
  let out = "";
  let at = 0;
  let waiting: Waiting[] = [];
  while (at < command.length) {
    const char = command[at] ?? "";
    const next = command[at + 1] ?? "";
    const closing = char === '"' || char === "'" ? closingQuote(command, at) : -1;
    let end = at + 1;
    const heredoc = heredocAt(command, at);
    const from = heredoc === null ? 0 : partStart(out, at);
    if (heredoc !== null && !inArithmetic(out, from, at)) {
      waiting.push({ heredoc, from, owner: programAt(command, out, from, at) });
      end = at + heredoc.length;
      out += command.slice(at, end);
      at = end;
      continue;
    }
    if (char === "\n" && waiting.length > 0) {
      // The bodies start after this newline, one after the other.
      const line = at;
      out += char;
      at = end;
      let blank = true;
      let stop = at;
      const spans: [number, number][] = [];
      for (const each of waiting) {
        const close = bodyEnd(command, stop, each.heredoc);
        const body = close < 0 ? "" : command.slice(stop, close);
        const text = TEXT_SINKS.has(each.owner) && pipesToText(command, out, each.from, line);
        if (close < 0 || !text || (!each.heredoc.quoted && /\$\(|`/.test(body))) {
          blank = false;
          break;
        }
        spans.push([stop, close]);
        stop = close + 1;
      }
      if (!blank) {
        // The body stays in the rating. A program other than a shell reads it as its own code or data (H52).
        let start = at;
        for (const each of waiting) {
          const close = bodyEnd(command, start, each.heredoc);
          if (close < 0) break;
          const reader = readerOf(command, out, each, line);
          if (!BODY_SHELLS.has(reader.program) && !TEXT_SINKS.has(reader.program)) bodies.push({ start, end: close, reader: reader.start });
          start = close + 1;
        }
      }
      waiting = [];
      if (blank) {
        for (const [index, [from, to]] of spans.entries()) {
          out += " ".repeat(to - from);
          // The newline between two bodies stays blank too, so the bodies give no part.
          if (index < spans.length - 1) out += " ";
        }
        at = spans.at(-1)?.[1] ?? at;
      }
      continue;
    }
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
  const bodies: Body[] = [];
  const text = withoutText(command, bodies);
  const bodyAt = (at: number): Body | undefined => bodies.find((body) => at >= body.start && at < body.end);
  // A body can be in the body of another program. The owner is the outer program, so a prefix goes outside each body.
  const ownerOf = (at: number): number | null => {
    let owner: number | null = null;
    for (let body = bodyAt(at); body !== undefined; body = bodyAt(body.reader)) owner = body.reader;
    return owner;
  };
  const parts: Part[] = [];
  let start = 0;
  for (const match of [...text.matchAll(SEPARATOR), null]) {
    const end = match ? (match.index ?? 0) : command.length;
    parts.push({ start, raw: command.slice(start, end), text: text.slice(start, end), owner: ownerOf(start) });
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
  // A part with no command text (a comment, or the body of a here-document of text) runs nothing.
  if (part.text.trim() === "") return false;
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
 *
 * The prefix does not go in the body of a here-document that a program other than a shell reads (H52). There, the body
 * is code or data of that program, so the prefix goes in front of that program: `node - <<'JS'` gives
 * `headroom run --mem auto -- node - <<'JS'`. In the body of a shell, the heavy part is a command, so the prefix goes there.
 */
export function leased(command: string): string {
  const parts = partsOf(command);
  const heavy = parts.find(isHeavyPart);
  if (heavy === undefined) return `headroom run --mem auto -- ${command}`;
  const target = heavy.owner === null ? heavy : (parts.find((part) => part.start === heavy.owner) ?? heavy);
  const at = target.start + leadOf(target);
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
