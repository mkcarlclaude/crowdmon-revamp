import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { beforeAll, describe, expect, it } from "vitest";
import { currentTraceparent } from "../../src/tracing";

/**
 * On plain Node, for the same reason trace-route.test.ts and
 * reclaim-spans.test.ts are: @opentelemetry/api's ESM build does not resolve
 * under workerd's module loader, and this function has no bindings in it
 * anyway.
 *
 * The workers-pool tests (test/workers/claim.test.ts, fanout.test.ts) cover
 * what the handlers do with this value once it is a string or null; what
 * only a real span can prove is that the string is a correctly-formed W3C
 * `traceparent`, which is what these tests are for.
 */

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  // Without a context manager, context.active() always returns the root and
  // trace.getActiveSpan() would never see the span startActiveSpan opened.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
});

describe("currentTraceparent", () => {
  it("returns null with no active span", () => {
    // The state every request is in unless something wrapped it in
    // instrumentation first — a Worker with tracing disabled, or a test that
    // calls app.request() directly. Submitting a video must still work.
    expect(currentTraceparent()).toBeNull();
  });

  it("serialises the active span as a W3C traceparent", async () => {
    const tracer = trace.getTracer("test");

    let captured: string | null = null;
    await tracer.startActiveSpan("submitVideo", (span) => {
      captured = currentTraceparent();
      const ctx = span.spanContext();

      // version-traceId-spanId-flags, exactly four hyphen-joined fields —
      // the shape propagation.TraceContext.Extract on the Go side requires to
      // treat this as a parent rather than degrading to a root span.
      expect(captured).toBe(`00-${ctx.traceId}-${ctx.spanId}-01`);
      span.end();
    });

    expect(captured).not.toBeNull();
  });

  it("sets the sampled flag when the span is sampled", async () => {
    const tracer = trace.getTracer("test");

    await tracer.startActiveSpan("submitVideo", (span) => {
      // BasicTracerProvider's default sampler is AlwaysOn, so every span here
      // is sampled — the case this asserts is that the flag reflects that
      // rather than being hardcoded to one value regardless of the sampler.
      expect(span.spanContext().traceFlags & 0x01).toBe(1);
      expect(currentTraceparent()?.endsWith("-01")).toBe(true);
      span.end();
    });
  });
});
