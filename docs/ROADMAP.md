# The roadmap of headroom

Mark approved the plan on 2026-10-19. The plan follows the design rule of Mark: choose the most general option for the long term.

## The design

### The resources

- A resource is a named pool with an amount: `memory` in MB, `cpu` in processors, or a count of slots, for example `docker` or `npm-publish`.
- The capacity of `memory` is measured, not configured. It is the available memory of the computer, less a reserve.
- The capacity of the other resources is configured in the database.
- `docs/RESOURCES.md` gives the general model (H22): each resource has the same five parts. Memory is its first resource, and disk is the second.
- The next resources are H30 to H43, which Mark approved on 2026-10-24: power, heat, the GPU, disk speed, containers, budgets, end dates and job conditions.

### The leases

- A lease has a holder (a session or a role), a job name, the amounts that it asks for, a priority and a heartbeat.
- headroom grants a lease when the reserved amounts plus the request fit in the capacity, and the measured free memory also has room.
- Requests wait in a queue in the order of their priority, then of their time. A long wait raises the priority, so no request waits forever.
- A lease can name a process. headroom releases the lease when that process exits. A lease without a process expires when its heartbeat stops. Thus a crash cannot hold a lease forever.

### The observations

- The sampler reads the available memory, the commit charge, the kernel pools and the memory of each process.
- It gives each process tree to an owner: a Claude Code session (from `claude agents --json`), Docker, the browser or other.
- An orphan keeps the owner that it had while its parent was alive (H48). The store keeps these owner records over a restart of the daemon.
- The database keeps the samples in a ring buffer, with a coarser history for the older samples.

### The faces

- The procedures are `resources.*`: `lease`, `release`, `renew`, `run`, `status`, `wait` and `history`.
- The CLI is `headroom`: for example `headroom run --mem 2g -- pnpm test`, and `headroom status`.
- The MCP tools let a Claude Code session ask for a slot itself. A long wait is an MCP task.

### When the daemon is down

A client that cannot reach the daemon runs the job and prints a warning. It does not block the work.

## The items

