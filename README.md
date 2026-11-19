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

The jobs that run continue across a restart (H202). `headroom service restart` names them before the stop, and tells which still run after it. A job that ends during the restart keeps its exit code. Its client writes the end to a file in `~/.headroom/ends` before its release, and the new daemon reads that file.

When leases wait for a long time, use `headroom service restart --when-idle` to load a new version. The command does not wait. The daemon restarts itself at its first tick with no waiting lease. `headroom status` shows the restart that waits, and `--cancel` cancels it. During a planned restart, `headroom run` waits for the new daemon.

Run a heavy job under a lease. The job waits until the memory is free. When the daemon does not run, the job runs at once with a warning.

```sh
headroom run --mem 2g -- pnpm test
headroom run --slot docker --mem 1g -- docker compose up -d mongo
```

**The queue (H178).** The leases wait in the order of their priority. A waiting lease gains 1 of priority each minute. A smaller lease that fits can go before a larger first lease, until the first lease waited 10 minutes. After that wait, a later lease goes first only when it cannot delay the start of the first lease:

- The expected run time of a job is the 90th percentile of its last 20 runs with an exit code. The runs of the same holder come first. A job with no such run has no expected run time.
- When the ends of the granted leases give the first lease its room, the broker knows its expected start. A later lease goes first when its expected run ends before that start. It also goes first when it fits in the room that the first lease does not need.
- When no end of a granted lease gives the first lease its room, other processes hold that room, and the start is not known. Then a later lease goes first when its expected run is at most 10 minutes. Thus the first lease starts at most 10 minutes after the room comes back.
- In that case, a later lease with a longer run also goes first when the leases that went first stay in a cap (H187). The cap is the room that the first lease waits for from other processes. Thus the leases that go first at most double that room.
- After 30 minutes of measures, a granted lease holds its measured memory, not its amount (H187). The measured memory is the peak of the job times 1.25, or its use at this time when that is more. Thus a server that asked for 1024 MB and uses 32 MB holds 40 MB. A lease with no process keeps its amount, because the read does not measure it. A job that starts containers keeps its amount until a container counts for its lease (H62).
- A later lease that waits for the first lease tells it in `headroom status`, for example `waits for the first request (pnpm build): its run of 25 min would delay that request`.

See the memory, the free space of the drives, the free amounts, the leases and the memory of each owner:

```sh
headroom status
headroom history --minutes 120
```

The list "Memory by owner" gives the private memory and the memory in RAM of each owner. Its last row, `unattributed`, gives the memory in use that no owner holds (H49):

- A process belongs to its Claude Code session, its MCP server of the gateway, or a group, for example `docker`, `browser`, `editor` or `system`.
- A Node process with `--title=<name>` that Task Scheduler, a service or Explorer starts is the owner `service:<name>`, for example `service:headroom-daemon`.
- On Windows, the minimal processes have their own owners: `system:memory compression`, `system:registry` and `system:secure system`. The Docker VM is in `docker (VM)`.
- On Windows, the file readers of the system have their own owners (H50): `system:search` (Windows Search and its filter hosts) and `system:defender` (the scanner of Microsoft Defender).
- On Windows, some owners have no process: `kernel` (the kernel pools), `kernel:cache` (the system file cache in RAM), `kernel:drivers` (the code of the kernel and of the drivers), `kernel:driver locked`, `kernel:pfn database` and `kernel:page tables`.
- On Windows, one read of `SystemProcessInformation` gives the memory of each process, also of a protected process. The daemon opens no process for it.
- The memory in RAM of a process is its private working set, as the column "Memory" of Task Manager. A page that processes share is in no owner, so it is in `unattributed`.

`headroom status` also gives the top writers and readers of the last hour, the processors in use, the network, the TCP connections and the shared services:

```text
Writes (last hour): session:shop 31.2 GB, mcp:vex 2.1 GB.
Reads (last hour): session:shop 12.4 GB, other 2.7 GB.
CPU: 11.2 of 16 cores in use (2 kept for Mark). Most: session:shop 6.1, mcp:vex 2.0. Capped: shop-e2e 4 cores.
Process starts: 1,450 a minute. Most (at least): session:client 410 (jobs 12, own commands 398, job e2e: 9,800 so far), session:organizer 120.
Network: 1.2 MB/s in, 0.3 MB/s out.
TCP: 812 connections (120 waiting to close), 2% of the dynamic ports.
Services: docker ok (12 ms), local-site ok (3 ms), mcp:vex ok, mcp:loom idle.
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
3000     21512  node.exe                   session:shop           127.0.0.1
5173     30404  node.exe                   session:client         ::1

3 listening ports. Outgoing connections use the dynamic ports 49152-65535, so give a dev server a port below 49152.
```

### The peer of a local connection (H46)

The local site serves its procedures as MCP tools to `claude.exe`. Each call needs the role of the caller. The site gets the role from the TCP peer, not from a header. The procedure `resources.peer` gives it:

- The input is `{ localPort, remotePort }`: the two ports that the site sees on its loopback connection.
- The daemon reads the client row of the connection from the IPv4 and the IPv6 table. The two ends must be loopback addresses.
- The output is `{ pid, exe, via, sessionId?, session?, role?, rolesUnknown? }`. `via` gives the process IDs from the peer up to the nearest `claude.exe`.
- A peer with no `claude.exe` above it is anonymous. It has no session and no role. This is not an error.
- The errors are `NO_CONNECTION` (no row for the two ports) and `PEER_GONE` (the process ended before the walk). Linux gives `NOT_SUPPORTED`.
- The role comes from the role registry: first by the session ID, then by the session name.
- The registry has the role files and `roles.json`. The file of a role wins over its entry in `roles.json`.
- The registry has no default. `headroom config roles-file <path>` sets it. With no setting, the state is `roles unknown`: the output has `rolesUnknown: true` and no role.

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
- **The memory reserve.** A lease waits when its grant leaves less memory than the reserve. The default is 1 GB. A computer with a low-memory line of its own sets the same number with `headroom config memory-reserve <MB>`, so that no grant crosses the line.
- **The reserve for Mark.** The cpu amounts of the running leases do not take the last 2 cores. `headroom config cpu-reserve <cores>` changes the count, and `0` turns the reserve off.
- **A hard cap.** `headroom run --cpu 4 --limit` puts the job into a job object that cannot use more than 4 cores.
- **A weight.** Without `--limit`, each job object gets the weight 5 of 9. Thus the leased jobs get equal parts of the processors when they compete.
- **`--cpu auto`** gives the cores from the peak cores of the last 20 runs of the job: the 90th percentile and 25% more. The runs of the same holder come first. A job with no run gets 2 cores.
- `headroom job` names the peak cores and the cap of a job, for example `peak 3.5 cores, capped at 4 cores`.

The alerts use the reads of the processor times that the daemon already makes each 10 seconds. The 1-minute average at each read gives the time above a line.

### Process starts (H29)

On 2026-10-24, a pool trace showed a leak in the AMD display driver `amdkmdag.sys`. Each new process leaks approximately 0.9 KB of the non-paged pool. With 14 or more new processes each second, the pool grew approximately 800 MB each hour. Until the driver is updated, the sessions must start fewer processes. headroom shows who starts them:

- **The computer**: an exact count on Windows. Windows gives each new process the next sequence number. The daemon reads the number of the newest process with `NtQueryInformationProcess(ProcessSequenceNumber)` at each read, every 10 seconds.
- **A leased job**: an exact count. The job object of `headroom run` counts each process of the job (`TotalProcesses`). The client reports the count every 30 seconds and at the release.
- **An owner**: a lower bound. The daemon counts the new processes of each owner at each read. A read every 10 seconds misses most short processes, for example each stage of a Git Bash pipeline.
- **Own commands**: the new processes of an owner outside its leases. The jobs of an owner are the counts of its leases. The holder decides the owner of a job, not the process tree or the name of the job.

The line `Process starts` of `headroom status` gives the starts of the last 10 minutes, in one minute. The owners show their jobs and their own commands. `Status.starts` gives the same data, and the dashboard has a panel `Process starts`.

- The alert `churn` starts a warning when the computer starts more than 600 processes in one minute, as an average over 10 minutes. It names the 3 owners and the 3 leased jobs with the most starts.
- `headroom job <name|id>` and its JSON give `processes`: the processes that the job started so far. The lease keeps the count.
- At its end, `headroom run` writes the count, for example `It started 9800 processes.`
- A parent counts only when it started at or before its child. Windows gives the ID of an ended process to a new process. Thus a child with an old parent ID goes to the owner of its own part of the tree.
- A parent with no start counts only for a child with no start (H212). The read of the starts comes before the list of the processes. A process with no start started after the read of the starts, so it is not the parent of an older process.

On 2026-10-24, this computer started 1,450 processes in one minute. A read every second found only 260 of them, and a read every 10 seconds found 60.

### Named process starts (H188)

H29 gives the exact count of all the starts, but a read every 10 seconds sees few of them. Thus an owner had only a lower bound, and an alert could not name the program that starts the processes. With H188, the daemon traces the starts on Windows:

- The daemon puts each process of a traced owner in a job object of its own. All the jobs have one completion port. The children of a process go into its job.
- Windows then sends a message for each start and each exit in the tree. A reader thread takes the messages.
- The reader reads the name and the parent of each new process, and keeps a handle until the exit. Thus it gets the exit code, also of a process that lives for 10 ms.
- The jobs have no limit and do not stop their processes. `headroom run --detach` does not need a breakaway from them (H190).
- The jobs of the sessions refuse a breakaway, so the children of Git Bash stay in the trace (H191). The other jobs let a child break away, for example the restart helper of a service.
- By default, the trace follows the sessions, the MCP servers, the services, Docker and the processes under the granted leases. The browsers and the editors of Mark stay out of it.

The line `Traced starts` of `headroom status` comes after the line `Process starts`, for example:

