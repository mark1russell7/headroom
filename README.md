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
CPU: 11.2 of 16 cores in use (2 kept for Mark). Most: session:graph 6.1, mcp:vex 2.0. Capped: graph-e2e 4 cores.
Process starts: 1,450 a minute. Most (at least): session:client 410 (jobs 12, own commands 398, job e2e: 9,800 so far), session:organizer 120.
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

### The peer of a local connection (H46)

The fleet site serves its procedures as MCP tools to `claude.exe`. Each call needs the fleet role of the caller. The site gets the role from the TCP peer, not from a header. The procedure `resources.peer` gives it:

- The input is `{ localPort, remotePort }`: the two ports that the site sees on its loopback connection.
- The daemon reads the client row of the connection from the IPv4 and the IPv6 table. The two ends must be loopback addresses.
- The output is `{ pid, exe, via, sessionId?, session?, role? }`. `via` gives the process IDs from the peer up to the nearest `claude.exe`.
- A peer with no `claude.exe` above it is anonymous. It has no session and no role. This is not an error.
- The errors are `NO_CONNECTION` (no row for the two ports) and `PEER_GONE` (the process ended before the walk). Linux gives `NOT_SUPPORTED`.
- The role comes from the fleet registry: first by the session ID, then by the session name.
- The registry has the role files `~/git/fleet/registry/roles/<id>.json` and `roles.json`. The file of a role wins over its entry in `roles.json`.

`headroom peer <localPort> <remotePort>` shows the same answer for a check by hand. `--json` gives the JSON. An error gives the exit code 3.

```text
Peer: node.exe (process 8932)
Via: 8932 > 4888 > 23080 > 21804 > 15696 > 25064 (the last is claude.exe)
Session: headroom (19f84d12-fed5-4c42-a6bd-7d856e31cc16)
Role: headroom
```

**The limit.** This attribution is as strong as "the same Windows user". It is not a security boundary. A process of that user can choose its parent with `PROC_THREAD_ATTRIBUTE_PARENT_PROCESS`, and it can write a session file. `docs/RESOURCES.md` gives the details.

### Processors (H23)

headroom watches the cores in use, and keeps some cores for Mark:

- **The CPU alert.** A warning comes when the cores in use stay above 85% of the processors for 5 minutes. A critical alert comes above 95% for 5 minutes.
- The alert names the 3 owners with the most cores, and their leased jobs. It clears after 2 minutes below its line.
- **Runaway trees.** A process tree with no lease that uses more than 4 cores for 10 minutes gives a runaway alert. A tree is the top process of an owner and its child processes.
- **The reserve for Mark.** The cpu amounts of the running leases do not take the last 2 cores. `headroom config cpu-reserve <cores>` changes the count, and `0` turns the reserve off.
- **A hard cap.** `headroom run --cpu 4 --limit` puts the job into a job object that cannot use more than 4 cores.
- **A weight.** Without `--limit`, each job object gets the weight 5 of 9. Thus the leased jobs get equal parts of the processors when they compete.
- **`--cpu auto`** gives the cores from the peak cores of the last runs of the job, with the rule of `--mem auto`. A job with no run gets 2 cores.
- `headroom job` names the peak cores and the cap of a job, for example `peak 3.5 cores, capped at 4 cores`.

The alerts use the reads of the processor times that the daemon already makes each 10 seconds. The 1-minute average at each read gives the time above a line.

### Process starts (H29)

On 2026-10-24, a pool trace showed a leak in the AMD display driver `amdkmdag.sys`. Each new process leaks approximately 0.9 KB of the non-paged pool. With 14 or more new processes each second, the pool grew approximately 800 MB each hour. Until Mark updates the driver (hub ask `amd-driver`), the fleet must start fewer processes. headroom shows who starts them:

