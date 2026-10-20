// @ts-check
/**
 * The stdio bridge of the MCP gateway: `node bridge.mjs <name>`.
 *
 * A program that can only start a stdio MCP server starts the bridge, for example the launcher of a
 * plugin. The bridge sends each message of its input to the server `<name>` of the gateway. It writes
 * each message of the gateway to its output.
 *
 * - This file is JavaScript, not TypeScript, and it uses no package. Thus Node loads no type stripper,
 *   and the bridge uses approximately 29 MB, not 40 MB.
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

/** @typedef {{ jsonrpc: "2.0", id?: string | number | null, method?: string, params?: Record<string, unknown>, result?: Record<string, unknown> }} Message */

const RETRIES = 5;

/** This function reads the discovery file of the daemon, as `paths.ts` does. */
function discovery() {
  try {
    const file = join(process.env["HEADROOM_HOME"] ?? join(homedir(), ".headroom"), "daemon.json");
    return /** @type {{ endpoint: string, token: string }} */ (JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

/** @param {number} ms */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The bridge of one server of the gateway. */
export class Bridge {
  /** @type {string} */ #name;
  /** @type {(message: unknown) => void} */ #write;
  /** @type {string | undefined} */ #token;
  /** @type {string | undefined} */ #session;
  /** @type {string | undefined} */ #version;
  /** @type {Message | undefined} */ #initialize;
  /** @type {Promise<void>} */ #ready = Promise.resolve();
  #listening = false;
  #closed = false;

  /**
   * @param {string} name
   * @param {(message: unknown) => void} write
   */
  constructor(name, write) {
    this.#name = name;
    this.#write = write;
    this.#token = discovery()?.token;
  }

  /**
   * This function sends one message of the client. The `initialize` request goes first, and the others wait for it.
   * @param {Message} message
   * @returns {Promise<void>}
   */
  send(message) {
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
  async close() {
    this.#closed = true;
    if (!this.#session) return;
    await fetch(this.#url(), { method: "DELETE", headers: this.#headers() }).catch(() => undefined);
  }

  #url() {
    const endpoint = discovery()?.endpoint ?? "http://127.0.0.1:4730/api";
    return `${new URL(endpoint).origin}/mcp/${encodeURIComponent(this.#name)}`;
  }

  /** @returns {Record<string, string>} */
  #headers(accept = "application/json, text/event-stream") {
    return {
      accept,
      "content-type": "application/json",
      ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
      ...(this.#session ? { "mcp-session-id": this.#session } : {}),
      ...(this.#version ? { "mcp-protocol-version": this.#version } : {}),
    };
  }

  /**
   * @param {Message} message
   * @param {(message: unknown) => void} write
   * @returns {Promise<void>}
   */
  async #post(message, write, attempt = 0) {
    /** @type {Response} */
    let res;
    try {
      res = await fetch(this.#url(), { method: "POST", headers: this.#headers(), body: JSON.stringify(message) });
    } catch (error) {
      // The daemon does not answer: it can be in a restart. Wait, then try again with a new session.
      if (attempt < RETRIES) {
        await pause(1000 * (attempt + 1));
        return this.#again(message, write, attempt);
      }
      return this.#fail(message, `The MCP gateway does not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (res.status === 401 && attempt < RETRIES) {
      this.#token = discovery()?.token;
      return this.#post(message, write, attempt + 1);
    }
    if (res.status === 404 && this.#session && message.method !== "initialize" && attempt < RETRIES) return this.#again(message, write, attempt);
    const session = res.headers.get("mcp-session-id");
    if (session) this.#session = session;
    if (res.status === 202) return;
    if (!res.ok) return this.#fail(message, `The MCP gateway answered ${res.status}: ${(await res.text()).slice(0, 500)}`);
    /** @param {unknown} item */
    const handle = (item) => {
      const result = /** @type {Message} */ (item).result;
      if (message.method === "initialize" && typeof result?.["protocolVersion"] === "string") this.#version = result["protocolVersion"];
      write(item);
    };
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) await readEvents(res, handle);
    else {
      const text = await res.text();
      if (text.trim()) for (const item of [JSON.parse(text)].flat()) handle(item);
    }
  }

  /**
   * This function opens a new session with the first `initialize` of the client, then sends the message again.
   * @param {Message} message
   * @param {(message: unknown) => void} write
   * @param {number} attempt
   * @returns {Promise<void>}
   */
  async #again(message, write, attempt) {
    if (this.#initialize && message.method !== "initialize") {
      this.#session = undefined;
      this.#token = discovery()?.token;
      const silent = () => undefined;
      await this.#post(this.#initialize, silent, RETRIES);
      await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" }, silent, RETRIES);
      void this.#listen();
    }
    return this.#post(message, write, attempt + 1);
  }

  /**
   * @param {Message} message
   * @param {string} text
   */
  #fail(message, text) {
    process.stderr.write(`headroom bridge ${this.#name}: ${text}\n`);
    if (message.id !== undefined && message.method !== undefined) this.#write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: text } });
  }

  /** This function keeps the stream of the notifications of the server open while the session lives. */
  async #listen() {
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

/**
 * This function reads a stream of server-sent events, and gives the data of each event as JSON.
 * @param {Response} res
 * @param {(item: unknown) => void} handle
 */
async function readEvents(res, handle) {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  /** @param {string} block */
  const flush = (block) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data.trim()) handle(JSON.parse(data));
  };
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    /** @type {RegExpExecArray | null} */
    let end;
    while ((end = /\r?\n\r?\n/.exec(buffer))) {
      flush(buffer.slice(0, end.index));
      buffer = buffer.slice(end.index + end[0].length);
    }
  }
  if (buffer.trim()) flush(buffer);
}

/**
 * This function connects the input and the output of this process to a server of the gateway.
 * @param {string} name
 */
export function runBridge(name) {
  const bridge = new Bridge(name, (message) => process.stdout.write(`${JSON.stringify(message)}\n`));
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (raw) => {
    // Some programs write a byte order mark before the first line.
    const line = raw.replace(/^﻿/, "");
    if (!line.trim()) return;
    /** @type {Message} */
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write(`headroom bridge ${name}: a line is not JSON\n`);
      return;
    }
    bridge.send(message).catch((error) => process.stderr.write(`headroom bridge ${name}: ${String(error)}\n`));
  });
  input.on("close", () => {
    void bridge.close().finally(() => process.exit(0));
  });
}

