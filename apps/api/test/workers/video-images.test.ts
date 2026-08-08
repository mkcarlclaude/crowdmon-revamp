import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { seedVideo } from "./seed";

/**
 * `GET /api/videos/{video_id}/images` (M11.3): the candidate pool
 * `ImageSampler.Sample` (worker/internal/worker/pipeline.go) reads before
 * drawing its bounded, timeline-spread subset.
 *
 * Scoped by video id, not job id — `Sample`'s signature carries only a video
 * id, so the lease check here reads `idx_jobs_one_prelabel_per_video`
 * (migration 0005) instead of a job's primary key. Every test below is really
 * testing that substitution: a row exists exactly when a prelabel job for
 * this video is claimed by this worker, and not otherwise.
 */

/** A prelabel job for `videoId`, claimed by `workerId`, with no `chunks` row needed. */
async function seedHeldPrelabelJob(videoId: string, workerId = "w1"): Promise<void> {
  await seedVideo(videoId);
  const at = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `INSERT INTO jobs (kind, video_id, status, attempts, claimed_by, claimed_at, heartbeat_at)
          VALUES ('prelabel', ?, 'claimed', 1, ?, ?, ?)`,
  )
    .bind(videoId, workerId, at, at)
    .run();
}

async function seedImage(videoId: string, r2Key: string, timestampSeconds: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO images (r2_key, video_id, timestamp_seconds, phash, dedup_threshold)
          VALUES (?, ?, ?, 'af3c9e1b2d4f7a80', 8)`,
  )
    .bind(r2Key, videoId, timestampSeconds)
    .run();
}

function listVideoImages(videoId: string, workerId: string | undefined) {
  const query = workerId === undefined ? "" : `?worker_id=${encodeURIComponent(workerId)}`;
  return app.request(`/api/videos/${videoId}/images${query}`, {}, env);
}

describe("GET /api/videos/{video_id}/images", () => {
  it("returns every image row for the video, oldest timestamp first", async () => {
    await seedHeldPrelabelJob("aaaaaaaaaaa");
    await seedImage("aaaaaaaaaaa", "aaaaaaaaaaa/0000002.jpg", 2);
    await seedImage("aaaaaaaaaaa", "aaaaaaaaaaa/0000000.jpg", 0);
    await seedImage("aaaaaaaaaaa", "aaaaaaaaaaa/0000001.jpg", 1);

    const res = await listVideoImages("aaaaaaaaaaa", "w1");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      video_id: "aaaaaaaaaaa",
      images: [
        { r2_key: "aaaaaaaaaaa/0000000.jpg", timestamp_seconds: 0 },
        { r2_key: "aaaaaaaaaaa/0000001.jpg", timestamp_seconds: 1 },
        { r2_key: "aaaaaaaaaaa/0000002.jpg", timestamp_seconds: 2 },
      ],
    });
  });

  it("returns an empty pool for a held video with no images rows yet", async () => {
    await seedHeldPrelabelJob("bbbbbbbbbbb");

    const res = await listVideoImages("bbbbbbbbbbb", "w1");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ video_id: "bbbbbbbbbbb", images: [] });
  });

  it("rejects a worker that does not hold this video's prelabel job", async () => {
    await seedHeldPrelabelJob("ccccccccccc", "somebody-else");
    await seedImage("ccccccccccc", "ccccccccccc/0000000.jpg", 0);

    const res = await listVideoImages("ccccccccccc", "w1");

    expect(res.status).toBe(404);
  });

  it("rejects a video with no prelabel job at all", async () => {
    await seedVideo("ddddddddddd");

    const res = await listVideoImages("ddddddddddd", "w1");

    expect(res.status).toBe(404);
  });

  it("rejects a video whose only held job is a chunk job, not a prelabel job", async () => {
    // The lease check names kind = 'prelabel' explicitly (unlike the
    // job-id-scoped routes, which have a job row to read `kind` off of and so
    // answer this case with a 400): a chunk job's lease says nothing about
    // whether this worker is the one running the video's prelabel pass.
    await seedVideo("eeeeeeeeeee");
    const at = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO jobs (kind, video_id, status, claimed_by, claimed_at, heartbeat_at)
            VALUES ('chunk', ?, 'claimed', 'w1', ?, ?)`,
    )
      .bind("eeeeeeeeeee", at, at)
      .run();

    const res = await listVideoImages("eeeeeeeeeee", "w1");

    expect(res.status).toBe(404);
  });

  it("rejects a request with no worker_id", async () => {
    await seedHeldPrelabelJob("fffffffffff");

    const res = await listVideoImages("fffffffffff", undefined);

    expect(res.status).toBe(400);
  });
});