| ID | Item | Status |
|---|---|---|
| H0 | The repository, the plan and the tracker | done |
| H1 | The sampler: the memory counters, the owner of each process tree, the history in SQLite | done (v0) |
| H2 | The leases: the pools, the admission rule, the queue, the release on process exit | done (v0) |
| H3 | The daemon: the `resources.*` procedures on `runProcedureHost` over HTTP, and the `headroom` CLI | done (v0) |
| H4 | The MCP face: the tools, and a long wait as an MCP task (after client CLI-11 and CLI-35) | later |
| H5 | The hub: the organizer writes the state of headroom into the `resources` collection of the Fleet Hub | later |
| H6 | Enforce on Windows: a job object with a memory limit, and a stop when the job closes | done: the job object, `--limit` and `--keep` |
| H7 | Enforce on Linux and WSL: a cgroup with `MemoryMax` | later |
| H8 | A Claude Code hook that sends each heavy command through `headroom run` | done: the hook fix is merged. Mark installs the plugin. |
| H9 | Alerts: kernel pool growth and a commit charge near its limit, sent with `notify.send` | done: the alerts, and the pool tags with their drivers |
| H10 | More resource kinds: Docker, the npm publish quota, GitHub Actions minutes | in progress: the slot `browser` for browser tests, by itself. Each other slot works with `--slot`. |
| H11 | The MCP gateway: one copy of each local MCP server for all the sessions, over HTTP | in progress: the gateway works, the rollout waits for the owners |
| H12 | Start the daemon at login, and start it again after a crash: `headroom service install` | done |
| H13 | The resume plan: the command of each live session, for a reboot | done: `headroom resume-plan` also writes `~/.headroom/resume-plan.md`, and a drain writes it again (H34) |
| H14 | Runaway alerts: a process above 4 GB that has no lease, or a process whose parent stopped. headroom reports to the organizer. It does not stop the process. | done |
| H15 | The dashboard: a page of the daemon at `http://127.0.0.1:4730/`, and `headroom dashboard` | done |
| H16 | The Dev Drive: the code and the package caches on a ReFS volume. `docs/DEV-DRIVE.md` gives the plan. | done: the move is done, the lessons are in `docs/DEV-DRIVE.md` |
| H18 | Disk space: alerts for low free space, and headroom run waits on a full disk | done |
| H19 | Disk: each job gets its own `TEMP` and `TMP` folder on the Dev Drive `D:`. The release removes it. | done: `headroom config job-temp`, a temp folder for each lease, `--keep-temp`, and the sweep of the daemon every 10 minutes |
| H20 | Disk: who writes. The bytes that each session, MCP server and job writes, from the I/O counters of its processes. | done: one counter tracker gives the writes and the cores of each owner. `Status.writes`, the owners of each instance in `Status.resources`, the disk alert and `headroom status` name the owners. The store keeps the writes of each owner each minute. |
| H21 | Disk: a report of what uses the space, and a safe cleanup. It removes only data that is disposable by definition. All other data goes to Mark first. The `*.before-devdrive` copies stay. | done: `headroom disk report [--drive] [--deep] [--json]` in the process of the command (a fixed list of places, a walk that follows no link or junction, a budget of 30 seconds or 3 minutes with partial sizes), the saved report and its dashboard card. `headroom disk clean [--apply]` deletes only the temp folders of ended leases, old trace files and, behind a gate, `pnpm store prune`. Each other large place goes to the list "Ask Mark". The disk alerts end with a hint to the report. |
| H22 | One resource model: memory, disk, then CPU and more. Each resource has the same five parts: measure, attribute, alert, admit and enforce. | done: memory, disk, CPU, network and services are on the model. The design is `docs/RESOURCES.md`. Steps 1 to 4 shipped in #29, #30 and #31: the types, the broker on two admit modes, `Status.resources` and the alert rules. Step 5 makes disk a lease resource (`--disk 5g`, `--disk D:=5g`). Step 6 is H19. Step 7 is H20. Step 8 has its own item, H21. |
| H23 | CPU on the resource model: the processors get the five parts of the model | done: the `cpu` alert (85% and 95% of the cores for 5 minutes), the runaway alert for a process tree above 4 cores for 10 minutes, `headroom config cpu-reserve` (2 cores for Mark), the hard cap of `--cpu N --limit` and the weight of each other job object, `--cpu auto` and the peak cores of each lease |
| H24 | The network on the resource model: the throughput of the adapters, the dynamic TCP ports and the listening ports | done: `net:in` and `net:out` in MB/s, `ports:tcp` with the connections of each owner, the `ports` alert, `headroom ports` and `resources.ports` |
| H25 | The dashboard: one panel for each resource, from the model | done |
| H26 | The state of a job: `headroom job <name\|id>`, for the fleet's typed wait `job:<name>` | done |
| H27 | Service health: Docker, the MCP servers of the gateway, the fleet site | done |
| H28 | UX round 1: the dashboard and the tracker. The dashboard shows what uses the computer, opens each panel to its history and shows the jobs on a timeline. | done |
| H29 | Process starts by owner. Each new process leaks kernel memory in the AMD display driver until Mark updates it (hub ask `amd-driver`). | done: the resource `procs` in starts each minute, an exact total of the computer from the sequence numbers of Windows, exact counts of the leased jobs from their job objects, a lower bound for each owner with its jobs and its own commands, the alert `churn`, the line of `headroom status`, `processes` in `headroom job`. A parent counts only when it started at or before its child. |
| H30 | Battery and power: the battery becomes a resource of the model. On battery, heavy jobs wait or run in the efficiency mode of Windows. | done: the resources `battery` (Wh) and `power` (W, the owners as an estimate), the power events of Windows, the sleep gaps in the leases, the rates and the charts, the alerts `battery`, EcoQoS for the jobs of `headroom run` on battery (`--no-eco`), a power request on AC power while a lease is granted, and the line `Power` of `headroom status`. The wait rules come with H31. |
| H31 | Conditions for a job: plugged in, Mark away, no metered network, a cool CPU. A job waits for a condition, not only for an amount: `headroom run --when ac,away`. | done: the registry of the conditions with `ac`, `battery>=N` and `usage<N` (the usage window of the fleet, fail closed), `--when`, `--timing` (waits for AC power), the battery floor for heavy jobs (`headroom config battery-floor`, `--battery-ok`), the admission at the tick of a power event, and the record of a job that runs without its condition. The planned names point to H33 (`away`), H35 (`cool`), H39 (`unmetered`) and H42 (`night`). |
| H32 | A forecast for each resource: the time to a limit, from its history. The fleet acts before the limit, not at it. | done: a Theil–Sen fit of the last hour with Kendall's tau as its confidence, the targets from the alert limits, the time left of Windows for the battery, `forecast` in `Status.resources`, the alert `forecast` (a drive at its critical level within 24 hours, a pool at its alert level within 2 hours, the commit charge at 90% within 30 minutes), `headroom forecast`, the line of `headroom status` and a line on each card of the dashboard |
| H33 | Keep room for Mark: while Mark works or is on a call, heavy jobs wait or run slower. When Mark steps away, they run. | done: the state `present`, `busy` or `away` from the session events, the last input, the notification state and the camera and the microphone (no app names), the condition `away`, the busy wait of heavy jobs (`headroom config busy-wait`, `--ignore-presence`), EcoQoS for heavy jobs and a larger CPU reserve while Mark is at the laptop, no reserve while Mark is away, `headroom config presence off`, the line `You` of `headroom status`, `headroom presence` and the chip of the dashboard |
| H34 | The reboot budget and a planned drain. headroom forecasts when the kernel leak of the AMD driver needs a reboot, and offers a reboot window. The resume plan (H13) brings the fleet back. | done: `headroom reboot-plan` and `Status.reboot` (the pools, their growth and forecast, a waiting Windows update, the uptime and a recommendation), `headroom drain --at --until --cancel` with the alerts `drain` and `drain:ready`, `--during-drain`, the drain in the settings, the resume plan file, a line of `headroom status` and of the dashboard |
| H35 | Heat and throttling: when heat or a power limit slows the CPU, timing tests and benchmarks wait, because their numbers are wrong. | done: the speed limit, the speed, the frequency and the thermal zones from the PDH query of the Energy Meter, the resource `thermal` (%), the throttle rule (a limit over 10% or a passive limit, for 30 seconds), the alert `heat` with the owners and their leased jobs, the condition `cool` (`--timing` waits for it), `headroom thermal`, a status line and a dashboard chip |
| H36 | GPU for each process: the GPU uses the main memory, so GPU memory counts against memory, and each session sees its share. | done: the resource `gpu:<n>` for each adapter (the GPU memory from 5 wildcard counters of PDH in the query of the Energy Meter, the limits from DXGI one time), the GPU memory and the engine use of each owner and of each leased job, the peak GPU memory of a lease, the alert `gpu` (above 90% for 2 minutes), the line `GPU` of `headroom status`, `headroom gpu` and a dashboard panel for each adapter. Windows already counts the shared GPU memory in the available memory, so `memory` does not subtract it. |
| H37 | Disk speed, SSD wear and disk limits for jobs. A cap on the disk rate of a job keeps the computer fast for the other jobs. | later |
| H38 | Docker inside: the memory, CPU and disk of each container, by session. The Docker VM shows as one big process, so headroom asks the Docker engine. | done: a Docker client in the daemon (GET requests on the pipe of the engine from the tick, no process), the containers every 30 seconds and `GET /system/df` every 10 minutes, the owner of each container from the folder or the name of its compose project and the fleet roles, the split of the owner `docker` into the owners of the containers and `docker (VM)`, the memory of `vmmemWSL` from `SystemProcessInformation`, `Status.docker`, the alert `docker` (build cache above 20 GB, images with no container above 10 GB), the line `Docker` of `headroom status`, `headroom docker` and a dashboard card. |
| H39 | Network cost: on a metered network, big downloads wait. While the network is offline, the jobs that need it wait and do not fail. | later |
| H40 | Budgets outside this computer: the GitHub API quota that all sessions share. A job can wait for room in it. Claude usage stays with the usage meter of the organizer. | later |
| H41 | Things that expire: certificates, the npm trust, tokens and keys. headroom shows the time left and alerts before each one ends. | later |
| H42 | Quiet hours and the overnight window: a CPU cap at night for quiet fans, or big test suites that wait for the night. Mark picks the hours. | later |
| H43 | Clean-grid timing: jobs that can wait run when the New England grid is cleanest. The effect is small, so this item is last. | later |
| H44 | Fix: the Angular completion in `~/.bashrc` starts node in each login shell, 13 times a minute, only from two sessions that run with no shell snapshot. A restart of those sessions stops it. | waits for Mark |
| H45 | Fix: VS Code polls Docker every 2 seconds. Mark closes the Containers view of VS Code when it is not in use. If the poll continues, Mark turns off the extension in the workspaces that do not use Docker. | waits for Mark |
| H46 | The peer of a local connection: `resources.peer` gives the process, the nearest `claude.exe`, the session and the fleet role at the other end of a loopback TCP connection. The fleet site uses it for its MCP face (server-stack fp-mcp). Also `headroom peer`. | done |
| H47 | Jobs that start many processes do not run beside browser tests. The lease keeps its peak starts in one minute. A job name whose past runs are above 600 a minute is spawn-heavy, and a first run becomes spawn-heavy when it goes above the limit. A spawn-heavy lease and a browser test wait for each other, in the queue order. Also `--spawn-heavy`, `--no-spawn-heavy` and `headroom config spawn-heavy`. | done |
| H48 | Runaway handles and the owners of orphans. On 2026-10-25, an orphan `find.exe` of a session held 1.3 million handles, the paged pool grew 593 MB an hour, and headroom named no owner. The alert `handles` (`runaway:handles:<pid>`) warns above 100,000 handles or a gain of 20,000 in 5 minutes, and is critical above 500,000. The daemon records the owner and the command line of each process at its first read, and the table `process_owners` keeps them over a restart. An orphan shows as `<owner> (orphan)` in the owners lists and the CPU runaway alert. `headroom status` gives the sum of the handles. | done |
| H49 | The memory of the processes that headroom cannot open. On 2026-10-25, the protected services and the minimal processes counted as 0, approximately 7.5 GB. One read of `SystemProcessInformation` gives the private memory and the private working set of each process, with no open. The minimal processes have their own owners (`system:memory compression`, `system:registry`, `system:secure system`), and the VM stays in `docker (VM)` one time. Three new kernel owners give the locked pages, the PFN database and the page tables. The row `unattributed` of `headroom status`, the top bar and the memory card of the dashboard give the memory in use that no owner holds: 4.0 GB, mostly the shared pages. `headroom docker` gives the local clock. | done |
| H50 | The system file cache. On 2026-10-25, the cache grew to 10.1 GB two times, the available memory stayed near 1 GB for 22 minutes, and the reaper of Claude Code stopped jobs. Windows Search read 350 MB each second from the files of the sessions. The owners `system:search` and `system:defender` show the indexer and the scanner. The engine counts the reads of each owner. The alert `cache` warns when the cache holds 4 GB or more and less than 6 GB is available, and names the top readers and writers. headroom does not trim the cache: the daemon has no privilege for it. Mark removes `D:` from the scope of Windows Search. | in progress |
| H51 | The alert names the driver of each pool tag that grows. `driversOf` finds no driver for the tags of ReFS (`MSb+`, `MSpa`, `MSde`), so the alert of 2026-10-29 named none. Add a table of the known tags (docs/DEV-DRIVE.md, "The pool tags and their drivers") for the tags that the driver files do not hold as text, and give one line for each tag in the alert, with its driver and its advice. | next |

