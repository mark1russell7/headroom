import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { captureTelemetry, type TelemetryCapture } from "@mark1russell7/rigor-testkit/otel";
import { SpanKind, trace } from "@opentelemetry/api";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { createProcedureHost, peerHostOptions } from "@procedures/peer";
import { afterEach, describe, expect, it } from "vitest";
import { connectTo } from "./client.ts";
import { DEFAULT_PORT, daemonPolicy, daemonRegistry, withFaces } from "./daemon.ts";
import { HOOK_CLIENT, HOOK_HEADER, HOOK_PATH, hookFace } from "./hook-face.ts";
import { diskProcedures } from "./procedures.ts";
import { daemonVersion, SERVICE_NAME, startTelemetry, traceWords, withTraceIds } from "./telemetry.ts";

/** The trace of the caller, in the `traceparent` header of a call of the hook. */
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const CALLER_SPAN_ID = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID}-${CALLER_SPAN_ID}-01`;
const TOKEN = "telemetry-test-token";

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

/** This function starts the context of the traces with the exporter of a capture, and stops it after the test. */
function capturedContext(): TelemetryCapture {
  const capture = captureTelemetry({ sdk: "external" });
  const context = startTelemetry({ version: "0.0.0-test", spanProcessors: [new SimpleSpanProcessor({ exporter: capture.spanExporter })], env: {} });
  stops.push(() => context.shutdown());
  return capture;
}

/**
 * This function starts the host as `serve()` makes it, with the policy of the daemon and the face of the hook. The gate of
 * links of the hook refuses each command, and it writes a line to `lines` through the log of the daemon.
 */
async function startHost(lines: string[]): Promise<number> {
  const log = withTraceIds((line) => lines.push(line));
  const base = peerHostOptions(
    {
      id: "headroom-test",
      transports: [{ type: "http", port: DEFAULT_PORT, host: "127.0.0.1", basePath: "/api" }],
      registry: daemonRegistry(diskProcedures(() => null)),
      policy: daemonPolicy(TOKEN),
    },
    "headroom",
  );
  const links = async (command: string): Promise<string> => {
    log(`The hook refused the command ${command}.`);
    return "The test refuses each command.";
  };
  // With no listener, the host serves its faces on its handler.
  const host = createProcedureHost({ ...withFaces(base, { hook: hookFace({ status: () => null, links }) }), listen: undefined });
  const server = createServer((req, res) => {
    if (!host.handler(req, res)) {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stops.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

describe("the traces of the daemon", () => {
  it("makes a span of a call of the hook in the trace of its caller, and the log line of the call has the ids of the span", async () => {
    const capture = capturedContext();
    const lines: string[] = [];
    const port = await startHost(lines);
    const response = await fetch(`http://127.0.0.1:${port}${HOOK_PATH}`, {
      method: "POST",
      headers: { [HOOK_HEADER]: HOOK_CLIENT, traceparent: TRACEPARENT, "content-type": "application/json" },
      body: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("The test refuses each command.");
    const spans = await capture.spans();
    const hook = spans.find((span) => span.name === `POST ${HOOK_PATH}`);
    expect(hook).toBeDefined();
    expect(hook!.kind).toBe(SpanKind.SERVER);
    expect(hook!.instrumentationScope.name).toBe(SERVICE_NAME);
    expect(hook!.resource.attributes).toMatchObject({ "service.name": SERVICE_NAME, "service.version": "0.0.0-test" });
    expect(hook!.spanContext().traceId).toBe(TRACE_ID);
    expect(hook!.parentSpanContext?.spanId).toBe(CALLER_SPAN_ID);
    expect(lines).toEqual([`The hook refused the command ls. trace_id=${TRACE_ID} span_id=${hook!.spanContext().spanId}`]);
  });

  it("makes a span of the host for each procedure call, in the trace of the caller", async () => {
    const capture = capturedContext();
    const port = await startHost([]);
    const connection = connectTo({ pid: process.pid, endpoint: `http://127.0.0.1:${port}/api`, token: TOKEN, startedAt: new Date(0).toISOString() });
    const traceId = await trace.getTracer("test").startActiveSpan("caller", async (caller) => {
      try {
        await connection.call(["procedure", "manifest"], { namespace: "disk" });
        return caller.spanContext().traceId;
      } finally {
        caller.end();
      }
    });
    const spans = await capture.spans();
    const host = spans.filter((span) => span.kind === SpanKind.SERVER);
    expect(host.map((span) => span.name)).toEqual(["procedure.manifest"]);
    expect(host[0]!.spanContext().traceId).toBe(traceId);
    expect(host[0]!.parentSpanContext?.isRemote).toBe(true);
  });

  it("leaves a line with no span as it is", () => {
    capturedContext();
    const lines: string[] = [];
    withTraceIds((line) => lines.push(line))("The daemon starts.");
    expect(lines).toEqual(["The daemon starts."]);
    expect(traceWords()).toBe("");
  });

  it("gives the version of the daemon package", () => {
    expect(daemonVersion()).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+/);
  });
});
