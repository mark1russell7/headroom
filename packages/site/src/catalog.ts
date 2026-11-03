/**
 * The data of the simulator: the kinds of job that a visitor can add, the computers and the burst. Each kind gives the
 * lease that `headroom run` asks for, and the behavior of the job during its operation.
 */

/** One kind of job. */
export interface JobKind {
  /** The id of the kind, for example `test`. */
  readonly id: string;
  /** The name of the kind on the page, for example "Test suite". */
  readonly label: string;
  /** The command of the job, for example `pnpm test`. The lease gives it as the job name. */
  readonly job: string;
  /** The holder of the job: a session or a project. */
  readonly holder: string;
  /** The memory of the lease, in MB. */
  readonly memoryMb: number;
  /** The processors of the lease. */
  readonly cpu: number;
  /** True: the job runs browser tests, so its lease holds the slot `browser`. */
  readonly browser: boolean;
  /** The run time of the job, in seconds. */
  readonly seconds: number;
  /** The highest memory of the job, in MB. A job with a leak has no highest memory. */
  readonly peakMb: number;
  /** The growth of a job with a leak, in MB each second. A job without a leak has 0. */
  readonly leakMbPerSecond: number;
  /** The processes that the job starts in one minute. */
  readonly startsPerMinute: number;
  /** The peak starts in one minute of the past runs of the job. The broker learns the spawn class from them. */
  readonly pastPeaks: readonly number[];
  /** The number of the color of the kind, from 1 to 5. */
  readonly color: number;
}

/** The kinds of job, in the order of the buttons. */
export const KINDS: readonly JobKind[] = [
  { id: "test", label: "Test suite", job: "pnpm test", holder: "api", memoryMb: 2048, cpu: 4, browser: false, seconds: 40, peakMb: 1700, leakMbPerSecond: 0, startsPerMinute: 320, pastPeaks: [300, 340, 310], color: 1 },
  { id: "e2e", label: "Browser test", job: "pnpm e2e", holder: "web", memoryMb: 3072, cpu: 2, browser: true, seconds: 50, peakMb: 2500, leakMbPerSecond: 0, startsPerMinute: 120, pastPeaks: [110, 140], color: 2 },
  { id: "build", label: "Build", job: "pnpm build", holder: "docs", memoryMb: 4096, cpu: 6, browser: false, seconds: 45, peakMb: 3600, leakMbPerSecond: 0, startsPerMinute: 200, pastPeaks: [180, 220, 210], color: 3 },
  { id: "churn", label: "Many workers", job: "vitest --pool forks", holder: "cli", memoryMb: 1536, cpu: 4, browser: false, seconds: 35, peakMb: 1300, leakMbPerSecond: 0, startsPerMinute: 1850, pastPeaks: [1790, 1910, 1850], color: 4 },
  { id: "leak", label: "Job with a leak", job: "node import.js", holder: "data", memoryMb: 1024, cpu: 1, browser: false, seconds: 150, peakMb: 0, leakMbPerSecond: 100, startsPerMinute: 6, pastPeaks: [5], color: 5 },
];

/** This function gives the kind of an id. It throws for an unknown id. */
export function kindOf(id: string): JobKind {
  const kind = KINDS.find((each) => each.id === id);
  if (kind === undefined) throw new RangeError(`no job kind ${id}`);
  return kind;
}

/** One computer of the simulator. */
export interface Machine {
  readonly id: string;
  readonly label: string;
  /** The physical memory, in MB. */
  readonly memoryMb: number;
  /** The logical processors. */
  readonly cores: number;
  /** The memory of the programs with no lease, in MB: the editor, the browser and the system. */
  readonly otherMb: number;
  /** The capacity of the slot `browser`. */
  readonly browsers: number;
}

/** The computers, the first is the default. */
export const MACHINES: readonly Machine[] = [
  { id: "laptop", label: "Laptop: 16 GB, 12 cores", memoryMb: 16_384, cores: 12, otherMb: 5120, browsers: 1 },
  { id: "small", label: "Small laptop: 8 GB, 8 cores", memoryMb: 8192, cores: 8, otherMb: 3072, browsers: 1 },
  { id: "workstation", label: "Workstation: 32 GB, 24 cores", memoryMb: 32_768, cores: 24, otherMb: 8192, browsers: 2 },
];

/** This function gives the computer of an id, or the default computer for an unknown id. */
export function machineOf(id: string): Machine {
  return MACHINES.find((each) => each.id === id) ?? (MACHINES[0] as Machine);
}

/** The jobs of the burst: the kind and the holder of each, in the order of their requests. */
export const BURST: readonly (readonly [kind: string, holder: string])[] = [
  ["leak", "data"],
  ["test", "api"],
  ["e2e", "web"],
  ["churn", "cli"],
  ["build", "docs"],
  ["test", "web"],
];

/** The jobs at the first load of the page, so that the queue already shows a wait. */
export const START: readonly (readonly [kind: string, holder: string])[] = [
  ["test", "api"],
  ["e2e", "web"],
  ["churn", "cli"],
  ["build", "docs"],
];
