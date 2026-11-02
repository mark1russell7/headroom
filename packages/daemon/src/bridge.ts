/**
 * The stdio bridge of the MCP gateway: `node bridge.ts <name>`.
 *
 * A program that can only start a stdio MCP server starts the bridge, for example the launcher of a
 * plugin. The bridge sends each message of its input to the server `<name>` of the gateway. It writes
 * each message of the gateway to its output.
 *
 * - This file uses no package, and only the types that Node can remove. Thus Node starts it directly, with no
 *   other type stripper.
 * - It reads the token of the daemon from the discovery file. After a 401 answer, it reads the token again.
 * - A restart of the daemon ends the session. The bridge then sends the first `initialize` again, opens a
 *   new session, and sends the message again. The client does not see the restart.
 * - A second stream (GET) brings the notifications of the server, for example a change of the tools.
 * - The bridge exits when its input closes.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { windowsCommand } from "./winshell.ts";

/** One JSON-RPC message of MCP. */
export interface Message {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

/** The function that writes one message to the client. */
type Write = (message: unknown) => void;

const RETRIES = 5;

/** This function reads the discovery file of the daemon, as `paths.ts` does. */
function discovery(): { endpoint: string; token: string } | undefined {
  try {
    const file = join(process.env["HEADROOM_HOME"] ?? join(homedir(), ".headroom"), "daemon.json");
    return JSON.parse(readFileSync(file, "utf8")) as { endpoint: string; token: string };
  } catch {
    return undefined;
  }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The bridge of one server of the gateway. */
export class Bridge {
  #name: string;
  #write: Write;
  #token: string | undefined;
  #session: string | undefined;
  #version: string | undefined;
  #initialize: Message | undefined;
  #ready: Promise<void> = Promise.resolve();
  #reopening: Promise<void> | undefined;
  #listening = false;
  #closed = false;

  constructor(name: string, write: Write) {
    this.#name = name;
    this.#write = write;
    this.#token = discovery()?.token;
  }

  /** This function sends one message of the client. The `initialize` request goes first, and the others wait for it. */
  send(message: Message): Promise<void> {
    if (message.method === "initialize") {
      this.#initialize = message;
      this.#ready = this.#post(message, this.#write);
      return this.#ready;
    }
    const sent = this.#ready.then(() => this.#post(message, this.#write));
    if (message.method === "notifications/initialized") return sent.then(() => this.#listen());
    return sent;
  }

  /** This function ends the session and stops the stream of notifications. */
  async close(): Promise<void> {
    this.#closed = true;
    if (!this.#session) return;
    await fetch(this.#url(), { method: "DELETE", headers: this.#headers() }).catch(() => undefined);
  }

  #url(): string {
    const endpoint = discovery()?.endpoint ?? "http://127.0.0.1:4730/api";
    return `${new URL(endpoint).origin}/mcp/${encodeURIComponent(this.#name)}`;
  }

  #headers(accept = "application/json, text/event-stream"): Record<string, string> {
    return {
      accept,
      "content-type": "application/json",
      ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
      ...(this.#session ? { "mcp-session-id": this.#session } : {}),
      ...(this.#version ? { "mcp-protocol-version": this.#version } : {}),
    };
  }

  /** This function sends one message. While a new session opens, a message waits for it, except the messages that open it (`reopen`). */
  async #post(message: Message, write: Write, attempt = 0, reopen = false): Promise<void> {
    if (!reopen && this.#reopening) await this.#reopening;
    const used = this.#session;
    let res: Response;
    try {
      res = await fetch(this.#url(), { method: "POST", headers: this.#headers(), body: JSON.stringify(message) });
    } catch (error) {
      // The daemon does not answer: it can be in a restart. Wait, then try again with a new session.
      if (attempt < RETRIES) {
        await pause(1000 * (attempt + 1));
        return this.#again(message, write, attempt, used);
      }
      return this.#fail(message, `The MCP gateway does not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (res.status === 401 && attempt < RETRIES) {
      this.#token = discovery()?.token;
      return this.#post(message, write, attempt + 1, reopen);
    }
    if (res.status === 404 && used && message.method !== "initialize" && attempt < RETRIES) return this.#again(message, write, attempt, used);
    const session = res.headers.get("mcp-session-id");
    if (session) this.#session = session;
    if (res.status === 202) return;
    if (!res.ok) return this.#fail(message, `The MCP gateway answered ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const handle = (item: unknown): void => {
      const result = (item as Message).result;
      const version = result?.["protocolVersion"];
      if (message.method === "initialize" && typeof version === "string") this.#version = version;
      write(item);
    };
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) await readEvents(res, handle);
    else {
      const text = await res.text();
      if (text.trim()) for (const item of [JSON.parse(text) as unknown].flat()) handle(item);
    }
  }

  /**
   * This function opens a new session with the first `initialize` of the client, then sends the message again.
   * The session `lost` is the session that the message used.
   */
  async #again(message: Message, write: Write, attempt: number, lost: string | undefined): Promise<void> {
    if (this.#initialize && message.method !== "initialize") await this.#reopen(this.#initialize, lost);
    return this.#post(message, write, attempt + 1);
  }

  /**
   * This function opens one new session for all the messages that lost the session `lost`. The other messages wait for it.
   * When another message opened a new session before, the function does nothing.
   */
  #reopen(initialize: Message, lost: string | undefined): Promise<void> {
    if (this.#reopening) return this.#reopening;
    if (this.#session !== lost) return Promise.resolve();
    this.#reopening = (async () => {
      this.#session = undefined;
      this.#token = discovery()?.token;
      const silent = (): undefined => undefined;
      await this.#post(initialize, silent, RETRIES, true);
      await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" }, silent, RETRIES, true);
      void this.#listen();
    })().finally(() => {
      this.#reopening = undefined;
    });
    return this.#reopening;
  }

  #fail(message: Message, text: string): void {
    process.stderr.write(`headroom bridge ${this.#name}: ${text}\n`);
    if (message.id !== undefined && message.method !== undefined) this.#write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: text } });
  }

  /** This function keeps the stream of the notifications of the server open while the session lives. */
  async #listen(): Promise<void> {
    if (this.#listening) return;
    this.#listening = true;
    void (async () => {
      while (!this.#closed && this.#session) {
        const session = this.#session;
        try {
          const res = await fetch(this.#url(), { method: "GET", headers: this.#headers("text/event-stream") });
          if (res.status === 405 || !res.ok) {
            // A server without the stream, or a session that ended: the next request opens a new session.
            if (res.status === 405 || this.#session === session) break;
            continue;
          }
          await readEvents(res, this.#write);
        } catch {
          await pause(2000);
        }
      }
      this.#listening = false;
    })();
  }
}

/** This function reads a stream of server-sent events, and gives the data of each event as JSON. */
async function readEvents(res: Response, handle: (item: unknown) => void): Promise<void> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (block: string): void => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data.trim()) handle(JSON.parse(data));
  };
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: RegExpExecArray | null;
    while ((end = /\r?\n\r?\n/.exec(buffer))) {
      flush(buffer.slice(0, end.index));
      buffer = buffer.slice(end.index + end[0].length);
    }
  }
  if (buffer.trim()) flush(buffer);
}

/** This function connects the input and the output of this process to a server of the gateway. */
export function runBridge(name: string): void {
  const bridge = new Bridge(name, (message) => process.stdout.write(`${JSON.stringify(message)}\n`));
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (raw) => {
    // Some programs write a byte order mark before the first line.
    const line = raw.replace(/^﻿/, "");
    if (!line.trim()) return;
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      process.stderr.write(`headroom bridge ${name}: a line is not JSON\n`);
      return;
    }
    bridge.send(message).catch((error: unknown) => process.stderr.write(`headroom bridge ${name}: ${String(error)}\n`));
  });
  input.on("close", () => {
    void bridge.close().finally(() => process.exit(0));
  });
}

