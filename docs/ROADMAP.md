# The roadmap of headroom

Mark approved the plan on 2026-10-19. The plan follows the design rule of Mark: choose the most general option for the long term.

## The design

### The resources

- A resource is a named pool with an amount: `memory` in MB, `cpu` in processors, or a count of slots, for example `docker` or `npm-publish`.
- The capacity of `memory` is measured, not configured. It is the available memory of the computer, less a reserve.
- The capacity of the other resources is configured in the database.
- `docs/RESOURCES.md` gives the general model (H22): each resource has the same five parts. Memory is its first resource, and disk is the second.

### The leases

- A lease has a holder (a session or a role), a job name, the amounts that it asks for, a priority and a heartbeat.
- headroom grants a lease when the reserved amounts plus the request fit in the capacity, and the measured free memory also has room.
- Requests wait in a queue in the order of their priority, then of their time. A long wait raises the priority, so no request waits forever.
- A lease can name a process. headroom releases the lease when that process exits. A lease without a process expires when its heartbeat stops. Thus a crash cannot hold a lease forever.

### The observations

- The sampler reads the available memory, the commit charge, the kernel pools and the memory of each process.
- It gives each process tree to an owner: a Claude Code session (from `claude agents --json`), Docker, the browser or other.
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
| H13 | The resume plan: the command of each live session, for a reboot | done (v0) |
| H14 | Runaway alerts: a process above 4 GB that has no lease, or a process whose parent stopped. headroom reports to the organizer. It does not stop the process. | done |
| H15 | The dashboard: a page of the daemon at `http://127.0.0.1:4730/`, and `headroom dashboard` | done |
| H16 | The Dev Drive: the code and the package caches on a ReFS volume. `docs/DEV-DRIVE.md` gives the plan. | done: the move is done, the lessons are in `docs/DEV-DRIVE.md` |
| H18 | Disk space: alerts for low free space, and headroom run waits on a full disk | done |
| H19 | Disk: each job gets its own `TEMP` and `TMP` folder on the Dev Drive `D:`. The release removes it. | done: `headroom config job-temp`, a temp folder for each lease, `--keep-temp`, and the sweep of the daemon every 10 minutes |
| H20 | Disk: who writes. The bytes that each session, MCP server and job writes, from the I/O counters of its processes. | done: one counter tracker gives the writes and the cores of each owner. `Status.writes`, the owners of each instance in `Status.resources`, the disk alert and `headroom status` name the owners. The store keeps the writes of each owner each minute. |
| H21 | Disk: a report of what uses the space, and a safe cleanup. It removes only data that is disposable by definition. All other data goes to Mark first. The `*.before-devdrive` copies stay. | later |
| H22 | One resource model: memory, disk, then CPU and more. Each resource has the same five parts: measure, attribute, alert, admit and enforce. | done: memory, disk, CPU, network and services are on the model. The design is `docs/RESOURCES.md`. Steps 1 to 4 shipped in #29, #30 and #31: the types, the broker on two admit modes, `Status.resources` and the alert rules. Step 5 makes disk a lease resource (`--disk 5g`, `--disk D:=5g`). Step 6 is H19. Step 7 is H20. Step 8 has its own item, H21. |
| H23 | CPU on the resource model: the processors get the five parts of the model | in progress: the measure and the attribute part came with H20. They give the cores in use and the cores of each owner. Next: the CPU alert, then the admit part and the enforce part. |
| H24 | The network on the resource model: the throughput of the adapters, the dynamic TCP ports and the listening ports | done: `net:in` and `net:out` in MB/s, `ports:tcp` with the connections of each owner, the `ports` alert, `headroom ports` and `resources.ports` |
| H25 | The dashboard: one panel for each resource, from the model | done |
| H26 | The state of a job: `headroom job <name\|id>`, for the fleet's typed wait `job:<name>` | done |
| H27 | Service health: Docker, the MCP servers of the gateway, the fleet site | done |
| H28 | UX round 1: the dashboard and the tracker. The dashboard shows what uses the computer, opens each panel to its history and shows the jobs on a timeline. | done |
| H29 | Process starts by owner | later |

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
