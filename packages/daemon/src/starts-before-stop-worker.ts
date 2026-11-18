/**
 * The worker thread of `keepStartsBeforeStop` (H206). It writes the file of the starts before an unclean stop and sends the
 * result to the daemon. The daemon thread does not wait for it.
 */

import { parentPort, workerData } from "node:worker_threads";
import type { StartsBeforeStopInput, StartsBeforeStopMessage } from "./starts-before-stop.ts";
import { writeStartsBeforeStop } from "./starts-cli.ts";

const input = workerData as StartsBeforeStopInput;
let message: StartsBeforeStopMessage;
try {
  message = { kept: writeStartsBeforeStop(input.path, input.folder, input.before) };
} catch (error) {
  message = { error: error instanceof Error ? error.message : String(error) };
}
parentPort?.postMessage(message);
