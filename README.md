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

When leases wait for a long time, use `headroom service restart --when-idle` to load a new version. The command does not wait. The daemon restarts itself at its first tick with no waiting lease. `headroom status` shows the restart that waits, and `--cancel` cancels it. During a planned restart, `headroom run` waits for the new daemon.

Run a heavy job under a lease. The job waits until the memory is free. When the daemon does not run, the job runs at once with a warning.

```sh
headroom run --mem 2g -- pnpm test
headroom run --slot docker --mem 1g -- docker compose up -d mongo
```

See the memory, the free space of the drives, the free amounts, the leases and the memory of each owner:

```sh
headroom status
headroom history --minutes 120
```

The list "Memory by owner" gives the private memory and the memory in RAM of each owner. The owners and the available memory add up to approximately the physical memory:

- A process belongs to its Claude Code session, its MCP server of the gateway, or a group, for example `docker`, `browser`, `editor` or `system`.
- A Node process with `--title=<name>` that Task Scheduler, a service or Explorer starts is the owner `service:<name>`, for example `service:headroom-daemon`.
- On Windows, three owners have no process: `kernel` (the kernel pools), `kernel:cache` (the system file cache in RAM) and `kernel:drivers` (the code of the kernel and of the drivers).

`headroom status` also gives the owners that wrote most in the last hour, the processors in use, the network, the TCP connections and the shared services:

```text
Writes (last hour): session:graph 31.2 GB, mcp:vex 2.1 GB.
CPU: 3.4 of 16 cores in use. Most: session:graph 2.1, mcp:vex 0.4.
Network: 1.2 MB/s in, 0.3 MB/s out.
TCP: 812 connections (120 waiting to close), 2% of the dynamic ports.
Services: docker ok (12 ms), fleet-site ok (3 ms), mcp:vex ok, mcp:loom idle.
```

- The writes come from the write counter of each process: `WriteTransferCount` on Windows, and `write_bytes` of `/proc/<pid>/io` on Linux. The line names the 5 owners above 10 MB.
- The Windows counter counts each write of a process, also to a pipe or a device. The counters do not name the drive, so the amount of an owner is for all the drives together.
- A write is not always new space. A file that a job writes again uses no new space.
- The process `System` writes the file cache and the pages of mapped files to the drives. Thus one write can count for its process and for the owner `system`.
- The Windows counters charge to `system` the disk writes of cached files and of the page file. The lazy writer and the memory manager write them, so `system` can hide the real writer.
- The cores of an owner are an average over the last minute, from the processor time of its processes.
- The network line is the throughput of the physical adapters and the Wi-Fi adapters over the last 10 seconds. A loopback, a tunnel or a virtual adapter does not count. After a start of the daemon, the line comes after 10 seconds, because a rate needs two reads.
- The TCP line counts the connections of IPv4 and IPv6. A connection that waits to close is in `TIME_WAIT`, and Windows keeps its port for some minutes. The part is the connections with a local port in the dynamic range (49152 to 65535 on Windows), in each state.

Sessions start dev servers, and two servers on the same port collide. `headroom ports` shows the listening TCP ports, with the process and the owner of each port, by port. `--json` gives the list and the dynamic port range.

```text
PORT       PID  PROCESS                    OWNER                  ADDRESSES
135        932  svchost.exe                system                 0.0.0.0, ::
3000     21512  node.exe                   session:graph          127.0.0.1
5173     30404  node.exe                   session:client         ::1

3 listening ports. Outgoing connections use the dynamic ports 49152-65535, so give a dev server a port below 49152.
```

### The shared services (H27)

On 2026-10-24, the Docker engine stopped to answer, and an MCP server of the gateway did not start. Nothing told the sessions. Since H27, the daemon checks the shared services every 30 seconds, with a time limit of 3 seconds for each check:

- **Docker**: a `GET /_ping` on the pipe of the engine, `\\.\pipe\docker_engine` on Windows and `/var/run/docker.sock` on Linux. headroom starts no `docker` process. When the pipe does not exist, the state is `absent`, and no alert starts.
- **The MCP servers of the gateway**: the state of the gateway, with no call. A server that did not start is `down`, with the last error line of its stderr. A server that the gateway stopped for idle is `idle`, not `down`. A server that exited is `idle`, because the next request starts it again. With 3 exits in 10 minutes, it is `down`.
- **The URLs of the setting `health`**: a `GET` of each URL. An answer with a status below 500 is good. The default list has the fleet site only: `fleet-site` at `http://127.0.0.1:4731/`.

Each service has a state: `ok`, `slow` (an answer after more than 1 second), `down`, `idle` or `absent`. `headroom services` shows the state, the latency, the start of the state, the last good check and the last error of each service. `--json` gives the list.

```text
SERVICE                  STATE    LATENCY  SINCE (UTC)      LAST OK  LAST ERROR
docker                   ok         12 ms  16:02 (2.7 h)    18:45    -
fleet-site               ok          3 ms  16:02 (2.7 h)    18:45    -
mcp:vex                  down           -  18:41 (4 min)    -        18:45 Error: Cannot find module 'zod'
mcp:loom                 idle           -  16:02 (2.7 h)    -        -
```

- `headroom config health <name> <url>` adds a URL or changes it. `headroom config health <name> --clear` removes one URL.
- `headroom config health --clear` sets the default list again. `headroom config health` shows the list.
- headroom does not restart a service for its health. A person or the session that owns the service decides.

On Windows, `headroom run` puts the job into a job object:

- When the run ends, Windows stops each process that the job started and that still runs. Thus a test server or a search does not stay as an orphan. `--keep` turns this off, for a command that starts a service on purpose.
- `--limit` makes the memory of the lease a hard limit: the job cannot commit more. An allocation above the limit fails, and the job stops with its own error.
- The run writes the peak memory of the job, for example `the job used at most 248 MB of its lease of 300 MB`. The ended lease keeps the peak.
- A browser test (`playwright test`, `cypress run`, or a command that names `e2e`) takes the slot `browser` by itself. Thus one browser test job runs at a time. Two jobs at the same time start many browser processes, and new processes can then fail with `0xC0000142`. A script that runs browser tests inside it, for example a gate, takes the slot with `--slot browser`. `--no-auto-slot` turns it off, and `headroom pool browser 2` lets two run.
- `--mem auto` sizes the lease from the peaks of the last runs of the same job: the 90th percentile and 25% more. The runs of the same holder come first. A job with no run gets 1 GB.

A pool with no capacity is a lock of 1. Set a capacity with `headroom pool cpu 8`.

A queued job can run after the shell that started it stops. `headroom job` gives the state of a job, so a session can wait for the end of the job and read its exit code:

```sh
headroom run --job graph-e2e --log D:\logs\e2e.log -- pnpm e2e
headroom job graph-e2e
headroom job 3f2a9c1e --json
```

```text
headroom: lease 3f2a9c1e for graph-e2e, queued for browser.
graph-e2e (3f2a9c1e) of graph: exited with code 1 at 17:42, waited 12 min, ran 6 min, peak 1.8 GB. Log: D:\logs\e2e.log
```

- `headroom run` writes the lease id and the job first. The release of the lease records the exit code of the job, or the signal that stopped it.
- `--log <file>` sends the output and the errors of the job to the console and to the end of the file. The run makes the file and its folder when they do not exist. The lease records the absolute path.
- `headroom job <name|id>` finds the lease by its id, or by a unique prefix of 8 or more characters of the id. Then it finds the latest lease of the job name. `--holder <h>` uses only the leases of one holder. `--all` gives each match of the last 24 hours.
- The state is `queued` (the lease waits), `running` (the lease is granted) or `exited` (the lease is released, cancelled or expired). A lease that ends with no job exit, for example a lease whose client stopped, has the exit code `null` and a reason.
- `--json` gives `{ id, job, holder, state, exitCode, signal, reason, queuedAt, startedAt, endedAt, waitedMs, ranMs, peakMb, log }`. The times are ISO strings or `null`. The procedure is `resources.job`.
- The command gives the exit code 0 when it finds a job. With no match, it gives the exit code 3, and `--json` writes `{ "error": "no job", "query": "..." }`.
- The store keeps each ended lease for at least 7 days.