/**
 * This function tells if the gateway serves a server. A GET without a session gets 400 from a configured
 * server and 404 from an unknown server. When the daemon is stopped, the GET gets no answer.
 */
export async function gatewayServes(name: string): Promise<boolean> {
  const found = discovery();
  if (!found) return false;
  try {
    const url = `${new URL(found.endpoint).origin}/mcp/${encodeURIComponent(name)}`;
    const res = await fetch(url, { method: "GET", headers: { authorization: `Bearer ${found.token}` }, signal: AbortSignal.timeout(3000) });
    await res.body?.cancel();
    return res.status === 400;
  } catch {
    return false;
  }
}

/**
 * This function starts the local copy of a server in place of the gateway. It gives the input and the
 * output of this process to the copy, and exits with the exit code of the copy.
 */
function runLocal(command: readonly string[]): void {
  const [file, ...args] = command;
  if (!file) process.exit(2);
  // On Windows, a program starts directly. A .cmd file, such as npx, starts in cmd with each argument escaped.
  const win = process.platform === "win32" ? windowsCommand(command) : null;
  const child =
    win === null
      ? spawn(file, args, { stdio: "inherit" })
      : spawn(win.file, win.args, { stdio: "inherit", windowsVerbatimArguments: win.verbatim });
  child.on("exit", (code) => process.exit(code ?? 1));
  child.on("error", (error) => {
    process.stderr.write(`headroom bridge: the local server did not start: ${error.message}\n`);
    process.exit(127);
  });
}

if (import.meta.main) {
  // node bridge.ts <name> [-- <command> [args...]]: the command is the local copy, for when the gateway does not serve <name>.
  const [name, separator, ...command] = process.argv.slice(2);
  if (!name || (separator !== undefined && separator !== "--")) {
    process.stderr.write("Usage: node bridge.ts <name> [-- <command> [args...]]\n");
    process.exit(2);
  }
  if (command.length > 0 && !(await gatewayServes(name))) runLocal(command);
  else runBridge(name);
}
