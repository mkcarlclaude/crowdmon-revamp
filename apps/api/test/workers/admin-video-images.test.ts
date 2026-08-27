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
    // `url_mode` and `expires_at` are asserted here rather than only where a
    // frame exists: a page with nothing on it still has to carry them, or a
    // client would need one code path for an empty response and another for
    // every other one. The test env sets no S3 credential, so `proxy` is the
    // honest mode for it to report.
    await expect(res.json()).resolves.toMatchObject({
      video_id: "no-such-video",
      total: 0,
      images: [],
      url_mode: "proxy",
    });
  });

  it("gives every frame a URL the client does not have to construct", async () => {
    const { videoId } = await seedPool();

    const res = await listImages(videoId);
    const body = (await res.json()) as {
      images: Array<{ r2_key: string; url: string }>;
      url_mode: string;
    };

    // Proxy mode in tests, because signing needs a credential no test
    // environment holds — so what this pins is that the URL is *minted by the
    // API*, whichever mode it is in. M16 shipped the grid building
    // `/api/admin/image?key=…` in the client, which meant §Q25's presigned
    // path could never apply to it no matter how the deployment was
    // configured, and no test could see that because no test asked the API
    // for a URL at all.
    expect(body.url_mode).toBe("proxy");
    for (const image of body.images) {
      expect(image.url).toBe(`/api/admin/image?key=${encodeURIComponent(image.r2_key)}`);
    }
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

  // M17, plan §B: `createPrelabelHandler`'s own "already sampled" refusal
  // reads exactly this predicate (`images.selection_reason IS NOT NULL`),
  // and this route exposes it as a boolean so the multi-select grid can
  // grey a frame out before an operator picks it, rather than let them
  // learn from a 400 after the fact.
  it("reports sampled true once selection_reason is set, regardless of which reason", async () => {
    const { videoId } = await seedPool();
    await env.DB.prepare("UPDATE images SET selection_reason = 'random' WHERE video_id = ?")
      .bind(videoId)
      .run();
    await seedImage(videoId, 2); // a second, never-sampled frame

    const res = await listImages(videoId);
    const body = (await res.json()) as {
      images: Array<{ timestamp_seconds: number; sampled: boolean }>;
    };

    expect(body.images.find((i) => i.timestamp_seconds === 1)?.sampled).toBe(true);
    expect(body.images.find((i) => i.timestamp_seconds === 2)?.sampled).toBe(false);
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

  /**
   * M25.1. The grid stopped being only a picker when M25's `diverse` draw made
   * "which 400 frames did that pass take" a question worth asking — and the
   * boolean `sampled` above cannot answer it. These tests are the answer.
   */
  describe("the selection_reason filter", () => {
    async function seedReasons(videoId: string) {
      await seedVideo(videoId);
      const random = await seedImage(videoId, 1);
      const diverse = await seedImage(videoId, 2);
      const manual = await seedImage(videoId, 3);
      const unsampled = await seedImage(videoId, 4);
      for (const [id, reason] of [
        [random, "random"],
        [diverse, "diverse"],
        [manual, "manual"],
      ] as const) {
        await env.DB.prepare("UPDATE images SET selection_reason = ? WHERE id = ?")
          .bind(reason, id)
          .run();
      }
      return { random, diverse, manual, unsampled };
    }

    it("carries the reason itself, not only the boolean", async () => {
      const videoId = "dQw4w9WgXcQ";
      await seedReasons(videoId);

      const res = await listImages(videoId);
      const body = (await res.json()) as {
        images: Array<{ timestamp_seconds: number; selection_reason: string | null }>;
      };

      const byTimestamp = new Map(
        body.images.map((i) => [i.timestamp_seconds, i.selection_reason]),
      );
      expect(byTimestamp.get(1)).toBe("random");
      expect(byTimestamp.get(2)).toBe("diverse");
      expect(byTimestamp.get(3)).toBe("manual");
      expect(byTimestamp.get(4)).toBeNull();
    });

    it("returns only the frames one pass drew", async () => {
      const videoId = "dQw4w9WgXcQ";
      await seedReasons(videoId);

      const res = await listImages(videoId, "?selection_reason=diverse");
      const body = (await res.json()) as {
        total: number;
        images: Array<{ timestamp_seconds: number }>;
      };

      expect(body.images.map((i) => i.timestamp_seconds)).toEqual([2]);
      expect(body.total).toBe(1);
    });

    // `selection_reason = NULL` is NULL rather than true, so a filter that
    // bound the value through `=` would answer this — the filter an operator
    // reaches for most — with a silently empty grid.
    it("answers none with the frames no pass has claimed", async () => {
      const videoId = "dQw4w9WgXcQ";
      await seedReasons(videoId);

      const res = await listImages(videoId, "?selection_reason=none");
      const body = (await res.json()) as {
        total: number;
        images: Array<{ timestamp_seconds: number; selection_reason: string | null }>;
      };

      expect(body.images.map((i) => i.timestamp_seconds)).toEqual([4]);
      expect(body.images[0]?.selection_reason).toBeNull();
      expect(body.total).toBe(1);
    });

    // `total` drives the page controls. If it kept describing the whole video
    // while `offset` paginated the filtered set, the grid would offer pages
    // that do not exist and strand the operator on an empty screen.
    it("counts the filtered set in total, not the whole video", async () => {
      const videoId = "dQw4w9WgXcQ";
      await seedVideo(videoId);
      for (let t = 0; t < 6; t++) {
        const id = await seedImage(videoId, t);
        if (t < 2) {
          await env.DB.prepare("UPDATE images SET selection_reason = 'diverse' WHERE id = ?")
            .bind(id)
            .run();
        }
      }

      const res = await listImages(videoId, "?selection_reason=diverse&limit=1");
      const body = (await res.json()) as { total: number; images: unknown[] };

      expect(body.total).toBe(2);
      expect(body.images).toHaveLength(1);
    });

    it("keeps the filter scoped to this video", async () => {
      await seedReasons("videoA");
      await seedReasons("videoB");

      const res = await listImages("videoA", "?selection_reason=diverse");
      const body = (await res.json()) as { total: number };

      expect(body.total).toBe(1);
    });

    // The column is free text on purpose (migration 0001), so an unknown
    // value is an empty page rather than a 400 — the day a fifth selector
    // lands, this filter shows its output without a schema change.
    it("answers an unknown reason with an empty page rather than an error", async () => {
      const videoId = "dQw4w9WgXcQ";
      await seedReasons(videoId);

      const res = await listImages(videoId, "?selection_reason=uncertain");
      const body = (await res.json()) as { total: number; images: unknown[] };

      expect(res.status).toBe(200);
      expect(body.total).toBe(0);
      expect(body.images).toHaveLength(0);
    });
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