A job that writes much data asks for space on a drive with `--disk`. `--disk 5g` asks for space on the drive of the current folder, and `--disk D:=5g` names the drive. The lease waits until the drive has the space. The broker keeps the critical limit of the disk alert free: 5 GB, or 5% of a small drive. A disk lease holds its full amount until its release. A lease that is larger than the drive, or that names a drive that does not exist, is cancelled at once.

```sh
headroom run --disk 5g -- pnpm test
headroom run --disk D:=20g --mem 2g -- node trace.js
```

Set a temp root to give each job its own temp folder:

```sh
headroom config job-temp D:\headroom\tmp
headroom config
```

- `headroom run` makes the folder `<temp root>\<lease id>` before the job starts. The job gets it in `TEMP`, `TMP` and `TMPDIR`. Thus the temp files of a test or a trace go to the Dev Drive, not to `C:`.
- The run removes the folder when the job ends, also when the job fails. The ended lease keeps the size of the folder in `usage.tempMb`.
- `--keep-temp` keeps the folder for debugging. The folder then contains the file `.headroom-keep`, and the daemon does not remove it. Remove it by hand.
- With `--keep`, the job uses the `TEMP` of its parent. A service that the job starts can then use its temp folder after the job ends.
- A client that stops before its release leaves its folder. The daemon removes these folders at its start and every 10 minutes. It removes only a folder directly under the temp root whose name is the id of an ended lease in its store. It does not follow a link or a junction.
- `headroom config job-temp --clear` removes the setting. Without the setting, each job uses the `TEMP` of its parent, as before.

The alerts tell about a problem before the memory runs out. `headroom status` shows them first, and `headroom alerts --watch` writes one line when an alert starts or ends. The alerts only report. They do not stop a process.

| Alert | The condition |
|---|---|
| `runaway` | One process holds more than 4 GB with no lease. Docker and the system are not examined. |
| `orphan` | A process with no owner holds more than 1 GB, and its parent stopped. |
| `memory` | Less than 1 GB of memory is available. |
| `commit` | The commit charge is above 90% of its limit. |
| `desktop` | More than 1000 processes run in the session. The desktop heap can run out, and new processes then fail at their start. |
| `pool` | The non-paged kernel pool is above 3 GB, or the paged pool is above 4 GB, or one of them grew more than 500 MB in one hour. The alert names the pool tags that grow. |
| `disk` | A fixed drive has less than 20 GB free (a warning), or less than 5 GB free (critical). The alert gives the free space that the drive lost in the last hour. It names the 3 owners that wrote most in the last hour, each above 100 MB, for example `Most writes in the last hour: session:graph 31.2 GB, mcp:vex 2.1 GB.` It also names the 3 largest files above 1 GB of the last 2 hours in the home folder, the downloads, the temporary folders and the root of the drive. A drive smaller than 100 GB uses 20% and 5% of its size. |
| `ports` | More than 80% of the dynamic TCP ports are in use (a warning), or more than 95% (critical). When no dynamic port is free, new connections fail. The alert names the 3 owners with the most connections, and the count in `TIME_WAIT`. |
| `service` | A shared service does not answer for 2 checks in a row (one minute): critical for Docker and the MCP servers, a warning for a URL of the setting `health`. An answer after more than 1 second for 3 checks in a row is a warning. The id is `service:<name>`, for example `The Docker engine does not answer since 18:42 UTC (3 min). Containers such as Mongo and the graph tests need it. headroom does not restart it.` An idle MCP server and an absent Docker engine give no alert. |
| `stop` | Another process stopped the daemon, or 2 clients of `headroom run` in 2 minutes. This alert is an event: it stays for 15 minutes. |

On Windows, the daemon reads the kernel pool by pool tag every 5 minutes. A driver marks its allocations with a tag, so the tag that grows names the driver that leaks. `headroom pool-tags --drivers` shows the largest tags, the tags that grew in the last hour, and the driver files that contain each tag. It needs no admin rights and no driver kit.

## The plugin for Claude Code