/**
 * This function tells if the gateway serves a server: a GET without a session gets 400 from a configured
 * server, 404 from an unknown server, and no answer when the daemon does not run.
 * @param {string} name
 */
export async function gatewayServes(name) {
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
 * @param {readonly string[]} command
 */
function runLocal(command) {
  const [file, ...args] = command;
  if (!file) process.exit(2);
  // On Windows, npx and pnpm are .cmd files, which only a shell starts. The shell gets one quoted command line.
  /** @param {string} arg */
  const quote = (arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);
  const child =
    process.platform === "win32"
      ? spawn([file, ...args].map(quote).join(" "), { stdio: "inherit", shell: true })
      : spawn(file, args, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
  child.on("error", (error) => {
    process.stderr.write(`headroom bridge: the local server did not start: ${error.message}\n`);
    process.exit(127);
  });
}

if (import.meta.main) {
  // node bridge.mjs <name> [-- <command> [args...]]: the command is the local copy, for when the gateway does not serve <name>.
  const [name, separator, ...command] = process.argv.slice(2);
  if (!name || (separator !== undefined && separator !== "--")) {
    process.stderr.write("Usage: node bridge.mjs <name> [-- <command> [args...]]\n");
    process.exit(2);
  }
  if (command.length > 0 && !(await gatewayServes(name))) runLocal(command);
  else runBridge(name);
}
