import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { seedVideo } from "./seed";

/**
 * Fan-out (M7.2, M7.3): the download worker reports what it probed, and the
 * API turns that into one chunk job per 60s segment.
 *
 * The whole point of doing it here rather than in the worker is that the job
 * row and its `chunks` row must be inserted together — CONTEXT.md §Q13, which
 * M3.4's claim handler already depends on: it retires a chunk job whose chunk
 * row is missing as corruption.
 */

/** A download job already held by `workerId`, as the fan-out endpoint needs. */
async function seedHeldDownloadJob(videoId: string, workerId = "w1"): Promise<number> {
  await seedVideo(videoId);
  const at = Math.floor(Date.now() / 1000);

  const row = await env.DB.prepare(
    `INSERT INTO jobs (kind, video_id, status, attempts, claimed_by, claimed_at, heartbeat_at)
          VALUES ('download', ?, 'claimed', 1, ?, ?, ?)
       RETURNING id`,
  )
    .bind(videoId, workerId, at, at)
    .first<{ id: number }>();

  if (!row) throw new Error("seedHeldDownloadJob inserted nothing");
  return row.id;
}

function fanOut(jobId: number, body: Record<string, unknown>) {
  return app.request(
    `/api/jobs/${jobId}/fanout`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

const probed = (overrides: Record<string, unknown> = {}) => ({
  worker_id: "w1",
  duration_seconds: 150,
  width: 1920,
  height: 1080,
  ...overrides,
});

describe("POST /api/jobs/{id}/fanout", () => {
  it("enqueues one chunk job per 60s segment, the last one short", async () => {
    const jobId = await seedHeldDownloadJob("aaaaaaaaaaa");

    const res = await fanOut(jobId, probed({ duration_seconds: 150 }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ video_id: "aaaaaaaaaaa", segments: 3, created: 3 });

    const { results } = await env.DB.prepare(
      `SELECT c.segment_index, c.start_seconds, c.end_seconds, j.kind, j.status, j.video_id
         FROM chunks c JOIN jobs j ON j.id = c.job_id
        WHERE c.video_id = ?
        ORDER BY c.segment_index`,
    )
      .bind("aaaaaaaaaaa")
      .all();

    // The segments tile the video exactly: no gap, no overlap, and the last
    // one stops at the duration rather than running past the end of the file.
    expect(results).toEqual([
      {
        segment_index: 0,
        start_seconds: 0,
        end_seconds: 60,
        kind: "chunk",
        status: "pending",
        video_id: "aaaaaaaaaaa",
      },
      {
        segment_index: 1,
        start_seconds: 60,
        end_seconds: 120,
        kind: "chunk",
        status: "pending",
        video_id: "aaaaaaaaaaa",
      },
      {
        segment_index: 2,
        start_seconds: 120,
        end_seconds: 150,
        kind: "chunk",
        status: "pending",
        video_id: "aaaaaaaaaaa",
      },
    ]);
  });

  it("persists the probed metadata on the video", async () => {
    const jobId = await seedHeldDownloadJob("bbbbbbbbbbb");

    await fanOut(
      jobId,
      probed({ duration_seconds: 60, width: 1280, height: 720, title: "Paimon compilation" }),
    );

    const video = await env.DB.prepare(
      "SELECT title, duration_seconds, width, height FROM videos WHERE id = ?",
    )
      .bind("bbbbbbbbbbb")
      .first();

    expect(video).toEqual({
      title: "Paimon compilation",
      duration_seconds: 60,
      width: 1280,
      height: 720,
    });
  });

  it("creates nothing the second time — a reaped fan-out re-runs (M7.3)", async () => {
    const jobId = await seedHeldDownloadJob("ccccccccccc");

    await fanOut(jobId, probed({ duration_seconds: 150 }));
    const again = await fanOut(jobId, probed({ duration_seconds: 150 }));

    expect(again.status).toBe(200);
    // `segments` still describes the video; `created` is what this call did.
    expect(await again.json()).toEqual({ video_id: "ccccccccccc", segments: 3, created: 0 });

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE kind = 'chunk'",
    ).first<{
      n: number;
    }>();
    expect(count?.n).toBe(3);
  });

  it("finishes a fan-out that was interrupted halfway", async () => {
    const jobId = await seedHeldDownloadJob("ddddddddddd");

    // What a reap mid-fan-out leaves behind: the first segments exist and the
    // rest do not. The re-run must fill the gap without duplicating the rest.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('chunk', ?)").bind("ddddddddddd"),
      env.DB.prepare(
        `INSERT INTO chunks (job_id, video_id, segment_index, start_seconds, end_seconds)
                VALUES (last_insert_rowid(), ?, 0, 0, 60)`,
      ).bind("ddddddddddd"),
    ]);

    const res = await fanOut(jobId, probed({ duration_seconds: 150 }));

    expect(await res.json()).toEqual({ video_id: "ddddddddddd", segments: 3, created: 2 });

    const rows = await env.DB.prepare(
      "SELECT segment_index FROM chunks WHERE video_id = ? ORDER BY segment_index",
    )
      .bind("ddddddddddd")
      .all();
    expect(rows.results).toEqual([
      { segment_index: 0 },
      { segment_index: 1 },
      { segment_index: 2 },
    ]);

    // Every chunk job has exactly one chunk row. A job inserted without one is
    // the state M3.4's claim handler retires as corruption, so a fan-out that
    // could leave one behind would quietly destroy a segment.
    const orphans = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM jobs j WHERE j.kind = 'chunk' AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.job_id = j.id)",
    ).first<{ n: number }>();
    expect(orphans?.n).toBe(0);
  });

  it("rejects a job this worker does not hold", async () => {
    const jobId = await seedHeldDownloadJob("eeeeeeeeeee", "somebody-else");

    const res = await fanOut(jobId, probed({ worker_id: "w1" }));

    expect(res.status).toBe(404);
    const chunks = await env.DB.prepare("SELECT COUNT(*) AS n FROM chunks").first<{ n: number }>();
    expect(chunks?.n).toBe(0);
  });

  it("rejects fanning out a chunk job", async () => {
    await seedVideo("fffffffffff");
    const at = Math.floor(Date.now() / 1000);
    const row = await env.DB.prepare(
      `INSERT INTO jobs (kind, video_id, status, claimed_by, claimed_at, heartbeat_at)
            VALUES ('chunk', ?, 'claimed', 'w1', ?, ?)
         RETURNING id`,
    )
      .bind("fffffffffff", at, at)
      .first<{ id: number }>();

    const res = await fanOut(row?.id ?? 0, probed());

    // 400, not 404: the lease is real and the worker is who it says it is —
    // what is wrong is the request, and a 404 would send it looking for a lost
    // lease that it still holds.
    expect(res.status).toBe(400);
  });

  it("rejects a duration no video could have", async () => {
    const jobId = await seedHeldDownloadJob("ggggggggggg");

    expect((await fanOut(jobId, probed({ duration_seconds: 0 }))).status).toBe(400);
    expect((await fanOut(jobId, probed({ duration_seconds: -60 }))).status).toBe(400);
  });

  it("fans out a long video in one batch", async () => {
    const jobId = await seedHeldDownloadJob("hhhhhhhhhhh");

    // Four hours. Fan-out is one D1 batch by design (CONTEXT.md §Q13), so the
    // ceiling on statements per batch is a real ceiling on video length — and
    // an unrunnable one would show up as a failed download job in production
    // rather than here.
    const res = await fanOut(jobId, probed({ duration_seconds: 4 * 60 * 60 }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ video_id: "hhhhhhhhhhh", segments: 240, created: 240 });
  });
});