- **The computer**: an exact count on Windows. Windows gives each new process the next sequence number. The daemon reads the number of the newest process with `NtQueryInformationProcess(ProcessSequenceNumber)` at each read, every 10 seconds.
- **A leased job**: an exact count. The job object of `headroom run` counts each process of the job (`TotalProcesses`). The client reports the count every 30 seconds and at the release.
- **An owner**: a lower bound. The daemon counts the new processes of each owner at each read. A read every 10 seconds misses most short processes, for example each stage of a Git Bash pipeline.
- **Own commands**: the new processes of an owner outside its leases. The jobs of an owner are the counts of its leases. The holder decides the owner of a job, not the process tree or the name of the job.

The line `Process starts` of `headroom status` gives the starts of the last 10 minutes, in one minute. The owners show their jobs and their own commands. `Status.starts` gives the same data, and the dashboard has a panel `Process starts`.

- The alert `churn` starts a warning when the computer starts more than 600 processes in one minute, as an average over 10 minutes. It names the 3 owners and the 3 leased jobs with the most starts.
- `headroom job <name|id>` and its JSON give `processes`: the processes that the job started so far. The lease keeps the count.
- At its end, `headroom run` writes the count, for example `It started 9800 processes.`
- A parent counts only when it started at or before its child. Windows gives the ID of an ended process to a new process. Thus a child with an old parent ID goes to the owner of its own part of the tree.

On 2026-10-24, this computer started 1,450 processes in one minute. A read every second found only 260 of them, and a read every 10 seconds found 60.

### Spawn-heavy jobs and browser tests (H47)

On 2026-10-24, the Playwright browsers of graph did not start three times, with `0xC0000142`. Two of these runs overlapped bursts of process starts from other leases. The desktop heap, the memory, the commit charge and the kernel pools had room. Thus the burst itself stops the start of a browser.

A spawn-heavy job and a browser test do not run at the same time:

- **The peak.** The lease keeps the highest starts in one minute of its job, over a window of 30 seconds. The counts come from the job object, every 30 seconds and at the release.
- **The past runs.** A job name is spawn-heavy when the peak of its past runs is above the limit. The rule is the rule of `--mem auto`: the 90th percentile of the last 20 runs, the runs of the same holder first.
- **The limit.** The default is 600 starts in one minute. `headroom config spawn-heavy 900` changes it. `headroom config spawn-heavy --clear` sets the default again.
- **A new job.** A job with no past runs is normal. When its own peak goes above the limit, it becomes spawn-heavy at once, and each later browser test waits for it.
- **The queue.** A spawn-heavy lease waits while a browser test runs, and a browser test waits while a spawn-heavy lease runs. A later lease does not go before an earlier waiting lease that it conflicts with.
- Two spawn-heavy jobs can run together. Two browser tests follow the capacity of the slot `browser`.
- **The options.** `--spawn-heavy` marks a new job that starts many processes. `--no-spawn-heavy` marks a job as normal, also when its past runs are above the limit.
- **The sum.** Several moderate jobs together also make a burst. Beside a browser test, the other leases together start at most the limit. Each lease counts its own rate of the last 30 seconds, else its learned peak. A browser test waits while the sum is above the limit. Another lease waits while its rate pushes the sum above the limit.

`headroom status` gives the line `Spawn-heavy now: test-churn (server-stack), 1,870 a minute.` `headroom job` and its JSON give the peak, the average and the class of a job. The dashboard gives them in the timeline of the jobs. A wait gives a reason that names the other job:

```text
waits for the browser tests of graph (pnpm e2e) to end: this job starts many processes (about 1,870 a minute in past runs), and browsers can fail to start beside it
waits for test-churn of server-stack to end: it starts many processes (about 1,870 a minute), and browsers can fail to start beside it
waits for the other jobs to start fewer processes: tsc (client) 400 and vitest (vex) 300 start 700 a minute together, above the limit of 600, and browsers can fail to start beside it
```

These reasons do not start with `waits for memory`, so the hook of the plugin does not count them. `docs/RESOURCES.md` gives the rules.

### Battery and power (H30)

On a laptop, the battery is a resource too. headroom reads it with the processes, every 10 seconds. The read starts no process and no timer:

