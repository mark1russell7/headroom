/**
 * The watch of the shell of a waiting client (H64).
 *
 * On Git Bash, a stop of a shell and its process tree does not reach the client. The chain of parents breaks at each fork, and
 * the parent of the client is a stub of `sh` that stays alive. A test on 2026-11-05 shows this. So a client whose shell is gone
 * keeps its place in the queue, and its job starts at the grant with nobody to read it. The file `bin/headroom` gives the
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
