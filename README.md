# headroom

headroom keeps the memory and the processors of one computer free enough for the work that runs on it. It is a small daemon with a SQLite database. It serves its procedures over HTTP, and later over MCP.

## Why

Many Claude Code sessions, Docker and the browser share one computer. When memory runs low, every session slows down, and the low-memory guard of Claude Code stops jobs. Before headroom, a person or an organizer session looked at the free memory and told each session when to start a heavy run. That is slow, and it does not scale.

headroom does three jobs:

1. **Observe.** It samples the memory counters of the computer every few seconds. It gives the memory of each process tree to its owner, for example a Claude Code session or Docker. It keeps the history in SQLite.
2. **Admit.** A job asks for a lease. The lease names an amount of memory, a count of processors or a slot of a named resource. The daemon grants the lease when the measured free memory has room for it. Otherwise the job waits in a queue.
3. **Enforce.** headroom starts the job itself, with a memory limit at the size of its lease. On Windows, a job object holds the limit. On Linux, a cgroup holds it. A job that grows past its lease stops with a clear reason, and the other jobs keep their memory.

## Status

Version 0 works: the sampler, the leases, the daemon, the CLI and the service. Its leases are advisory. `docs/ROADMAP.md` gives the plan and the status of each item.

## Use

Register the daemon as a service of your user. It starts at login, and it starts again when it stops. It listens on `127.0.0.1:4730` and writes its address and token to `~/.headroom/daemon.json`.

```sh
headroom service install
headroom service status
```

On Windows, a scheduled task starts the daemon at logon and every 2 minutes when it stopped. The log is `~/.headroom/daemon.log`. On Linux, a systemd user unit starts it. `headroom service uninstall` stops the daemon and removes the service. To start the daemon in a terminal, use `headroom serve`.

Run a heavy job under a lease. The job waits until the memory is free. When the daemon does not run, the job runs at once with a warning.

```sh
headroom run --mem 2g -- pnpm test
headroom run --slot docker --mem 1g -- docker compose up -d mongo
```

See the memory, the free amounts, the leases and the memory of each owner:

```sh
headroom status
headroom history --minutes 120
```

A pool with no capacity is a lock of 1. Set a capacity with `headroom pool cpu 8`.

## The MCP gateway

Claude Code starts a copy of each stdio MCP server for each session. The gateway starts one copy of a server for all the sessions, and serves it at `http://127.0.0.1:4730/mcp/<name>`.

```sh
headroom mcp add vex --cwd ~/git/Vex/packages/mcp -- node --import tsx src/main.ts
headroom mcp config vex
headroom mcp list
```

- `headroom mcp config` gives the configuration for Claude Code: an `http` server with a `headersHelper`. The helper gives the token of the daemon at each connection.
- The gateway starts a server at the first request, and stops it after 30 minutes with no request. `--idle 0` keeps it.
- Start a server with `node` directly, not through `npx` or `pnpm exec`. A server of the MCP SDK stops when its input closes, so a stop of the daemon also stops it.
- Use the gateway only for a server that keeps no state for a session. A server with one browser for each session stays a stdio server.

| Exit code | Meaning |
|---|---|
| The code of the job | The job ran under its lease. |
| 75 | The lease was not granted in time, or it ended before the job started. Nothing ran. |
| 2 | The command line is not correct. |

## How it is built

- The procedures use `@procedures/client`. The host is `runProcedureHost` of `@procedures/server`, on the runner of `@mark1russell7/service`.
- The database is `node:sqlite`, with one file in WAL mode.
- The daemon is one Node process. Its target is less than 60 MB of memory.

## License

MIT
