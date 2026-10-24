# The resource model of headroom

On 2026-10-24, Mark decided that headroom becomes the general resource manager of this computer (hub decision `2026-10-24-headroom-resources`). Memory and slots come first. Disk is next. CPU, network, ports and GPU follow when the fleet competes for them.

This document gives one model for all of them. Memory is the first resource on the model. Disk is the second resource, not a special case. The roadmap item is H22.

## The words

- A **resource kind** is a type of resource, for example `memory`, `disk` or `cpu`.
- An **instance** is one resource that headroom measures or counts. A kind can have several instances, for example one disk for each mount.
- The **id** of an instance is the kind, or the kind and a colon and the instance: `memory`, `cpu`, `disk:C:`, `disk:D:`. A lease amount names an id.
- An id with no known kind is a **slot**, as today: `browser`, `docker`, `npm-publish`.
- An **owner** is a Claude Code session, an MCP server of the gateway, a lease, Docker or the system.

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
export type ResourceKind = "memory" | "commit" | "pool" | "desktop" | "disk" | "cpu" | "slot" | "network" | "port" | "gpu";

/** The unit of the amounts of a kind. Disk writes use MB/h. */
export type Unit = "MB" | "cores" | "count" | "MB/h";

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

### 5. Enforce

`headroom run` holds each job in a job object (H6). The enforce part of a kind tells what the job object can limit. Without a limit, headroom only reports the use of the job at its release.

| Kind | Limit of the job object | Without a limit |
|---|---|---|
| `memory` | `JOB_OBJECT_LIMIT_JOB_MEMORY`, with `--limit` (today) | The peak memory of the job (today) |
| `cpu` | `JobObjectCpuRateControlInformation` with `JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP`, with `--limit` | The processor time of the job |
| `disk` | None. Windows has no space quota for one job. | `TEMP` and `TMP` of the job on the Dev Drive (H19), and the bytes that the job wrote |
| `desktop` | Later: `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` | The count of processes |
| `network`, `port` | None | Report only |

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
| `cpu` (cores) | H23. Capacity: the logical processors. Used: the busy processors, as a 1-minute average. | The processor time of each process tree. | Level: free below 10% for 5 minutes. Outlier: a process above 4 cores for 10 minutes with no lease. | Measured. Reserve: 1 core. A configured pool `cpu` is a cap. | `JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP` with `--limit`. Report: the processor time. |
| Slots: `browser`, `docker`, each name (count) | Capacity: configured with `headroom pool`, else 1. Used: the granted leases. | The holders of the granted leases. | Later: a lease that waits more than 30 minutes for a slot. | Counted. A command pattern takes a slot by itself, as `browser` does. | None on the job. The lease ends with its process. |
| `network` (later, MB/s) | The bytes of each interface: `GetIfTable2`, `/proc/net/dev`. | None. The bytes of each process need ETW and admin rights. | Later: a link that stays full. | A slot for large downloads. | None. Report only. |
| `port:<number>` (later, count) | The listening ports and their processes: `GetExtendedTcpTable`, with no admin rights. | The owner of the process of each port. | A port that an orphan holds. | Counted, capacity 1: one lease holds one port. | None. Report only. |
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
- `cpu` is counted until H23, with the count of processors as its capacity.
- `detect()` gives at most one alert for each process, and one alert for each alert id. The first rule wins.
- `explain()` has no implementation yet. The engine still adds the pool tags and the large files to the messages.

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

- **Measure**: `os.cpus()` gives the processor times on Windows and on Linux, with no FFI. The capacity is `os.availableParallelism()`. The used part is the average of the last minute.
- **Attribute**: the processor time of each process, from `GetProcessTimes` or `/proc/<pid>/stat`. The use of an owner is in cores.
- **Alert**: free below 10% for 5 minutes. An outlier is one process above 4 cores for 10 minutes with no lease, for example a loop that does not stop.
- **Admit**: measured, with a reserve of 1 core. The unspent part of a lease is its amount less the cores of its tree.
- **Enforce**: with `--limit`, a hard cap of the CPU rate on the job object. Without it, headroom reports the processor time of the job.

Before step 2, `cpu` was a counted pool with the capacity 1 when no pool set it. Thus `headroom run --cpu 2` without `headroom pool cpu 8` got cancelled. Step 2 corrects this: `cpu` is a counted kind, and its capacity is the count of logical processors. A configured pool `cpu` stays, as a cap. H23 makes `cpu` a measured kind.

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
| Does a CPU lease get a limit without `--limit`? | No. | A full processor slows the jobs, but it does not stop them. Memory is different: when it is full, jobs stop. |
| Does a configured pool `cpu` stay? | Yes, as a cap: the capacity is the lower of the pool and the processors. | `headroom pool cpu 8` keeps its meaning. |
| How does the store keep the new data? | New tables `resource_samples` and `owner_use`, and a column `usage` in `leases`. The old tables stay. | The history, the dashboard and the tests of today keep their data and their queries. |
