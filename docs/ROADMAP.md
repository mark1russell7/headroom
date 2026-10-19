# The roadmap of headroom

Mark approved the plan on 2026-10-19. The plan follows his design rule: choose the most general option for the long term.

## The design

### The resources

- A resource is a named pool with an amount: `memory` in MB, `cpu` in processors, or a count of slots, for example `docker` or `npm-publish`.
- The capacity of `memory` is measured, not configured. It is the available memory of the computer, less a reserve.
- The capacity of the other resources is configured in the database.

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
| H0 | The repository, the plan and the tracker | in progress |
| H1 | The sampler: the memory counters, the owner of each process tree, the history in SQLite | next |
| H2 | The leases: the pools, the admission rule, the queue, the release on process exit | next |
| H3 | The daemon: the `resources.*` procedures on `runProcedureHost` over HTTP, and the `headroom` CLI | next |
| H4 | The MCP face: the tools, and a long wait as an MCP task (after client CLI-11 and CLI-35) | later |
| H5 | The hub: the organizer writes the state of headroom into the `resources` collection of the Fleet Hub | later |
| H6 | Enforce on Windows: a job object with a memory limit, and a stop when the job closes | later |
| H7 | Enforce on Linux and WSL: a cgroup with `MemoryMax` | later |
| H8 | A Claude Code hook that sends each heavy command through `headroom run` | later |
| H9 | Alerts: kernel pool growth and a commit charge near its limit, sent with `notify.send` | later |
| H10 | More resource kinds: Docker, the npm publish quota, GitHub Actions minutes | later |
| H11 | Measure the memory of the MCP servers of each session, then decide on one shared copy | later |
| H12 | Start the daemon at login, and start it again after a crash | later |

## Version 0

Version 0 is H1, H2 and H3. Its leases are advisory: headroom grants and records them, but it does not stop a job that grows past its lease. H6 adds the limit.
