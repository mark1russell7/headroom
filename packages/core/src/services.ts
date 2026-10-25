/**
 * The health of the shared services (H27). The services are the Docker engine, the MCP servers of the gateway and the URLs
 * of the setting `health`.
 *
 * The monitor starts each check every 30 seconds, with a time limit of 3 seconds. It does not start a check again before
 * the last start of the check ends. A check that has not ended at the next round counts as a check with no answer.
 *
 * The monitor only reports. headroom does not restart a service for its health.
 */

/** The state of a service at its last check. An MCP server that the gateway stopped on purpose is `idle`. No Docker engine is `absent`. */
export type ServiceState = "ok" | "slow" | "down" | "idle" | "absent";

/** The type of a check: a ping of the Docker engine, a GET of a URL, or the state of an MCP server. */
export type ServiceType = "docker" | "url" | "mcp";

/** The result of one check. A check gives no `slow` state, because the monitor compares the latency with its limit. */
export interface ServiceProbe {
  readonly state: "ok" | "down" | "idle" | "absent";
  /** The time to the answer in milliseconds, or `null` when the check got no answer or made no call. */
  readonly latencyMs: number | null;
  /** The last error line, or `null`. */
  readonly error: string | null;
}

/** One check of a service. */
export interface ServiceCheck {
  /** The name: `docker`, `mcp:<server>`, or a name of the setting `health`. The id of the instance is `service:<name>`. */
  readonly name: string;
  readonly type: ServiceType;
  /** The name for a person, at the start of a sentence, for example "The Docker engine". */
  readonly title: string;
  /** The pipe or the URL of the check, or `null` for an MCP server. */
  readonly target: string | null;
  /** With this flag, a service that is down gives a critical alert. Without it, the alert is a warning. */
  readonly critical: boolean;
  /** The sentence that tells who needs the service. The alert adds it. */
  readonly needs?: string | undefined;
  /** This function makes the check. The monitor aborts the signal at its time limit. */
  run(signal: AbortSignal): Promise<ServiceProbe>;
}

/** The health of one service after its last check. */
export interface ServiceHealth {
  readonly name: string;
  readonly type: ServiceType;
  readonly title: string;
  readonly target: string | null;
  readonly critical: boolean;
  readonly needs: string | null;
  readonly state: ServiceState;
  /** The time to the answer of the last check in milliseconds, or `null`. */
  readonly latencyMs: number | null;
  /** The time of the last check. */
  readonly checkedAt: number;
  /** The time of the first check with the current state. */
  readonly since: number;
  /** The count of checks in a row with the current state. The alert rules use it. */
  readonly checks: number;
  /** The time of the last check that got an answer (`ok` or `slow`), or `null`. */
  readonly okAt: number | null;
  /** The last error line. It stays after the service is good again, with its time in `errorAt`. */
  readonly error: string | null;
  readonly errorAt: number | null;
}

/** The time between two rounds of checks. */
export const CHECK_EVERY_MS = 30_000;
/** The time limit of one check. */
export const CHECK_TIMEOUT_MS = 3000;
/** An answer slower than this, in milliseconds, makes the state `slow`. */
export const SLOW_MS = 1000;

/** The URLs that the monitor checks without the setting `health`: the fleet site only. */
export const DEFAULT_HEALTH: Readonly<Record<string, string>> = { "fleet-site": "http://127.0.0.1:4731/" };

/** The name of a URL check: letters, digits, `.`, `-` and `_`. A colon is not in it, so it is different from `mcp:<server>`. */
export const HEALTH_NAME: RegExp = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** The largest count of URLs in the setting `health`. */
const MAX_URLS = 20;

/**
 * This function examines the URLs of the setting `health`. It gives the URLs in their normal form, or it throws an error
 * with the cause. The name `docker` is for the Docker engine.
 */
