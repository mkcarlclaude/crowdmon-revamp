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
 * id, so the lease check here reads `jobs` for a claimed row of the right
 * kind instead of a job's primary key. Before migration 0011 (M17, plan §B)
 * dropped `idx_jobs_one_prelabel_per_video`, that read was provably exact for
 * a prelabel job (at most one could ever be held per video); it now proves
 * the same, slightly weaker thing `dryrun`'s own case always did — this
 * worker holds *a* claimed sampling job for this video — which is still all
 * the guarantee this route needs (`listVideoImagesHandler`'s own comment).
 * Every test below is really testing that substitution: a row exists exactly
 * when a prelabel or dry-run job (M12.2) for this video is claimed by this
 * worker, and not otherwise.
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

  it("serves a worker holding a dry-run lease, not only a prelabel one", async () => {
    // M12.2's dry-run samples from the same pool through the same client, so a
    // check that named only `prelabel` would 404 every dry-run ever queued —
    // the worker would report it as a lost lease and the job would fail.
    await seedVideo("ggggggggggg");
    await seedImage("ggggggggggg", "frames/ggggggggggg/00000.000.jpg", 0);
    const at = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO jobs (kind, video_id, status, claimed_by, claimed_at, heartbeat_at)
            VALUES ('dryrun', ?, 'claimed', 'w1', ?, ?)`,
    )
      .bind("ggggggggggg", at, at)
      .run();

    const res = await listVideoImages("ggggggggggg", "w1");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      video_id: "ggggggggggg",
      images: [{ r2_key: "frames/ggggggggggg/00000.000.jpg", timestamp_seconds: 0 }],
    });
  });

  it("still rejects a worker holding a dry-run lease on a different video", async () => {
    await seedVideo("hhhhhhhhhhh");
    await seedVideo("iiiiiiiiiii");
    const at = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO jobs (kind, video_id, status, claimed_by, claimed_at, heartbeat_at)
            VALUES ('dryrun', ?, 'claimed', 'w1', ?, ?)`,
    )
      .bind("hhhhhhhhhhh", at, at)
      .run();

    const res = await listVideoImages("iiiiiiiiiii", "w1");

    expect(res.status).toBe(404);
  });

  it("rejects a request with no worker_id", async () => {
    await seedHeldPrelabelJob("fffffffffff");

    const res = await listVideoImages("fffffffffff", undefined);

    expect(res.status).toBe(400);
  });
});
