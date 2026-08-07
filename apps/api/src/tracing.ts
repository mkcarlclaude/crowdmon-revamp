import type { ResolveConfigFn } from "@microlabs/otel-cf-workers";
import { trace } from "@opentelemetry/api";
import type { Bindings } from "./bindings";

/**
 * Resolved per request, which is the only way to read `env` — a Worker has no
 * module-level access to its bindings, so the endpoint and the Access token
 * cannot be baked in at build time even if we wanted them to be.
 *
 * The exporter is OTLP over **HTTP**. gRPC is not an option here: the Workers
 * runtime has `fetch` and nothing else, so the collector's 4317 receiver is
 * unreachable from the edge no matter how it is configured.
 */
export const traceConfig: ResolveConfigFn<Bindings> = (env) => ({
  exporter: {
    url: env.OTLP_ENDPOINT,
    headers: {
      "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
    },
  },
  service: {
    name: "crowdmon-api",
  },
});

/**
 * Serialises the currently active span into a W3C `traceparent` string, or
 * `null` when nothing is tracing this request.
 *
 * M9.2's join between submit and claim runs through D1, not HTTP, so the
 * value produced here is what a `jobs` row carries until a worker claims it
 * and turns it back into a parent span context. Built by hand from
 * `SpanContext` rather than pulled in from `@opentelemetry/core`'s
 * `W3CTraceContextPropagator`: that propagator injects into a carrier object,
 * which is the right shape for a header map and the wrong shape for a single
 * column, and the format itself is four fields joined by hyphens — not worth
 * a second direct dependency when `@opentelemetry/api` already exposes both
 * fields and the validity check.
 *
 * `instrument()` (index.ts) is what makes a span active in production; the
 * request handlers here have no idea whether it is installed, which is
 * exactly why this degrades to `null` instead of throwing — a Worker running
 * with tracing disabled, or a test that calls `app.request()` directly with
 * no instrumentation wrapped around it, must still be able to submit a video.
 */
export function currentTraceparent(): string | null {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext || !trace.isSpanContextValid(spanContext)) return null;

  // Only version 00 is defined, and only the sampled bit of the flags byte
  // (0x01) is ours to set — 0x02 is "random", reserved by the spec's own
  // trace-id generation rule, not a status this process can be in.
  const flags = (spanContext.traceFlags & 0x01).toString(16).padStart(2, "0");
  return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
}
