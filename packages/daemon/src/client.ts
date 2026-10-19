/**
 * The client of the daemon: it finds the daemon through its discovery file and calls its procedures.
 */

import { processIsAlive } from "@headroom/core";
import { Client, HttpTransport } from "@procedures/client";
import { readDiscovery, type Discovery } from "./paths.ts";

/** A connection to the running daemon. */
export interface Connection {
  readonly endpoint: string;
  /** This function calls a procedure of the daemon and gives its last value. */
  call<T>(path: readonly string[], input: unknown): Promise<T>;
}

/** This function connects to the daemon that a discovery file names. */
export function connectTo(discovery: Discovery): Connection {
  const transport = new HttpTransport({ baseUrl: discovery.endpoint, defaultHeaders: { Authorization: `Bearer ${discovery.token}` } });
  const client = new Client({ transport });
  return {
    endpoint: discovery.endpoint,
    async call<T>(path: readonly string[], input: unknown): Promise<T> {
      const method = { service: path.slice(0, -1).join("."), operation: path[path.length - 1] ?? "" };
      let last: { value: unknown } | undefined;
      for await (const item of client.stream(method, input)) last = { value: item };
      if (!last) throw new Error(`headroom gave no answer to ${path.join(".")}`);
      return last.value as T;
    },
  };
}

/** This function connects to the running daemon, or gives `null` when none runs. */
export function connect(): Connection | null {
  const discovery = readDiscovery();
  if (!discovery || !processIsAlive(discovery.pid)) return null;
  return connectTo(discovery);
}

/**
 * This function tells if the daemon of a discovery file answers. After a restart of the computer, a new
 * process can have the process ID of the old daemon. Thus a live process ID is not sufficient.
 */
export async function answers(discovery: Discovery, timeoutMs: number = 3000): Promise<boolean> {
  if (!processIsAlive(discovery.pid)) return false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const call = connectTo(discovery)
    .call(["resources", "status"], {})
    .then(() => true, () => false);
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** This function tells if an error comes from a daemon that does not answer, not from the procedure. */
export function isNetworkError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "NETWORK_ERROR";
}

const RESTART_CODES = new Set(["NETWORK_ERROR", "UNAUTHORIZED", "UNAVAILABLE", "SERVICE_UNAVAILABLE"]);

/** This function tells if an error comes from a restart of the daemon. The causes: no answer, an old token, or a daemon that stops. */
export function isRestartError(error: unknown): boolean {
  return typeof error === "object" && error !== null && RESTART_CODES.has(String((error as { code?: unknown }).code));
}
