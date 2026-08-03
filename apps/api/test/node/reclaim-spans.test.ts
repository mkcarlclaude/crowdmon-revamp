import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RECLAIMED_SPAN, RETIRED_SPAN, recordReclaims } from "../../src/reclaim-spans";

/**
 * M6.3, on plain Node: @opentelemetry/api's ESM build does not resolve under
 * workerd's module loader, and this module has no bindings in it anyway.
 */

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
});

beforeEach(() => {
  exporter.reset();
});

const job = (id: number, attempts: number) => ({
  id,
  kind: "download" as const,
  video_id: "aaaaaaaaaaa",
  attempts,
});

describe("recordReclaims", () => {
  it("emits one span per re-queued job", async () => {
    recordReclaims({ requeued: [job(1, 1), job(2, 2)], retired: [] });

    const spans = exporter.getFinishedSpans();
    // One per job, not one per tick carrying a count. Tempo's
    // metrics-generator turns span *rate* into a panel; a count buried in an
    // attribute cannot become a rate without a metrics pipeline this project
    // does not have.
    expect(spans).toHaveLength(2);
    expect(spans.map((s) => s.name)).toEqual([RECLAIMED_SPAN, RECLAIMED_SPAN]);
  });

  it("gives retired jobs a different span name from re-queued ones", async () => {
    recordReclaims({ requeued: [job(1, 1)], retired: [job(2, 3)] });

    const names = exporter.getFinishedSpans().map((s) => s.name);
    // Two names rather than one name plus an `outcome` attribute. The
    // metrics-generator's default dimensions are service, span name, kind and
    // status — an arbitrary attribute is not among them, so an attribute-based
    // split would not be separable in Grafana at all.
    expect(names).toContain(RECLAIMED_SPAN);
    expect(names).toContain(RETIRED_SPAN);
    expect(RECLAIMED_SPAN).not.toBe(RETIRED_SPAN);
  });

  it("records which job moved and how many attempts it had spent", async () => {
    recordReclaims({ requeued: [job(7, 2)], retired: [] });

    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes).toMatchObject({
      "crowdmon.job.id": 7,
      "crowdmon.job.kind": "download",
      "crowdmon.video.id": "aaaaaaaaaaa",
      "crowdmon.job.attempts": 2,
    });
  });

  it("emits nothing when the tick reaped nothing", async () => {
    recordReclaims({ requeued: [], retired: [] });

    // The common case by far — 288 ticks a day against a queue that is
    // usually healthy. A span per empty tick would bury the real events.
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("summarises the tick on the enclosing span", async () => {
    const tracer = trace.getTracer("test");
    await tracer.startActiveSpan("scheduled", async (span) => {
      recordReclaims({ requeued: [job(1, 1)], retired: [job(2, 3)] });
      span.end();
    });

    // The tick's own span carries the totals, so a healthy tick — which has no
    // child spans at all — still says so rather than being indistinguishable
    // from a reaper that never ran.
    const tick = exporter.getFinishedSpans().find((s) => s.name === "scheduled");
    expect(tick?.attributes).toMatchObject({
      "crowdmon.reaper.requeued": 1,
      "crowdmon.reaper.retired": 1,
    });
  });

  it("hangs the per-job spans off the tick that produced them", async () => {
    const tracer = trace.getTracer("test");
    await tracer.startActiveSpan("scheduled", async (span) => {
      recordReclaims({ requeued: [job(1, 1)], retired: [] });
      span.end();
    });

    const spans = exporter.getFinishedSpans();
    const tick = spans.find((s) => s.name === "scheduled");
    const reclaim = spans.find((s) => s.name === RECLAIMED_SPAN);

    // Parented, so a rate spike in Grafana leads back to the exact jobs
    // behind it rather than to a pile of orphan spans.
    expect(reclaim?.parentSpanContext?.spanId).toBe(tick?.spanContext().spanId);
  });
});
