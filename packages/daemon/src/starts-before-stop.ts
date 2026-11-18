/**
 * The copy of the starts before an unclean stop, in a worker thread (H206).
 *
 * - After a bugcheck, the daemon keeps the starts of the last 2 minutes before the stop in a file (`writeStartsBeforeStop`).
 *   On 2026-11-18, that read took 15 minutes, and the daemon did it before it bound its port. So the hook of each session
 *   got a refused connection for 15 minutes.
 * - The daemon calls this function after it binds its port. The read runs in a worker thread, so the event loop of the
 *   daemon answers the hook and the procedures during the read.
 */

import { Worker } from "node:worker_threads";

/** The file of the starts and their count. */
export interface KeptStarts {
  readonly file: string;
  readonly starts: number;
}

/** The input of the worker. */
export interface StartsBeforeStopInput {
  readonly path: string;
  readonly folder: string;
  readonly before: number;
}

/** The message of the worker: the result, or the text of the error. */
export type StartsBeforeStopMessage = { readonly kept: KeptStarts | null } | { readonly error: string };

/** This function writes the file of the starts before the stop in a worker thread. It gives the file, or `null` when the log has no start. */
export function keepStartsBeforeStop(input: StartsBeforeStopInput): Promise<KeptStarts | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./starts-before-stop-worker.ts", import.meta.url), { workerData: input });
    let settled = false;
    worker.once("message", (message: StartsBeforeStopMessage) => {
      settled = true;
      if ("error" in message) reject(new Error(message.error));
      else resolve(message.kept);
    });
    worker.once("error", (error) => {
      settled = true;
      reject(error);
    });
    worker.once("exit", (code) => {
      if (!settled) reject(new Error(`The worker of the starts before the stop ended with the code ${code} and no result.`));
    });
  });
}
