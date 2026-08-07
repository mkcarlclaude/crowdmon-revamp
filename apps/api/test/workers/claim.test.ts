import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import type { JobResponse } from "../../src/schemas";
import { seedDownloadJob, seedVideo } from "./seed";

function claim(workerId = "w1") {
  return app.request(
    "/api/jobs/claim",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker_id: workerId }),
    },
    env,
  );
}

describe("POST /api/jobs/claim", () => {
  it("answers 204 when the queue is empty", async () => {
    const res = await claim();

    // Not 200-with-null: empty polls are the common case (CONTEXT.md §Q20,
    // ~1,000 a day at idle) and the worker's backoff should branch on the
    // status line rather than parse a body to discover it is empty.
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("hands out a pending download job", async () => {
    await seedDownloadJob("aaaaaaaaaaa");

    const res = await claim("carls-ubuntu-1");

    expect(res.status).toBe(200);
    const job = (await res.json()) as JobResponse;
    expect(job).toMatchObject({
      kind: "download",
      video_id: "aaaaaaaaaaa",
      video_url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
      attempts: 1,
    });
    // A download job has no chunk work. The worker branches on this rather
    // than re-reading `kind`.
    expect(job.chunk).toBeUndefined();

    const row = await env.DB.prepare(
      "SELECT status, claimed_by, attempts, claimed_at, heartbeat_at FROM jobs WHERE id = ?",
    )
      .bind(job.id)
      .first<{
        status: string;
        claimed_by: string;
        attempts: number;
        claimed_at: number;
        heartbeat_at: number;
      }>();
    expect(row).toMatchObject({ status: "claimed", claimed_by: "carls-ubuntu-1", attempts: 1 });
    // The lease starts ticking at the claim, not at the first heartbeat —
    // otherwise a worker that dies before its first heartbeat holds a job the
    // reaper has no timestamp to judge.
    expect(row?.heartbeat_at).toBe(row?.claimed_at);
  });

  it("counts the attempt on the claim, not on the failure", async () => {
    await seedDownloadJob("bbbbbbbbbbb");

    const first = (await (await claim()).json()) as JobResponse;
    await env.DB.prepare("UPDATE jobs SET status = 'pending' WHERE id = ?").bind(first.id).run();
    const second = (await (await claim()).json()) as JobResponse;

    // A worker that dies without ever reporting back still has to count
    // against the ceiling M6.1 enforces, or a job that crashes the worker
    // before it can report is retried forever.
    expect(second.attempts).toBe(2);
  });

  it("does not hand out a job that is already claimed", async () => {
    await seedDownloadJob("ccccccccccc");

    expect((await claim("w1")).status).toBe(200);
    expect((await claim("w2")).status).toBe(204);
  });

  it("gives two simultaneous claims two different jobs", async () => {
    await seedDownloadJob("ddddddddddd");
    await seedDownloadJob("eeeeeeeeeee");

    const [a, b] = await Promise.all([claim("w1"), claim("w2")]);

    expect([a.status, b.status]).toEqual([200, 200]);
    const [ja, jb] = (await Promise.all([a.json(), b.json()])) as [JobResponse, JobResponse];
    // The claim is one `UPDATE ... RETURNING` precisely so this cannot come
    // back as the same row twice.
    expect(ja.id).not.toBe(jb.id);
  });

  it("takes the oldest job first", async () => {
    await seedDownloadJob("fffffffffff");
    await seedDownloadJob("ggggggggggg");

    const first = (await (await claim()).json()) as JobResponse;
    const second = (await (await claim()).json()) as JobResponse;

    expect(first.id).toBeLessThan(second.id);
  });
});

describe("the trace context carried on a job row (M9.2)", () => {
  it("hands back the traceparent the row was stamped with", async () => {
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    await seedDownloadJob("jjjjjjjjjjj", traceparent);

    const job = (await (await claim()).json()) as JobResponse;

    // The worker extracts this with propagation.TraceContext and starts the
    // job's spans as a child of it — the only way submit and claim end up in
    // one trace, since nothing calls claim synchronously from submit.
    expect(job.traceparent).toBe(traceparent);
  });

  it("hands back null for a job with no stored context", async () => {
    // Every row from before migration 0002, and every submit that ran with
    // tracing disabled or no active span, looks like this. The worker's
    // fallback — start a root span, exactly as it does today — depends on
    // being able to tell that apart from a value it failed to extract.
    await seedDownloadJob("kkkkkkkkkkk");

    const job = (await (await claim()).json()) as JobResponse;

    expect(job.traceparent).toBeNull();
  });
});

describe("a job that can never be run", () => {
  it("retires a chunk job with no chunk row rather than handing it out", async () => {
    await seedVideo("iiiiiiiiiii");
    const { id } = (await env.DB.prepare(
      "INSERT INTO jobs (kind, video_id) VALUES ('chunk', ?) RETURNING id",
    )
      .bind("iiiiiiiiiii")
      .first<{ id: number }>()) as { id: number };

    const res = await claim();

    // Found on a real local run against leftover rows: without this the
    // worker is handed a chunk job with no segment to extract and discovers
    // that only after downloading. M7.2's fan-out writes the pair in one
    // `batch()`, so this is corruption rather than a reachable state — and
    // this check is what makes that a guarantee instead of a hope.
    expect(res.status).toBe(204);
    const row = await env.DB.prepare("SELECT status, failure_reason FROM jobs WHERE id = ?")
      .bind(id)
      .first();
    // Terminal, not back to pending: re-queueing hands the same broken job
    // out again on the next poll, forever.
    expect(row).toMatchObject({ status: "failed", failure_reason: "chunk row missing" });
  });
});

describe("claiming a chunk job", () => {
  beforeEach(async () => {
    await seedVideo("hhhhhhhhhhh");
    const { id } = (await env.DB.prepare(
      "INSERT INTO jobs (kind, video_id) VALUES ('chunk', ?) RETURNING id",
    )
      .bind("hhhhhhhhhhh")
      .first<{ id: number }>()) as { id: number };
    await env.DB.prepare(
      `INSERT INTO chunks (job_id, video_id, segment_index, start_seconds, end_seconds)
       VALUES (?, ?, 2, 120, 180)`,
    )
      .bind(id, "hhhhhhhhhhh")
      .run();
  });

  it("carries the segment the worker has to extract", async () => {
    const res = await claim();

    expect(res.status).toBe(200);
    const job = (await res.json()) as JobResponse;
    expect(job.kind).toBe("chunk");
    // Without this the worker would need a second round trip to find out what
    // slice of the video it just took responsibility for.
    expect(job.chunk).toEqual({ segment_index: 2, start_seconds: 120, end_seconds: 180 });
  });
});
