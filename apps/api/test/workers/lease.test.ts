import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import type { JobResponse } from "../../src/schemas";
import { seedDownloadJob } from "./seed";

async function post(path: string, body: unknown) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function claimAJob(workerId: string): Promise<JobResponse> {
  await seedDownloadJob("aaaaaaaaaaa");

  const res = await post("/api/jobs/claim", { worker_id: workerId });
  return (await res.json()) as JobResponse;
}

function jobRow(id: number) {
  return env.DB.prepare(
    "SELECT status, claimed_by, heartbeat_at, failure_reason FROM jobs WHERE id = ?",
  )
    .bind(id)
    .first<{
      status: string;
      claimed_by: string | null;
      heartbeat_at: number | null;
      failure_reason: string | null;
    }>();
}

describe("POST /api/jobs/{id}/heartbeat", () => {
  let job: JobResponse;

  beforeEach(async () => {
    job = await claimAJob("w1");
  });

  it("renews the lease", async () => {
    // Wind the lease back so the renewal is visible: within one second the
    // before and after timestamps would be equal and the test would pass
    // whether or not the handler wrote anything.
    await env.DB.prepare("UPDATE jobs SET heartbeat_at = heartbeat_at - 600 WHERE id = ?")
      .bind(job.id)
      .run();
    const stale = (await jobRow(job.id))?.heartbeat_at ?? 0;

    const res = await post(`/api/jobs/${job.id}/heartbeat`, { worker_id: "w1" });

    expect(res.status).toBe(204);
    const renewed = (await jobRow(job.id))?.heartbeat_at ?? 0;
    expect(renewed).toBeGreaterThan(stale);
  });

  it("refuses a worker that does not hold the job", async () => {
    const res = await post(`/api/jobs/${job.id}/heartbeat`, { worker_id: "someone-else" });

    // Without the ownership check any process that knows a job id could keep
    // someone else's lease alive, and the reaper's guarantee would mean
    // nothing.
    expect(res.status).toBe(404);
  });

  it("refuses a job the reaper has already taken back", async () => {
    await env.DB.prepare("UPDATE jobs SET status = 'pending', claimed_by = NULL WHERE id = ?")
      .bind(job.id)
      .run();

    const res = await post(`/api/jobs/${job.id}/heartbeat`, { worker_id: "w1" });

    expect(res.status).toBe(404);
  });

  it("answers 404 for a job that does not exist", async () => {
    const res = await post("/api/jobs/999999/heartbeat", { worker_id: "w1" });

    expect(res.status).toBe(404);
  });
});

describe("POST /api/jobs/{id}/complete", () => {
  let job: JobResponse;

  beforeEach(async () => {
    job = await claimAJob("w1");
  });

  it("records a successful job", async () => {
    const res = await post(`/api/jobs/${job.id}/complete`, {
      worker_id: "w1",
      status: "done",
    });

    expect(res.status).toBe(204);
    expect(await jobRow(job.id)).toMatchObject({
      status: "done",
      // Cleared so a finished row cannot be mistaken for a held one, and so
      // the reaper's partial index stops covering it.
      claimed_by: null,
      heartbeat_at: null,
      failure_reason: null,
    });
  });

  it("records why a job failed", async () => {
    const res = await post(`/api/jobs/${job.id}/complete`, {
      worker_id: "w1",
      status: "failed",
      failure_reason: "video unavailable",
    });

    expect(res.status).toBe(204);
    expect(await jobRow(job.id)).toMatchObject({
      status: "failed",
      failure_reason: "video unavailable",
    });
  });

  it("drops a failure reason sent alongside success", async () => {
    await post(`/api/jobs/${job.id}/complete`, {
      worker_id: "w1",
      status: "done",
      failure_reason: "should not be recorded",
    });

    // A done job with a failure reason is a row that reads as a contradiction
    // in every dashboard that touches it.
    expect((await jobRow(job.id))?.failure_reason).toBeNull();
  });

  it("refuses a worker that does not hold the job", async () => {
    const res = await post(`/api/jobs/${job.id}/complete`, {
      worker_id: "someone-else",
      status: "done",
    });

    expect(res.status).toBe(404);
    expect((await jobRow(job.id))?.status).toBe("claimed");
  });

  it("refuses to complete the same job twice", async () => {
    await post(`/api/jobs/${job.id}/complete`, { worker_id: "w1", status: "done" });
    const res = await post(`/api/jobs/${job.id}/complete`, { worker_id: "w1", status: "failed" });

    // The second call arrives after the reaper could have re-queued and
    // another worker could have finished it. Only a held job can be closed.
    expect(res.status).toBe(404);
    expect((await jobRow(job.id))?.status).toBe("done");
  });
});
