# The resource model of headroom

On 2026-10-24, Mark decided that headroom becomes the general resource manager of this computer (hub decision `2026-10-24-headroom-resources`). Memory and slots come first. Disk is next. CPU, network, ports and GPU follow when the fleet competes for them.

This document gives one model for all of them. Memory is the first resource on the model. Disk is the second resource, not a special case. The roadmap item is H22.

## The words

- A **resource kind** is a type of resource, for example `memory`, `disk` or `cpu`.
- An **instance** is one resource that headroom measures or counts. A kind can have several instances, for example one disk for each mount.
- The **id** of an instance is the kind, or the kind and a colon and the instance: `memory`, `cpu`, `disk:C:`, `disk:D:`. A lease amount names an id.
- An id with no known kind is a **slot**, as today: `browser`, `docker`, `npm-publish`.
- An **owner** is a Claude Code session, an MCP server of the gateway, a service, a lease, Docker, the system or the kernel.

## The model

Each resource kind has the same five parts:

1. **Measure**: the capacity, the used part and the free part of each instance, in the unit of the kind.
2. **Attribute**: the use of each owner, from the data of its processes.
3. **Alert**: the rules on the free part, on the growth, and on owners that use much more than the others.
4. **Admit**: how the broker compares a lease amount with the free part, less a reserve.
5. **Enforce**: what the job object of `headroom run` can limit, and what headroom can only report.

The kinds are in one registry. A part that a kind does not have is `null`.

```ts
/** One instance of a resource: `memory`, `cpu`, `disk:D:`, `browser`. A lease amount names it. */
export type ResourceId = string;

/** The kinds. An id with no known kind is a slot, as today. */
export type ResourceKind = "memory" | "commit" | "pool" | "desktop" | "disk" | "cpu" | "slot" | "net" | "ports" | "service" | "procs" | "battery" | "power" | "gpu";

/** The unit of the amounts of a kind. Disk writes use MB/h, and the network uses MB/s. A service has a state (H27). The process starts use "per minute" (H29). The battery uses Wh, and the power uses W (H30). */
export type Unit = "MB" | "cores" | "count" | "MB/h" | "MB/s" | "state" | "per minute" | "Wh" | "W";

/** One resource kind with its five parts. */
export interface Resource {
  readonly kind: ResourceKind;
  readonly unit: Unit;
  readonly measure: Measure;
  readonly attribute: Attribute | null;
  readonly alert: AlertPart;
  readonly admit: Admit | null;
  readonly enforce: Enforce | null;
}

/** The kinds by name. */
export declare const RESOURCES: ReadonlyMap<ResourceKind, Resource>;

/** This function gives the kind of an id: `disk:D:` gives `disk`, and `browser` gives `slot`. */
export declare function kindOf(id: ResourceId): ResourceKind;
```

### The design rule: the sampler reads, the kinds calculate

The sampler reads the operating system one time for each tick, as today. Each part of a kind is a pure function of these reads. The parts have no clock and no input or output of their own. Thus the tests of a kind use fixed reads, as the tests of the broker do today.

```ts
/** The reads of one tick. The sampler makes them, and each kind uses its part. */
export interface Readings {
  readonly at: number;
  readonly memory: SystemMemory;
  /** The processes of this read and of the read before it. The rates come from the two reads. */
  readonly processes: readonly ProcessInfo[];
  readonly previous: readonly ProcessInfo[];
  readonly disks: readonly DiskSpace[];
  readonly load: SessionLoad;
  /** The processor times since the start of the computer (H23). */
  readonly cpu?: CpuTimes | undefined;
  /** The capacity of each configured pool, from the store. */
  readonly pools: Readonly<Record<string, number>>;
}
```

### 1. Measure

A measurement gives the capacity, the used part and the free part of one instance. The sampler gives the reads, and the kind gives one measurement for each instance.

- Memory has one instance. Its capacity is the physical memory, and its free part is the available memory.
- Disk has one instance for each fixed drive: `disk:C:` and `disk:D:`. Its free part is the space that this user can use.
- A kernel pool has no capacity that Windows tells. Its capacity is `null`, and only its used part counts.
- A slot has a configured capacity. Its used part is the sum of its granted leases.

```ts
/** The level of one instance at one tick. */
export interface Measurement {
  readonly id: ResourceId;
  /** The capacity, or `null` when the kind has no limit to measure, for example a kernel pool. */
  readonly capacity: number | null;
  readonly used: number;
  /** The free part, or `null` without a capacity. Memory: the available memory. */
  readonly free: number | null;
}

export interface Measure {
  /** This function gives the instances of the kind at one tick. */
  read(readings: Readings): readonly Measurement[];
}
```

### 2. Attribute

Attribution gives the use of a resource to each owner. `attribute()` in `owners.ts` gives the owner of each process today. The model keeps that function, and adds the lease of each process.

Each kind reads one counter of the processes:

| Kind | Counter | Windows | Linux |
|---|---|---|---|
| `memory` | The private bytes | `K32GetProcessMemoryInfo`, `PrivateUsage` (today) | `RssAnon` of `/proc/<pid>/status` (today) |
| `disk` | The bytes that the process wrote | `GetProcessIoCounters`, `WriteTransferCount` | `write_bytes` of `/proc/<pid>/io` |
| `cpu` | The processor time | `GetProcessTimes`, the kernel time and the user time | `utime` and `stime` of `/proc/<pid>/stat` |

- Memory is a level: the private bytes at this time. Disk and CPU are totals since the start of the process. Their use is the change between two reads.
- The sampler reads the new counters with the same process handle as the memory. Thus a read of the processes opens no more handles.
- `GetProcessTimes` also gives the start time of the process. A process ID that Windows gives again to a new process then does not give a false change.
- A process that exits between two reads loses its last change. The job object of a lease keeps the exact totals, so the report of a lease is exact.

```ts
/** The new counters of a process. Each one is a total since the start of the process. */
export interface ProcessInfo {
  // ...the fields of today: pid, ppid, name, privateMb, workingMb
  readonly startedAt?: number | undefined;
  readonly cpuMs?: number | undefined;
  readonly writeMb?: number | undefined;
}

/** The owner of each process at one tick. */
export interface Owners {
  /** The owner of each process: `session:graph`, `mcp:vex`, `docker`, `system`. */
  readonly ownerOf: ReadonlyMap<number, string>;
  readonly kindOf: ReadonlyMap<string, OwnerKind>;
  /** The lease of each process under a granted lease: the lease process and its descendants. */
  readonly leaseOf: ReadonlyMap<number, string>;
}

/** The use of one resource by one owner. */
export interface OwnerUse {
  /** The kind: `memory`, `disk` or `cpu`. The disk counters do not name the drive. */
  readonly resource: ResourceKind;
  /** The owner, or `lease:<id>`. A lease row is a part of the row of its session, not an addition to it. */
  readonly owner: string;
  readonly kind: OwnerKind | "lease";
  readonly amount: number;
  readonly processes: number;
}

export interface Attribute {
  /** The unit of the use. Disk: MB/h written, not MB. */
  readonly unit: Unit;
  /** This function gives the use of each owner, the largest first. */
  read(readings: Readings, owners: Owners): readonly OwnerUse[];
}
```

### 3. Alert

The alert part of a kind is a list of rules. There are three types of rules:

- A **level** rule examines the free part or the used part of an instance. It has a warning limit, a critical limit, or both.
- A **growth** rule examines the change over a window, for example 500 MB of kernel pool in one hour.
- An **outlier** rule examines one process or one owner, for example a process above 4 GB with no lease.

A limit is an amount, a part of the capacity, or both. With both, the lower limit counts. Thus a small drive does not always alert, as today.

```ts
export type Level = "warning" | "critical";

/** A limit: an amount, a part of the capacity, or both. With both, the lower one counts. */
export interface Limit {
  readonly amount?: number | undefined;
  readonly ratio?: number | undefined;
}

interface RuleBase {
  /** The kind of the alert, as today: `memory`, `pool`, `disk`, `runaway`. */
  readonly alert: AlertKind;
  /** The id of the alert. The default is the id of the instance. `pool:nonpaged` keeps the id `pool`. */
  readonly alertId?: ((instance: ResourceId) => string) | undefined;
}

/** A rule on the level of an instance. `free`: below the limit. `used`: above the limit. */
export interface LevelRule extends RuleBase {
  readonly type: "level";
  readonly on: "free" | "used";
  readonly warning?: Limit | undefined;
  readonly critical?: Limit | undefined;
  /** The condition must continue for this time. CPU uses it, because short peaks are normal. */
  readonly forMs?: number | undefined;
}

/** A rule on the change of an instance over a window. */
export interface GrowthRule extends RuleBase {
  readonly type: "growth";
  /** `used`: a gain of the used part. `free`: a loss of the free part. */
  readonly on: "free" | "used";
  readonly windowMs: number;
  readonly warning: number;
  /** With less history than this, the rule gives no alert. The pool rule uses 50 minutes. */
  readonly minHistoryMs: number;
}

/** A rule on one process or one owner. */
export interface OutlierRule extends RuleBase {
  readonly type: "outlier";
  readonly subject: "process" | "owner";
  readonly above: number;
  /** The owner kinds that the rule does not examine. `runaway` skips docker, system and kernel. */
  readonly skip: readonly OwnerKind[];
  /** `unleased`: no lease holds the process. `orphaned`: its parent stopped. */
  readonly when: "always" | "unleased" | "orphaned";
}

export type Rule = LevelRule | GrowthRule | OutlierRule;

export interface AlertPart {
  readonly rules: readonly Rule[];
  /** This function adds the names that help the reader: the pool tags that grow, the new large files, the top writers. */
  explain?(alert: Alert, readings: Readings, owners: Owners): string;
}
```

The alerts of today go onto the rules with no change to their ids, kinds, messages or severities:

| Alert of today | Kind | Rule |
|---|---|---|
| `memory` | `memory` | Level on free: below 1024 MB. |
| `commit` | `commit` | Level on used: above 90% of the commit limit. |
| `pool` | `pool` (`pool:nonpaged`) | Level on used: above 3072 MB. Growth of used: more than 500 MB in one hour. |
| `pool:paged` | `pool` (`pool:paged`) | Level on used: above 4096 MB. Growth of used: more than 500 MB in one hour. |
| `desktop` | `desktop` | Level on used: above 1000 processes. |
| `disk:<mount>` | `disk` | Level on free: a warning below 20 GB or 20%, critical below 5 GB or 5%. |
| `runaway:<pid>` | `memory` | Outlier: a process above 4096 MB, with no lease. Docker, the system and the kernel are not examined. |
| `orphan:<pid>` | `memory` | Outlier: a process above 1024 MB with an owner of the kind `other`, whose parent stopped. |
| `stop:*` | none | An event of the daemon, not a rule of a resource. It stays as it is. |