- **The battery** (`battery`, in Wh): the capacity and the charge from `CallNtPowerInformation(SystemBatteryState)`. It also gives the power source, the charge state, the percent, the rate in W and the minutes left.
- **The power** (`power`, in W): the power of the whole computer from the counter set `Energy Meter` (PDH). The users of the power are an estimate: the CPU power, shared by the processor time of each owner.
- A computer with no battery has no `battery`, and a computer with no counter set `Energy Meter` has no `power`. The values are absent, not 0. Linux and macOS have neither resource.
- Windows tells the daemon when the power source, the percent, the lid or the power mode changes, and when the laptop sleeps or wakes. The daemon then reads the battery at once. If an event does not register, the daemon writes one line to its log and reads every 10 seconds.

The line `Power` of `headroom status` gives the state, for example `Power: on battery, 68%, 18.0 W, 1 h 58 min left (power mode: balanced). Most (estimate): session:server-stack 3.1 W, session:graph 2.4 W.` or `Power: plugged in, charging, 92%.` The dashboard has a panel for each resource and a chip `Power`.

- **Alerts** (kind `battery`): a warning when leased jobs run on battery, with the 3 owners that use the most power. A warning below 30 minutes left. A critical alert below 10 minutes or below 10%. Each alert ends when AC power returns.
- **Efficiency mode**: on battery, `headroom run` puts the processes of its job in EcoQoS, and takes them out of it when AC power returns. The answer of each heartbeat tells the client the power source. `--no-eco` keeps the full speed.
- **Keep awake**: on AC power, while a lease is granted, the daemon holds a power request (`headroom: 2 jobs run`). Thus Windows does not put the laptop to sleep for no input. A lid close still puts the laptop to sleep. On battery, the daemon does not hold the request.
- **Sleep**: after a wake, each lease gets the time of the sleep on its heartbeat. Thus no lease ends because the laptop slept. The rates start again at the wake, and the charts draw no line across the sleep.

On battery below a floor, a heavy job waits. The next section gives this rule and the other conditions of a job (H31).

### Forecasts (H32)

headroom tells the time until each resource reaches a limit, so the fleet acts before the limit. The forecast comes from the history of the last hour:

- **The fit**: the daemon fits a robust line to the points of each instance at each sample, one time each minute. The slope is the median of the slopes of all the pairs of points (Theil–Sen), so one outlier does not move it.
- **The confidence**: Kendall's tau of the points, from 0 to 1. A fit below 0.5 gives no forecast. A fit also needs 30 minutes of points. A sleep, a restart of the computer or a gap of more than 5 minutes starts the fit again.
- **The targets**: the limits of the alerts. A drive gets 20 GB free, 5 GB free and full. A kernel pool gets its alert level. The commit charge gets 90% of its limit. The memory gets 1 GB available. The TCP ports get 80% and 95%.
- **The battery**: on battery, the forecast is the time left that Windows estimates, with no fit.
- The processors, the network, the process starts and the slots have no forecast. A target more than 30 days away gives no forecast.

`headroom forecast` lists the forecast of each instance to its nearest limit, for example `Drive D: 20 GB free in 4 days (at 1.1 GB an hour, confidence 0.65).` `--json` gives the data. `headroom status` adds the line `Forecast (24 h)` with the forecasts under 24 hours. Each card of the dashboard shows its forecast in one line, and `Status.resources` gives the field `forecast`.

- **Alerts** (kind `forecast`): a warning before a limit. A drive reaches its critical level within 24 hours, a kernel pool its alert level within 2 hours, or the commit charge 90% within 30 minutes.
- The message names the rate and the time, for example `Drive C: loses 4.1 GB an hour. At this rate, it has 5 GB free in 3 h 10 min, at 06:40 UTC. Most writes in the last hour: session:graph 3.2 GB.`
- A pool alert names the owners with the most process starts and the pool tags that grow. A commit alert names the owners with the most private memory.
- An active forecast alert ends past 1.25 times its horizon, so a small change of the rate does not end it and start it again.

### Conditions for a job (H31)

Some jobs need a fact of the computer, not an amount. A benchmark needs AC power, because its numbers on battery are wrong. A fan-out of `claude -p` needs room in the usage window. `--when` makes the lease wait until each condition holds:

