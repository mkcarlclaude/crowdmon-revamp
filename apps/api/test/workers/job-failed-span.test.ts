import { env } from "cloudflare:test";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import type { JobResponse } from "../../src/schemas";
import { seedDownloadJob } from "./seed";

/**
 * `job.failed` (M9.3) lives beside the SQL that decides whether to emit it
 * (routes/jobs.ts), unlike `job.reclaimed`/`job.retired`, whose emitter sits
 * in reclaim-spans.ts and is tested on Node because `@opentelemetry/api` was
 * believed unable to resolve under workerd's module loader — see
 * routes/jobs.ts's comment on why that belief no longer holds. This file is
 * the proof: it runs the exact `BasicTracerProvider` /
 * `InMemorySpanExporter` / `AsyncLocalStorageContextManager` setup
 * test/node/traceparent.test.ts uses, but inside the `workers` vitest
 * project, against the real `completeJobHandler`.
 */

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
});

async function post(path: string, body: unknown) {
  return app.request(
    path,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    env,
  );
}

async function claimAJob(videoId: string): Promise<JobResponse> {
  await seedDownloadJob(videoId);
  const res = await post("/api/jobs/claim", { worker_id: "w1" });
  return (await res.json()) as JobResponse;
}

function failedSpans() {
  return exporter.getFinishedSpans().filter((span) => span.name === "job.failed");
}

describe("job.failed span", () => {
  it("is emitted once when a job is reported failed", async () => {
    exporter.reset();
    const job = await claimAJob("fffffffffff");

    const res = await post(`/api/jobs/${job.id}/complete`, {
      worker_id: "w1",
      status: "failed",
      failure_reason: "video unavailable",
    });

    expect(res.status).toBe(204);
    const spans = failedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes).toMatchObject({
      "crowdmon.job.id": job.id,
      "crowdmon.job.kind": "download",
      "crowdmon.video.id": "fffffffffff",
      "crowdmon.job.attempts": 1,
      "crowdmon.job.failure_reason": "video unavailable",
    });
  });

  // The whole reason this milestone exists: before it, a reported failure and
  // a reported success were indistinguishable at Tempo's span-metrics layer.
  it("is not emitted when a job is reported done", async () => {
    exporter.reset();
    const job = await claimAJob("ggggggggggg");

    await post(`/api/jobs/${job.id}/complete`, { worker_id: "w1", status: "done" });

    expect(failedSpans()).toHaveLength(0);
  });

  it("carries no failure_reason attribute when none was given", async () => {
    exporter.reset();
    const job = await claimAJob("hhhhhhhhhhh");

    await post(`/api/jobs/${job.id}/complete`, { worker_id: "w1", status: "failed" });

    const span = failedSpans()[0];
    expect(span).toBeDefined();
    expect(span?.attributes["crowdmon.job.failure_reason"]).toBeUndefined();
  });

  it("is not emitted for a worker that does not hold the job", async () => {
    exporter.reset();
    const job = await claimAJob("iiiiiiiiiii");

    const res = await post(`/api/jobs/${job.id}/complete`, {
      worker_id: "someone-else",
      status: "failed",
      failure_reason: "video unavailable",
    });

    expect(res.status).toBe(404);
    expect(failedSpans()).toHaveLength(0);
  });
});
