import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app";

// A stand-in for what `instrument()` does in the real runtime: open a span
// around the request and make it the active one. Testing against the real
// wrapper would mean booting workerd, which buys nothing here — the behaviour
// under test is what the middleware does to whatever span is already active.
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

const env = { ENVIRONMENT: "test" };

beforeAll(() => {
  // Without a context manager, `context.active()` always returns the root and
  // the middleware would never find a span — the test would pass vacuously.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
});

beforeEach(() => {
  exporter.reset();
});

async function requestInsideSpan(path: string, method = "GET") {
  const tracer = trace.getTracer("test");
  await tracer.startActiveSpan("fetchHandler", async (span) => {
    await app.request(path, { method }, env);
    span.end();
  });
  const [span] = exporter.getFinishedSpans();
  // Asserted rather than returned optional: no span means the context manager
  // never propagated, and every assertion below would silently pass on
  // `undefined` instead of reporting the real failure.
  expect(span).toBeDefined();
  return span as NonNullable<typeof span>;
}

describe("span naming", () => {
  it("renames the request span after the matched route", async () => {
    const span = await requestInsideSpan("/health");

    expect(span.name).toBe("GET /health");
    expect(span.attributes["http.route"]).toBe("/health");
  });

  it("does not claim a route when nothing matched", async () => {
    const span = await requestInsideSpan("/nope");

    // `/*` is Hono's non-match sentinel. Recording it as http.route would
    // collapse every unmatched path in the system into a single series and
    // report a template that does not exist.
    expect(span.name).toBe("GET");
    expect(span.attributes["http.route"]).toBeUndefined();
  });

  it("distinguishes methods on the same path", async () => {
    const span = await requestInsideSpan("/health", "POST");

    // POST /health is not routed, so this is the non-match path — the point is
    // that the name still carries the method rather than being shared with GET.
    expect(span.name).toBe("POST");
  });
});