```text
Traced starts: 900 a minute, 90 % of all the starts. 12 a minute failed with 0xC0000142. The trace used 85 ms of processor time a minute, with 12 jobs and 40 live processes.
  Most: session:shop bash.exe > git.exe 600, mcp:vex node.exe > cmd.exe 250, 12 failed.
```

- A source is an owner, a parent program and a program. The line names the sources of 90 % of the traced starts, at most 12.
- The alert `churn` names these sources when the trace has them.
- The resource `procs` gets 2 more instances. `procs:traced` is the traced starts in one minute. `procs:failed` is the starts that failed with `0xC0000142`.
- An owner gets the higher of its two rates: its lower bound from the reads, or its traced starts.
- `headroom config start-trace session,mcp` sets the owner kinds that the trace follows. `off` stops the trace, and `--clear` sets the default again.
- `headroom config start-trace-hold session` sets the owner kinds whose jobs refuse a breakaway (H191). With `off`, each job lets a child break away, also each open job. `--clear` sets the default again: `session`.

Windows refuses a job for a protected process and for a process of another user. The status counts these refusals.

Each restart of the daemon puts one more job around a live process, because a job keeps the port of its first daemon. Windows nests jobs, so the processes go on. The end of this limit: a later step gives the port to the next daemon.

The rule and the measures are in [docs/RESOURCES.md](docs/RESOURCES.md#h188-the-start-trace).

### The start log (H193)

On 2026-11-15 and 2026-11-16, 4 bugchecks stopped this computer. In each dump, a driver stopped Windows in the image load of a new process. That came 251 ms to 525 ms after the creation of the process. A dump gives the pid of the process, but not its program. With H193, the reader of the trace writes each start and each exit to a log on the disk:

- The log is the SQLite file `~/.headroom/starts.db`, with the pragma `synchronous` FULL. A commit is on the disk when it ends, so the rows stay after a bugcheck.
- The reader commits each row at most 100 ms after the message of the job.
- A start row has the pid, the parent, the creation time, the program, the command line and the command line of the parent. The creation time is a FILETIME, as in a dump.
- A start row also has the time since a traced process with the same pid ended, when that time is less than 60 s.
- A row that comes more than 1 s after the creation of its process is an adoption. The process ran before the trace put it in a job, for example at the start of the daemon. The counts, the lag and the ranking do not count an adoption.
- The log keeps 24 hours, counted back from its newest row.
- After an unclean stop, the daemon writes the starts of the last 2 minutes before the stop to `~/.headroom/starts-before-<time>.json`.

The command `headroom starts` reads the file, so it needs no daemon:

- `headroom starts <pid> --at <time>` gives the program, the command line, the exit and the parents of the pid of a dump.
- `headroom starts --top --hours 1` ranks the starters of the last hour, by program and by the command line of the parent. `--hours 24` gives the day.
- `--json` gives the rows as data.

Each start is one more chance for the bug of the driver, so the fleet cuts the top starters. The line `Start log` of `headroom status` gives the count of the starts and of the adoptions. It also gives the longest time from the creation of a new process to its row on the disk.

The limits: the log has only the processes of the trace. A reuse of a pid shows only when the trace saw the exit of the old process. Thus the log cannot prove that no reuse came.

The rule and the measures are in [docs/RESOURCES.md](docs/RESOURCES.md#h193-the-start-log).

### Spawn-heavy jobs and browser tests (H47)

On 2026-10-24, the Playwright browsers of shop did not start three times, with `0xC0000142`. Two of these runs overlapped bursts of process starts from other leases. The desktop heap, the memory, the commit charge and the kernel pools had room. Thus the burst itself stops the start of a browser.

A spawn-heavy job and a browser test do not run at the same time:

- **The peak.** The lease keeps the highest starts in one minute of its job, over a window of 30 seconds. The counts come from the job object, every 30 seconds and at the release.
- **The past runs.** A job name is spawn-heavy when the peak of its past runs is above the limit. The peak is the 90th percentile of the last 20 runs. The runs of the same holder come first.
- **The limit.** The default is 600 starts in one minute. `headroom config spawn-heavy 900` changes it. `headroom config spawn-heavy --clear` sets the default again.
- **A new job.** A job with no past runs is normal. When its own peak goes above the limit, it becomes spawn-heavy at once, and each later browser test waits for it.
- **A quiet job.** A job stops being spawn-heavy when no 30-second window of its last 5 minutes is above the limit. So one burst at the start of a server does not hold the browser tests for the whole run of the server. A new burst makes the job spawn-heavy again. A job with `--spawn-heavy` keeps its class.
- **The queue.** A spawn-heavy lease waits while a browser test runs, and a browser test waits while a spawn-heavy lease runs. A later lease does not go before an earlier waiting lease that it conflicts with.
- Two spawn-heavy jobs can run together. Two browser tests follow the capacity of the slot `browser`.
- **The options.** `--spawn-heavy` marks a new job that starts many processes. `--no-spawn-heavy` marks a job as normal, also when its past runs are above the limit.
- **The sum.** Several moderate jobs together also make a burst. Beside a browser test, the other leases together start at most the limit. Each lease counts its own rate of the last 30 seconds, else its learned peak. A browser test waits while the sum is above the limit. Another lease waits while its rate pushes the sum above the limit.

`headroom status` gives the line `Spawn-heavy now: test-churn (server-stack), 1,870 a minute.` `headroom job` and its JSON give the peak, the average and the class of a job. The dashboard gives them in the timeline of the jobs. A wait gives a reason that names the other job:

```text
waits for the browser tests of shop (pnpm e2e) to end: this job starts many processes (about 1,870 a minute in past runs), and browsers can fail to start beside it
waits for test-churn of server-stack to end: it starts many processes (about 1,870 a minute), and browsers can fail to start beside it
waits for the other jobs to start fewer processes: tsc (client) 400 and vitest (vex) 300 start 700 a minute together, above the limit of 600, and browsers can fail to start beside it
```

These reasons do not start with `waits for memory`, so the hook of the plugin does not count them. `docs/RESOURCES.md` gives the rules.

### The start cap (H197)

A lease also waits while the computer starts too many processes. All 5 bugchecks of 2026-11-15 to 2026-11-17 came when the start rate was in its highest 8 %.

- **The sum.** The starts of the computer in the last 2 minutes, plus the expected rate of this job. Each new lease also adds the part of its starts that the window does not hold yet.
- **The cap.** The default is 3,500 starts a minute, and 1,822 in the first hour after a boot. `headroom config start-cap 2000@0,3000@60m` sets other steps. `off` turns the cap off, and `--clear` sets the default again.
- **The expected rate.** The learned peak of the job (H47). A job with no runs counts as the 90th percentile of the last 200 first runs of other jobs.
- **No wait.** A light job, at most 1 % of the cap, does not wait. After 10 minutes, a lease stops counting its own rate. Then it starts when the computer and the new leases are under the cap.
- A job that runs is not slowed or stopped. The cap changes no setting of the system.

```text
Start cap: 3,500 a minute. The computer starts 2,246 a minute. 2 leases wait for it.
waits for the start cap: the computer starts 3,100 a minute, new jobs add 400 and this job adds 600. The sum of 4,100 is above the cap of 3,500.
```

`docs/RESOURCES.md` gives the data of the default values and their limits.

### Handles and orphans (H48)

On 2026-10-25, a subagent started `find / -name ... | head -3` in Git Bash. The Bash call ended after 2 minutes, but `find.exe` stayed as an orphan. It held 1.3 million handles, and the paged pool grew 593 MB in one hour. The daemon gave no alert, and after a restart it did not know the owner. Thus headroom watches the handles and keeps the owners of orphans:

- **The handles.** The daemon reads the handles of each process in the call that gives the processor times. It starts no process and no timer.
- **The alert `handles`.** A warning comes when one process holds more than 100,000 handles, or gains more than 20,000 handles in 5 minutes. Above 500,000 handles, the alert is critical.
- The alert names the process, its handles and their gain in one minute, its age, its owner and its command line. It ends when the process ends, or after 2 minutes under its line.
- headroom does not stop the process. The owner stops it by its process ID.

### Orphans that a session stops (H183)

On 2026-11-15, a `grep.exe` over the transcript of a session stayed after its shell ended. It held 1.5 GB of private memory for 3.5 hours. `headroom reap` lists such processes, and it stops a process only for its own session:

```sh
headroom reap            # each process of a session whose parent is proven gone
headroom reap --all      # also the orphans that no session started
headroom reap 27308      # stop a process of your session
headroom reap --shadow   # the processes that a later automatic rule stops
headroom reap --log      # the stops and the requests
```

- A row has the process ID, the private memory, the age, the session and the command line. `(yours)` marks a process of your session.
- For a process of another session, headroom does not stop it. It records a request and shows it in `headroom alerts`. headroom has no path that sends a notice to one session.
- A process of a session that ended needs the owner of the machine. headroom records it in the same way.
- The shadow log records each reader with no parent that reads the files of a session: grep, rg, sort, findstr or cat. It records the reader when it holds more than 500 MB for more than 30 minutes. No rule stops a process in this version.
- `headroom config reap-auto on|off` is the setting of the later automatic mode. Off is the default, and in this version on stops no process.

The rule and the tables are in [docs/RESOURCES.md](docs/RESOURCES.md#h183-headroom-reap-and-the-shadow-log).

### The system file cache (H50)

On 2026-10-25, the available memory fell two times while no job used much memory. The system file cache grew from 0.5 GB to 10.1 GB in some minutes, and the available memory stayed near 1 GB for 22 minutes. Then the reaper of Claude Code stopped jobs. Windows Search read 350 MB each second from the files of the sessions on `D:`, and Defender scanned them.

- **The cause.** The system file cache holds the pages of the open files and the metadata of the file system. Windows does not count these pages as available memory, and it trims them slowly. The standby list is a different list: it is available memory.
- **The alert `cache`.** A warning comes when the cache holds 4 GB or more and less than 6 GB of memory is available. Below 1 GB available, the alert is critical. It ends when the cache falls below 3 GB, or when more than 8 GB is available.
- The alert names the owners that read most and wrote most in the last hour. The daemon counts the reads of each owner from the same process read as the writes. The count includes the reads from the cache and from pipes.
- **The owners.** `system:search` and `system:defender` show the work of the indexer and the scanner in the lists of owners.
- **The alert `reader` (H192).** An owner of the kind `system` or `other` can read 50 GB or more in the last hour. When less than 2 GB of memory is available then, a warning comes. The alert names the processes of the owner that read most in the last minute. For Windows Search and Defender, it also gives the next step. headroom does not stop them. The alert ends when the reads fall below 37.5 GB, or when more than 2.7 GB is available. `headroom config alerts readerMb 0` turns it off.
- **The jobs.** Run jobs that read many files (a wide grep, a build of many repos) with `headroom run --slot files`. Only one job holds the slot `files` at a time.
- headroom does not trim the cache. A trim needs a privilege that the daemon does not have. `docs/RESOURCES.md` gives the commands for an admin shell.
- **The owner records.** At the first read of a process, the daemon records its owner, its full command line and its start. It also records its parent with the start of the parent, and its session. The record keeps the owner after the parent ends.
- **No secret in a stored text (H186).** Before the daemon stores or shows a command line or the name of a job, it puts the mark `[secret]` in place of each secret. An example: `curl -u admin:[secret] https://...`. The rest of the text does not change.
- An orphan shows as `<owner> (orphan)`, with the owner of its record, in the owners of `headroom status`, of the dashboard and of each resource. Only an owner that started the tree goes to the processes under the orphan: a session, an MCP server or a service (H185). The owner of a rule, for example `system` for Explorer, does not: a browser that Explorer started stays `browser`. The runaway alerts of the memory and the CPU (H23) add `(orphan)` to the owner of each orphan, also `other (orphan)`.
- The store keeps the records of the processes that live for more than one minute. Thus a restart of the daemon keeps the owners of the orphans. The record of an ended process goes away at the next read.
- `headroom status` gives the sum of the handles, for example `Handles: 200,020 in all`. When one process is above 100,000 handles, it also names the 3 processes with the most handles.

```text
ALERT since 05:40 UTC: find.exe (pid 27056) holds 1,313,105 handles, +40,000 a minute. It started 44 min ago. Owner: session:server-stack tools (orphan, parent ended). Command: find / -name WIRE-PROTOCOL.md -path *procedures*. The owner stops it by its pid.
```

### Battery and power (H30)

On a laptop, the battery is a resource too. headroom reads it with the processes, every 10 seconds. The read starts no process and no timer:

- **The battery** (`battery`, in Wh): the capacity and the charge from `CallNtPowerInformation(SystemBatteryState)`. It also gives the power source, the charge state, the percent, the rate in W and the minutes left.
- **The power** (`power`, in W): the power of the whole computer from the counter set `Energy Meter` (PDH). The users of the power are an estimate: the CPU power, shared by the processor time of each owner.
- A computer with no battery has no `battery`, and a computer with no counter set `Energy Meter` has no `power`. The values are absent, not 0. Linux and macOS have neither resource.
- Windows tells the daemon when the power source, the percent, the lid or the power mode changes, and when the laptop sleeps or wakes. The daemon then reads the battery at once. If an event does not register, the daemon writes one line to its log and reads every 10 seconds.

The line `Power` of `headroom status` gives the state, for example `Power: on battery, 68%, 18.0 W, 1 h 58 min left (power mode: balanced). Most (estimate): session:server-stack 3.1 W, session:shop 2.4 W.` or `Power: plugged in, charging, 92%.` The dashboard has a panel for each resource and a chip `Power`.

- **Alerts** (kind `battery`): a warning when leased jobs run on battery, with the 3 owners that use the most power. A warning below 30 minutes left. A critical alert below 10 minutes or below 10%. Each alert ends when AC power returns.
- **Efficiency mode**: on battery, `headroom run` puts the processes of its job in EcoQoS, and takes them out of it when AC power returns. The answer of each heartbeat tells the client the power source. `--no-eco` keeps the full speed.
- **Keep awake**: on AC power, while a lease is granted, the daemon holds a power request (`headroom: 2 jobs run`). Thus Windows does not put the laptop to sleep for no input. A lid close still puts the laptop to sleep. On battery, the daemon does not hold the request.
- **Sleep**: after a wake, each lease gets the time of the sleep on its heartbeat. Thus no lease ends because the laptop slept. The rates start again at the wake, and the charts draw no line across the sleep.

On battery below a floor, a heavy job waits. The next section gives this rule and the other conditions of a job (H31).

### GPU (H36)

The GPU of this laptop, a Radeon 860M, uses the main memory. headroom reads the GPU with the processes, every 10 seconds. The read starts no process and no timer:

- **The GPU** (`gpu:<n>`, in MB): one instance for each adapter. The used part is the dedicated and the shared GPU memory, from the counter set `GPU Adapter Memory` (PDH).
- **The limits** come from DXGI, one time at the start: the dedicated memory and the shared limit, as Task Manager shows them. On this laptop, they are 4.0 GB and 13.8 GB.
- **The owners.** The counters `GPU Process Memory` and `GPU Engine` give the GPU memory and the engine use of each process. Each process goes to its owner, as for the memory.
- **The use** is the use of the busiest engine, as Task Manager shows it. `headroom gpu` also gives the use of each family: 3D, compute, copy and video.
- **The leases.** The status gives the GPU memory of each leased job. The lease keeps its peak, and `headroom job` gives it, for example `peak GPU 900 MB`.
- An adapter that DXGI does not list, for example an NPU, gets its LUID as its name. Its shared limit is half of the RAM, the default of Windows.
- A computer with no GPU counters has no `gpu` instance. Linux and macOS have none.

The line `GPU` of `headroom status` gives the state, for example `GPU: 1.3 of 17.8 GB (0.3 GB in RAM), 34% busy. Most: session:shop chrome.exe 820 MB.` `headroom gpu` gives each adapter, its owners and the leased jobs, and `--json` gives `Status.gpu`. The dashboard has a panel for each adapter.

- **The alert** (kind `gpu`): a warning when the GPU memory of an adapter stays above 90% of its limits for 2 minutes. The alert names the 3 owners with the most GPU memory. It ends after one minute below the line.
- **No amount.** A job object has no GPU limit, so a lease has no GPU amount.
- **The memory.** Shared GPU memory is in the RAM. Windows already counts it in the available memory and in the commit charge, so `memory` does not subtract it again. `docs/RESOURCES.md` gives the measurement.

### Docker inside (H38)

Docker Desktop keeps its containers in one VM. Windows shows the VM as one process, `vmmemWSL`. Thus headroom asks the Docker engine for each container:

- **The read.** Every 30 seconds, the daemon sends GET requests to the pipe of the engine: the list of the containers and one-shot stats of each running container. It starts no `docker` process and no timer.
- **The memory** of a container is its use less its inactive file cache, as `docker stats` gives it. **The cores** come from the change of its processor time between two reads.
- **The disk use**: every 10 minutes, `GET /system/df` gives the images, the images with no container, the build cache, the volumes and the writable layers.
- **The owner** of a container is the session of its compose project. The folder of the project in a folder of a role gives `session:<role>`. A project with the name of a role also gives that role. Else the owner is `docker:<project>` or `docker:<name>`.
- **No roles file.** With no setting `rolesFile`, the state is `roles unknown`. Each container then has the owner `docker:<project>` or `docker:<name>`. `headroom docker` writes a line about the state. headroom does not flag or stop a container because of this state. It stops no container in any state.
- **The split.** In the memory and the CPU of the owners, the containers get their part of the owner `docker`. The rest is `docker (VM)`: the VM, its cache and the Docker programs of Windows.
- **The VM memory.** `vmmemWSL` gives no memory counters to `K32GetProcessMemoryInfo`. The sampler reads its memory from `SystemProcessInformation`, as for each process (H49). The split moves a part of the VM memory to the containers, so the VM counts one time.
- No pipe or no answer: no Docker read and no split. The log of the daemon gets one line for each change of the state of the engine.

The line `Docker` of `headroom status` gives the state, for example `Docker: 1 container, 0.6 GB, 0.55 cores. Most: session:shop shop-mongo-1 0.6 GB. Build cache 17.1 GB. Unused images 26.2 GB`. `headroom docker` gives each container with its owner, memory, cores and state, the VM, the disk use and the cost of the reads. `--json` gives `Status.docker`. The dashboard has one card, after the card of the Docker engine.

- **The alerts** (kind `docker`): a warning when the build cache is above 20 GB, or the images with no container are above 10 GB. The message gives the size and the prune commands.
- headroom does not prune, stop or start a container, an image or Docker. `docker builder prune` or `docker image prune` frees the space.
- **The cost** on this laptop: the list and the stats take approximately 60 ms, with no measurable CPU in the daemon. The disk read takes approximately 5 s in the engine and 15 ms of CPU in the daemon, one time each 10 minutes.

### A lease that uses more than it states (H62)

A job states its memory with `--mem`. headroom compares the use of each granted lease with that amount:

- **The use** of a lease is the private memory of its job tree, plus the memory of its containers. **The peak** is the largest use since the grant.
- **The alert** (kind `over`): a warning when the peak of a lease is 2 times its amount or more, and at least 1 GB above it. The message names the 3 largest excesses and the containers of each lease.
- `headroom status` gives the use on the row of each lease, for example `memory 500 MB  uses 3.3 GB with 1 container, peak 3.3 GB, over: 6.6 times its amount`. `--json` gives `Status.leaseUse`.

**The containers of a lease.** Docker keeps the memory of a container in its VM, not in the tree of the job that started it. Thus headroom gives each running container to one lease at most:

1. **The label.** `headroom run` gives each job the variable `HEADROOM_LEASE`, with the ID of its lease. To give a container to its lease, set the label `headroom.lease` from this variable:

   ```yaml
   services:
     db:
       image: mongo:7
       labels:
         headroom.lease: ${HEADROOM_LEASE:-}
   ```

   A container with this label counts for the lease that it names. A label of a lease that ended counts for no lease.
2. **The folder.** With no label, a container counts for a lease when three facts hold. The folder of its compose project is the folder of the job, or a folder in it. The job tree has a container client, for example `docker`. The container started after the grant of the lease.
3. **One lease.** When two leases match, the container counts for neither. The home folder and a root folder are too wide for the folder rule.

- A job tree with a container client and no container of its lease has no measure. Its lease then holds its full amount (H187).
- **A detached start.** `docker compose up -d` ends after the start, and its lease ends with it. The containers then count for no lease. The hold of the lease covers only the start.

**A container start waits for room.** The hook rates a container start as heavy: `docker run`, `docker start`, `docker restart`, and `docker compose up`, `start`, `run` or `restart`. The same rule applies to `docker-compose`, `podman` and `nerdctl`. Below 4 GB free, or while a job waits for memory, the hook tells the session to send the command under a lease. `headroom run --mem 3g -- docker compose up -d` then waits until 3 GB is free.

**The peaks of large processes.** The minute sample keeps the memory of each owner at one read. Thus a process that grows and ends between two samples leaves no trace there. Each read of the processes, every 10 seconds, also gives each process and each running container of 512 MB or more to a tracker. The store keeps the largest amount of each holder in each minute for 7 days, with its owner, its lease and its command line. One minute keeps the 30 largest holders.

- `headroom peaks` gives each holder with its largest minute, the largest first. `--minutes 1440` sets the window, `--min 2g` sets the least peak, and `--lease <id>` keeps one lease.
- `--key <key>` gives the minutes of one holder. Add `--container` for the key of a container. `--json` gives the answer of the procedure `resources.peaks`.
- The memory of a container is in the VM of Docker, so the VM process is also a large process. The rows are peaks, not a sum.

### Forecasts (H32)

headroom tells the time until each resource reaches a limit, so the sessions act before the limit. The forecast comes from the history of the last hour:

- **The fit**: the daemon fits a robust line to the points of each instance at each sample, one time each minute. The slope is the median of the slopes of all the pairs of points (Theil–Sen), so one outlier does not move it.
- **The confidence**: Kendall's tau of the points, from 0 to 1. A fit below 0.5 gives no forecast. A fit also needs 30 minutes of points. A sleep, a restart of the computer or a gap of more than 5 minutes starts the fit again.
- **The targets**: the limits of the alerts. A drive gets 20 GB free, 5 GB free and full. A kernel pool gets its alert level. The commit charge gets 90% of its limit. The memory gets 1 GB available. The TCP ports get 80% and 95%.
- **The battery**: on battery, the forecast is the time left that Windows estimates, with no fit.
- The processors, the network, the process starts and the slots have no forecast. A target more than 30 days away gives no forecast.

`headroom forecast` lists the forecast of each instance to its nearest limit, for example `Drive D: 20 GB free in 4 days (at 1.1 GB an hour, confidence 0.65).` `--json` gives the data. `headroom status` adds the line `Forecast (24 h)` with the forecasts under 24 hours. Each card of the dashboard shows its forecast in one line, and `Status.resources` gives the field `forecast`.

- **Alerts** (kind `forecast`): a warning before a limit. A drive reaches its critical level within 24 hours, a kernel pool its alert level within 2 hours, or the commit charge 90% within 30 minutes.
- The message names the rate and the time, for example `Drive C: loses 4.1 GB an hour. At this rate, it has 5 GB free in 3 h 10 min, at 06:40 UTC. Most writes in the last hour: session:shop 3.2 GB.` A drive message ends with the hint of H21.
- A pool alert names the owners with the most process starts and the pool tags that grow. A commit alert names the owners with the most private memory.
- An active forecast alert ends past 1.25 times its horizon, so a small change of the rate does not end it and start it again.

### The alert limits (H179)

Each limit of the alerts has a default, for example 1 GB of available memory. A computer with its own lines sets them in the store:

```sh
headroom config alerts availableMb 3072          # a memory warning below 3 GB available
headroom config alerts availableCriticalMb 2048  # a critical memory alert below 2 GB available
headroom config alerts diskWarnMb 15360          # a disk warning below 15 GB free
headroom config alerts availableCriticalMb --clear
headroom config alerts                           # the limits that differ from the defaults
headroom config alerts --clear                   # all the defaults again
```

- The names are the fields of `AlertRules`. A limit is a value of 0 or more. A ratio is at most 1, and a percent is at most 100.
- A warning must not go past its critical limit. For a free amount, the warning limit is the larger one.
- The memory alert has no critical level by default. With `availableCriticalMb`, the memory alert gives its level in `severity`, and the forecast gets a second target.
- The next read of the processes, 10 seconds or less later, uses the new limits.

### What uses the space, and a safe cleanup (H21)

`headroom disk report` shows what uses the space of each drive. `headroom disk clean` removes only the data that is disposable by definition. All other data goes to Mark.

```sh
headroom disk report                     # the known places, 30 seconds
headroom disk report --drive C: --deep   # also the largest folders to depth 3, 3 minutes
headroom disk clean                      # a dry run: what the cleanup deletes
headroom disk clean --apply              # delete it, and log each delete
```

- The report runs in the process of the command, not in the daemon. It sizes a fixed list of places: the free space of each drive and the temp folders.
- The list also has the temp folders of the jobs (live or not), the pnpm store, the npm cache, the Playwright browsers and the VS Code caches.
- It also sizes the disk images of Docker Desktop and WSL, the Recycle Bins, `~/.claude/projects` and `node_modules` of each repository in `~/git`.
- It lists each `*.before-devdrive` copy and marks it `kept`. Only Mark decides about these copies.
- `--deep` adds the largest folders under the home folder and the root of each drive other than the system drive, to depth 3.
- The walk does not follow a symbolic link, a junction or another reparse point. A file with two hard links counts one time.
- The quick report has 30 seconds, and `--deep` has 3 minutes. A place whose time runs out gets a lower limit, marked `partial`.
- The report saves itself to `~/.headroom/disk-report.json`. The dashboard shows its time and its largest places. `--json` gives the full report.

`headroom disk clean` is a dry run. With `--apply`, it deletes only 3 kinds of data:

1. The temp folders of the jobs whose lease ended. The daemon tells the state of each lease. With no answer, the cleanup removes no folder.
2. The trace files directly in the temp folder of the user and in the temp root, 7 days or older. These are `node_trace.*.log`, `*.cpuprofile`, `*.heapsnapshot`, `*.heapprofile` and the Playwright temp folders.
3. `pnpm store prune`, only when no lease is live, no pnpm process runs, and less than half of the store has one hard link.

- pnpm counts a store file with one hard link as unused. On a Dev Drive, pnpm uses block clones, so each file has one link. A prune then removes almost the whole store.
- Each other place of 1 GB or more goes to the list "Ask Mark", with its size and the steps to free it. The cleanup deletes none of them.
- The cleanup refuses each path with `.before-devdrive` in it, each disk image and each path in `~/git`. It does not touch the temp folder of a live job.
- `~/.headroom/disk-clean.log` gets one line for each delete: the time, the kind, the size and the path.
- The disk alert and the disk forecast alert end with the hint `Run headroom disk report to see what uses the space.`

### The git worktrees of the sessions (H175)

Agent sessions make a git worktree for each task. Each worktree has its own `node_modules`, from 0.15 GB to 0.35 GB. On 2026-11-08, 654 worktrees filled a drive of 195 GB.

On Windows, `git worktree remove` fails partway with "Filename too long". The paths in `node_modules/.pnpm` are longer than 260 characters. `fs.rmSync` deletes them with no error. `headroom worktree` keeps the worktrees cheap, and removes them safely.

```sh
headroom worktree list                     # the state of each worktree, with counts for each repository
headroom worktree list --sizes             # also the size of node_modules
headroom worktree clean --dry-run          # the plan of the cleanup, also in ~/.headroom/worktree-plan.json
headroom worktree clean                    # one batch: at most 20 trees
headroom worktree remove <path>            # remove one tree after its merge
```

- The default root is the real folder of `~/git`. `--root <folder>` sets a different root. You can give more than one.
- For each main checkout directly under a root, `git worktree list --porcelain` gives its worktrees. These can be in any folder.
- A tree is idle when its top entries, its git `HEAD` and its git `index` did not change in 24 hours. `--idle` sets a different time. `node_modules` does not count.

Each linked worktree has one state:

| State | The condition | What `clean` does |
|---|---|---|
| `active` | A change in the idle time. | Nothing. |
| `removable` | Idle, no changes, and each commit is on a remote. A removal loses nothing. | It deletes each `node_modules` folder, then starts `git worktree remove`. |
| `keep` | Idle, with changes or commits that are not on a remote, or locked. | It deletes only the `node_modules` folders. The owner decides about the rest. |
| `broken` | git marks it prunable, or its folder does not exist. | `git worktree prune` in its main checkout. |
| `orphan` | A folder `<repo>-*` next to a main checkout, or in a `<repo>-*wt` folder, with files, that git does not list. | Nothing. Only its owner decides. |

- The changes come from `git status --porcelain --untracked-files=normal`. The ignored files, for example `node_modules`, do not count.
- The commits that are not on a remote come from `git rev-list --count HEAD --not --remotes`.
- When git cannot give a fact, the tree is `keep`.
- The removal keeps the local branch.

The steps of a removal:

1. The removal examines the tree again. It refuses a tree with changes, with commits that are not on a remote, or with a lock.
2. It finds each `node_modules` folder in the tree, also in each package of a workspace. The search does not go into a `node_modules` folder, and does not follow a link or a junction.
3. It deletes each of these folders that git ignores, with `fs.rmSync`.
4. It starts `git worktree remove` with no `--force`. Thus git refuses a tree with changes.
5. When git fails and still lists the tree, the removal stops. When git does not list the tree, the removal deletes the rest of the folder. Step 1 examined the tree before the removal started.

The rules of safety, with a test for each:

- No step removes a main checkout, or a folder that holds one.
- No step acts on a path outside the roots.
- No step uses `--force` with `git worktree remove`.
- No step deletes an orphan. `list` and `clean` show its size and the time of its last change.

`headroom worktree remove <path>` is the command for a session after its merge. Use it in place of `rm -rf` or `git worktree remove --force`.

- It refuses with exit code 1 a tree with changes, with commits that are not on a remote, or with a lock. Then it changes nothing.
- It does not wait for the idle time.
- Start it from a folder outside the tree. Windows cannot delete a folder in use.

A deletion fills the file cache of the system, and so it takes memory. Thus the cleanup works in batches:

- One run changes at most 20 trees. `--max` sets a different count.
- It waits 5 seconds between two trees. `--pause` sets a different time.
- Before each tree, it reads the available memory, as the daemon does. When less than 2 GB is available, the run stops. `--min-free-mem` sets a different level, and `0` turns the check off.
- A refusal, and a tree with no work, do not count.
- A dry run changes nothing, and shows the whole plan. The limits do not apply to it.

The daemon writes a plan before it removes a tree:

1. The daemon starts a dry run when no plan in the file has the key of its rules (H198). The key is a hash of the code of the rules, the roots and the idle time.
   - Thus the first start of the daemon starts a dry run. A change of a rule or of a setting of the scan also starts one.
   - A restart, or a new version with the same rules, starts no dry run.
   - The dry run writes the plan to `~/.headroom/worktree-plan.json`, with its key and the version of the daemon. The note `worktree:plan` gives its counts.
   - A dry run that writes no plan with the key starts again at most one time each hour.
2. The setting `worktreeAutoClean` is off by default. While it is off, the daemon only writes a new plan, 24 hours after the time of the last plan in the file.
3. Read the plan. Then start the removals with `headroom config worktree-auto-clean on`.
4. While the setting is on, the daemon starts `headroom worktree clean` in a child process one time each 24 hours. It also starts it when a drive of a root has less than 20 GB free, at most one time each hour.
5. When a run stops before the end, the next check of the daemon, 5 minutes later, starts the next batch. This continues until the cleanup has no more trees.
6. The scan of each run of the daemon waits 500 ms between the starts of two git commands. On Windows, each git command starts 2 or 3 processes.
   A scan of 555 trees with no wait started 5,156 processes in 45 s on 2026-11-17. `--git-gap` sets the wait of a run from the command line. The default there is 0.

- The cleanup writes its counts to `~/.headroom/worktrees.json`, and one line for each action to `~/.headroom/worktree-clean.log`.
- When more than 100 trees are `keep`, the alert `worktree:keep` names the 3 repositories with the most.

### Heat and throttling (H35)

When heat or a power limit slows the CPU, timing tests and benchmarks give wrong numbers. Such jobs wait for a cool CPU, and headroom names the owners that make the heat.

- **The reads**: PDH gives the speed limit, the speed and the nominal frequency of the CPU. It also gives the temperature, the passive limit and the throttle reasons of each thermal zone.
- The counters are in the PDH query of the Energy Meter. The read comes with the read of the processes, every 10 seconds, with no new process and no timer.
- **The resource** (`thermal`, in %): the free part is the speed that the limits permit. The used part is the part that a limit takes.
- **Throttled**: a speed limit under 90% (a limit over 10%), or a passive limit under 100% in a thermal zone, for 30 seconds.
- **Hot**: a thermal zone at 98 °C or more, or a zone with a passive limit.
- A missing counter gives `null`. A computer with none of the counters has no `thermal`. Linux and macOS have no reads.

`headroom thermal` prints the reads, the state, the condition `cool` and the owners. `--json` gives the data. `headroom status` adds a line only when the CPU is throttled or hot, for example `Heat: the CPU runs at 62% of its speed since 14:02: a power or heat limit.`

- **Alert** (kind `heat`): a warning after 5 minutes of throttle. It ends after 2 minutes with no throttle.
- The message names the speed, the cause and the 3 owners with the most cores, with their power as an estimate and their leased jobs.
- **The condition `cool`**: it holds when the CPU was not throttled in the last 2 minutes. `--timing` waits for `ac` and `cool`.
- A wait gives the limit, for example `waits until the CPU runs at full speed (now 62%, a power or heat limit)`.
- The dashboard has a chip `Heat` and a panel "CPU speed and heat".

On this laptop on 2026-10-25, all six counters gave values. The CPU had no limit (100%) and ran at 190% to 204% of its nominal 2.0 GHz. The zone `\_TZ.THM0` was at 86 °C to 100 °C.

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
| `usage<N` | The five-hour usage window of Claude is under N%. The data comes from the usage file. Set the file with `headroom config usage-file <path>`. |
| `starts<N` | The computer starts fewer than N processes in one minute, over the last 2 minutes. The daemon tests it at each read of the processes. |
| `away` | Mark is away from the laptop (H33). A computer with no read of the presence counts as away. |
| `cool` | The CPU was not throttled in the last 2 minutes (H35). A computer with no read of the speed counters counts as cool. |

- **The wait.** The lease waits until each condition holds and its amounts fit. A lease that waits for a condition does not hold the queue: later leases go before it.
- **A power event.** When the charger goes in or out, Windows tells the daemon. The daemon reads the battery and runs the admission at once. Thus a lease that waits for `ac` starts in less than a second.
- **A wrong name.** `headroom run` refuses an unknown condition, with the list of the known conditions. A planned condition names its item: `unmetered` (H39) and `night` (H42).
- **A running job.** A job continues when a condition stops, for example when the charger goes out. The lease records it, and `headroom status` shows `runs without its condition: on battery since 01:20`.
- **`--timing`.** A job that measures time waits for AC power and a cool CPU (`ac` and `cool`). Its reason tells you to run timing tests in CI.

**The battery policy.** On battery below the floor, a new heavy lease waits. A lease is heavy when it asks for 2 GB of memory or more, holds the slot `browser`, or is spawn-heavy. `--battery-ok` starts it. `headroom config battery-floor 15` changes the floor, and `0` turns the rule off. The default is 25%.

**The usage data.** `usage<N` reads the usage file, at most one time in 30 seconds. The file has no default. `headroom config usage-file <path>` sets it, and `--clear` removes it. `headroom config roles-file <path>` sets the registry of the roles in the same way. The condition fails closed:

- With no setting, the job waits. Its reason gives the command that sets the file. `headroom status` shows the reason in the row of the job and in a line `Problem:`.
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

### Keep room for Mark (H33)

While Mark works at the laptop or is on a call, heavy jobs wait or run slower, so the laptop stays fast for Mark. When Mark steps away, they run at full speed.

| State | When |
|---|---|
| `present` | An input came in the last 5 minutes. |
| `busy` | Mark is present, and a full-screen app or a presentation runs. A call also makes Mark busy, with or without input: an app uses the camera or the microphone. |
| `away` | No input came for 5 minutes, Windows tells that the user is inactive, the display is off, or the session is locked. |

**The measure.** The reads are cheap. They start no process, no timer and no window:

- Windows tells the daemon when the user presence or the display changes. The daemon then runs a tick at once.
- At each tick, every 2 seconds, `GetLastInputInfo` gives the time since the last input. `SHQueryUserNotificationState` tells if the session is locked, a full-screen app runs or a presentation runs. The two calls take approximately 0.2 ms.
- At most one time in 30 seconds, the daemon reads the consent store of the camera and the microphone in the registry. It only reads.
- The daemon keeps only the fact that a call is on, and the device. It keeps no name of an app.

**The rules.**

- **A heavy job waits while Mark is busy.** The reason is `waits while Mark is on a call (at most until 10:22, then in eco mode)`, or `presents`, or `uses a full-screen app`. After 20 minutes, the job starts in efficiency mode. A light job and a running job continue.
- **Efficiency mode while Mark is at the laptop.** While Mark is present or busy, each heavy job runs in EcoQoS, and 2 more cores stay for Mark. The client of `headroom run` changes the mode at its next heartbeat. `--no-eco` keeps the full speed.
- **Full speed while Mark is away.** No job runs in efficiency mode for Mark, and the CPU reserve is 0. On battery, the efficiency mode of H30 applies in each state.
- **Heavy.** A heavy job asks for 2 GB of memory or more, holds the slot `browser`, or is spawn-heavy. With `--ignore-presence`, a heavy job does not wait and keeps its full speed.
- **`--when away`.** The job waits until Mark is away. A change of the state runs the admission at once, so the job starts within 2 seconds.

```sh
headroom run --when away -- pnpm bench
headroom config away-after 10m      # no input for 10 minutes: away (the default: 5 min)
headroom config busy-wait 30m       # the longest wait of a heavy job while Mark is busy (the default: 20 min)
headroom config present-reserve 3   # 3 more cores for Mark while Mark is at the laptop (the default: 2)
headroom config presence off        # measure only: no wait, no efficiency mode, no change of the reserve
```

`headroom status` gives one line, for example `You: present (last input 12 s ago). Heavy jobs run in eco mode.`, `You: on a call since 10:02. 2 heavy jobs wait.` or `You: away since 09:40.` `headroom presence` gives the state, its reason and the last 20 changes. `--json` gives the data. The dashboard shows the state in the chip `You`.

### The reboot budget and a planned drain (H34)

The AMD display driver of this laptop leaks kernel memory with each new process. Only a reboot gives the memory back. As the leak grows, process starts fail at smaller bursts (0xC0000142). A reboot works best in a planned window: no job runs, each session wrote its handoff, and the resume plan brings the sessions back.

headroom does not reboot the computer, and it does not log off. Only Mark does these actions.

**The budget.** `headroom reboot-plan` gives the facts and a recommendation. `--json` gives the data, and `Status.reboot` has the same data.

```text
Reboot: Reboot within 6 hours: the non-paged pool reaches its alert level at 07:40. A Windows update waits for a reboot too.
Kernel pools: non-paged 2.6 GB (alert level 3.0 GB, +80 MB in the last hour, at its alert level in 6 h 10 min), paged 2.6 GB (alert level 4.0 GB, +10 MB in the last hour).
Automatic drain: at 6.0 GB of the kernel pools together, now 5.2 GB. The forecast reaches it at 25 Oct 11:20, in 8 h 40 min.
Windows: an update waits for a reboot (Windows Update).
Uptime: 3 days, since 22 Oct 21:10.
Drain: none. `headroom drain --at 02:30` plans one.
Resume plan: C:\Users\<you>\.headroom\resume-plan.md, written 2 h 10 min ago (25 Oct 00:30). A drain writes it again at its start.
```

The rules of the recommendation go in this order:

1. A kernel pool at or above its alert level (3 GB non-paged, 4 GB paged), or the two pools at or above the automatic level: "Reboot soon".
2. A forecast (H32) of a pool to its alert level, or of the two pools to the automatic level, within 24 hours: "Reboot within N hours", with the time.
3. A pool that grows 500 MB or more in one hour, with no forecast: "Plan a reboot".
4. Only a waiting Windows update: "Reboot when it suits you". With another rule, the update adds one sentence.
5. Else: "No reboot needed", with the time of a far forecast.

headroom reads two registry keys, and writes none: `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired` and `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending`.

**The drain.** A drain holds new jobs before a reboot:

```sh
headroom drain --at 02:30 --until 06:00   # from 02:30, new jobs wait. At 06:00, the drain ends if no reboot came.
headroom drain --at now
headroom drain                            # the drain and its jobs
headroom drain --cancel
headroom run --during-drain -- git status # this job starts also in the drain
```

- From the time of the drain, a new lease waits with the reason `waits for the planned reboot at 02:30 (headroom drain)`. The running jobs finish.
- At the start, headroom sends the alert `drain`. It names the running jobs and their holders. The daemon also writes the resume plan again.
- When the last running job ends, headroom sends the alert `drain:ready`: "Ready for the reboot: no job runs." The organizer reads the alerts at each sweep.
- The settings keep the drain, so it continues after a restart of the daemon. A start of the computer after the drain ends it, because the reboot came.
- `--until` ends the drain at its time when no reboot came. The alert `drain:ended` tells it, and the waiting jobs start.
- `headroom status` shows a line, for example `Drain for the reboot at 02:30: 2 jobs still run.` The dashboard shows the budget in one line under the strip, with a bar for each pool.
- The reason of a drain does not start with `waits for memory`, so the hook of the plugin does not count it. A restart of the daemon for an idle queue does not wait for it.

**The automatic drain.** At a high pool level, new processes fail with 0xC0000142. On 2026-10-24 the two pools reached approximately 6.3 GB, and a reboot was necessary. No session watches the pools all the time, so headroom does it:

```sh
headroom config auto-drain 6g      # the level: the non-paged pool and the paged pool together. The default: 6 GB.
headroom config auto-drain off     # no automatic drain
headroom config auto-drain --clear # the default level again
```

- When the two pools stay at or above the level for 2 minutes, the daemon starts a drain with no end time. It does this only when no drain is planned or active.
- An automatic drain holds only the heavy jobs. A heavy job asks for 2 GB of memory or more, 4 cores or more, or the slot `browser`, or it is spawn-heavy (learned, or `--spawn-heavy`). The amounts of `--mem auto` and `--cpu auto` count.
- The failed starts came from browsers and test workers. Thus a light job, for example lint or a typecheck, starts. `headroom run` then writes `headroom: a drain for a reboot runs. Light jobs start.`
- A heavy lease waits with the reason `waits for a reboot: the kernel pools are at 6.1 GB, and this job is heavy: it runs browser tests (headroom drain, automatic: heavy jobs wait)`.
- A drain of `headroom drain` still holds each new job, light or heavy.
- The alert `drain` and the drain line of `headroom status` tell `automatic: heavy jobs wait`. The alert `drain` also tells why the drain started and what ends it. The alert `drain:ready` and the resume plan are the same as for a planned drain.
- At its start, the daemon runs the admission at once. Thus a light job that waited under an older version starts at the deploy.
- A reboot ends the drain. `headroom drain --cancel` ends it too.
- The automatic drain also ends by itself when the pools stay under the level less 300 MB for 10 minutes. The alert `drain:ended` tells it.
- After `headroom drain --cancel`, the rule starts no new drain until the pools fall under the level less 300 MB, or until a reboot.
- The rule does not change a drain of `headroom drain`, and it does not end one.
- `headroom reboot-plan` gives the level and the time when the forecast (H32) of the two pools reaches it.

**The resume plan (H13).** `headroom resume-plan` prints the command of each live session, the organizer first. It also writes the plan to `~/.headroom/resume-plan.md`. `headroom reboot-plan` tells where the file is and its age.

### The shared services (H27)

On 2026-10-24, the Docker engine stopped to answer, and an MCP server of the gateway did not start. Nothing told the sessions. Since H27, the daemon checks the shared services every 30 seconds, with a time limit of 3 seconds for each check:

- **Docker**: a `GET /_ping` on the pipe of the engine, `\\.\pipe\docker_engine` on Windows and `/var/run/docker.sock` on Linux. headroom starts no `docker` process. When the pipe does not exist, the state is `absent`, and no alert starts.
- **The MCP servers of the gateway**: the state of the gateway, with no call. A server that did not start is `down`, with the last error line of its stderr. A server that the gateway stopped for idle is `idle`, not `down`. A server that exited is `idle`, because the next request starts it again. With 3 exits in 10 minutes, it is `down`.
- **The URLs of the setting `health`**: a `GET` of each URL. An answer with a status below 500 is good. The list has no default, so with no setting the monitor checks no URL.
- **The hook of the plugin** (H194): a read of `plugins/installed_plugins.json` in the settings folder of Claude Code. The check also reads the `hooks/hooks.json` of each install of the plugin `headroom`. The check is `ok` when each HTTP hook asks the port of this daemon. It is also `ok` for the command hook of a version before 0.2.0. It is `down` when a hook asks another port or host, or when an install has no hook of headroom. A file that cannot be read also gives `down`. With no install, it is `absent`. Its alert is a warning.

Each service has a state: `ok`, `slow` (an answer after more than 1 second), `down`, `idle` or `absent`. `headroom services` shows the state, the latency, the start of the state, the last good check and the last error of each service. `--json` gives the list.

```text
SERVICE                  STATE    LATENCY  SINCE (UTC)      LAST OK  LAST ERROR
docker                   ok         12 ms  16:02 (2.7 h)    18:45    -
local-site               ok          3 ms  16:02 (2.7 h)    18:45    -
mcp:vex                  down           -  18:41 (4 min)    -        18:45 Error: Cannot find module 'zod'
mcp:loom                 idle           -  16:02 (2.7 h)    -        -
```

- `headroom config health <name> <url>` adds a URL or changes it. `headroom config health <name> --clear` removes one URL.
- `headroom config health --clear` makes the list empty. `headroom config health` shows the list.
- headroom does not restart a service for its health. A person or the session that owns the service decides.

On Windows, `headroom run` puts the job into a job object:

- When the run ends, Windows stops each process that the job started and that still runs. Thus a test server or a search does not stay as an orphan. `--keep` turns this off, for a command that starts a service on purpose.
- `--limit` makes the memory of the lease a hard limit: the job cannot commit more. An allocation above the limit fails, and the job stops with its own error.
- With `--cpu N`, `--limit` also puts a hard cap of N cores on the job (H23). Without `--limit`, the job object gets the default weight. The run writes the average cores of the job.
- The run writes the peak memory of the job, for example `the job used at most 248 MB of its lease of 300 MB`. The ended lease keeps the peak.
- The run also writes the count of processes that the job started (H29). The lease keeps the count.
- On battery, the run puts the processes of the job in efficiency mode (EcoQoS), and writes one line when the mode changes (H30). `--no-eco` turns this off.
- A browser test (`playwright test`, `cypress run`, or a command that names `e2e`) takes the slot `browser` by itself. A program that does not start a browser (for example `tsc -p e2e`, `eslint e2e` or `git add e2e`) and a list of the tests (`playwright test --list`) take no slot. Thus one browser test job runs at a time. Two jobs at the same time start many browser processes, and new processes can then fail with `0xC0000142`. A script that runs browser tests inside it, for example a gate, takes the slot with `--slot browser`. `--no-auto-slot` turns it off, and `headroom run --slot browser` adds it. `headroom pool browser 2` lets two run.
- The rating reads each part of the line (H55). For `vitest` and `jest`, the word `e2e` is a filter word, so it gives no slot. The exceptions are `--browser`, and a `--project` or `--config` that names `e2e`. Another unit test run that starts a browser from its own code takes the slot with `--slot browser`.
- A spawn-heavy job does not run beside a browser test (H47). `--spawn-heavy` and `--no-spawn-heavy` set the class of the job.
- `--when ac,usage<80` makes the job wait for its conditions, and `--timing` makes it wait for AC power (H31). On a low battery, a heavy job waits. `--battery-ok` starts it.
- `--mem auto` sizes the lease from the peaks of past runs (H78). It reads the runs of the same job, else of its key, its repository, a fit on the count of packages, or its kind. A job with no run of its kind gets 1 GB. See [The memory of `--mem auto`](#the-memory-of---mem-auto-h78).

A pool with no capacity is a lock of 1. Set a capacity with `headroom pool docker 2`. The processors are different: their count is the capacity of `cpu`, and `headroom pool cpu 8` sets a lower cap.

A job with `--detach` can run after the shell that started it stops. A client in a Git Bash shell gives up its place in the queue when that shell ends (H64). `headroom job` gives the state of a job, so a session can wait for the end of the job and read its exit code:

```sh
headroom run --job shop-e2e --log D:\logs\e2e.log -- pnpm e2e
headroom job shop-e2e
headroom job 3f2a9c1e --json
```

```text
headroom: lease 3f2a9c1e for shop-e2e, queued for browser.
shop-e2e (3f2a9c1e) of shop: exited with code 1 at 17:42, waited 12 min, ran 6 min, peak 1.8 GB, 412 processes started, at most 380 starts a minute, normal (about 350 a minute in past runs). Log: D:\logs\e2e.log
```

- `headroom run` writes the lease id and the job first. The release of the lease records the exit code of the job, or the signal that stopped it.
- `--log <file>` sends the output and the errors of the job to the console and to the end of the file. The run makes the file and its folder when they do not exist. The lease records the absolute path.
- `headroom job <name|id>` finds the lease by its id, or by a unique prefix of 8 or more characters of the id. Then it finds the latest lease of the job name. `--holder <h>` uses only the leases of one holder. `--all` gives each match of the last 24 hours.
- The state is `queued` (the lease waits), `running` (the lease is granted) or `exited` (the lease is released, cancelled or expired). A lease that ends with no job exit, for example a lease whose client stopped, has the exit code `null` and a reason.
- `--json` gives `{ id, job, holder, state, exitCode, signal, reason, queuedAt, startedAt, endedAt, waitedMs, ranMs, peakMb, processes, peakStartsPerMin, averageStartsPerMin, spawn, log }`. The times are ISO strings or `null`. The procedure is `resources.job`.
- The command gives the exit code 0 when it finds a job. With no match, it gives the exit code 3, and `--json` writes `{ "error": "no job", "query": "..." }`.
- The store keeps each ended lease for at least 7 days.

### A job that runs without its shell (H56)

Use `headroom run --detach` in place of a background shell. It is for a job that waits in a queue or runs for more than a few minutes.

```sh
headroom run --detach --job shop-e2e --mem 2g -- pnpm e2e
headroom job shop-e2e
```

```text
headroom: job shop-e2e runs detached, lease 3f2a9c1e. Log: C:\Users\you\.headroom\jobs\5d1c0f3a.log. State: headroom job shop-e2e
```

Claude Code stops a background shell when the runtime gives memory pressure "critical", no turn or agent runs, and the last input is 30 minutes old. On Windows, it reads no memory figure. Thus it stops a client of `headroom run` that only waits in the queue. On 2026-11-04, two clients stopped this way with approximately 5 GB available. The stop reaches the shell. It does not always reach the job: a script can continue without its shell. A detached job is not a child of that shell.

- The run starts the same client as a detached process with no window, and returns when the client has its lease. The lease can wait in the queue.
- The queue, the slots, the limits, the job object, the exit record and the release are the same as for a foreground run. `--wait` still sets the longest wait in the queue, and its default is 30 minutes.
- `--detach` needs `--job <name>`, so that the wait has a name. Without `--job`, the run stops with the exit code 2.
- A detached job that waits is a row of the daemon, with no process (H64). The daemon starts its client at the grant. The environment of the job stays in the memory of the daemon. A crash of the daemon ends the waiting job, and `headroom job <name>` shows the reason.
- A client in the queue gives up its place when its shell ends (H64). The command file gives the Windows process id of the shell in `HEADROOM_SHELL`. `headroom service command` writes that file. With no value, the client does not watch. A job that outlives its shell on purpose uses `--detach`.
- The output of the client and the job goes to the file of `--log`, or to a new file `jobs/<uuid>.log` under the folder of headroom. `headroom job <name>` gives the path of the log.
- `headroom job <name>` gives the state and the exit code of the job. The run itself gives 0 when the client starts, not the exit code of the job.
- Without a daemon, the job runs without a lease, as a foreground run does. Then `headroom job` has no state of it, so read the log.
- On Windows, a child process is in each job of its parent. An editor can keep its processes in a job that stops them when the editor closes. Thus a client that the run starts itself can stop with the editor.
- So the run starts that client through a relay, which has the shell of the desktop as its parent process (H190). The client is then in none of the jobs of the caller. The log tells where the client started.
- When the shell does not start the relay, the relay starts with a breakaway from the jobs of the caller. This occurs on a computer with no desktop shell, for example.
- When Windows also refuses the breakaway, the client starts in the jobs of the caller. The run tells why on stderr and in the log. For example, Windows refuses when the run is elevated and the shell is not.
- A client that the daemon starts (H64) also starts through the relay (H202). Without the relay, the client is in the jobs of the daemon. On 2026-11-18, the job of the scheduled task ended an adopted client at a restart of the daemon.

A session can take its queued job off the queue with `headroom cancel`, for example after its subagent ended:

```sh
headroom cancel 3f2a9c1e                       # the lease id, or its first 8 characters
headroom cancel --job shop-e2e --holder shop # only the jobs of one holder
headroom cancel --job "pnpm test" --all        # each waiting match
```

- The job does not start. Its waiting `headroom run` exits with code 75 and writes `headroom: shop-e2e was cancelled by shop before it started. Nothing ran.`
- The lease records who cancelled it: the session of the caller (`HEADROOM_HOLDER` or the session of the process tree), else `cli`. Its state is `cancelled`.
- `--job` with more than one waiting match lists the matches and cancels none. `--all` cancels each match.
- A running job does not change. `headroom cancel` tells it and gives exit code 1. `headroom release <id>` ends its lease, but the job does not stop.
- The exit code is 0 after a cancel, or when the match ended already. It is 3 with no match, 1 for more than one match, and 2 for a wrong use.
- `--json` gives `{ cancelled, matches }`. The procedure is `resources.cancel`.
- A waiting lease also ends by itself when its client stops. A lease with a process ends at the next tick after its process exits. A lease with no process ends after its heartbeat limit (5 minutes by default) with no call.
- After a restart of the daemon, each waiting lease of the store gets a new limit. It ends when its client does not call again in that limit.
- A client can fail to reach the daemon for its release, for example during a restart. Then the lease ends with the exit of the end record of the client (H202). Its reason tells that the exit came from that record.

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
| `handles` | One process holds more than 100,000 handles (a warning) or more than 500,000 (critical), or gains more than 20,000 handles in 5 minutes. The id is `runaway:handles:<pid>`. The alert names the owner, also after the parent ended, and the command line (H48). |
| `memory` | Less than 1 GB of memory is available. |
| `cache` | The system file cache holds 4 GB or more, and less than 6 GB of memory is available (a warning) or less than 1 GB (critical). The alert names the owners that read and wrote most in the last hour (H50). |
| `reader` | An owner of the kind `system` or `other`, for example Windows Search, read 50 GB or more in the last hour, and less than 2 GB of memory is available. The alert names its processes of the last minute and the next step (H192). |
| `commit` | The commit charge is above 90% of its limit. |
| `desktop` | More than 1000 processes run in the session. The desktop heap can run out, and new processes then fail at their start. |
| `pool` | The non-paged kernel pool is above 3 GB, or the paged pool is above 4 GB, or one of them grew more than 500 MB in one hour. The alert names the pool tags that grow. |
| `disk` | A fixed drive has less than 20 GB free (a warning), or less than 5 GB free (critical). The alert gives the free space that the drive lost in the last hour. It names the 3 owners that wrote most in the last hour, each above 100 MB, for example `Most writes in the last hour: session:shop 31.2 GB, mcp:vex 2.1 GB.` It also names the 3 largest files above 1 GB of the last 2 hours in the home folder, the downloads, the temporary folders and the root of the drive. A drive smaller than 100 GB uses 20% and 5% of its size. |
| `ports` | More than 80% of the dynamic TCP ports are in use (a warning), or more than 95% (critical). When no dynamic port is free, new connections fail. The alert names the 3 owners with the most connections, and the count in `TIME_WAIT`. |
| `service` | A shared service does not answer for 2 checks in a row (one minute): critical for Docker and the MCP servers, a warning for a URL of the setting `health`. An answer after more than 1 second for 3 checks in a row is a warning. The id is `service:<name>`, for example `The Docker engine does not answer since 18:42 UTC (3 min). Containers such as Mongo and the test databases need it. headroom does not restart it.` An idle MCP server and an absent Docker engine give no alert. |
| `stop` | Another process stopped the daemon, or 2 clients of `headroom run` in 2 minutes. This alert is an event: it stays for 15 minutes. |

On Windows, the daemon reads the kernel pool by pool tag every 5 minutes. A driver marks its allocations with a tag, so the tag that grows names the driver that leaks. The store keeps one snapshot for each hour for 7 days. It also keeps the first snapshot after the start of Windows.

`headroom pool-tags --since boot` (or `--hours <n>`) shows the growth of the tags in both pools over days. `headroom pool-tags --drivers` shows the largest tags, the tags that grew in the last hour, and the driver files that contain each tag. It needs no admin rights and no driver kit. The procedure `resources/pooltags` gives the lines of a chart with the input `series`, the number of tags for each pool (H53).

### The memory of `--mem auto` (H78)

`--mem auto` asks for the memory that the job used in its past runs. Before H78, the name of the job was the only key. Most jobs have a new name. Thus in the 7 days before 2026-11-16, 41% of the leases asked for the default of 1 GB. A request was approximately 2 times the peak.

From H78, `headroom run` sends a typed key with the request. The client makes the key from the command and from the files of its folder. It reads only files: it starts no process, not git either.

| Field | Where it comes from |
| --- | --- |
| `kind` | The command: `install`, `test`, `typecheck`, `build`, `lint`, `browser` or `other`. A browser run is the run that takes the slot `browser`. A job name of one word gives the kind from its words, for example `h78-typecheck`. |
| `repo` | The git folder above the folder of the command. A worktree gives its main repository. |
| `lock` | The first 16 hex characters of the SHA-256 of the nearest lockfile. |
| `filter` | The `--filter` values of pnpm or the `--workspace` values of npm, else the folder of the package. |
| `warm` | True when `node_modules` is next to the lockfile. |
| `packages` | The count of the packages of the lockfile. |
| `command` | The command with no absolute paths, temporary folders or hex ids. |

The daemon goes down a ladder, and takes the first rung with runs:

1. `job`: the runs of the same job in the same repository. The runs of the same holder come first.
2. `key`: the runs of the same kind, repository, lockfile, filter and warm state.
3. `repo`: the same, with another lockfile.
4. `fit`: the runs of the same kind and warm state in each repository. A least-squares line of the log of the peak on the log of the count of packages gives the amount. The amount adds the 90th percentile of the residuals. The fit needs 10 runs or more.
5. `kind`: the last 50 runs of the same kind.
6. `none`: no run. The client asks for 1 GB.

At each rung but `fit`, the amount is the 90th percentile of the peaks, 10% more and 128 MB more. The amount rounds up to 64 MB, and is at least 256 MB. The rungs `job`, `key` and `repo` read the last 20 runs. The line of the run names the rung and the count of runs:

```text
headroom: --mem auto gives 832 MB, at the rung key: the peaks of 2 runs of the same key (kind, repository, lockfile and package) (the highest 600 MB).
headroom: --mem auto gives 1.0 GB: no read, because no run of this job, its key or its kind (test) has a peak yet.
```

- The core does not read the command. It compares only the fields of the key.
- A daemon of before H78 ignores the key. A client of before H78 sends no key, and its runs stay at the rung `job`.
- Step 4 of the store adds the table `lease_keys`. Each lease with a key writes its key, and the amount and the run time that the ladder gave at its request.
- The expected run time of H178 and H184 also uses the key. It reads the runs of the job first, then of its key, of its repository and of its size class.

**The report.** `headroom report leases [--days 7] [--json]` opens the store read-only and needs no daemon. It gives four measures:

- the share of the leases with a measured or fitted amount (the rungs `job`, `key`, `repo` and `fit`)
- the sum of the requests over the sum of the peaks
- the share of the leases with a peak over their request
- the 90th percentile of the wait of the install leases, from the request to the grant

It gives them for the leases as they ran, and for a walk-forward replay: each request sees only the runs that ended before it. The replay compares the rule of before H78 with the ladder, over a grid of amount rules. There are two gates. The upper end of the 95% Wilson interval of the over share is at most 5%. The sum of the requests is at most 1.5 times the sum of the peaks. The report chooses the rule with the lowest ratio that holds both gates. When no rule holds both, it chooses the rule with the lowest ratio that holds the over gate. A lease of before H78 has no key. Thus the report takes its kind from its job text, and the replay can test only the rungs `job` and `kind`.

## The plugin for Claude Code

The plugin `headroom` has a hook for the Bash and PowerShell tools. When a session starts a heavy command (tests, builds, Playwright, Docker builds) and the memory is tight, the hook refuses the command. It gives the session the form under a lease, for example `cd app && headroom run --mem auto -- pnpm test`.

- The memory is tight when less than 4 GB is free for a lease, or when jobs wait.
- The hook does not approve a command. The session sends the new form, and the permission rules of the user apply to it.
- The hook reads the command words of each part of the line, not the text (H55). The text of a quoted string or of a comment does not count, so `git commit -m "fix vitest"` is light. A shell that runs its argument is different: `bash -c "pnpm test"` is heavy. `sh -c`, `powershell -Command`, `pwsh -Command` and `cmd /c` are the same.
- A text reader is light, whatever its arguments say. The text readers are `grep`, `rg`, `git grep`, `sed`, `cat`, `echo`, `head`, `tail`, `ls`, `Select-String` and `Get-Content`.
- The body of a here-document is text when its program only takes text (`cat > a.md <<'EOF'`, `gh pr create --body-file - <<'EOF'`, `git commit -F -`) and the shell runs no part of it (H181). A body that a shell reads stays in the rating: `bash <<'EOF'` and `cat <<'EOF' | bash` are heavy when the body is heavy.
- A `headroom run` waits for its grant in the foreground of the tool call (H208). At the timeout of the call, Claude Code moves the call to the background. There, the stop of idle background shells ends the job with no exit code. Thus while a job waits for memory, the hook refuses a run with no `--detach` whose `--wait` is not shorter than the timeout.
- The timeout is the field `timeout` of the call: 2 minutes by default, and 10 minutes at most. A call that starts in the background counts each wait. The refusal gives two safe forms. The first is `headroom run --detach --job tests ... -- <command>`, and then `headroom job tests` gives the state of the job. The second is a short wait, for example `--wait 8m` with a timeout of 600000.
- The guard reads the options of a run with the table of `headroom run`, so a `--detach` after `--` is an argument of the command. The guard does not count the time of the job after its grant (H209).
- The hook is an HTTP hook (H194). Claude Code sends each event to `POST http://127.0.0.1:4730/hooks/pre-tool-use` on the daemon, so a tool call starts no process for the hook. The daemon has the one copy of the rating (`packages/daemon/src/hook-rating.ts`).
- The route answers only on 127.0.0.1 or localhost, and only a request with the header `x-headroom-client: hook`. A web page cannot send that header to another origin without a CORS preflight, and the daemon answers no preflight.
- For a light command, the answer is `{}` and the command goes on. Without a daemon, the request fails, and Claude Code lets the tool call go on: the hook has a timeout of 1 second and no `onFailure`.
- With the daemon stopped, Claude Code shows a `PreToolUse:Bash hook error` notice for each Bash or PowerShell call, because a failed HTTP hook is a non-blocking error. The call goes on. The command hook before version 0.2.0 showed no notice.
- The URL of an HTTP hook takes no environment variable, so the hook calls the default port 4730. A daemon on a different port (`headroom serve --port`) gets no request from the hook, so the hook refuses no command. The service check `hook` tells it: its warning names the port of the hook and the port of the daemon (`headroom services`).
- Version 0.2.0 of the plugin needs version 0.3.4 or later of the daemon. An older daemon has no route, so the hook refuses no command. Update the daemon first, then the plugin.

To turn it on in Claude Code: `/plugin marketplace add C:\Users\<you>\git\headroom`, then `/plugin install headroom@headroom`. To turn it off: `/plugin disable headroom@headroom`.

## The dashboard

The daemon serves a dashboard at `http://127.0.0.1:4730/`. `headroom dashboard` opens it in the browser. It shows the alerts and what uses the computer. Then it shows one panel for each resource, the jobs, the owners, the MCP gateway and the pool tags. Its charts show the last hour to the last 7 days.

- Each alert is one line with its kind, its start and its first sentence (H189). Select the line for the rest of the text and a link to the panel of its resource. An open alert stays open after a refresh.
- The top section shows what uses the computer. One bar shows the memory in RAM by owner, the unattributed memory and the free memory. A second bar shows the processors by owner. The memory card also gives the unattributed memory (H49).
- A third bar shows the process starts of each owner in one minute (H189). Its hatched part is the starts that no read named. These are the starts of the owners after the top 10, and of the short processes that end between two reads. Select the name of the bar for the panel of the process starts.
- Each owner has the color of its group. The groups are the Claude sessions, the editor, the browser, Docker, the services, Windows, the kernel and the other programs.
- Select a part of a bar, a group or an owner row. The page then marks that owner in the panels and the owner table. Escape removes the mark.
- A line of chips gives the state of each service: the Docker engine, the MCP servers of the gateway and the local site. On a laptop, a chip gives the power source and the charge. The chip `Heat` gives the speed of the CPU and its hottest zone (H35).
- The section "Resources" has one panel for each resource of `Status.resources`. These are the drives, memory, commit charge, processors, CPU speed and heat, and the GPU adapters. The other panels are network, TCP ports, services, slots, kernel pools, desktop, process starts, battery and power. The page makes each panel from the model, so a new resource gets a panel with no change to the page.
- Each panel shows the free part and the capacity in the unit of the resource, and a bar of the used part. It shows a line of the window from `History.resources`, and the change in one hour for a size.
- A panel also shows the active alert of its resource and the leases that hold an amount of it. When the status gives the top users of the resource, the panel shows them. A disk lease shows the temp folder of its job.
- The write counters do not name the drive. Thus the drive panels show no users, and one panel "Writes to all drives" follows them with the top writers.
- The panel "Docker containers" follows the panel of the Docker engine (H38). It gives the running containers with their owners, the VM, the disk use and the Docker alerts.
- The panel "What uses the space" follows it. It shows the time of the last `headroom disk report` and its largest places (H21).
- Select a panel to open it to the full width. It then shows a chart of its history in the window, a table of the data and all its users.
- The section "Jobs" shows the leases of the window on a timeline, one line for each holder. A bar is amber while its job waits for room, and blue from its start to its end. A dot at its end gives the exit code.
- The card "Pool tags" shows two charts, one for each kernel pool (H53). Each chart has one line for each of the 5 tags that grew most since the start of Windows.
- A line gives the growth of its tag since the first snapshot after the start of Windows. The legend gives the name and the growth of each tag, and the tooltip gives its size.
- Before the second snapshot, and on a computer without Windows, the card shows a note and no chart. Two tables under the charts give the tags of the last hour.
- The page is one HTML file of approximately 100 KB, with no framework and no build step. The daemon keeps it as one string.
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
- The start script of the sessions runs it before it starts the sessions.

A program that starts only stdio servers, for example the launcher of a plugin, uses the bridge:

```sh
node packages/daemon/src/bridge.ts vex -- npx -y @mark1russell7/vex-mcp
```

The bridge sends the messages of the session to the gateway. When the gateway does not serve the server, the bridge starts the command after `--`. Thus the same launcher works on a computer without headroom. The bridge uses approximately 30 MB, and it opens a new session after a restart of the daemon.

| Exit code | Meaning |
|---|---|
| The code of the job | The job ran under its lease. |
| 75 | The lease was not granted in time, or it ended before the job started. Or a fixed drive has less than 5 GB free: a full drive stops the builds, the tests and git of all the sessions. Nothing ran. Free space, or start the job again with `--force-disk`. |
| 2 | The command line is not correct. |

## How it is built

- The procedures use `@procedures/client`. The host is `runProcedureHost` of `@procedures/server`, on the runner of `@mark1russell7/service`.
- The database is `node:sqlite`, with one file in WAL mode and the pragma `synchronous` NORMAL. A new lease, each change of the state of a lease and the key of a new lease are synced writes (H204). A synced write is on the disk when the call returns. The field `syncs` of `headroom status --json` gives their count, their time and the longest one.
- The daemon is one Node process. Its target is less than 60 MB of memory.

## License

MIT