```sh
headroom run --when ac -- pnpm bench
headroom run --when battery>=50,usage<80 -- pnpm agents
headroom run --timing -- pnpm test:timeouts
headroom run --when "starts<700" -- pnpm e2e
```

| Condition | It holds when |
|---|---|
| `ac` | The laptop is plugged in. A computer with no battery counts as plugged in. |
| `battery>=N` | The battery is at N% or more, or the laptop is plugged in. |
| `usage<N` | The five-hour usage window of Claude is under N%. The data comes from the usage file of the fleet. |
| `starts<N` | The computer starts fewer than N processes in one minute, over the last 2 minutes. The daemon tests it at each read of the processes. |

- **The wait.** The lease waits until each condition holds and its amounts fit. A lease that waits for a condition does not hold the queue: later leases go before it.
- **A power event.** When the charger goes in or out, Windows tells the daemon. The daemon reads the battery and runs the admission at once. Thus a lease that waits for `ac` starts in less than a second.
- **A wrong name.** `headroom run` refuses an unknown condition, with the list of the known conditions. A planned condition names its item: `away` (H33), `cool` (H35), `unmetered` (H39) and `night` (H42).
- **A running job.** A job continues when a condition stops, for example when the charger goes out. The lease records it, and `headroom status` shows `runs without its condition: on battery since 01:20`.
- **`--timing`.** A job that measures time waits for AC power. Its reason tells you to run timing tests in CI. H35 adds `cool` to `--timing`.

**The battery policy.** On battery below the floor, a new heavy lease waits. A lease is heavy when it asks for 2 GB of memory or more, holds the slot `browser`, or is spawn-heavy. `--battery-ok` starts it. `headroom config battery-floor 15` changes the floor, and `0` turns the rule off. The default is 25%.

**The usage data.** `usage<N` reads `~/git/fleet/artifacts/hub/db/usage/current.json`, at most one time in 30 seconds. `headroom config usage-file <path>` changes the file. The condition fails closed:

- A missing or unreadable file stops the job, and the reason names the path.
- Data older than 70 minutes stops the job, and the reason gives its age.
- After the reset time of the window, the old ratio does not apply, so the condition holds.

The reasons do not start with `waits for memory`, so the hook of the plugin does not count them:

```text
headroom: lease 3f2a9c1e for pnpm bench, queued until the laptop is plugged in.
waits until the laptop is plugged in (--timing): timing numbers on battery are wrong, so run timing tests in CI
waits until the battery is at 25% or more, or plugged in (now 18%): this job is heavy (it asks for 4.0 GB of memory). --battery-ok starts it on a low battery
waits until the five-hour usage window is under 80% (now 91%, resets at 02:10)
waits for fresh usage data: the file is 95 minutes old
waits until the computer starts fewer than 700 processes a minute (now 1,108)
```

`headroom job` gives the conditions of a job and a time when it ran without one of them. The timeline of the dashboard draws the wait for a condition as a dashed line, and the time without a condition as a red line. A restart of the daemon for an idle queue does not wait for a lease that waits for a condition. The new daemon keeps the lease.

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
- With `--cpu N`, `--limit` also puts a hard cap of N cores on the job (H23). Without `--limit`, the job object gets the default weight. The run writes the average cores of the job.
- The run writes the peak memory of the job, for example `the job used at most 248 MB of its lease of 300 MB`. The ended lease keeps the peak.
- The run also writes the count of processes that the job started (H29). The lease keeps the count.
- On battery, the run puts the processes of the job in efficiency mode (EcoQoS), and writes one line when the mode changes (H30). `--no-eco` turns this off.
- A browser test (`playwright test`, `cypress run`, or a command that names `e2e`) takes the slot `browser` by itself. Thus one browser test job runs at a time. Two jobs at the same time start many browser processes, and new processes can then fail with `0xC0000142`. A script that runs browser tests inside it, for example a gate, takes the slot with `--slot browser`. `--no-auto-slot` turns it off, and `headroom pool browser 2` lets two run.
- A spawn-heavy job does not run beside a browser test (H47). `--spawn-heavy` and `--no-spawn-heavy` set the class of the job.
- `--when ac,usage<80` makes the job wait for its conditions, and `--timing` makes it wait for AC power (H31). On a low battery, a heavy job waits. `--battery-ok` starts it.
- `--mem auto` sizes the lease from the peaks of the last runs of the same job: the 90th percentile and 25% more. The runs of the same holder come first. A job with no run gets 1 GB.

