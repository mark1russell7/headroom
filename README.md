# headroom

headroom keeps the memory and the processors of one computer free enough for the work that runs on it. It is a small daemon with a SQLite database. It serves its procedures over HTTP, and later over MCP.

## Why

Many Claude Code sessions, Docker and the browser share one computer. When memory runs low, every session slows down, and the low-memory guard of Claude Code stops jobs. Before headroom, a person or an organizer session looked at the free memory and told each session when to start a heavy run. That is slow, and it does not scale.

headroom does three jobs:

1. **Observe.** It samples the memory counters of the computer every few seconds. It gives the memory of each process tree to its owner, for example a Claude Code session or Docker. It keeps the history in SQLite.
2. **Admit.** A job asks for a lease: an amount of memory, a number of processors, or a slot of another named resource. headroom grants the lease when the measured free memory has room for it. Otherwise the job waits in a queue.
3. **Enforce.** headroom starts the job itself, with a memory limit at the size of its lease. On Windows, a job object holds the limit. On Linux, a cgroup holds it. A job that grows past its lease stops with a clear reason, and the other jobs keep their memory.

## Status

Version 0 is in progress. `docs/ROADMAP.md` gives the plan and the status of each item.

## How it is built

- The procedures use `@procedures/client`. The host is `runProcedureHost` of `@procedures/server`, on the runner of `@mark1russell7/service`.
- The database is `node:sqlite`, with one file in WAL mode.
- The daemon is one Node process. Its target is less than 60 MB of memory.

## License

MIT
