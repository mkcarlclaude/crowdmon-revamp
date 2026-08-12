import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { seedClass, seedImage, seedPrediction } from "./labelling-seed";
import { seedVideo } from "./seed";

/**
 * The public page's read side (M14.2).
 *
 * Three claims, matched to CONTEXT.md §12's three bounds on this surface:
 * only `public_sample` frames are eligible, a frame with no predictions is
 * never handed out even if flagged, and the route fails closed (`503`)
 * rather than falling back to the Access-gated proxy `frameUrls` uses for
 * the admin session — a visitor with no Access cookie cannot reach that
 * route, so a URL pointing at it would just break in the browser.
 */

afterEach(() => {
  env.FRAMES_S3_BASE_URL = undefined;
  env.R2_ACCESS_KEY_ID = undefined;
  env.R2_SECRET_ACCESS_KEY = undefined;
});

function configureSigning() {
  env.FRAMES_S3_BASE_URL = "https://accountid.r2.cloudflarestorage.com/crowdmon-frames";
  env.R2_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
  env.R2_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
}

async function getFrame(exclude?: number): Promise<Response> {
  const query = exclude === undefined ? "" : `?exclude=${exclude}`;
  return app.request(`/api/public/frame${query}`, {}, env);
}

interface Frame {
  id: number;
  r2_key: string;
  url: string;
  predictions: Array<{ id: number; class_name: string; confidence: number }>;
  expires_at: number;
}

describe("the public frame", () => {
  it("404s when nothing is flagged into the public sample", async () => {
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    const classId = await seedClass("Paimon");
    await seedPrediction(await seedImage(videoId, 1), classId);

    expect((await getFrame()).status).toBe(404);
  });

  it("never hands out a public_sample frame with no predictions", async () => {
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    await seedImage(videoId, 1, { publicSample: 1 });

    expect((await getFrame()).status).toBe(404);
  });

  it("503s when this deployment has no R2 signing credential", async () => {
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    const classId = await seedClass("Paimon");
    await seedPrediction(await seedImage(videoId, 1, { publicSample: 1 }), classId);

    expect((await getFrame()).status).toBe(503);
  });

  it("hands back a flagged frame, signed, with its boxes", async () => {
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    const classId = await seedClass("Paimon");
    const imageId = await seedImage(videoId, 1, { publicSample: 1 });
    const predictionId = await seedPrediction(imageId, classId);
    configureSigning();

    const res = await getFrame();
    expect(res.status).toBe(200);

    const frame = (await res.json()) as Frame;
    expect(frame.id).toBe(imageId);
    expect(frame.predictions).toEqual([
      expect.objectContaining({ id: predictionId, class_name: "Paimon", confidence: 0.87 }),
    ]);
    // No prompt_version, no model_id — PublicProposedBox trims what an
    // operator needs and a visitor does not.
    expect(frame.predictions[0]).not.toHaveProperty("prompt_version");
    expect(frame.predictions[0]).not.toHaveProperty("model_id");

    const url = new URL(frame.url);
    expect(url.origin).toBe("https://accountid.r2.cloudflarestorage.com");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(frame.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("never draws from an image outside the public sample", async () => {
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    const classId = await seedClass("Paimon");
    // Ordinary labelling-pool frame, not flagged.
    await seedPrediction(await seedImage(videoId, 1), classId);
    const publicImageId = await seedImage(videoId, 2, { publicSample: 1 });
    await seedPrediction(publicImageId, classId);
    configureSigning();

    const frame = (await (await getFrame()).json()) as Frame;
    expect(frame.id).toBe(publicImageId);
  });

  /**
   * `exclude` (M18, plan §C): the client passes the frame currently on
   * screen so "another frame" cannot hand back the one already showing.
   */
  describe("excluding the frame already on screen", () => {
    it("never returns the excluded id when another qualifying frame exists", async () => {
      const videoId = "dQw4w9WgXcQ";
      await seedVideo(videoId);
      const classId = await seedClass("Paimon");
      const first = await seedImage(videoId, 1, { publicSample: 1 });
      await seedPrediction(first, classId);
      const second = await seedImage(videoId, 2, { publicSample: 1 });
      await seedPrediction(second, classId);
      configureSigning();

      // Run several times rather than once — the draw is `ORDER BY
      // RANDOM()`, so a single call could pass by chance even if `exclude`
      // were silently ignored.
      for (let attempt = 0; attempt < 10; attempt++) {
        const frame = (await (await getFrame(first)).json()) as Frame;
        expect(frame.id).toBe(second);
      }
    });

    it("still returns the only frame rather than 404ing when the pool has exactly one", async () => {
      // The degenerate case the plan calls out explicitly: excluding the
      // only qualifying frame must not turn "another frame" into "no
      // frame" — a visitor with one frame in the pool still gets it back.
      const videoId = "dQw4w9WgXcQ";
      await seedVideo(videoId);
      const classId = await seedClass("Paimon");
      const only = await seedImage(videoId, 1, { publicSample: 1 });
      await seedPrediction(only, classId);
      configureSigning();

      const res = await getFrame(only);
      expect(res.status).toBe(200);
      const frame = (await res.json()) as Frame;
      expect(frame.id).toBe(only);
    });

    it("still 503s for the pool-of-one fallback when signing is not configured", async () => {
      // The fallback query still has to run the same `frameUrls` mode check
      // as the primary path — this pins down that the fallback is not a
      // shortcut that skips the "no signing credential" failure the
      // unexcluded route already covers.
      const videoId = "dQw4w9WgXcQ";
      await seedVideo(videoId);
      const classId = await seedClass("Paimon");
      const only = await seedImage(videoId, 1, { publicSample: 1 });
      await seedPrediction(only, classId);
      // No configureSigning() — this deployment has no credential.

      expect((await getFrame(only)).status).toBe(503);
    });

    it("ignores an exclude id that names nothing in the pool", async () => {
      const videoId = "dQw4w9WgXcQ";
      await seedVideo(videoId);
      const classId = await seedClass("Paimon");
      const only = await seedImage(videoId, 1, { publicSample: 1 });
      await seedPrediction(only, classId);
      configureSigning();

      const frame = (await (await getFrame(999_999)).json()) as Frame;
      expect(frame.id).toBe(only);
    });
  });
});
