/**
 * The context of the traces of the daemon. The daemon starts the entry `/node/context` of `@mark1russell7/otel-ts`: the
 * context of OpenTelemetry and a tracer provider with the resource of the service. That entry loads no SDK of
 * `@opentelemetry/sdk-node`, no exporter and no instrumentation. Thus no span leaves the process, and the daemon pays only
 * for the context.
 *
 * - The host starts the context before its listeners, and its last stop phase, `flush the output`, stops it.
 * - Each procedure call is a span of the host (`tracingInterceptor` of `@procedures/client`, in `daemonPolicy`).
 * - Each call of the hook is a span (`inRequestSpan`), in the trace of the `traceparent` header of its caller.
 * - Each line of the log of the daemon in a span gets the trace id and the span id of that span (`withTraceIds`).
 * - The export of the spans waits for an endpoint. A test gives a span processor with the exporter of its capture.
 */
import { readFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { context, isSpanContextValid, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { incomingContext } from "@mark1russell7/otel-ts/context";
import { startNodeContext, type NodeContext, type NodeContextOptions } from "@mark1russell7/otel-ts/node/context";

/** The name of the service in the resource of each span, and the name of the tracer of the daemon. */
export const SERVICE_NAME = "headroom";

/** This function gives the version of the daemon package, from its `package.json`. */
export function daemonVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  return typeof manifest.version === "string" ? manifest.version : "unknown";
}

/** The options of `startTelemetry`. */
export interface TelemetryOptions {
  /** The version of the daemon package: the attribute `service.version` of the resource. */
  readonly version: string;
  /** The span processors. The daemon gives none, thus no span leaves the process. A test gives the processor of its capture. */
  readonly spanProcessors?: NodeContextOptions["spanProcessors"];
  /** The environment of the resource detectors (`OTEL_NODE_RESOURCE_DETECTORS`). The default is `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * This function registers the context of the traces of the daemon, with the resource of the service. A second start before
 * the `shutdown()` of the first throws.
 */
export function startTelemetry(options: TelemetryOptions): NodeContext {
  return startNodeContext({
    serviceName: SERVICE_NAME,
    resourceAttributes: { "service.version": options.version },
    ...(options.spanProcessors === undefined ? {} : { spanProcessors: options.spanProcessors }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

/** This function gives the words of the trace ids of the active span for the end of a line, or "" when no span is active. */
export function traceWords(): string {
  const ids = trace.getActiveSpan()?.spanContext();
  return ids !== undefined && isSpanContextValid(ids) ? ` trace_id=${ids.traceId} span_id=${ids.spanId}` : "";
}

/** This function gives a log that writes each line with the trace ids of the active span. A line with no span does not change. */
export function withTraceIds(log: (line: string) => void): (line: string) => void {
  return (line) => log(`${line}${traceWords()}`);
}

/**
 * This function runs `work` in a span of the host named `name`. The span continues the trace of the `traceparent` header of
 * the caller. It takes no baggage from the caller. A rejection of `work` gives the span the status `error`.
 */
export async function inRequestSpan<T>(name: string, headers: IncomingHttpHeaders, work: () => Promise<T>): Promise<T> {
  const parent = incomingContext(headers, { trust: "trace" });
  const span = trace.getTracer(SERVICE_NAME).startSpan(name, { kind: SpanKind.SERVER }, parent);
  try {
    return await context.with(trace.setSpan(parent, span), work);
  } catch (error) {
    span.recordException(error instanceof Error ? error : String(error));
    span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    span.end();
  }
}
