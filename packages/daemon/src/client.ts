/**
 * The client of the daemon: it finds the daemon through its discovery file and calls its procedures.
 */

import { processIsAlive } from "@headroom/core";
import { Client, HttpTransport } from "@procedures/client";
import { readDiscovery } from "./paths.ts";

/** A connection to the running daemon. */
export interface Connection {
  readonly endpoint: string;
  /** This function calls a procedure of the daemon and gives its last value. */
  call<T>(path: readonly string[], input: unknown): Promise<T>;
}

/** This function connects to the running daemon, or gives `null` when none runs. */
export function connect(): Connection | null {
  const discovery = readDiscovery();
  if (!discovery || !processIsAlive(discovery.pid)) return null;
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