- The pool tags, the new large files and the top writers come from `explain()`. Thus `detect()` adds no special text for a kind.
- `AlertRules` keeps its fields. They become the defaults of the rules, so a test that sets `diskWarnMb` continues to work.

### 4. Admit

A lease asks for amounts by id: `{ memory: 2048, "disk:D:": 5120, browser: 1 }`. The broker grants the lease when each amount fits in the free part of its id.

The broker has two modes:

- **Measured**: the operating system gives the free part. The broker uses the measured free part, less the reserve, less the unspent part of each granted lease.
- **Counted**: the store gives the capacity. The broker uses the capacity, less the sum of the granted amounts. A slot is counted.

The unspent part of a lease is its amount less the part that its job uses at this time. A job that starts uses little memory, but it holds the rest of its amount. This rule is the `MEMORY` special case of `Broker.free()` today. The model makes it the rule of each measured kind.

```ts
/** How the broker compares a lease amount with an instance. */
export interface Admit {
  readonly mode: "measured" | "counted";
  /** The amount that the broker keeps free (measured). Memory: 1024 MB. Disk: the critical limit. CPU: 1 core. */
  readonly reserve: Limit;
  /** The capacity of an instance with no measurement and no configuration. A slot: 1, a lock. */
  readonly defaultCapacity?: number | undefined;
  /** The part of a granted lease that its job uses at this time. Without it, the lease keeps its full amount. */
  used?(lease: Lease, id: ResourceId, readings: Readings, owners: Owners): number;
  /** At this level of an instance, no job starts, also a job with no amount of it. Disk: `critical`. */
  readonly gate?: Level | undefined;
}

/** The room of one instance, from its measurement and its admit part. The engine gives it to the broker. */
export interface Room {
  readonly mode: "measured" | "counted";
  readonly capacity: number;
  /** The measured free part. It is `null` for a counted instance. */
  readonly free: number | null;
  readonly reserve: number;
}
```

The broker then has one rule for each id, with no name of a kind in it:

```ts
// free(id), for a measured id:
//   room.free - room.reserve - sum over the granted leases of max(0, amount(id) - used(lease, id))
// free(id), for a counted id:
//   room.capacity - sum over the granted leases of amount(id)
// A lease cannot fit at any time when amount(id) > room.capacity - room.reserve. The broker then cancels it.
// An id with no room is a slot with the capacity 1, as today.
```

- `Capacity` gets a field `rooms: Record<ResourceId, Room>`. The engine fills it from the measurements and the configured pools.
- `BrokerOptions.usedMb` becomes `used(lease, id)`. `usedMb` stays as the memory case of `used`.
- A lease for a drive that does not exist, for example `disk:Q:`, gets the capacity 0. The broker cancels it at once with a clear reason.

**Conflicts (H47).** Some leases cannot run at the same time, also when each amount fits. `BrokerOptions.conflict(lease, other)` gives the reason, or `null`. The broker has no name of a kind in it.

- The broker examines the amounts first. When the amounts fit, it examines each granted lease, and each lease that waits before the lease in the queue.
- A lease that conflicts with an earlier waiting lease waits too. Thus a stream of later leases cannot keep an earlier lease in the queue forever.
- The queue order is the order of the broker: the priority with the aging, then the time of the request.
- The engine gives the spawn rule of H47: a spawn-heavy lease and a lease with the slot `browser` do not run at the same time.
- `BrokerOptions.groupConflict(lease, granted, before)` examines all the other leases together, after the pairs. The engine gives the sum of the start rates of H47.

**Conditions (H31).** Some leases wait for a fact, not for an amount. `BrokerOptions.condition(lease)` gives the reason of the wait, or `null`. The broker has no name of a condition in it.

- The broker examines the conditions first, then the amounts, then the conflicts.
- A lease that waits for a condition has no place in the queue. It does not hold the head after a long wait, and no later lease waits for it in a conflict.
- The engine gives `conditionWait()` of `conditions.ts`: the `--when` conditions, `--timing` and the battery floor.

### 5. Enforce

`headroom run` holds each job in a job object (H6). The enforce part of a kind tells what the job object can limit. Without a limit, headroom only reports the use of the job at its release.

| Kind | Limit of the job object | Without a limit |
|---|---|---|
| `memory` | `JOB_OBJECT_LIMIT_JOB_MEMORY`, with `--limit` (today) | The peak memory of the job (today) |
| `cpu` | `JobObjectCpuRateControlInformation` with `JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP`, with `--limit` | The processor time of the job |
| `disk` | None. Windows has no space quota for one job. | `TEMP` and `TMP` of the job on the Dev Drive (H19), and the bytes that the job wrote |
| `desktop` | Later: `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` | The count of processes |
| `net`, `ports` | None | Report only |

- The CPU rate of a job is in cycles for each 10,000 cycles of all the processors. A lease of 2 cores on 16 processors gives a rate of 1250.
- The job object gives the totals of the job in `JobObjectBasicAndIoAccountingInformation`. This class gives the processor time and the bytes written, also of the processes that exited.
- On Linux (H7), a cgroup has the same parts: `memory.max`, `cpu.max` and `io.max`. `io.max` limits the speed of the writes, not the space.

```ts
/** The limits that `headroom run` sets on the job object (Windows) or the cgroup (Linux, H7). */
export interface JobLimits {
  /** JOB_OBJECT_LIMIT_JOB_MEMORY (today). */
  readonly memoryMb?: number | undefined;
  /** JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, in cycles for each 10,000 (H23). */
  readonly cpuRate?: number | undefined;
  /** JOB_OBJECT_CPU_RATE_CONTROL_WEIGHT_BASED, from 1 to 9 (H23). A cap wins over a weight. */
  readonly cpuWeight?: number | undefined;
}

/** The environment of a job, from its lease. The release removes the folders. */
export interface JobSetup {
  readonly env: Readonly<Record<string, string>>;
  readonly folders: readonly string[];
}

/** The use of a job at its release, from its job object. Today only `peakMb` exists. */
export interface JobUsage {
  /** JOBOBJECT_EXTENDED_LIMIT_INFORMATION.PeakJobMemoryUsed (today). */
  readonly peakMb?: number | undefined;
  /** JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION: IoInfo.WriteTransferCount. */
  readonly writtenMb?: number | undefined;
  /** JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION: TotalUserTime and TotalKernelTime. */
  readonly cpuMs?: number | undefined;
  /** The size of the temp folder of the lease, before the release removes it (H19). */
  readonly tempMb?: number | undefined;
}

export interface Enforce {
  /** The limit for an amount, with `--limit`. `null`: the kind has no limit, so headroom only reports. */
  limit(amount: number): Partial<JobLimits> | null;
  /** The setup of a job for its lease. Disk: TEMP and TMP under the temp root. */
  setup?(lease: Lease): JobSetup;
  /** The fields of `JobUsage` that the kind reports at the release. */
  readonly report: readonly (keyof JobUsage)[];
}
```

The enforce part works in the process of `headroom run`, not in the daemon. The client imports the registry from `@headroom/core`, so the daemon and the client use the same parts.

## The resources

| Resource | Measure | Attribute | Alert | Admit | Enforce |
|---|---|---|---|---|---|
| `memory` (MB) | Capacity: the physical memory. Free: the available memory. | The private bytes of each process tree. | Level: free below 1 GB. Outliers: `runaway` and `orphan`. | Measured. Reserve: 1024 MB. A lease keeps its amount less the private bytes of its tree. | `JOB_OBJECT_LIMIT_JOB_MEMORY` with `--limit`. Report: the peak. |
| `commit` (MB) | Capacity: the commit limit. Used: the commit charge. | The private bytes of `memory`. They are the commit of each process. | Level: used above 90%. | None. A memory lease covers it. | The memory limit of a job is a commit limit. |
| `pool:nonpaged`, `pool:paged` (MB) | Used only. Windows tells no capacity. | By pool tag, not by process. A tag names its driver. | Level: used above 3 GB or 4 GB. Growth: 500 MB in one hour. | None. | None. Report only. |
| `desktop` (count) | Used: the processes of the session, and the USER and GDI objects. | The processes of each owner. | Level: used above 1000 processes. | None. The `browser` slot limits the largest cause. | Later: `JOB_OBJECT_LIMIT_ACTIVE_PROCESS`. |
| `disk:<mount>` (MB) | One instance for each fixed drive. Capacity: the size. Free: the space for this user. | H20: the bytes that each owner writes, in MB/h. The counters do not name the drive. | Level on free: a warning below 20 GB or 20%, critical below 5 GB or 5%. Outlier: an owner writes more than 20 GB in one hour. | Measured. Reserve: the critical limit. Gate: at critical, no job starts. | No quota. H19: `TEMP` and `TMP` of the job on `D:`. Report: the bytes written. |
| `cpu` (cores) | H23. Capacity: the logical processors. Used: the cores in use, as a 1-minute average. | The processor time of each owner, of each leased job and of each process tree with no lease. | Level `cpu`: used above 85% (warning) or 95% (critical) for 5 minutes, clear after 2 minutes below. Outlier: a process tree above 4 cores for 10 minutes with no lease. | Counted. Reserve: 2 cores for Mark, from `headroom config cpu-reserve`. A configured pool `cpu` is a cap. | With `--limit`: a hard cap of the CPU rate on the job object. Without it: the weight 5 of 9. Report: the processor time and the peak cores. |
| Slots: `browser`, `docker`, each name (count) | Capacity: configured with `headroom pool`, else 1. Used: the granted leases. | The holders of the granted leases. | Later: a lease that waits more than 30 minutes for a slot. | Counted. A command pattern takes a slot by itself, as `browser` does. | None on the job. The lease ends with its process. |
| `net:in`, `net:out` (MB/s) | H24. The bytes of the physical and Wi-Fi adapters: `GetIfTable2`, `/proc/net/dev`. Used: the MB/s between two reads. Capacity: the sum of the link speeds, else `null`. | None. The bytes of each process need ETW and admin rights. | Later: a link that stays full. | None. Later: a slot for large downloads. | None. Report only. |
| `ports:tcp` (count) | H24. The TCP connections of IPv4 and IPv6: `GetExtendedTcpTable`, `/proc/net/tcp`. Capacity: the dynamic port range. Used: the connections with a local port in the range, in each state. | The connections of each owner, from the process of each row. `headroom ports` gives the listening ports of each owner. | Level on used: a warning above 80%, critical above 95%. | None. Later: a port lease for dev servers. | None. Report only. |
| `procs` (per minute) | H29. The process starts in one minute, as an average over the last 10 minutes. Windows: exact, from the sequence number of the newest process. Elsewhere: a lower bound. Capacity: `null`. | The starts of each owner: its leased jobs (exact, from the job objects) and its own commands (a lower bound, the new processes of each read). | Level on used: a warning above 600 for 10 minutes (`churn`). | None. | None. Report only: the lease keeps `processes`. |
| `battery` (Wh) | H30. Capacity: the full charge. Free: the remaining charge, from `CallNtPowerInformation(SystemBatteryState)`. The measurement also has the power source, the charge state, the percent, the rate in W and the minutes left. No battery: no instance. Linux and macOS: no instance. | None. | Check: a warning below 30 minutes left, critical below 10 minutes or 10%. A warning when leased jobs run on battery. On AC power, no alert. | No amount. The conditions of H31 read the power source and the charge: `ac`, `battery>=N` and the battery floor. | EcoQoS for the processes of `headroom run` on battery, from the answer of the heartbeat. `--no-eco` turns it off. |
| `power` (W) | H30. Used: the power of the whole computer, from the counter `\Energy Meter(*)\Power` (PDH). Capacity: `null`. No counter set: no instance. Linux and macOS: no instance. | An estimate: the CPU power, shared by the processor time of each owner. | None. The battery alert names the 3 owners with the most power. | None. | A power request keeps the computer awake on AC power while a lease is granted. |
| `service:<name>` (state) | H27. One instance for each shared service: `service:docker`, `service:mcp:<server>` and each URL of the setting `health`. The measurement has the health: `ok`, `slow`, `down`, `idle` or `absent`. Used: the latency of the last check in ms. | None. | Health: down for 2 checks in a row, critical for Docker and the MCP servers, else a warning. Slow for 3 checks: a warning. | None. | None. headroom does not restart a service. |
| `gpu:<adapter>` (later, MB) | The dedicated memory of each adapter. | The counter `GPU Process Memory` of each process. | Level on free. | Measured, as `memory`. | None. A job object has no GPU limit. |

