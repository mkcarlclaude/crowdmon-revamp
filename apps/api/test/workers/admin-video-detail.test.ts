import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";
import { seedImage, seedPool, seedPrediction, seedVerdict } from "./labelling-seed";
import { seedVideo } from "./seed";

/**
 * `GET /api/admin/videos/{id}` (M19, plan §A): the header
 * `/admin/videos/:id` renders above the frame grid `admin-video-images.test.ts`
 * already covers — `videos`' own metadata plus the per-video aggregates.
 */
beforeAll(installAdminIdentity);
beforeEach(configureAccess);

async function getDetail(videoId: string): Promise<Response> {
  return app.request(`/api/admin/videos/${videoId}`, { headers: await adminHeaders() }, env);
}

describe("GET /api/admin/videos/{id}", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await app.request("/api/admin/videos/dQw4w9WgXcQ", {}, env);
    expect(res.status).toBe(401);
  });

  it("404s for a video that was never submitted, unlike the frame grid's empty page", async () => {
    const res = await getDetail("no-such-video");
    expect(res.status).toBe(404);
  });

  it("reads title, duration, resolution and url straight off the videos row", async () => {
    await env.DB.prepare(
      "INSERT INTO videos (id, url, title, duration_seconds, width, height) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "dQw4w9WgXcQ",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "Archon quest",
        1200,
        1920,
        1080,
      )
      .run();

    const res = await getDetail("dQw4w9WgXcQ");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: "dQw4w9WgXcQ",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: "Archon quest",
      duration_seconds: 1200,
      width: 1920,
      height: 1080,
    });
  });

  it("reads null metadata as null, not zero, for a video still mid-download", async () => {
    await seedVideo("dQw4w9WgXcQ");

    const res = await getDetail("dQw4w9WgXcQ");
    const body = (await res.json()) as {
      title: unknown;
      duration_seconds: unknown;
      width: unknown;
      height: unknown;
    };

    expect(body).toMatchObject({ title: null, duration_seconds: null, width: null, height: null });
  });

  it("counts frames, sampled frames and public samples over this video's own images", async () => {
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    await seedImage(videoId, 1);
    await seedImage(videoId, 2, { publicSample: 1 });
    await env.DB.prepare(
      "UPDATE images SET selection_reason = 'random' WHERE video_id = ? AND timestamp_seconds = 1",
    )
      .bind(videoId)
      .run();

    const res = await getDetail(videoId);
    const body = (await res.json()) as {
      image_count: number;
      frames_sampled: number;
      public_samples: number;
    };

    expect(body).toMatchObject({ image_count: 2, frames_sampled: 1, public_samples: 1 });
  });

  it("reads zero, not null, when the video has no images yet", async () => {
    await seedVideo("dQw4w9WgXcQ");

    const res = await getDetail("dQw4w9WgXcQ");
    const body = (await res.json()) as {
      image_count: number;
      frames_sampled: number;
      public_samples: number;
    };

    expect(body).toMatchObject({ image_count: 0, frames_sampled: 0, public_samples: 0 });
  });

  it("scopes every count to the requested video, not every video's rows", async () => {
    await seedVideo("videoA");
    await seedVideo("videoB");
    await seedImage("videoA", 1);
    await seedImage("videoB", 1);
    await seedImage("videoB", 2);

    const res = await getDetail("videoA");
    const body = (await res.json()) as { image_count: number };

    expect(body.image_count).toBe(1);
  });

  it("treats an anon verdict as not ruling — the one thing this rollup can get quietly wrong", async () => {
    // CONTEXT.md §Q10's two tiers, mirrored here exactly as `verdictState()`
    // (admin-video-images.ts) encodes it for the frame grid one screen below
    // this header: an anonymous ruling must not close out a frame the admin
    // tier has not looked at, and it must not drop the prediction from the
    // rollup either.
    const { videoId, imageId, classId, predictionId } = await seedPool();
    const secondPredictionId = await seedPrediction(imageId, classId);
    await seedVerdict(predictionId, { source: "anon", annotatorId: "session-abc" });
    await seedVerdict(secondPredictionId);

    const res = await getDetail(videoId);
    const body = (await res.json()) as {
      predictions: number;
      frames_with_predictions: number;
      frames_verified: number;
      frames_unverified: number;
    };

    // Two predictions on the same frame: one carries only an anon verdict
    // (does not count as ruled), the other carries an admin verdict. The
    // frame still has an unruled prediction on it, so the whole frame reads
    // unverified rather than verified.
    expect(body).toMatchObject({
      predictions: 2,
      frames_with_predictions: 1,
      frames_verified: 0,
      frames_unverified: 1,
    });
  });

  it("reports every prediction verified once every one of a frame's boxes carries an admin verdict", async () => {
    const { videoId, predictionId } = await seedPool();
    await seedVerdict(predictionId);

    const res = await getDetail(videoId);
    const body = (await res.json()) as { frames_verified: number; frames_unverified: number };

    expect(body).toMatchObject({ frames_verified: 1, frames_unverified: 0 });
  });

  it("reads model_id and prelabelled_at off the newest prediction, not an alphabetic max", async () => {
    const { videoId, imageId, classId } = await seedPool();
    await seedPrediction(imageId, classId, { modelId: "older-model.onnx" });
    // seedPool's own prediction already used owlvit-base-patch32.onnx; insert
    // a third, explicitly newer row so "newest" cannot be confused with
    // "alphabetically greatest" or "insertion order."
    await env.DB.prepare(
      `INSERT INTO predictions
          (image_id, class_id, x_min, y_min, x_max, y_max, confidence, prompt_version, model_id, created_at)
          VALUES (?, ?, 0.1, 0.2, 0.5, 0.6, 0.9, '2026-08-08-a', 'zzz-newest.onnx', 9_999_999_999)`,
    )
      .bind(imageId, classId)
      .run();

    const res = await getDetail(videoId);
    const body = (await res.json()) as { model_id: string; prelabelled_at: number };

    expect(body.model_id).toBe("zzz-newest.onnx");
    expect(body.prelabelled_at).toBe(9_999_999_999);
  });

  it("reads model_id and prelabelled_at as null when no prediction exists yet", async () => {
    await seedVideo("dQw4w9WgXcQ");

    const res = await getDetail("dQw4w9WgXcQ");
    const body = (await res.json()) as { model_id: unknown; prelabelled_at: unknown };

    expect(body).toMatchObject({ model_id: null, prelabelled_at: null });
  });

  it("summarizes the download job's status and leaves prelabel null before one exists", async () => {
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    await env.DB.prepare("INSERT INTO jobs (kind, video_id, status) VALUES ('download', ?, 'done')")
      .bind(videoId)
      .run();

    const res = await getDetail(videoId);
    const body = (await res.json()) as {
      jobs: { download: string | null; prelabel: string | null; chunks_total: number };
    };

    expect(body.jobs).toMatchObject({ download: "done", prelabel: null, chunks_total: 0 });
  });

  it("sums chunk jobs across statuses rather than reporting the last one seen", async () => {
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    await env.DB.prepare(
      `INSERT INTO jobs (kind, video_id, status) VALUES
         ('chunk', ?, 'done'), ('chunk', ?, 'done'), ('chunk', ?, 'failed'), ('chunk', ?, 'pending')`,
    )
      .bind(videoId, videoId, videoId, videoId)
      .run();

    const res = await getDetail(videoId);
    const body = (await res.json()) as {
      jobs: { chunks_total: number; chunks_done: number; chunks_failed: number };
    };

    expect(body.jobs).toMatchObject({ chunks_total: 4, chunks_done: 2, chunks_failed: 1 });
  });
});
