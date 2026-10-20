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

The command line of the daemon has the title `headroom-daemon`. The command line of a Node server of the gateway has the title `headroom-mcp-<name>`, and the server has the variable `HEADROOM_MCP_SERVER`. To find or stop these processes, search for the titles, not for `cli.ts`.

On Windows, a scheduled task starts the daemon at logon and every 2 minutes when it stopped. The log is `~/.headroom/daemon.log`. On Linux, a systemd user unit starts it. `headroom service restart` loads a new version: it waits until no lease waits, and it marks the stop as planned, so no `stop` alert starts. `headroom service uninstall` stops the daemon and removes the service. To start the daemon in a terminal, use `headroom serve`.

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

On Windows, `headroom run` puts the job into a job object:

- When the run ends, Windows stops each process that the job started and that still runs. Thus a test server or a search does not stay as an orphan. `--keep` turns this off, for a command that starts a service on purpose.
- `--limit` makes the memory of the lease a hard limit: the job cannot commit more. An allocation above the limit fails, and the job stops with its own error.
- The run writes the peak memory of the job, for example `the job used at most 248 MB of its lease of 300 MB`. The ended lease keeps the peak.
- A browser test (`playwright test`, `cypress run`, or a command that names `e2e`) takes the slot `browser` by itself. Thus one browser test job runs at a time. Two jobs at the same time start many browser processes, and new processes can then fail with `0xC0000142`. A script that runs browser tests inside it, for example a gate, takes the slot with `--slot browser`. `--no-auto-slot` turns it off, and `headroom pool browser 2` lets two run.
- `--mem auto` sizes the lease from the peaks of the last runs of the same job: the 90th percentile and 25% more. The runs of the same holder come first. A job with no run gets 1 GB.

A pool with no capacity is a lock of 1. Set a capacity with `headroom pool cpu 8`.

The alerts tell about a problem before the memory runs out. `headroom status` shows them first, and `headroom alerts --watch` writes one line when an alert starts or ends. The alerts only report. They do not stop a process.

| Alert | The condition |
|---|---|
| `runaway` | One process holds more than 4 GB with no lease. Docker and the system are not examined. |
| `orphan` | A process with no owner holds more than 1 GB, and its parent stopped. |
| `memory` | Less than 1 GB of memory is available. |
| `commit` | The commit charge is above 90% of its limit. |
| `desktop` | More than 1000 processes run in the session. The desktop heap can run out, and new processes then fail at their start. |
| `pool` | The non-paged kernel pool is above 3 GB, or the paged pool is above 4 GB, or one of them grew more than 500 MB in one hour. The alert names the pool tags that grow. |
| `stop` | Another process stopped the daemon, or 2 clients of `headroom run` in 2 minutes. This alert is an event: it stays for 15 minutes. |

On Windows, the daemon reads the kernel pool by pool tag every 5 minutes. A driver marks its allocations with a tag, so the tag that grows names the driver that leaks. `headroom pool-tags --drivers` shows the largest tags, the tags that grew in the last hour, and the driver files that contain each tag. It needs no admin rights and no driver kit.

## The plugin for Claude Code

The plugin `headroom` has a hook for the Bash and PowerShell tools. When a session starts a heavy command (tests, builds, Playwright, Docker builds) and the memory is tight, the hook refuses the command. It gives the session the form under a lease, for example `cd app && headroom run --mem auto -- pnpm test`.

- The memory is tight when less than 4 GB is free for a lease, or when jobs wait.
- The hook does not approve a command. The session sends the new form, and the permission rules of the user apply to it.
- Without a daemon, or for a light command, the hook does nothing. It adds approximately 65 ms to each command.

To turn it on in Claude Code: `/plugin marketplace add C:Usersmarktgitheadroom`, then `/plugin install headroom@headroom`. To turn it off: `/plugin disable headroom@headroom`.

## The dashboard

The daemon serves a dashboard at `http://127.0.0.1:4730/`. `headroom dashboard` opens it in the browser. It shows the memory, the alerts, the memory of each owner, the leases, the MCP gateway and the pool tags. Its charts show the last hour to the last 7 days.

- The page is one HTML file of approximately 35 KB, with no framework and no build step. The daemon keeps it as one string.
- The page stops its requests while its tab is hidden. Close the tab, and the dashboard costs nothing.
- Only a request to `127.0.0.1` or `localhost` gets the page, because the page holds the token of the daemon.

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
- The gateway sends the progress of a call to its session. It also sends a question of the server (MCP elicitation) to the session of the call. Stdio does not tell which call asks. Thus, when more than one session waits for the server, the answer is `decline`.

A program that starts only stdio servers, for example the launcher of a plugin, uses the bridge:

```sh
node packages/daemon/src/bridge.mjs vex -- npx -y @mark1russell7/vex-mcp
```

The bridge sends the messages of the session to the gateway. When the gateway does not serve the server, the bridge starts the command after `--`. Thus the same launcher works on a computer without headroom. The bridge uses approximately 30 MB, and it opens a new session after a restart of the daemon.

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
