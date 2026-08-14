import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { seedVideo } from "./seed";

/**
 * `completeJobHandler`'s M11.1 addition: the video's one `prelabel` job is
 * enqueued the instant its last `chunk` job finishes, not one per chunk — a
 * chunk job only ever sees its own sixty seconds, so no single chunk's
 * completion can assemble the whole-timeline sample M11.3 draws from.
 *
 * These tests write chunk jobs directly with SQL, the same way `fanout.test`
 * seeds a half-fanned-out video by hand: what is under test is
 * `completeJobHandler`'s own decision, not fan-out's.
 */

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    env,
  );
}

/** N claimed chunk jobs for one video, each with its own `chunks` row. */
async function seedClaimedChunkJobs(
  videoId: string,
  n: number,
  workerId = "w1",
): Promise<number[]> {
  const at = Math.floor(Date.now() / 1000);
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const row = await env.DB.prepare(
      `INSERT INTO jobs (kind, video_id, status, attempts, claimed_by, claimed_at, heartbeat_at)
            VALUES ('chunk', ?, 'claimed', 1, ?, ?, ?)
         RETURNING id`,
    )
      .bind(videoId, workerId, at, at)
      .first<{ id: number }>();
    if (!row) throw new Error("seedClaimedChunkJobs inserted nothing");
    await env.DB.prepare(
      `INSERT INTO chunks (job_id, video_id, segment_index, start_seconds, end_seconds)
            VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(row.id, videoId, i, i * 60, i * 60 + 60)
      .run();
    ids.push(row.id);
  }
  return ids;
}

function prelabelJobs(videoId: string) {
  return env.DB.prepare(
    "SELECT id, traceparent, selection_reason FROM jobs WHERE video_id = ? AND kind = 'prelabel'",
  )
    .bind(videoId)
    .all<{ id: number; traceparent: string | null; selection_reason: string | null }>();
}

describe("completing a chunk job's effect on the video's prelabel job", () => {
  // The regression test the M17 plan calls for by name: "The automatic first
  // pass still happens with no admin action after the last chunk completes.
  // This is the regression test for v2's done-claim; it should have existed
  // already." It did — this test predates M17 — and it now also pins the
  // `selection_reason` this milestone added: the automatic pass must keep
  // stamping `'random'`, the value `reportPredictionsHandler`'s write-once
  // stamp will read straight off this job's own row once a prelabel worker
  // reports back (M17, plan §B; see `predictions.test.ts`'s own tests on that
  // handler).
  it("enqueues one prelabel job when the last chunk completes, stamped 'random'", async () => {
    await seedVideo("aaaaaaaaaaa");
    const [c0, c1] = await seedClaimedChunkJobs("aaaaaaaaaaa", 2);

    const first = await post(`/api/jobs/${c0}/complete`, { worker_id: "w1", status: "done" });
    expect(first.status).toBe(204);
    // One chunk still short of 'done' — nothing to enqueue yet.
    expect((await prelabelJobs("aaaaaaaaaaa")).results).toHaveLength(0);

    const last = await post(`/api/jobs/${c1}/complete`, { worker_id: "w1", status: "done" });
    expect(last.status).toBe(204);

    const rows = (await prelabelJobs("aaaaaaaaaaa")).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.selection_reason).toBe("random");
  });

  it("does not enqueue while any chunk is still pending or claimed", async () => {
    await seedVideo("bbbbbbbbbbb");
    const [c0] = await seedClaimedChunkJobs("bbbbbbbbbbb", 1);
    // A second chunk that exists but was never claimed.
    await env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('chunk', ?)")
      .bind("bbbbbbbbbbb")
      .run();

    await post(`/api/jobs/${c0}/complete`, { worker_id: "w1", status: "done" });

    expect((await prelabelJobs("bbbbbbbbbbb")).results).toHaveLength(0);
  });

  it("never enqueues for a chunk that fails rather than finishing — a video with a permanently failed chunk never becomes 'all done'", async () => {
    await seedVideo("ccccccccccc");
    const [c0, c1] = await seedClaimedChunkJobs("ccccccccccc", 2);

    await post(`/api/jobs/${c0}/complete`, {
      worker_id: "w1",
      status: "failed",
      failure_reason: "ffmpeg crashed",
    });
    await post(`/api/jobs/${c1}/complete`, { worker_id: "w1", status: "done" });

    // c0 sits at 'failed', never 'done', so the NOT EXISTS guard never
    // clears — this video simply never gets a prelabel job under today's
    // rule, a known and accepted gap rather than a bug this milestone closes.
    expect((await prelabelJobs("ccccccccccc")).results).toHaveLength(0);
  });

  it("does not enqueue a second prelabel job when the video already has one — the reap-and-rerun case", async () => {
    await seedVideo("ddddddddddd");
    const [c0] = await seedClaimedChunkJobs("ddddddddddd", 1);
    // Simulates the last chunk having already been completed once (by a
    // worker whose own completion request this test does not need to
    // replay) and a prelabel job already sitting in the queue as a result —
    // then the same chunk is reaped, re-run, and completed a second time.
    await env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('prelabel', ?)")
      .bind("ddddddddddd")
      .run();

    const res = await post(`/api/jobs/${c0}/complete`, { worker_id: "w1", status: "done" });

    // The worker did nothing wrong — reporting a chunk done is legitimate
    // even though this video's prelabel job already exists — so the
    // completion itself still succeeds.
    expect(res.status).toBe(204);
    expect((await prelabelJobs("ddddddddddd")).results).toHaveLength(1);
  });

  it("does not enqueue when the job completed is a download, not a chunk", async () => {
    await seedVideo("eeeeeeeeeee");
    const at = Math.floor(Date.now() / 1000);
    const row = await env.DB.prepare(
      `INSERT INTO jobs (kind, video_id, status, attempts, claimed_by, claimed_at, heartbeat_at)
            VALUES ('download', ?, 'claimed', 1, 'w1', ?, ?)
         RETURNING id`,
    )
      .bind("eeeeeeeeeee", at, at)
      .first<{ id: number }>();

    await post(`/api/jobs/${row?.id}/complete`, { worker_id: "w1", status: "done" });

    expect((await prelabelJobs("eeeeeeeeeee")).results).toHaveLength(0);
  });

  it("carries the completion request's own traceparent onto the new prelabel job", async () => {
    await seedVideo("fffffffffff");
    const [c0] = await seedClaimedChunkJobs("fffffffffff", 1);
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    await post(`/api/jobs/${c0}/complete`, { worker_id: "w1", status: "done" }, { traceparent });

    const rows = (await prelabelJobs("fffffffffff")).results;
    expect(rows).toHaveLength(1);
    // Forwarded verbatim, the same idiom fanOutJobHandler uses for the chunk
    // jobs it creates: this completion call is the request the enqueue
    // decision genuinely happened inside.
    expect(rows[0]?.traceparent).toBe(traceparent);
  });

  it("stamps null when the completion call carried no traceparent", async () => {
    await seedVideo("ggggggggggg");
    const [c0] = await seedClaimedChunkJobs("ggggggggggg", 1);

    await post(`/api/jobs/${c0}/complete`, { worker_id: "w1", status: "done" });

    const rows = (await prelabelJobs("ggggggggggg")).results;
    expect(rows[0]?.traceparent).toBeNull();
  });
});