A pool with no capacity is a lock of 1. Set a capacity with `headroom pool docker 2`. The processors are different: their count is the capacity of `cpu`, and `headroom pool cpu 8` sets a lower cap.

A queued job can run after the shell that started it stops. `headroom job` gives the state of a job, so a session can wait for the end of the job and read its exit code:

```sh
headroom run --job graph-e2e --log D:\logs\e2e.log -- pnpm e2e
headroom job graph-e2e
headroom job 3f2a9c1e --json
```

```text
headroom: lease 3f2a9c1e for graph-e2e, queued for browser.
graph-e2e (3f2a9c1e) of graph: exited with code 1 at 17:42, waited 12 min, ran 6 min, peak 1.8 GB, 412 processes started, at most 380 starts a minute, normal (about 350 a minute in past runs). Log: D:\logs\e2e.log
```

- `headroom run` writes the lease id and the job first. The release of the lease records the exit code of the job, or the signal that stopped it.
- `--log <file>` sends the output and the errors of the job to the console and to the end of the file. The run makes the file and its folder when they do not exist. The lease records the absolute path.
- `headroom job <name|id>` finds the lease by its id, or by a unique prefix of 8 or more characters of the id. Then it finds the latest lease of the job name. `--holder <h>` uses only the leases of one holder. `--all` gives each match of the last 24 hours.
- The state is `queued` (the lease waits), `running` (the lease is granted) or `exited` (the lease is released, cancelled or expired). A lease that ends with no job exit, for example a lease whose client stopped, has the exit code `null` and a reason.
- `--json` gives `{ id, job, holder, state, exitCode, signal, reason, queuedAt, startedAt, endedAt, waitedMs, ranMs, peakMb, processes, peakStartsPerMin, averageStartsPerMin, spawn, log }`. The times are ISO strings or `null`. The procedure is `resources.job`.
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
- A line of chips gives the state of each service: the Docker engine, the MCP servers of the gateway and the fleet site. On a laptop, a chip gives the power source and the charge.
- The section "Resources" has one panel for each resource of `Status.resources`. These are the drives, memory, commit charge, processors, network, TCP ports, services, slots, kernel pools, desktop, process starts, battery and power. The page makes each panel from the model, so a new resource gets a panel with no change to the page.
- Each panel shows the free part and the capacity in the unit of the resource, and a bar of the used part. It shows a line of the window from `History.resources`, and the change in one hour for a size.
- A panel also shows the active alert of its resource and the leases that hold an amount of it. When the status gives the top users of the resource, the panel shows them. A disk lease shows the temp folder of its job.
- The write counters do not name the drive. Thus the drive panels show no users, and one panel "Writes to all drives" follows them with the top writers.
- Select a panel to open it to the full width. It then shows a chart of its history in the window, a table of the data and all its users.
- The section "Jobs" shows the leases of the window on a timeline, one line for each holder. A bar is amber while its job waits for room, and blue from its start to its end. A dot at its end gives the exit code.
- The page is one HTML file of approximately 73 KB, with no framework and no build step. The daemon keeps it as one string.
- The page stops its requests while its tab is hidden. Close the tab, and the dashboard costs nothing.
- The page holds the token of the daemon. Thus only a request to `127.0.0.1` or `localhost` with the key of the dashboard gets the page.
- The key is in `~/.headroom/dashboard.key`, and only this user can read it. `headroom dashboard` opens the page with the key.
- The browser keeps the key. A later visit to `http://127.0.0.1:4730/` in the same browser opens the dashboard.
- A request without the key gets a page with no token. A process that can connect to the port but cannot read the key file thus gets no token.

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
