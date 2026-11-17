/**
 * The relay of `headroom run --detach` on Windows (H190). The run starts this file with the shell of the desktop as its
 * parent process. Thus the relay has none of the jobs of the caller. The relay reads the start of the client from the
 * pipe in its first argument. It starts the client as a foreground run does, and gives the result back on the pipe.
 */

import { runRelay } from "./detach.ts";

const pipe = process.argv[2];
if (pipe === undefined) process.exitCode = 2;
else
  void runRelay(pipe).then((code) => {
    process.exitCode = code;
  });