export function checkHealth(urls: Readonly<Record<string, string>>): Record<string, string> {
  const entries = Object.entries(urls);
  if (entries.length > MAX_URLS) throw new Error(`The setting health has ${entries.length} URLs. The limit is ${MAX_URLS}.`);
  const result: Record<string, string> = {};
  for (const [name, url] of entries) {
    if (!HEALTH_NAME.test(name) || name === "docker") {
      throw new Error(`The name "${name}" of a health check is not valid. Use letters, digits, ".", "-" and "_", and not "docker".`);
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`The URL of the health check ${name} is not valid: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`The URL of the health check ${name} is not http or https: ${url}`);
    result[name] = parsed.href;
  }
  return result;
}

/** This function gives the text of an error. */
export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0]?.slice(0, 300) ?? "";
}

/**
 * This function gives the health of a service after one check. An answer slower than `slowMs` is `slow`. A state that
 * continues keeps its start time, and its count of checks increases by one.
 */
export function nextHealth(previous: ServiceHealth | undefined, check: ServiceCheck, probe: ServiceProbe, at: number, slowMs: number = SLOW_MS): ServiceHealth {
  const state: ServiceState = probe.state === "ok" && probe.latencyMs !== null && probe.latencyMs > slowMs ? "slow" : probe.state;
  const same = previous !== undefined && previous.state === state;
  return {
    name: check.name,
    type: check.type,
    title: check.title,
    target: check.target,
    critical: check.critical,
    needs: check.needs ?? null,
    state,
    latencyMs: probe.latencyMs === null ? null : Math.round(probe.latencyMs),
    checkedAt: at,
    since: same ? previous.since : at,
    checks: same ? previous.checks + 1 : 1,
    okAt: state === "ok" || state === "slow" ? at : (previous?.okAt ?? null),
    error: probe.error ?? previous?.error ?? null,
    errorAt: probe.error === null ? (previous?.errorAt ?? null) : at,
  };
}

/** The options of a service monitor. */
export interface ServiceMonitorOptions {
  /** This function gives the checks of one round. The monitor uses it at each round, so a change of the settings applies. */
  readonly checks: () => readonly ServiceCheck[];
  readonly now?: (() => number) | undefined;
  /** The time limit of one check. The default is 3 seconds. */
  readonly timeoutMs?: number | undefined;
  /** An answer slower than this is `slow`. The default is 1 second. */
  readonly slowMs?: number | undefined;
}

/** The monitor of the services: the rounds of checks and the health of each service. */
export class ServiceMonitor {
  readonly #checks: () => readonly ServiceCheck[];
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #slowMs: number;
  #health = new Map<string, ServiceHealth>();
  /** The names of the checks that have not ended. */
  readonly #running = new Set<string>();
  #round: Promise<ServiceHealth[]> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ServiceMonitorOptions) {
    this.#checks = options.checks;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
    this.#slowMs = options.slowMs ?? SLOW_MS;
  }

  /** This function gives the health of each service after the last round, in the order of the checks. */
  list(): ServiceHealth[] {
    return [...this.#health.values()];
  }

  /** This function makes one round of checks. When a round runs, it gives that round. */
  check(): Promise<ServiceHealth[]> {
    this.#round ??= this.#check().finally(() => {
      this.#round = null;
    });
    return this.#round;
  }

  /** This function starts a round at once, and then one round each `everyMs`. */
  start(everyMs: number = CHECK_EVERY_MS): void {
    if (this.#timer !== null) return;
    const round = (): void => {
      this.check().catch(() => undefined);
    };
    round();
    this.#timer = setInterval(round, everyMs);
    this.#timer.unref?.();
  }

  /** This function stops the rounds. A check that runs continues until its time limit. */
  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  async #check(): Promise<ServiceHealth[]> {
    const at = this.#now();
    let checks: readonly ServiceCheck[];
    try {
      checks = this.#checks();
    } catch {
      // The list of checks comes from the settings. A failed read keeps the health of the last round.
      return this.list();
    }
    const probes = await Promise.all(checks.map((check) => this.#probe(check)));
    const next = new Map<string, ServiceHealth>();
    checks.forEach((check, index) => {
      const probe = probes[index];
      if (probe !== undefined) next.set(check.name, nextHealth(this.#health.get(check.name), check, probe, at, this.#slowMs));
    });
    this.#health = next;
    return this.list();
  }

  /** This function makes one check with the time limit. A check that has not ended since the last round gives no answer. */
  #probe(check: ServiceCheck): Promise<ServiceProbe> {
    if (this.#running.has(check.name)) return Promise.resolve({ state: "down", latencyMs: null, error: "The check of the last round has not ended" });
    this.#running.add(check.name);
    const controller = new AbortController();
    const run = Promise.resolve()
      .then(() => check.run(controller.signal))
      .catch((error: unknown): ServiceProbe => ({ state: "down", latencyMs: null, error: errorText(error) }))
      .finally(() => this.#running.delete(check.name));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<ServiceProbe>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ state: "down", latencyMs: null, error: `No answer in ${this.#timeoutMs / 1000} s` });
      }, this.#timeoutMs);
    });
    return Promise.race([run, limit]).finally(() => clearTimeout(timer));
  }
}