The plugin `headroom` has a hook for the Bash and PowerShell tools. When a session starts a heavy command (tests, builds, Playwright, Docker builds) and the memory is tight, the hook refuses the command. It gives the session the form under a lease, for example `cd app && headroom run --mem auto -- pnpm test`.

- The memory is tight when less than 4 GB is free for a lease, or when jobs wait.
- The hook does not approve a command. The session sends the new form, and the permission rules of the user apply to it.
- Without a daemon, or for a light command, the hook does nothing. It adds approximately 65 ms to each command.

To turn it on in Claude Code: `/plugin marketplace add C:\Users\markt\git\headroom`, then `/plugin install headroom@headroom`. To turn it off: `/plugin disable headroom@headroom`.

## The dashboard

The daemon serves a dashboard at `http://127.0.0.1:4730/`. `headroom dashboard` opens it in the browser. It shows the alerts and what uses the computer. Then it shows one panel for each resource, the jobs, the owners, the MCP gateway and the pool tags. Its charts show the last hour to the last 7 days.

- The top section shows what uses the computer. One bar shows the memory in RAM by owner, and the free memory. A second bar shows the processors by owner.
- Each owner has the color of its group. The groups are the Claude sessions, the editor, the browser, Docker, the services, Windows, the kernel and the other programs.
- Select a part of a bar, a group or an owner row. The page then marks that owner in the panels and the owner table. Escape removes the mark.
- A line of chips gives the state of each service: the Docker engine, the MCP servers of the gateway and the fleet site.
- The section "Resources" has one panel for each resource of `Status.resources`. These are the drives, memory, commit charge, processors, network, TCP ports, services, slots, kernel pools and desktop. The page makes each panel from the model, so a new resource gets a panel with no change to the page.
- Each panel shows the free part and the capacity in the unit of the resource, and a bar of the used part. It shows a line of the window from `History.resources`, and the change in one hour for a size.
- A panel also shows the active alert of its resource and the leases that hold an amount of it. When the status gives the top users of the resource, the panel shows them. A disk lease shows the temp folder of its job.
- Select a panel to open it to the full width. It then shows a chart of its history in the window, a table of the data and all its users.
- The section "Jobs" shows the leases of the window on a timeline, one line for each holder. A bar is amber while its job waits for room, and blue from its start to its end. A dot at its end gives the exit code.
- The page is one HTML file of approximately 69 KB, with no framework and no build step. The daemon keeps it as one string.
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

Claude Code waits 30 seconds for each MCP server of a session. When many sessions start at the same time, the first start of a server can take more time. `headroom mcp warm` starts the servers before the sessions start:

```sh
headroom mcp warm --timeout 120s
```

- Without names, it starts each configured server. With names, for example `headroom mcp warm loom vex`, it starts only those servers.
- First, it waits until the daemon answers, because the daemon can still start after a logon. Then it waits until each server answers its `initialize` request.
- It shows the servers and the time. The exit code is 0 only when each server runs. Otherwise, the exit code is 1.
- `~/git/start-fleet.ps1` runs it before it starts the sessions of the fleet.

A program that starts only stdio servers, for example the launcher of a plugin, uses the bridge:

```sh
node packages/daemon/src/bridge.mjs vex -- npx -y @mark1russell7/vex-mcp
```

The bridge sends the messages of the session to the gateway. When the gateway does not serve the server, the bridge starts the command after `--`. Thus the same launcher works on a computer without headroom. The bridge uses approximately 30 MB, and it opens a new session after a restart of the daemon.

| Exit code | Meaning |
|---|---|
| The code of the job | The job ran under its lease. |
| 75 | The lease was not granted in time, or it ended before the job started. Or a fixed drive has less than 5 GB free: a full drive stops the builds, the tests and git of all the sessions. Nothing ran. Free space, or start the job again with `--force-disk`. |
| 2 | The command line is not correct. |

## How it is built

- The procedures use `@procedures/client`. The host is `runProcedureHost` of `@procedures/server`, on the runner of `@mark1russell7/service`.
- The database is `node:sqlite`, with one file in WAL mode.
- The daemon is one Node process. Its target is less than 60 MB of memory.

## License

MIT
