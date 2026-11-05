import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The watch of the shell of a waiting client (H64).
 *
 * On Git Bash, a stop of a shell and its process tree does not reach the client. The chain of parents breaks at each fork, and
 * the parent of the client is a stub of `sh` that stays alive. A test on 2026-11-05 shows this. So a client whose shell is gone
 * keeps its place in the queue, and its job starts at the grant with nobody to read it. The command file of `commandFile` gives the
 * Windows pid of the shell in `HEADROOM_SHELL`.
 */

/** This constant gives the longest time between two examinations of the shell, in milliseconds. */
export const SHELL_WATCH_MS = 15_000;

/** This function tells if a process exists. Only a process that does not exist gives `false`. */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** This function gives a test of the shell of the client. With no shell in the environment, the test always gives `false`. */
export function shellWatch(env: Readonly<Record<string, string | undefined>>, exists: (pid: number) => boolean = processExists): () => boolean {
  const pid = Number(env["HEADROOM_SHELL"] ?? "");
  if (!Number.isInteger(pid) || pid <= 0) return () => false;
  return () => !exists(pid);
}

/**
 * This function gives the text of the `headroom` command file. Only a shell can read `/proc/$PPID/winpid`, because Node on Windows
 * has no such folder. With no such file, the value is empty, and the client does not watch.
 */
export function commandFile(cli: string): string {
  return [
    "#!/bin/sh",
    "# headroom: the memory and job broker of this computer. `headroom service command` writes this file.",
    'read -r HEADROOM_SHELL 2>/dev/null < "/proc/$PPID/winpid"',
    "export HEADROOM_SHELL",
    `exec node --title=headroom-cli "${cli.replaceAll("\\", "/")}" "$@"`,
    "",
  ].join("\n");
}

/** This function writes the command file in one step, so a shell does not read half of it. */
export function writeCommandFile(file: string, cli: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const part = `${file}.${process.pid}.part`;
  writeFileSync(part, commandFile(cli), { mode: 0o755 });
  renameSync(part, file);
}
