/**
 * The `headroom fits --mem <amount> [--cpu <n>] [--priority <n>] [--job <name>] [--holder <h>] [--json]` command (H220).
 *
 * It tells if a lease of these amounts starts at the next tick of the broker. The answer is a dry tick, so no lease is made.
 * It counts the free room, the rank in the queue, the conflicts and the hold of a long first request (H178).
 * A merge gate uses the exit code: 0 when the lease fits, 1 when it waits, 3 when the read failed.
 */

import { parseArgs } from "node:util";
import type { Fits } from "@headroom/core";
import type { Connection } from "./client.ts";
import { parseMemory } from "./parse.ts";

export const FITS_USAGE = "headroom fits --mem <amount> [--cpu <n>] [--priority <n>] [--job <name>] [--holder <h>] [--json]";

/** The exit code of `headroom fits` when the lease waits at the next tick, or cannot start at any time. */
export const DOES_NOT_FIT = 1;

/** The exit code of `headroom fits` when it has no answer: the daemon does not answer, or it has no dry tick. A gate does not pass on it. */
export const NO_READ = 3;

/** The outputs of the command. The tests replace them. */
export interface FitsOutput {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const CONSOLE: FitsOutput = { out: (text) => console.log(text), err: (text) => console.error(text) };

/** This function writes the amounts in one line: "memory 750 MB, cpu 1". */
export function amountsText(amounts: Readonly<Record<string, number>>): string {
  return Object.entries(amounts)
    .map(([id, amount]) => (id === "memory" ? `memory ${amount} MB` : `${id} ${amount}`))
    .join(", ");
}

/** This function gives the line of an answer of `resources.fits`. */
export function fitsLine(answer: Fits, amounts: Readonly<Record<string, number>>, priority: number): string {
  const what = `A lease of ${amountsText(amounts)} at priority ${priority}`;
  if (answer.fits) return `${what} starts at the next tick${answer.loan ? ", on a loan of the unused hold of a long lease (H219)" : ""}.`;
  if (answer.state === "cancelled") return `${what} cannot start at any time: ${answer.reason ?? "no reason"}.`;
  return `${what} waits: ${answer.reason ?? "no reason"}.`;
}

/**
 * This function operates `headroom fits`. It gives 0 when the lease starts at the next tick, and `DOES_NOT_FIT` when it
 * waits. It gives `NO_READ` when the daemon does not answer, and 2 for a wrong use.
 */
export async function fitsCommand(argv: readonly string[], connection: Connection | null, io: FitsOutput = CONSOLE): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.err(`headroom: ${(error as Error).message}`);
    io.err(`Usage: ${FITS_USAGE}`);
    return 2;
  }
  const { amounts, priority, job, holder, json } = parsed;
  if (!connection) {
    io.err("headroom does not run, so no read tells if the lease fits. Start it with: headroom service install");
    return NO_READ;
  }
  let answer: Fits;
  try {
    answer = await connection.call<Fits>(["resources", "fits"], { amounts, priority, ...(job === undefined ? {} : { job }), ...(holder === undefined ? {} : { holder }) });
  } catch (error) {
    // A daemon of before H220 has no procedure resources.fits.
    io.err(`headroom: the daemon gave no dry tick: ${(error as Error).message}`);
    return NO_READ;
  }
  if (json) io.out(JSON.stringify(answer, null, 2));
  else (answer.fits ? io.out : io.err)(fitsLine(answer, amounts, priority));
  return answer.fits ? 0 : DOES_NOT_FIT;
}

/** This function reads the arguments of `headroom fits`. It throws an `Error` for a wrong use. */
function parse(argv: readonly string[]): { amounts: Record<string, number>; priority: number; job?: string; holder?: string; json: boolean } {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { mem: { type: "string" }, cpu: { type: "string" }, priority: { type: "string" }, job: { type: "string" }, holder: { type: "string" }, json: { type: "boolean" } },
  });
  if (positionals.length > 0) throw new Error(`headroom fits takes no command: ${positionals.join(" ")}`);
  const amounts: Record<string, number> = {};
  if (values.mem !== undefined) amounts["memory"] = parseMemory(values.mem);
  if (values.cpu !== undefined) {
    const cores = Number(values.cpu);
    if (!Number.isFinite(cores) || cores <= 0) throw new Error(`Not a count of cores: ${values.cpu}`);
    amounts["cpu"] = cores;
  }
  if (Object.keys(amounts).length === 0) throw new Error("give --mem, --cpu or both");
  const priority = values.priority === undefined ? 0 : Number(values.priority);
  if (!Number.isInteger(priority) || priority < -100 || priority > 100) throw new Error(`Not a priority from -100 to 100: ${values.priority ?? ""}`);
  return { amounts, priority, json: values.json === true, ...(values.job === undefined ? {} : { job: values.job }), ...(values.holder === undefined ? {} : { holder: values.holder }) };
}