## The migration

### What stays the same

Memory moves onto the model with no change for its callers:

- The procedures `resources.*` keep their paths and their inputs. Each new input is optional.
- `headroom run` keeps its flags: `--mem`, `--mem auto`, `--cpu`, `--slot`, `--limit`, `--keep`, `--no-auto-slot` and `--force-disk`. It keeps its exit codes 75 and 2.
- `Status` keeps `memory`, `reserveMb`, `free`, `pools`, `owners`, `alerts`, `session`, `disks` and `self`. The hook reads `free.memory`, and the dashboard reads `free.memory` and `reserveMb`.
- `MemoryRow` keeps its fields. The tables `memory`, `owners` and `leases` stay.
- The alerts keep their ids, kinds, messages and severities. `Lease` keeps `peakMb`.

The model adds fields only: `Status.resources`, `History.resources`, `Lease.usage`, and the flag `--disk`. `status.free` gets new keys, for example `disk:D:`. `headroom status` shows each amount in the unit of its kind.

### The steps

Each step is one small PR with its tests. Each step works without the next step.

1. **The types** (H22). Add `packages/core/src/resources.ts`: the interfaces, `kindOf()`, and the parts of `memory` and of a slot. No caller changes. The tests compare the parts with the numbers of today.
2. **The broker on `Admit`** (H22). `free()` and the two checks of `tick()` read the mode of each id. The `MEMORY` special case goes. The broker tests pass with no change, and a new test adds a second measured kind.
3. **The engine on `Measure`** (H22). The engine keeps the measurements of each tick. It adds `Status.resources`, `History.resources` and the table `resource_samples`. Memory, commit, the pools, the desktop, the disks and the slots become measurements.
4. **The alerts on `Rule`** (H22). `detect()` reads the rules of each kind. The alert tests pass with no change.
5. **Disk as the second lease resource**. A lease can ask for `disk:<mount>`. `headroom run --disk 5g` asks for space on the drive of the current folder, and `--disk D:=5g` names the drive. The gate of the critical level moves into the admit part of disk.
6. **H19: the temp folder of each job**. This step sits on enforce.
7. **H20: who writes**. This step sits on attribute and alert.
8. **H21: the report and the safe cleanup**. This step sits on measure and enforce.
9. **H23: CPU on the model**. This step fills all five parts of `cpu`.

Steps 1 to 4 put memory on the model. Step 5 makes disk the second resource. H19 does not need steps 2 to 5. If the drive fills again before step 5, H19 can go first.

### What steps 1 to 4 changed in the types

Steps 1 to 4 shipped in #29, #30 and #31. The code in `packages/core/src/resources.ts` differs from the types above in these points:

- `AlertPart.rules` is a function of `AlertRules`. Thus a caller that sets `diskWarnMb` changes the limit of the disk rule.
- Each rule has a function `text`. It gives the subject, the message and the size of the alert, so `detect()` adds no text of its own.
- A level rule and a growth rule can name one `instance`. The two kernel pools have different limits and messages.
- A rule with `severity: true` gives its level in `Alert.severity`. Only the disk rule has it, as before.
- An outlier rule can have a list `only`. The orphan rule examines only the owners of the kind `other`.
- `Attribute.counter` gives the counter of one process. The outlier rules compare it with their limit.
- `Measurement.used` can be `null`. The processors have no used part until H23.
- `Readings` has `processors`, the count of logical processors, and `granted`, the sum of the granted amounts of each id.
- `cpu` is counted, with the count of processors as its capacity. H23 keeps it counted and adds a reserve of 2 cores for Mark.
- `detect()` gives at most one alert for each process, and one alert for each alert id. The first rule wins.
- `explain()` has no implementation yet. The engine still adds the pool tags and the large files to the messages.

### What steps 5 and 6 changed

Steps 5 and 6 differ from the design above in these points:

- `Admit` has the field `reserveFrom`. With it, the reserve is the limit of that level in the level rule of the kind. Disk has `reserveFrom: "critical"`, so its reserve follows `diskCriticalMb`.
- The gate of the critical level stays in `headroom run`. The client examines each drive before its lease request, as before.
- The temp root is the setting `jobTemp` in the new table `settings`. The procedures `config.get` and `config.set` read and change it. `headroom config job-temp <folder>` uses them.
- `Enforce.setup()` has no implementation. The temp root is a setting, not a part of the lease. Thus `jobTempSetup(root, leaseId)` in `temp.ts` gives the setup.
- `Lease.usage` and the column `usage` of `leases` keep the use of the job. The client reports `peakMb` and `tempMb`. `writtenMb` is not reported yet.
- The sweep of the daemon removes a folder only when the store has its lease and the lease ended. A folder with another name stays. A folder with the mark of `--keep-temp` stays.

### The history and the dashboard (H25)

- `History.resources` gives the points of each id: `[at, used, free]`, the oldest first. A step longer than one minute averages each step, as for the memory.
- The dashboard makes one panel for each entry of `Status.resources`, from its kind and its unit. Thus a new kind gets a panel with no change to the page.
- A panel opens to a chart of its points in the window, with all the owners of its instance (H28).
- The top bar of the dashboard adds up three parts. They are the memory in RAM of each entry of `Status.owners`, the part that no owner explains and the available memory.

### What step 7 changed

Step 7 (H20) differs from the design above in these points:

- Windows reads the totals of each process with one call of `NtQuerySystemInformation(SystemProcessInformation)`, not with `GetProcessIoCounters`. The call opens no process, so the protected processes and the process `System` have totals too.
- `ProcessInfo` has `startedAt`, `cpuMs`, `readBytes` and `writeBytes`. The write total is in bytes, not in MB.
- One counter tracker in `counters.ts` gives the change of each total for each owner. The disk and the processors use the same tracker.
- The tracker keeps the last totals of the live processes, the reads of the last 10 minutes and the minutes of the last hour. A process that the previous read did not have starts at its first read. Only a process that started after the previous read counts with its full total.
- `Readings.writes` and `Readings.cores` give the windows of the tracker to the parts. The attribute part of disk gives the MB of the last hour of each owner. The attribute part of `cpu` gives the cores of each owner over the last minute.
- The measure of `cpu` gives the cores in use: the sum over the processes. The broker still counts `cpu`.
- `Status.writes` gives the 10 owners that wrote most in the last hour. Each entry of `Status.resources` has its 10 largest owners, with no lease rows.
- The store keeps the writes of each owner in the column `write_mb` of `owners`, not in a new table `owner_use`. The engine reads the minutes of the last hour at its start.
- The text of the disk rule names the owners, not `explain()`.
- The outlier rule on an owner (20 GB in one hour) and the lease rows of disk and `cpu` are not in this step.
- The process `System` writes the file cache and the pages of mapped files. Thus one write can count for its process and for the owner `system`.
- The Windows counters charge to `system` the disk writes of cached files and of the page file. The lazy writer and the memory manager write them, so `system` can hide the real writer.

### The kernel owners and the services

On 2026-10-24, after a start of the computer, the owners held approximately 16 GB of 27.6 GB of RAM. The file cache held 10.1 GB, and no owner had it. Since this step, the RAM of the owners and the available memory add up to approximately the physical memory.

**The kernel owners.** `kernelOwners()` in `owners.ts` gives the memory that no process holds. Each owner has the kind `kernel` and no process.

| Owner | Private | In RAM | Windows counter |
|---|---|---|---|
| `kernel` | The size of the two pools, as before | The non-paged pool and the paged pool in RAM | `Pool Nonpaged Bytes`, `Pool Paged Resident Bytes` |
| `kernel:cache` | The same as in RAM | The working set of the system cache | `System Cache Resident Bytes` |
| `kernel:drivers` | The same as in RAM | The code of the kernel and of the drivers | `System Driver Resident Bytes`, `System Code Resident Bytes` |

- The sampler reads the three amounts with one call of `NtQuerySystemInformation(SystemPerformanceInformation)`. The call gives the same page counts as the counters, and it needs no admin rights.
- `SystemCache` of `GetPerformanceInfo` also counts the standby pages of the cache. The standby pages are available memory, so headroom does not use that field.
- `SystemMemory` has `cacheMb`, `kernelPagedResidentMb` and `driversMb`. Linux does not give them, so Linux has only the owner `kernel`.
- On this computer on 2026-10-25, the owners held 19.4 GB in RAM, and 7.2 GB was available, of 27.6 GB. The difference of approximately 1.7 GB is the pages that wait for a disk write, the page tables and the shared pages.

**The services.** Task Scheduler starts the daemon of headroom and the fleet site. Before this step, their owner was `system`, because `svchost.exe` is their ancestor.

