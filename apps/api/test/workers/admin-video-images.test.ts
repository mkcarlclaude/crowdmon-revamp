import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";
import { seedImage, seedPool, seedPrediction, seedVerdict } from "./labelling-seed";
import { seedVideo } from "./seed";

/**
 * `GET /api/admin/videos/{id}/images` (M16, ROADMAP M16.5): the browsable
 * frame grid, and specifically the half `listVideoImages`
 * (`/api/videos/{video_id}/images`) cannot answer — it needs a held worker
 * lease this surface has no reason to require (see the route's own comment).
 */
beforeAll(installAdminIdentity);
beforeEach(configureAccess);

async function listImages(videoId: string, query = ""): Promise<Response> {
  return app.request(
    `/api/admin/videos/${videoId}/images${query}`,
    { headers: await adminHeaders() },
    env,
  );
}

describe("GET /api/admin/videos/{id}/images", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await app.request("/api/admin/videos/dQw4w9WgXcQ/images", {}, env);
    expect(res.status).toBe(401);
  });

  it("answers an empty page rather than 404 for a video that does not exist", async () => {
    const res = await listImages("no-such-video");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      video_id: "no-such-video",
      total: 0,
      images: [],
    });
  });

  it("needs no worker lease, unlike /api/videos/{video_id}/images", async () => {
    // No `jobs` row at all, held or otherwise — the whole point of this route
    // existing separately from `listVideoImagesHandler`.
    const { videoId } = await seedPool();

    const res = await listImages(videoId);
    const body = (await res.json()) as { images: unknown[] };

    expect(res.status).toBe(200);
    expect(body.images).toHaveLength(1);
  });

  it("orders by timestamp and reports a frame with no predictions as such", async () => {
    const { videoId } = await seedPool();
    await seedImage(videoId, 5);
    await seedImage(videoId, 2);

    const res = await listImages(videoId);
    const body = (await res.json()) as {
      images: Array<{ timestamp_seconds: number; predictions: number; verdict_state: string }>;
    };

    expect(body.images.map((i) => i.timestamp_seconds)).toEqual([1, 2, 5]);
    // Frame at timestamp 1 is `seedPool`'s own, which carries one prediction;
    // the two added above carry none.
    expect(body.images[1]).toMatchObject({ predictions: 0, verdict_state: "no_predictions" });
    expect(body.images[2]).toMatchObject({ predictions: 0, verdict_state: "no_predictions" });
  });

  it("reports unverified while any of a frame's boxes has no admin verdict", async () => {
    const { videoId, imageId, classId, predictionId } = await seedPool();
    await seedPrediction(imageId, classId);
    await seedVerdict(predictionId);

    const res = await listImages(videoId);
    const body = (await res.json()) as {
      images: Array<{ predictions: number; verdict_state: string }>;
    };

    expect(body.images[0]).toMatchObject({ predictions: 2, verdict_state: "unverified" });
  });

  it("reports verified once every box on a frame has an admin verdict", async () => {
    const { videoId, predictionId } = await seedPool();
    await seedVerdict(predictionId);

    const res = await listImages(videoId);
    const body = (await res.json()) as { images: Array<{ verdict_state: string }> };

    expect(body.images[0]).toMatchObject({ verdict_state: "verified" });
  });

  it("does not count an anonymous verdict toward the admin tier's verified state", async () => {
    // CONTEXT.md §Q10's two tiers: an anonymous ruling must not close out a
    // frame the admin tier has not looked at.
    const { videoId, predictionId } = await seedPool();
    await seedVerdict(predictionId, { source: "anon", annotatorId: "session-abc" });

    const res = await listImages(videoId);
    const body = (await res.json()) as { images: Array<{ verdict_state: string }> };

    expect(body.images[0]).toMatchObject({ verdict_state: "unverified" });
  });

  it("carries the public_sample flag", async () => {
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    await seedImage(videoId, 1, { publicSample: 1 });

    const res = await listImages(videoId);
    const body = (await res.json()) as { images: Array<{ public_sample: boolean }> };

    expect(body.images[0]).toMatchObject({ public_sample: true });
  });

  it("reports the video's whole frame count in total, independent of limit", async () => {
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    for (let t = 0; t < 5; t++) await seedImage(videoId, t);

    const res = await listImages(videoId, "?limit=2");
    const body = (await res.json()) as { total: number; images: unknown[] };

    expect(body.total).toBe(5);
    expect(body.images).toHaveLength(2);
  });

  it("pages with limit and offset", async () => {
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    for (let t = 0; t < 5; t++) await seedImage(videoId, t);

    const res = await listImages(videoId, "?limit=2&offset=2");
    const body = (await res.json()) as { images: Array<{ timestamp_seconds: number }> };

    expect(body.images.map((i) => i.timestamp_seconds)).toEqual([2, 3]);
  });

  it("rejects an out-of-range limit", async () => {
    const res = await listImages("dQw4w9WgXcQ", "?limit=0");
    expect(res.status).toBe(400);
  });

  it("scopes to the requested video, not every video's frames", async () => {
    await seedVideo("videoA");
    await seedVideo("videoB");
    await seedImage("videoA", 1);
    await seedImage("videoB", 1);

    const res = await listImages("videoA");
    const body = (await res.json()) as { images: unknown[] };

    expect(body.images).toHaveLength(1);
  });
});
