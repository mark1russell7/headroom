/**
 * The `headroom fits` command (H220).
 *
 * It tells if a lease of these amounts starts at the next tick of the broker. The answer is a dry tick, so no lease is made.
 * It counts the free room, the rank in the queue, the conflicts and the hold of a long first request (H178).
 * A merge gate uses the exit code: 0 when the lease fits, 1 when it waits, 3 when the read failed.
 *
 * The amounts take the flags of `headroom run`. Thus `--mem auto` and `--cpu auto` give the amounts of the last runs of
 * the job. The command after `--` gives the key of the job (H78), as for a run. So the gate asks what the run asks.
 */

import { parseArgs } from "node:util";
import { CPU_AUTO_DEFAULT, FITS_DEFAULT, type Fits, type Suggestion } from "@headroom/core";
import type { Connection } from "./client.ts";
import { keyOfRun } from "./job-key.ts";
import { loanOption } from "./loan.ts";
import { AUTO_DEFAULT_MB } from "./lease-report.ts";
import { parseMemory } from "./parse.ts";

export const FITS_USAGE = "headroom fits --mem <amount|auto> [--cpu <n|auto>] [--priority <n>] [--job <name>] [--holder <h>] [--loan 60s] [--json] [-- <command>]";

/** The exit code of `headroom fits` when the lease waits at the next tick, or cannot start at any time. */
export const DOES_NOT_FIT = 1;

/** The exit code of `headroom fits` when it has no answer: the daemon does not answer, or it has no dry tick. A gate does not pass on it. */
export const NO_READ = 3;

/** The outputs of the command, and the folder of its command. The tests replace them. */
export interface FitsOutput {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly cwd?: string;
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
  let parsed: Parsed;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.err(`headroom: ${(error as Error).message}`);
    io.err(`Usage: ${FITS_USAGE}`);
    return 2;
  }
  if (!connection) {
    io.err("headroom does not run, so no read tells if the lease fits. Start it with: headroom service install");
    return NO_READ;
  }
  const { priority, job, holder, json, command, loanMs } = parsed;
  const amounts: Record<string, number> = { ...parsed.amounts };
  try {
    if (parsed.memAuto || parsed.cpuAuto) {
      const key = command.length === 0 ? null : keyOfRun(command, io.cwd ?? process.cwd());
      const suggestion = await connection.call<Suggestion>(["resources", "suggest"], { job: job ?? FITS_DEFAULT, holder: holder ?? FITS_DEFAULT, ...(key === null ? {} : { key }) });
      if (parsed.memAuto) amounts["memory"] = suggestion.memoryMb ?? AUTO_DEFAULT_MB;
      if (parsed.cpuAuto) amounts["cpu"] = typeof suggestion.cores === "number" ? suggestion.cores : CPU_AUTO_DEFAULT;
    }
    const answer = await connection.call<Fits>(["resources", "fits"], { amounts, priority, ...(job === undefined ? {} : { job }), ...(holder === undefined ? {} : { holder }), ...(loanMs === null ? {} : { loanMs }) });
    if (json) io.out(JSON.stringify({ ...answer, amounts }, null, 2));
    else (answer.fits ? io.out : io.err)(fitsLine(answer, amounts, priority));
    return answer.fits ? 0 : DOES_NOT_FIT;
  } catch (error) {
    // A daemon of before H220 has no procedure resources.fits.
    io.err(`headroom: the daemon gave no dry tick: ${(error as Error).message}`);
    return NO_READ;
  }
}

interface Parsed {
  readonly amounts: Record<string, number>;
  readonly memAuto: boolean;
  readonly cpuAuto: boolean;
  readonly priority: number;
  readonly job?: string;
  readonly holder?: string;
  readonly json: boolean;
  readonly command: readonly string[];
  readonly loanMs: number | null;
}

/** This function reads the arguments of `headroom fits`. It throws an `Error` for a wrong use. */
function parse(argv: readonly string[]): Parsed {
  const end = argv.indexOf("--");
  const flags = end === -1 ? argv : argv.slice(0, end);
  const command = end === -1 ? [] : argv.slice(end + 1);
  const { values, positionals } = parseArgs({
    args: [...flags],
    allowPositionals: true,
    options: { mem: { type: "string" }, cpu: { type: "string" }, priority: { type: "string" }, job: { type: "string" }, holder: { type: "string" }, loan: { type: "string" }, json: { type: "boolean" } },
  });
  if (positionals.length > 0) throw new Error(`put the command after --: ${positionals.join(" ")}`);
  const amounts: Record<string, number> = {};
  const memAuto = values.mem === "auto";
  const cpuAuto = values.cpu === "auto";
  if (values.mem !== undefined && !memAuto) amounts["memory"] = parseMemory(values.mem);
  if (values.cpu !== undefined && !cpuAuto) {
    const cores = Number(values.cpu);
    if (!Number.isFinite(cores) || cores <= 0) throw new Error(`Not a count of cores: ${values.cpu}`);
    amounts["cpu"] = cores;
  }
  if (values.mem === undefined && values.cpu === undefined) throw new Error("give --mem, --cpu or both");
  // H219: a job that asks for a loan can borrow the unused hold of a long lease. The dry tick counts the loan too.
  const loan = loanOption(values.loan, { mem: values.mem, keep: false });
  if (loan !== null && typeof loan === "object") throw new Error(loan.error);
  const priority = values.priority === undefined ? 0 : Number(values.priority);
  if (!Number.isInteger(priority) || priority < -100 || priority > 100) throw new Error(`Not a priority from -100 to 100: ${values.priority ?? ""}`);
  return {
    amounts,
    memAuto,
    cpuAuto,
    priority,
    json: values.json === true,
    command,
    loanMs: loan,
    ...(values.job === undefined ? {} : { job: values.job }),
    ...(values.holder === undefined ? {} : { holder: values.holder }),
  };
}