- The Windows sampler reads the command line of each new `node.exe` with `NtQueryInformationProcess(ProcessCommandLineInformation)`. It keeps the option `--title=<name>` for each process ID and start, and it forgets the processes that stopped.
- A title replaces the rule `system` farther up. Thus `node --title=headroom-daemon` from Task Scheduler is the owner `service:headroom-daemon`, with its descendants. The kind is `service`.
- A session and a server of the MCP gateway win over a title. A title under another rule, for example the editor, gives that rule. A title with no rule farther up is an orphan, so it stays `other`.
- The runaway rule examines the services, because a service is not the system.
- The owner `service:fleet-site` is the process of the health instance `service:fleet-site` (H27), when the title and the name are the same.

**The pool tags after a start.** The store keeps the pool tag snapshots (PR #26). A start of the computer empties the pools, so the change of a tag across a start is not a change.

- The sampler gives `bootedAt()`: the time of the read less `GetTickCount64`. Linux uses `os.uptime()`.
- The engine loads only the snapshots after the start. `poolTags()` and the growth rules of the pools compare only reads after the start.

### H19: the temp folder of each job

`headroom run` gives each job its own `TEMP` and `TMP` folder on the Dev Drive. Large test output then goes to `D:`, and a job cannot fill `C:` through its temp folder.

- The folder is `<temp root>\<lease id>`. The temp root is a setting of the store, for example `D:\headroom\tmp`. Without the setting, the job keeps the `TEMP` of its parent, as today.
- The client sets `TEMP`, `TMP` and `TMPDIR` for the job. It removes the folder at the release, and reports its size in `JobUsage.tempMb`.
- The folder of a lease is disposable by definition: only headroom writes folders in the temp root, and each one belongs to one lease.
- A client that stops before its release leaves its folder. The daemon removes each folder whose lease is not active, at most one time each 10 minutes. A file that a process holds open stays until the next sweep.
- With `--keep`, the job keeps the `TEMP` of its parent. A service that the job starts on purpose can use its temp folder after the job ends.
- The client also reports `JobUsage.writtenMb` from the job object, for each job.

### H20: who writes

The sampler reads `GetProcessIoCounters` with the memory of each process. The disk part of attribution gives the MB that each owner wrote in the last hour.

- The use of an owner is the change of the write counters of its processes between two reads.
- The disk alert names the 3 owners that wrote most in the last hour, next to the new large files.
- An outlier rule starts a warning when one owner writes more than 20 GB in one hour. A trace file of 100 GB filled `C:` on 2026-10-24.
- The store keeps the use of each owner in a new table `owner_use`, one row for each owner and kind each minute.

The write counters have limits. headroom tells them in the dashboard and in the report:

- The counters count each write of the process, also to a pipe or a device, not only to a file.
- The counters do not name the drive. The use of an owner is for all the drives together.
- A write is not always new space. A file that a job writes again uses no new space. A ReFS block clone of pnpm writes almost nothing.
- The memory manager writes the pages of a mapped file. The counters of the process can miss these writes.

### H21: the report and the safe cleanup

`headroom disk report` shows what uses the space of each drive. `headroom disk clean` removes only the data that is disposable by definition.

The report gives, for each drive:

- The free part, the size and the loss of the last hour (measure).
- The owners that wrote most (H20).
- The size of each known folder: the temp root, the temp folders, the pnpm store and the npm cache.
- The size of the disk images of Docker and WSL, of `~/.claude/projects` and of the `*.before-devdrive` copies.
- The large files, from the search of H18.

The report reads many files. Thus it starts only on demand, with a time limit. A tick of the daemon does not start it.

`headroom disk clean` is a dry run. It deletes only with `--apply`. It deletes only these classes:

1. The folders of the temp root whose lease is not active (H19).
2. The files in the temp folders of the user that are older than 7 days and that no process holds open.
3. The unused packages of the pnpm store, with `pnpm store prune`.

All other data goes to Mark first. The report gives Mark the size of each folder, and numbered steps for each delete. The cleaner skips each path that contains `.before-devdrive`, also inside a disposable class. A test covers this rule. The `*.before-devdrive` copies go only when Mark decides (`docs/DEV-DRIVE.md`, part B, step 8).

### H23: CPU on the model

H23 shipped in one change. These parts are as built:

- **Measure**: the counter tracker of H20 reads the processor time of each process each 10 seconds. The used part is the sum of the cores of all the owners over the last minute. The capacity is `os.availableParallelism()`.
- **Attribute**: the cores of each owner. The tracker also keeps the processor time of two kinds of groups: each leased job (`lease:<id>`) and each process tree with no lease (`tree:<pid>`).
- **The root of a tree** is the top process of the same owner with no lease. For a session, the root is one level below the session process. Thus each command of a session is its own tree.
- **Alert `cpu`**: a warning when the cores in use stay above 85% of the capacity for 5 minutes, and a critical alert above 95% for 5 minutes. The alert names the 3 owners with the most cores, and their leased jobs.
- **Runaway tree**: a tree with no lease above 4 cores for 10 minutes gives the alert `runaway:cpu:<pid>`. Docker, the system and the kernel are not examined.
- **The time above a line** comes from a trail: the 1-minute average at each read of the last 11 minutes. The daemon has no new timer for it.
- **Clear**: an active alert stays until its trail is below its line for 2 minutes. The engine passes its active alerts to `detect()`, so a short dip does not clear an alert.
- **Admit**: counted, with a reserve of 2 cores. Thus the sum of the `--cpu` amounts of the running leases does not take the last 2 cores. `headroom config cpu-reserve <cores>` changes the reserve, and `0` turns it off.
- **A pool cap**: a pool `cpu` below the processors is a cap. Only the part of the reserve above the cores outside the pool counts. Thus a pool of 8 on 16 processors keeps all 8 for the leases.
- **Enforce**: `headroom run --cpu N --limit` sets `JobObjectCpuRateControlInformation` (class 15) with `ENABLE | HARD_CAP` and the rate N / processors × 10,000.
- **The weight**: without `--limit`, each job object gets `ENABLE | WEIGHT_BASED` with the weight 5. A failed call does not stop the job. The run writes a warning.
- **Report**: the run gives the processor time of the job object at the release. The lease keeps its peak cores: the highest 1-minute average of its group, or the average over the run for a short job.
- **`--cpu auto`** gives the 90th percentile of the peak cores of the last 20 runs and 25% more, the rule of `--mem auto`. The amount is at most the processors less the reserve. A job with no run gets 2 cores.

Before step 2, `cpu` was a counted pool with the capacity 1 when no pool set it. Thus `headroom run --cpu 2` without `headroom pool cpu 8` got cancelled. Step 2 corrects this: `cpu` is a counted kind, and its capacity is the count of logical processors. A configured pool `cpu` stays, as a cap. H23 keeps `cpu` counted, because the cpu amount of a lease is a promise of cores, not a measure of them.

### H24: the network and the TCP ports

On 2026-10-24, Mark asked if the model covers more than the disk. H24 puts the network on the model with two kinds: `net` and `ports`.

**Measure of the network.** The kind `net` has two instances, `net:in` and `net:out`, in MB/s for all the adapters together.

- Windows reads `GetIfTable2` of `iphlpapi.dll`, and `FreeMibTable` frees the table. Linux reads `/proc/net/dev`, and keeps each interface with a device in `/sys/class/net`.
- A row counts when it is up and has the flag `HardwareInterface`. A row with the flag `FilterInterface`, a loopback and a tunnel do not count.
- Each filter of an adapter has its own row with the bytes of the adapter. Thus the flag `FilterInterface` removes these rows, and no byte counts two times.
- The used part is the change of `InOctets` and `OutOctets` between two reads, divided by the time between the reads. The first read gives no used part.
- The capacity is the sum of the link speeds of the adapters. When no adapter tells its speed, the capacity is `null`.

**Measure of the ports.** The kind `ports` has one instance, `ports:tcp`. Its capacity is the dynamic port range: 49152 to 65535 on Windows by default, 16384 ports.

- The Windows sampler reads the range one time, at its first read, with `netsh int ipv4 show dynamicport tcp`. Without an answer, it uses the default.
- Linux reads the range from `/proc/sys/net/ipv4/ip_local_port_range`.
- `GetExtendedTcpTable` with `TCP_TABLE_OWNER_PID_ALL` gives each TCP row of IPv4 and of IPv6, with its process. It needs no admin rights.
- Linux reads `/proc/net/tcp` and `/proc/net/tcp6`. These files give no process, so the rows of Linux have no owner.
- The used part is the count of rows with a local port in the range, in each state. `TIME_WAIT` and `LISTEN` count. An IPv4 row and an IPv6 row on the same port count two times.

**Attribute.** The owner of a TCP row is the owner of its process.

- The owners of `ports:tcp` give the connections of each owner in the dynamic range, in the unit `count`.
- `headroom ports` and `resources.ports` give the listening ports with the process and the owner of each port.
- On Windows, a row in `TIME_WAIT` has no process, so it has no owner.
- The bytes of each process need ETW, with admin rights or the group `Performance Log Users`. Thus the kind `net` has no attribute part.

**Alert.** The kind `ports` has a level rule on the used part: a warning above 80% of the range, and critical above 95%.

- `portsWarnRatio` and `portsCriticalRatio` of `AlertRules` set the two limits.
- The message names the 3 owners with the most connections, and the count in `TIME_WAIT`. Thus the reader finds the process that opens many connections.
- `InstanceFacts` has the owners of the processes. The text of a level rule can then name the owners, and `detect()` has no special case.

**Admit and enforce.** The two kinds have none. Later: a port lease for dev servers.

**Cost.** On this computer on 2026-10-24, the two reads used approximately 2 ms together, every 10 seconds. `netsh` used approximately 280 ms, one time.

**The dashboard.** Each instance gets its panel from the model. A rate in MB/s shows its used part, not its free part.

### H27: the health of the shared services

On 2026-10-24, the Docker engine stopped to answer: `docker ps` stopped at its time limit, Mongo went down, and the e2e tests of graph lost it. The MCP server vex of the gateway did not start, because a package was missing. Nothing told the sessions. H27 puts the shared services on the model with the kind `service`.

**Measure.** The service monitor in `services.ts` reads the services, and the kind calculates, as the design rule tells.

- The monitor makes one round of checks every 30 seconds. Each check has a time limit of 3 seconds. The monitor does not start a check again before the last start of the check ends. A check that has not ended at the next round counts as a check with no answer.
- Docker: `GET /_ping` on the pipe of the engine, with the `socketPath` of `node:http`. The pipe is `\\.\pipe\docker_engine` on Windows and `/var/run/docker.sock` on Linux. No pipe (`ENOENT`) gives `absent`. headroom starts no `docker` process.
- The URLs: a `GET` of each URL of the setting `health`. A status below 500 is an answer. The default list has the fleet site only.
- The MCP servers: the state of the gateway, with no call. `running` and `starting` give `ok`. `stopped` gives `idle`. A failed start gives `down`, with the last error line of the stderr of the server. An exit gives `idle`, because the next request starts the server again. With 3 exits in 10 minutes, the server is `down`.
- An answer after more than 1 second gives `slow`.
- `Readings.services` gives the health of each service. The measure gives one instance for each service, with the health in the new field `Measurement.health`.
- The health has the state, the latency and the time of the check. It also has the start of the state and the count of checks in a row with the state.
- The health keeps the time of the last good check, and the last error with its time.

**Alert.** A fourth type of rule, the **health** rule, examines the state of a service and its count of checks in a row.

- Down for 2 checks in a row, approximately one minute: critical for Docker and the MCP servers, and a warning for a URL. The id of the alert is `service:<name>`.
- Slow for 3 checks in a row: a warning.
- `serviceDownChecks` and `serviceSlowChecks` of `AlertRules` set the two counts.
- An idle MCP server and an absent Docker engine give no alert.
- The message names the service, the start of the state and who needs the service. For an MCP server, it gives the last error line.

**Attribute, admit and enforce.** The kind has none. A lease does not ask for a service. headroom does not restart a service for an alert. A person or the session that owns the service decides.

**The setting.** The setting `health` in the table `settings` gives the URLs by name, as JSON. `config.get` and `config.set` read and change it. `headroom config health <name> <url>` adds a URL, and `--clear` removes one URL or sets the default list again.

**Status and the command.** `headroom status` gives one line, for example `Services: docker ok (12 ms), fleet-site ok (3 ms), mcp:vex ok, mcp:loom idle.` `headroom services` and the procedure `resources.services` give the health of each service. The dashboard shows each service as a panel with its state.

### H29: process starts by owner

On 2026-10-24, a pool trace showed a leak in the AMD display driver `amdkmdag.sys`: two file objects of approximately 0.9 KB for each new process. The non-paged pool grew approximately 800 MB each hour. Git Bash starts one process for each stage of a pipeline, so a test that starts `gh | tr | base64` starts many processes. Until Mark updates the driver (hub ask `amd-driver`), the fleet must see who starts the most processes.

**Measure.** The kind `procs` has one instance, `procs`, in the unit `per minute`. Its capacity is `null`.

- Windows gives each new process the next sequence number. `NtQueryInformationProcess(ProcessSequenceNumber)` gives the number of one process with `PROCESS_QUERY_LIMITED_INFORMATION`.
- At each read of the processes, the sampler reads the number of the newest process. It tries at most 4 processes, because a short process can end before the read.
- The change of the number between two reads is the exact count of starts. The number keeps its highest value, so an ended newest process gives no negative count.
- On 2026-10-24, two processes that started one after the other had numbers with a difference of 1.
- `UniqueProcessKey` of `SYSTEM_PROCESS_INFORMATION` is 0 with `SystemProcessInformation`, and the process ID with `SystemExtendedProcessInformation`. Thus it is not a count.
- Linux gives no cheap exact count of processes. The `processes` line of `/proc/stat` counts each fork, also each thread. Thus Linux uses the lower bound.

**Attribute.** The start tracker in `starts.ts` gives the starts of each owner over the last 10 minutes.

- A new process is an ID that the previous read did not have, or an ID with a different start.
- The owner of a new process outside the leases is its owner from `attribute()`. These processes are the own commands of the owner. A new process in the tree of a lease counts for its lease. These counts are lower bounds.
- The job object of `headroom run` gives `TotalProcesses` of `JobObjectBasicAccountingInformation`. The client sends the count with `resources.renew` every 30 seconds and with `resources.release`. The count of the job object includes the client, so the client starts its count after itself.
- The lease keeps the count in the column `processes`. `headroom job` and its JSON give it.
- The holder of a lease decides the owner of its job: `holderOwner()`. A session with the name of the holder gives `session:<holder>`. Without that session, the holder is its own owner.
- The process tree and the name of the job do not decide. A shell between a session and its job can stop. Then the tree gives the job to `other`.
- The starts of an owner are its jobs and its own commands. A lease with no count, for example with `--keep`, gives the new processes of its tree, a lower bound.

**The parents.** Windows gives the ID of an ended process to a new process. A child keeps the ID of its ended parent, so a new process with that ID looks like its parent.

- `parentOf()` in `owners.ts` gives a parent only when the parent started at or before the child.
- `attribute()`, `leasesOf()`, `treeMb()` and the orphan rule use this rule. A child with a parent ID that is in use again goes to the owner of its own part of the tree. The orphan rule examines it.

**Alert.** A level rule on the used part of `procs`: a warning above 600 starts in one minute. The alert has the kind and the id `churn`.

- The rate is an average over 10 minutes. A level rule has the new field `minHistoryMs`: with a shorter window of the change, the rule gives no alert. The window is the time that the reads cover.
- `churnPerMinute` of `AlertRules` sets the limit.
- The message names the 3 owners with the most starts, with their jobs and their own commands. It also names the 3 leased jobs with the most starts. It ends with the reason: "Each new process leaks kernel memory in the AMD display driver until it is updated (hub ask amd-driver)."

**Status and the dashboard.** `Status.starts` gives the rate of the computer, the flag `exact`, the window, the owners and the jobs. `headroom status` gives one line, for example `Process starts: 1,450 a minute. Most (at least): session:client 410 (jobs 12, own commands 398, job e2e: 9,800 so far), session:organizer 120.` The dashboard gets the panel `Process starts` from the model.

**Cost.** One more `OpenProcess` and one more `NtQueryInformationProcess` at each read. The tracker keeps the start of each live process, the reads of 10 minutes and the counts of the jobs of 10 minutes.

**The numbers on 2026-10-24.** The computer started 1,450 processes in one minute. A read every second found 260 of them, and a read every 10 seconds found 60. Thus the owners show a small part of the starts, and the leased jobs give the exact part.

### H30: battery and power

Mark asked for the battery as a resource on battery power. An event or a cheap read tells the daemon when the state changes.

**Measure.** The daemon reads both resources at each read of the processes, every 10 seconds. It starts no process and no timer.

- `battery`: `CallNtPowerInformation(SystemBatteryState)` fills 32 bytes. `parseBatteryState()` in `power.ts` reads them, and `batteryState()` gives the percent, the rate in W and the minutes left.
- Windows gives an unknown rate as `0x80000000` and an unknown time as `0xFFFFFFFF`. Then the rate or the time is `null`. With no estimate of Windows, the minutes left come from the charge and the rate.
- `power`: PDH with the counter `\Energy Meter(*)\Power` in mW. The query opens at the first read. A rate needs two collections, so the first read gives no meters.
- The instance `System Power` gives the power of the computer. `CPU Power`, else `RAPL_Package0_PKG`, gives the CPU power. The instances of each core and `_Total` are skipped.
- A computer with no battery, with no counter set or with a failed read has no instance. The values are absent, not 0.
- Linux and macOS have neither resource. The sampler of Linux has no reader for them.

**Attribute.** The power of an owner is an estimate: the CPU power, shared by the cores of each owner over the last minute. The panel and the status call it an estimate. The GPU and the screen also use power, and no owner gets that part.

**Events.** `watchPower()` in `windows-power.ts` registers callbacks with `DEVICE_NOTIFY_CALLBACK`:

- `PowerSettingRegisterNotification` for the power source (`GUID_ACDC_POWER_SOURCE`), the percent (`GUID_BATTERY_PERCENTAGE_REMAINING`) and the lid (`GUID_LIDSWITCH_STATE_CHANGE`). A UPS counts as AC power.
- `PowerRegisterForEffectivePowerModeNotifications` (version 2) gives the power mode, for example `balanced`. Windows calls it once at the registration.
- `PowerRegisterSuspendResumeNotification` gives the suspend (`PBT_APMSUSPEND`) and the resume (`PBT_APMRESUMESUSPEND`, `PBT_APMRESUMEAUTOMATIC`).
- Each handler sets the state of the engine and asks for a tick with `setImmediate`. It does not wait, because the thread of Windows waits for the handler.
- The registrations run on a worker thread of koffi, so a callback during a registration does not block the main thread.
- If one registration fails, the daemon writes one line to its log, and the read every 10 seconds continues. At the stop, the daemon removes each registration.

**Sleep.** A resume event marks a sleep. With no event, a time of 60 seconds or more between two calls of the engine also marks a sleep. The daemon ticks every 2 seconds. The default of the engine is no limit, so a test can move its clock.

- `Broker.resume()` adds the time of the sleep to the heartbeat of each active lease, but not past the time of the call. Thus no lease ends because the laptop slept. A lease with a process ends when its process ends, as before.
- The rates start again at the wake: the processor time and the writes (`CounterTracker.gap()`), the process starts (`StartTracker.gap()`), the network and the drives.
- The growth of the kernel pools starts at the wake, so a growth does not span the sleep.
- The table `sleeps` keeps each sleep. `History.sleeps` gives them, and the charts draw a band and no line across a sleep.

**Alert.** The kind `battery` has two check rules. A check rule is a new rule type: a function of the facts of an instance gives the level.

- `battery`: on battery, a warning below 30 minutes left (`batteryWarnMinutes`). Critical below 10 minutes (`batteryCriticalMinutes`) or below 10% (`batteryCriticalPercent`).
- `battery:jobs`: a warning when granted leases run on battery. The message names the jobs and the 3 owners with the most power, as an estimate.
- On AC power, both rules give no level. Thus each alert ends when AC power returns. A power source event asks for a check at once.

**Enforce.** Two parts, both in this item:

- **EcoQoS.** The answer of `resources.renew` has the field `eco`: true on battery. The client of `headroom run` reads the processes of its job object (`JobObjectBasicProcessIdList`) and calls `SetProcessInformation(ProcessPowerThrottling)` for each new process, with the state mask 1. On AC power, it sets the state mask 0 for each process that it changed.
- The client does the change, not the daemon. The client holds the job object, and it has the rights on its own processes. The daemon does not open the processes of other users.
- The first heartbeat comes 3 seconds after the start, then every 30 seconds. `--no-eco` turns the mode off. A daemon of an older version gives no `eco`, and the job keeps its speed.
- **Keep awake.** On AC power, while a lease is granted, the daemon holds a power request: `PowerCreateRequest` with the reason `headroom: N jobs run`, then `PowerSetRequest(PowerRequestSystemRequired)`. With no lease or on battery, it clears the request. A lid close still puts the laptop to sleep, because the lid action of Windows is stronger than a power request.

**Admit.** None in this item. H31 adds the conditions in `conditions.ts`. They read the power source and the charge, not an amount, so the `admit` part of `battery` stays `null`.

**Status.** `Status.power` gives the power source, the power mode, the lid, `eco`, the reason of the power request and the last sleep. `headroom status` gives one line, for example `Power: on battery, 68%, 18.0 W, 1 h 58 min left (power mode: balanced). Most (estimate): session:server-stack 3.1 W, session:graph 2.4 W.`

**Cost.** The battery read is one call of approximately 32 bytes. The PDH query costs approximately 4 MB of private memory and approximately 900 ms once, at the first read. Each collection takes 4 to 28 ms. The PerfLib V2 consumer API can replace PDH later, if the 4 MB matter.

**The numbers on 2026-10-24.** On battery: 47%, 21.9 W, 67 minutes left. The Energy Meter gave 23.3 W for the computer, 7.1 W for the CPU and 0.05 W for the GPU.

### H31: conditions for a job

Mark approved a set of resources on 2026-10-24. Some of them are conditions, not amounts: plugged in, Mark away, no metered network, a cool CPU. H31 is the gate that each of them uses. Timing-sensitive work belongs in CI, and its local numbers are wrong on battery or under heat.

**The registry.** `CONDITIONS` in `conditions.ts` has one entry for each condition:

```ts
export interface Condition {
  readonly name: string;
  /** The fact, for the list of the known conditions: "the laptop is plugged in". */
  readonly about: string;
  /** The value of the condition: its operator and its range. A condition without it takes no value. */
  readonly value?: ConditionValue | undefined;
  /** A pure function of the facts: the power source, the charge, the usage window, the process starts and the time. */
  test(facts: ConditionFacts, value: number | null): boolean;
  /** The waiting reason, for example "waits until the laptop is plugged in". */
  reason(facts: ConditionFacts, value: number | null): string;
  /** The facts that stop the condition, for a granted lease: "on battery". */
  state(facts: ConditionFacts, value: number | null): string;
}
```

| Condition | Test | Reason |
|---|---|---|
| `ac` | The power source is not the battery. No battery read counts as AC power. | `waits until the laptop is plugged in` |
| `battery>=N` | AC power, no battery, or a charge of N% or more. N is 0 to 100. | `waits until the battery is at 50% or more, or plugged in (now 41%)` |
| `usage<N` | Fresh usage data, and the five-hour window is under N%. N is 1 to 100. | `waits until the five-hour usage window is under 80% (now 91%, resets at 02:10)` |
| `starts<N` | The computer starts fewer than N processes in one minute, over the last 2 minutes. N is 1 to 100,000. | `waits until the computer starts fewer than 700 processes a minute (now 1,108)` |

- `parseWhen()` reads `--when`. A value can have a list with commas, and the option can come more than one time. A condition that comes twice counts one time.
- An unknown name gives a `ConditionError` with the list of the known conditions. A planned name also names its item: `away` (H33), `cool` (H35), `unmetered` (H39) and `night` (H42).
- `headroom run` reads the conditions before it connects, so a wrong name stops the run with exit code 2. The broker reads them again at the request.
- A later item adds a condition with one entry in `CONDITIONS` and one field in `ConditionFacts`. It removes the name from `PLANNED_CONDITIONS`.

**The lease.** The lease keeps its conditions in the column `conditions`, as JSON: `{ when, timing, batteryOk }`. Two more columns keep the time when the conditions held after a wait (`conditions_met_at`) and the record of a running job (`unmet`). An older database gets the three columns at the start.

**Admit.** At each tick, the broker asks the engine for the reason of each waiting lease. `conditionWait()` examines the checks of the lease in this order:

1. The conditions of `--when`.
2. The conditions of `--timing`: `ac`, and `cool` when H35 comes. The reason adds `(--timing): timing numbers on battery are wrong, so run timing tests in CI`.
3. The battery floor, for a heavy lease without `--battery-ok`: `battery>=<floor>`. The reason names why the lease is heavy and tells about `--battery-ok`.

The first check that does not hold gives the reason. Each reason starts with "waits until" or "waits for", but not with "waits for memory". Thus the hook of the plugin does not count it.

**The power events.** A power event of H30 sets the state of the engine. The daemon then asks for a tick at once, and that tick reads the battery and runs the admission. Thus a lease that waits for `ac` starts within a second after the charger goes in. Without an event, the battery read comes with the read of the processes, every 10 seconds.

**The process starts.** `starts<N` lets a job wait for a quiet computer. On 2026-10-25, the browsers of graph failed with `0xC0000142` again, at approximately 1,108 starts in one minute.

- The rate comes from the start tracker of H29. It is the rate of the instance `procs`, but over the reads of the last 2 minutes, not 10.
- On Windows, the rate is exact: the sequence numbers of the new processes. Elsewhere, it is a lower bound.
- Before two reads of the processes, the rate is not known. The condition does not hold, and the reason ends with `(no count yet)`.
- Each read of the processes, every 10 seconds, sets new facts. The admission of the same tick tests the condition on the new sample. Thus a waiting lease starts at the first quiet sample.
- The rate counts the starts of the job itself. A running job with `starts<N` can thus get the record `unmet`, for example `1,108 process starts a minute`.

**The battery policy.** A lease is heavy when it asks for 2 GB of memory or more, holds the slot `browser`, or is spawn-heavy. On battery below the floor, a new heavy lease waits.

- The setting `batteryFloor` gives the floor: 25% by default. `headroom config battery-floor <pct>` changes it, and `0` turns the rule off.
- A change of the floor runs the admission at once.
- `--battery-ok` starts a heavy lease on a low battery.
- The floor is a rule for the start of a job. A heavy job that runs continues, and the battery alerts of H30 tell about it.

**The usage data.** `usage<N` reads the field `limits.five_hour` of the usage file of the fleet: `ratio` (0 to 1) and `resetsAt`. The setting `usageFile` gives the file, and `headroom config usage-file <path>` changes it.

- The engine reads the file only when a lease has a usage condition. `UsageReader` keeps each read for 30 seconds, and it has no file watcher.
- A missing or unreadable file fails closed: `waits for the usage data: <path> is missing`.
- Data older than 70 minutes fails closed: `waits for fresh usage data: the file is 95 minutes old`. The time of the data is the field `updatedAt`, else the time of the last write of the file.
- After `resetsAt`, the ratio of the old window does not apply, so the condition holds. Stale data stays closed, also after the reset.

**A running job.** A granted lease continues when a condition stops. Pausing a job is not in this item. At each tick, `nextUnmet()` examines the conditions of `--when` and `--timing` of each granted lease:

- A condition that stops starts the record `unmet`: `{ condition, state, since, until: null }`.
- A condition that holds again closes the record with `until`. A later stop starts a new record.
- `headroom status` gives `runs without its condition: on battery since 01:20`. `headroom job` gives an open or a closed record.

**Status.** `headroom status` gives the conditions of each lease, for example `[when ac, --timing]`, and the reason of each waiting lease. `headroom run` gives `queued until the laptop is plugged in`. The JSON of `headroom job` gives `conditions` and `unmet`. The timeline of the dashboard draws the wait for a condition as a dashed line, up to `conditionsMetAt`. It draws the time without a condition as a red line on the run.

**The restart.** A restart for an idle queue does not wait for a lease that waits for a condition. A condition can take hours, and the new daemon keeps each lease from the store.

**Cost.** The facts come from the last battery read, the power state and the start tracker, one time for each tick. The settings are one read of the store for each tick with a waiting lease or a lease with conditions. The usage file is approximately 50 KB, at most one read in 30 seconds while a usage condition waits.

### H32: forecasts

Mark approved this item on 2026-10-24. Each resource gets a time to a limit from its history, so the fleet acts before the limit. H34 builds on the forecast of the non-paged pool: the AMD display driver leaks kernel memory with each new process until a reboot.

**The forecast part.** A kind can have a sixth part, `forecast` (`ForecastPart` in `resources.ts`). A kind with no forecast part has no forecast.

- The targets of an instance are the warning and the critical limits of the level rules of its kind. `forecastTargets()` gives them. A rule with a duration does not count, because a level of one read does not start its alert.
- `more()` adds targets: a drive gets `empty`, a free part of 0.
- `given()` gives a forecast with no fit. The battery uses it: on battery, the forecast is the time left that Windows estimates. Its confidence is 1, and its source is `windows`.

| Kind | Targets |
|---|---|
| `disk` | 20 GB free and 5 GB free (20% and 5% on a small drive), and full |
| `pool` | the alert level of each pool: 3 GB non-paged, 4 GB paged |
| `commit` | 90% of the commit limit |
| `memory` | 1 GB available |
| `ports` | 80% and 95% of the dynamic ports |
| `battery` | the time left of Windows, on battery only |

The processors, the network, the process starts, the services, the power, the desktop and the slots have no forecast.

**The fit.** `forecast.ts` has the pure functions. `fitTrend()` fits one part, used or free, of the points of one instance:

- The points are the last 60 minutes before the last point, after the last gap. A step of more than 5 minutes between two points is a gap: a sleep, or a stop of the daemon. The caller also gives the start of the computer and the last wake.
- The slope is the Theil–Sen slope: the median of the slopes of all the pairs of points. One outlier does not move it. At one point each minute, a fit has at most 1770 pairs.
- The confidence is Kendall's tau in the direction of the slope. It is the part of the pairs that move with the trend, less the part that moves against it.
- The fit gives no trend with fewer than 10 points or with less than 30 minutes of points. A slope of 0 or a confidence below 0.5 also gives no trend.
- The newer half of the window must move with the trend. Thus a single step, for example one download, or a trend that stopped gives no trend.

`forecastFrom()` gives the time from a trend to a target, from the measurement at this time. It gives `null` in three cases:

- The trend moves away from the target.
- The instance is at or past the target.
- The target is more than 30 days away.

`forecast()` does both steps on the points of one instance.

**The engine.** The engine adds no timer. The store gets one sample each minute. At each sample, the engine adds the measurement of each instance with a fit to a cache of the last hour. Then it fits each instance again.

- A start of the daemon reads the points of the last hour from the table `resource_samples`. The points start after the start of the computer and after the last sleep.
- A wake empties the cache, so a fit does not span a sleep.
- `status()` and each check of the alerts give the forecasts from the fits of the last sample and the measurement at that time.
- The cache has approximately 8 instances of 60 points each.

**Status.** Each entry of `Status.resources` with a forecast gets the field `forecast`: `{ minutes, at, target, rate, confidence, source }`. It is the forecast to the nearest target. `target` is `{ on, amount, name }`, and `rate` is the change of the part of the target in one hour. A loss of free space has a negative rate.

**Alert.** The kind `forecast` has a check rule in the alert part of three kinds. The id is `forecast:<instance>`, and the level is `warning`.

- A drive reaches its critical level within 24 hours (`forecastDiskMs`). The message names the loss in one hour, the time, and the top writers of the last hour.
- A kernel pool reaches its alert level within 2 hours (`forecastPoolMs`). The message of the non-paged pool names the owners with the most process starts. The engine adds the pool tags that grow.
- The commit charge reaches 90% of its limit within 30 minutes (`forecastCommitMs`). The message names the owners with the most private memory.
- An active forecast alert ends past 1.25 times its horizon, so a small change of the rate does not end it and start it again. The check rule reads the level of the active alert from the field `active` of the facts.

**Faces.** `headroom forecast [--json]` lists the forecast of each instance, the nearest first. `headroom status` adds the line `Forecast (24 h)`. Each card of the dashboard shows its forecast in one line, with a dot under 24 hours. The battery card already gives the time left, so it has no extra line.

**The numbers on 2026-10-25.** A read-only fit of the live store at 05:13 UTC gave one forecast: `Drive D: 20 GB free in 4 days (at 1.1 GB an hour, confidence 0.65).` Drive C: lost 210 MB an hour with a confidence of 0.98. Its 20 GB target was 51 days away, so it got no forecast. The commit charge, the memory, the pools and the ports had no clear trend.

### H34: the reboot budget and a planned drain

Mark approved this item on 2026-10-24. The AMD display driver leaks kernel memory with each new process, and only a reboot gives it back. On 2026-10-24 the pools reached 4.6 GB. H34 tells when a reboot is due, and prepares a planned window for it. headroom does not reboot the computer and does not log off. Only Mark does these actions.

**The module.** `reboot.ts` has pure functions. The engine gives them the time and the reads.

- `rebootAdvice()` gives the level and the text of the recommendation. The rules go in this order:
  1. A pool at its alert level gives `overdue`.
  2. A forecast to the alert level within 24 hours gives `soon`.
  3. A growth of 500 MB in one hour gives `plan`.
  4. A waiting update alone gives `update`. Else the level is `none`.
- `windowsReboot()` reads the two keys of `REBOOT_KEYS` through a probe. The probe of the sampler is `registryKey()`: `RegOpenKeyExW` with the right to read values only. A key that refuses the read exists. A failed read is `unknown`.
- `drainWait()` gives the reason of a held lease, and `drainStatus()` the state of the drain. `drainLine()` and `drainAlerts()` give its status line and its alerts.
- `nextClock()` gives the next time of a local clock for `--at` and `--until`.

**The budget.** `Status.reboot` has the type `RebootBudget`: `{ at, advice, pools, windows, bootedAt, uptimeMinutes, drain, resumePlan }`.

- Each pool has its level, its alert level, its growth over the last hour, its growth limit and its forecast to the alert level (H32).
- The growth comes from the same hour as the pool alert. The hour starts after the start of the computer or the last wake, and needs 50 minutes of history.
- The engine reads the registry at most one time in 5 minutes.

**The drain.** The settings table keeps the drain as JSON under the name `drain`: `{ at, until, setAt, startedAt, readyAt }`.

- Admit: the condition hook of the broker gives the drain reason first, so a drain wait keeps no place in the queue. A lease with `conditions.duringDrain` does not wait.
- Before the admission of each tick, the engine ends the drain at its time `until`. At the start of the drain, it records `startedAt` and calls `onDrainStart`. The daemon then writes the resume plan.
- After the admission, the engine records `readyAt` when no lease is granted, and sets the alerts `drain` and `drain:ready`. The check of the alerts does not end them.
- A start of the daemon reads the drain. A start of the computer after `setAt` ends the drain, because the reboot came. The event alert `drain:ended` tells it.
- `isConditionWait()` matches the drain reason, so a restart for an idle queue does not wait for such a lease.

**Faces.** The commands are `headroom reboot-plan [--json]` and `headroom drain`, and the procedure is `resources.drain`. `headroom status` shows the drain line and the recommendation. The dashboard shows one line under the strip.

**The numbers on 2026-10-25.** A one-time run on a copy of the live store at 04:18 local time gave this budget. The non-paged pool was at 2.5 GB and the paged pool at 2.6 GB. Both were lower than one hour before. No update waited, and the uptime was 8 h 41 min. The recommendation was "No reboot needed."

### H46: the peer of a local connection

The fleet site (the item fp-mcp of server-stack) serves its procedures as MCP tools over Streamable HTTP to `claude.exe`. Each call needs the fleet role of the caller, from the TCP peer and not from a header. The step fp-identity of the organizer (`principalOf`) uses the same answer. The daemon reads the TCP table and the process tree already, so the procedure `resources.peer` gives the answer.

**The connection.** The input is `{ localPort, remotePort }`: the two ports that the site sees on loopback.

- The client row of the connection has the local port `remotePort` and the remote port `localPort`. The process of that row is the peer.
- Each call reads the IPv4 table and the IPv6 table of `GetExtendedTcpTable` one time. The parser keeps only the rows with the two ports.
- The two ends must be loopback addresses: `127.0.0.0/8`, `::1`, or `127.0.0.0/8` mapped into IPv6.
- No row with a process gives the error `NO_CONNECTION`. Rows of two processes also give `NO_CONNECTION`, because the call fails closed.

**The walk.** The peer of a call from a session is often not `claude.exe`. An example is `node scripts/fleet.mjs` from the Bash tool of a session.

- `GetProcessTimes` gives the live start of the peer. A peer that ended before the walk gives the error `PEER_GONE`.
- The walk uses the process snapshot of the daemon. A peer that is younger than the snapshot, or an entry with a different start, starts one fresh read.
- The fresh read is a Toolhelp snapshot and one call of `NtQuerySystemInformation`. It reads no memory and opens no process.
- The walk goes up at most 16 parents to the nearest `claude.exe`. Each parent must start at or before its child. A parent with no start stops the walk.
- `via` gives the process IDs from the peer up to `claude.exe`, with the two ends.
- Without a live `claude.exe` above it, the peer is anonymous. Then `via` has only the peer, and the answer has no session and no role. This is not an error.

**The session and the role.**

- The session is the session file of `claude.exe` in `~/.claude/sessions`, with the same process ID. On Windows, `procStart` of the file must be the start of that `claude.exe`.
- The role comes from the fleet registry. The registry has two sources: the role files `~/git/fleet/registry/roles/<id>.json` and the old file `~/git/fleet/registry/roles.json`.
- The file of a role wins over the entry of that role in `roles.json`. The other roles come from `roles.json`. These are the rules of `readRoleDocs` of the fleet.
- The name of a role file without `.json` is the ID of its role. A file with a different `id` in it does not count.
- The daemon skips a file that is not JSON, a hidden file and a temporary file. The entry in `roles.json` then applies.
- Each call reads the names of the role files, and the time and the size of each source. The daemon reads the two sources again only after a change.
- The role with the ID of the session wins. Then the role with the name of the session as its session name wins. For example, the session `strategies` gives the role `strategist`.
- Then the role with the name of the session as its ID wins, for a parked role with no session name. A retired role does not match.
- A role file can retire a role. Then that role does not match, also when `roles.json` gives the role as `active`.
- `EngineOptions.rolesFile` sets another registry. The folder `roles` next to that file holds its role files.

**Cost and the caches.**

- Each call reads the two TCP tables. It opens the peer and its `claude.exe` one time each, for their live starts.
- The cache keeps the walk of each peer by its process ID and start. A new process snapshot removes the walks of the ended peers. The cache keeps at most 256 walks.
- The cache keeps the session of each `claude.exe` until the next read of the session files, every 10 seconds.
- On this computer on 2026-10-24, a call with a fresh read used approximately 24 ms. A call with a walk from the cache used approximately 2 ms.

**The limit.** This attribution is as strong as "the same Windows user". It is not a security boundary.

- A process of that user can choose its parent with `PROC_THREAD_ATTRIBUTE_PARENT_PROCESS`. It can also write a session file or change the registry.
- Thus a role from `resources.peer` names the caller. It does not prove the identity of the caller.

**The depth.** On 2026-10-24, the Bash tool put 3 `bash.exe` processes between `claude.exe` and its command. A `timeout` and a pipe put more processes in the chain. In one check, a walk of 8 parents did not get to `claude.exe`. Thus the limit is 16 parents.

**Linux.** `/proc/net/tcp` gives no process for a row, so Linux gives the error `NOT_SUPPORTED`. A read of the socket inodes of each process is a later step.

**The command.** `headroom peer <localPort> <remotePort> [--json]` gives the answer for a check by hand. An error gives the exit code 3.

### H47: spawn-heavy jobs and browser tests

On 2026-10-24, the Playwright browsers of graph did not start three times, with `0xC0000142`. Two of these runs overlapped bursts of process starts from other leases:

- The organizer's `site-audit-gates` started 923 processes in 84 seconds.
- The `test-churn` of server-stack started approximately 1,870 processes in one minute. The computer had a peak of 3,637 starts in one minute.
- The desktop heap, the memory, the commit charge and the kernel pools had room at those times. Thus the burst itself stops the start of a browser.

**Measure.** The client of `headroom run` reports `TotalProcesses` of its job object every 30 seconds and at the release (H29). The engine gives each count to the start tracker. `windowRate()` in `spawn.ts` then gives the rate:

- The window starts at the newest count that is 30 seconds or more older than the last count. Without one, it starts at the grant, with 0 processes.
- A window shorter than 30 seconds counts as 30 seconds. The first count comes after 3 seconds, so a burst at the start gives no false peak.
- The lease keeps the highest rate in the column `peak_starts_per_min`. A lower rate does not lower it.
- `headroom job` also gives the average: the processes over the run time, with at least 30 seconds.

**Learn.** `Engine.spawnClass(job, holder)` uses the rule of `--mem auto`. The learned peak is the 90th percentile of the peaks of the last 20 runs. The runs of the same holder come first.

- Up to 10 runs, the 90th percentile is the highest peak.
- A run from before H47 has no peak. Its average is a lower bound, so it counts instead.
- The job is spawn-heavy when the learned peak is above the limit. The setting `spawnHeavy` gives the limit: 600 starts in one minute by default.
- `headroom config spawn-heavy <n>` sets the limit, and `--clear` sets the default again. A change applies to the next requests.

**The class.** The lease keeps its class in the column `spawn`, as JSON: `{ heavy, source, perMinute, runs }`. The source tells where the class comes from:

| Source | Meaning |
|---|---|
| `history` | The peaks of the past runs. A job with no past runs is normal, with `perMinute: null`. |
| `declared` | `headroom run --spawn-heavy`: the holder knows that a new job starts many processes. |
| `opted-out` | `headroom run --no-spawn-heavy`: the job is normal, also above the limit. Its owner knows that the class is wrong. |
| `live` | The peak of the job itself went above the limit while it ran. `perMinute` is the peak at that time. |

**Promote.** At each count, a lease that is not spawn-heavy gets the class `live` when its peak is above the limit. A lease with `--no-spawn-heavy` stays normal. A browser test that runs at that time continues. Each later browser test waits.

**Admit.** The engine gives `spawnConflict()` to the broker as its conflict rule:

- A spawn-heavy lease waits while a lease with the slot `browser` runs. A lease with the slot `browser` waits while a spawn-heavy lease runs.
- A later lease does not go before an earlier waiting lease that it conflicts with. Thus a stream of browser tests cannot keep a spawn-heavy job in the queue forever, and the reverse.
- Two spawn-heavy leases can run together. Two browser tests follow the capacity of the slot `browser`.
- A lease that is spawn-heavy and also has the slot `browser` conflicts with each other browser test.

The reasons of a wait name the other lease. They do not start with `waits for memory`, so the hook of the plugin does not count them:

```text
waits for the browser tests of graph (pnpm e2e) to end: this job starts many processes (about 1,870 a minute in past runs), and browsers can fail to start beside it
waits for test-churn of server-stack to end: it starts many processes (about 1,870 a minute), and browsers can fail to start beside it
```

When the other lease waits before it in the queue, the reason has "to run first and end". A job name that starts with `memory` gets the words "the job" before it.

**The sum of the start rates.** On 2026-10-25, the computer started approximately 1,108 processes in one minute, and the browsers of graph failed again. No lease was above the limit of 600. A first run, a type check, a vitest run and a release job ran together beside the browser test. Thus the engine also gives `startsSumConflict()` to the broker, as its group rule:

- The rate of a lease is its own rate of the last 30 seconds, from `windowRate()`, when it has two counts. Else, it is its learned peak.
- A first run with no past runs counts 0 until its second count. Then its own rate counts.
- A lease with `--no-spawn-heavy` counts only its own rate, because its owner says that its past runs are wrong.
- The sum counts the granted leases and the leases that wait before the lease in the queue. It does not count a browser test.
- A browser test waits while the sum is above the limit.
- Another lease waits while a browser test runs or waits before it, and the sum with its own rate is above the limit. A lease with no rate also waits while the sum is above the limit.
- The leases that wait before the lease count in the sum. Thus a later lease does not take the part of an earlier lease, in each order.
- A change of the limit runs the admission at once.

The reasons name each lease of the sum, the highest rate first. A lease that waits has the word `queued` after its holder:

```text
waits for the other jobs to start fewer processes: tsc (client) 400 and vitest (vex, queued) 300 start 700 a minute together, above the limit of 600, and browsers can fail to start beside it
waits for the browser tests of graph (pnpm e2e) to end: this job 300 and tsc (client) 400 start 700 a minute together, above the limit of 600, and browsers can fail to start beside it
```

**Status.** `headroom status` gives the line `Spawn-heavy now: test-churn (server-stack), 1,870 a minute.` for each granted spawn-heavy lease. `headroom job` gives the peak and the class, for example `at most 1,870 starts a minute, spawn-heavy (about 1,870 a minute in past runs)`. The JSON gives `peakStartsPerMin`, `averageStartsPerMin` and `spawn`. The dashboard gives the peak and the class in the tooltip of each job of the timeline.

**Cost.** The tracker keeps the counts of each job for 10 minutes, as before. The class costs one or two indexed queries of the store at each request. The sum reads the counts of each granted lease in memory, at each tick with a waiting lease.

## Decisions

These were the open questions. The session decided each one as a technical call. Mark can change any of them.

| Question | Decision | Reason |
|---|---|---|
| How does a lease name an instance? | A flat id in `Amounts`: `memory`, `cpu`, `disk:D:`, `browser`. An id with no known kind is a slot. | The leases, the store and the procedures keep their shape. A slot of today keeps its name. |
| Are commit, the kernel pools and the desktop resources? | Yes, with measure and alert only. They have no admit part and no enforce part. | Their alerts then use the same rules as memory and disk. `detect()` has no special case for them. |
| Which drive does `--disk 5g` use? | The drive of the real path of the current folder. `--disk D:=5g` names a drive. | The build output goes to the current folder. With the Dev Drive, the code and the temp root are both on `D:`. |
| Does a disk lease get the unspent-part rule? | No. A disk lease keeps its full amount until its release. | The write counters are larger than the new space, so they make the free part too large. Disk leases are short and approximate. |
| Does a critical drive make a job wait, or stop it at once? | It stops it at once, with the exit code 75, as today. `--force-disk` stays. | A full drive needs a cleanup, not a wait. The callers keep the behavior of H18. |
| Where does a job write its temp files? | Under a temp root that a setting gives, one folder for each lease. Without the setting, nothing changes. | Other computers and Linux keep their behavior. On this computer, the setting is `D:\headroom\tmp`. |
| The release removes the temp folder. A tool with a cache in `TEMP` then starts cold. Is that correct? | Yes. A tool that needs its cache gets a cache folder in its own settings. | The folder of a lease is disposable by definition only when nothing else uses it. |
| Does disk attribution split the writes by drive? | No. The use of an owner is for all the drives. A drive gets its large files and the size of the temp root. | The process counters do not name the drive. ETW gives each file, but it needs admin rights or the group `Performance Log Users`. |
| Does the daemon clean by itself? | Only the folders of ended leases. Each other class waits for `headroom disk clean --apply`. | headroom deletes nothing that a person did not ask for, except the data of its own leases. |
| Does a CPU lease get a limit without `--limit`? | No hard cap, but a weight (H23). | A full processor slows the jobs, but it does not stop them. Memory is different: when it is full, jobs stop. The weight 5 gives the leased jobs equal parts when they compete. |
| Does a configured pool `cpu` stay? | Yes, as a cap: the capacity is the lower of the pool and the processors. | `headroom pool cpu 8` keeps its meaning. |
| How does the model show the two directions of the network? | Two instances, `net:in` and `net:out`, in MB/s. | Each direction gets its own history and panel. One instance with the split in a detail field loses the split in the history. |
| Which network adapters count? | The adapters that are up, with a hardware interface and with no filter interface. | The filter rows and the virtual adapters count the same bytes again. The traffic of Tailscale and of WSL goes through the Wi-Fi adapter. |
| Does headroom read the network bytes of each process? | No. | Windows gives them only through ETW, with admin rights or the group `Performance Log Users`. |
| What does `ports:tcp` count? | Each TCP row with a local port in the dynamic range, in each state. | A port in `TIME_WAIT` is not free. When the range is full, new connections fail. |
| Who puts a job in efficiency mode on battery? | The client of `headroom run`, from the field `eco` of the answer of its heartbeat. | The client holds the job object and the rights on its processes. The daemon stays small and opens no process of a job. |
| Does a lease end because the laptop slept? | No. The heartbeat of each active lease gets the time of the sleep. | A heartbeat cannot come while the laptop sleeps. The job continues after the wake. |
| Is the power of an owner measured? | No. It is an estimate from the CPU power and the processor time of the owner. | Windows gives no power for each process with no ETW. The estimate is cheap and names the large users. |
| How does the model show the health of a service? | A new unit `state`. The measurement has the field `health`. Its used part is the latency of the last check in ms, and the capacity and the free part are `null`. | A state is not an amount. The latency gives the history and the trend of the panel a number. The unit `count` gives a capacity of 1 that tells nothing. |
| When is an MCP server down? | When its start failed, or after 3 exits in 10 minutes. A server that the gateway stopped for idle, or that exited one time, is `idle`. | The gateway starts a server again at the next request. Thus one exit is not a failure of the service, but a start that fails is. |
| Does headroom restart a service that is down? | No. The alert only reports. | A restart of Docker stops the containers of all the sessions. The owner of the service decides. |
| How does the store keep the new data? | New tables `resource_samples` and `owner_use`, and a column `usage` in `leases`. The old tables stay. | The history, the dashboard and the tests of today keep their data and their queries. |
| What is the name of the owner of the kernel pools? | `kernel`, as before. The file cache and the drivers are new owners `kernel:cache` and `kernel:drivers`. | The history of `kernel` stays comparable: its private memory is still the size of the two pools. Only its memory in RAM changes, to the part in RAM. |
| What is the private memory of the file cache and of the drivers? | The same as their memory in RAM. | They have no commit charge. With 0, the list sorts the largest owner of RAM last, and the dashboard shows no bar. |
| How does headroom count the process starts of the computer? | The change of the sequence number of the newest process on Windows. Elsewhere, the new processes of each read, a lower bound. | The sequence number is exact and costs one open of one process. ETW is exact too, but it needs admin rights. |
| Does a session get the starts of its jobs? | Yes, with a split: its jobs (exact) and its own commands (a lower bound). The holder decides the owner of a job, not the process tree. | A lease can have the name of the job of another project. The session that runs the lease starts its processes. |
| Which processes are services? | A Node process with a title under the rule `system`, with its descendants. | The title names the program. An orphan with a title stays `other`, so the orphan rule still finds it. |
| Does a lease that waits for a condition keep its place in the queue? | No. It does not hold the head, and no later lease waits for it in a conflict. | A condition can take hours. A lease that cannot run does not stop the leases that can run. |
| Does a job stop when its condition stops? | No. The lease records the time, and the status shows it. | Pausing a job is not in H31. A stopped benchmark loses its work, and the record tells that its numbers are suspect. |
| What does `usage<N` do without fresh data? | It waits, with the path or the age in the reason. After the reset time of fresh data, it holds. | A job that spends usage does not start on old data. A new window starts with no use. |
| Does a restart for an idle queue wait for a lease that waits for a condition? | No. | A condition can take hours. The new daemon keeps the lease, and its client connects again. |
| Which fit gives a forecast? | The Theil–Sen slope of the last hour, with Kendall's tau as its confidence. | The median of the pair slopes ignores outliers, for example one large download. Tau is a plain count of the pairs that agree with the trend. |
| Does the battery get a fit? | No. Its forecast is the time left that Windows estimates. | Windows knows the rate of the battery at this time. A fit of the charge lags behind a change of the load. |
| How far does a forecast go? | At most 30 days. | One hour of history tells little about next month. |
| Over which window does `starts<N` measure? | The reads of the last 2 minutes. | The 10 minutes of `procs` keep a lease in the queue for minutes after a burst. One read of 10 seconds changes too fast. |
| Does a browser test count in the sum of the start rates? | No. The sum counts the other leases. | The rule keeps the bursts of the other jobs away from the browser test. |
| Does a lease with no rate wait while the sum is above the limit? | Yes, beside a browser test. | A first run has no rate, and one first run was part of the burst of 2026-10-25. |