## The MCP gateway (H11)

A stdio MCP server has one pipe to one client. Claude Code starts each stdio server for each session, so 11 sessions run 11 copies. On 2026-10-19, 127 MCP processes held 8.5 GB of private memory.

- headroom starts each local MCP server that keeps no state for a session. It starts one copy only.
- headroom connects to it as an MCP client, and serves it at `http://127.0.0.1:4730/mcp/<name>`.
- The sessions use that URL as an `http` server. A token in a header protects it.
- headroom starts a server again after a crash. It reports the memory of each server as the owner `mcp:<name>`.
- A server that keeps state for each session stays a stdio server: for example playwright, with one browser for each session.

The state on 2026-10-19:

- The gateway works: `headroom mcp add`, `list`, `remove`, `restart` and `config`. The gateway is a face of the host on the listener of the daemon. Each session gets an MCP session of its own. The gateway sends each request, its cancel and its progress to the one copy.
- A test sent two sessions to the MCP server of Vex. One process of 51 MB answered both. Before, each session started its own chain of 4 processes, approximately 260 MB.
- The bridge `bridge.mjs` connects a program that starts only stdio servers to the gateway. When the gateway does not serve the server, it starts the usual command. It uses approximately 30 MB for each session.
- The rollout waits for the owner of each server. The plugin of Vex has the largest gain: 60 processes and 2.1 GB on 2026-10-19. The `loom` server of jarvis has 15 processes and 710 MB.

## Version 0

Version 0 is H1, H2 and H3. Its leases are advisory: headroom grants and records them, but it does not stop a job that grows past its lease. H6 adds the limit.
