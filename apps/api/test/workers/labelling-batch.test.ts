import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { PRESIGN_TTL_SECONDS } from "../../src/schemas";
import { adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";
import { seedClass, seedImage, seedPool, seedPrediction, seedVerdict } from "./labelling-seed";
import { seedVideo } from "./seed";

/**
 * The labelling session's read side (M13.4).
 *
 * Two things are being asserted, and they are independent:
 *
 * 1. **Which frames come back, and with which boxes.** A frame is in the pool
 *    while any of its boxes has no admin verdict, and it carries only those
 *    boxes. Every test below that seeds a verdict is a test of that predicate,
 *    because it is the one thing standing between an operator and being shown
 *    the same frame forever.
 * 2. **Where the bytes come from.** Signed when this deployment has an R2 S3
 *    credential, proxied through the Access-gated route when it does not. Both
 *    modes are exercised: the fallback is not a degraded path to be discovered
 *    in production, it is the mode every deployment is in until somebody mints
 *    a key by hand.
 */

beforeAll(installAdminIdentity);
beforeEach(configureAccess);

/**
 * Signing is off unless a test turns it on. `configureAccess` does not reset
 * these — they are not Access — so a test that sets them has to put them back,
 * or the next file in the same isolate signs by accident.
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

async function getBatch(query = "", headers?: Record<string, string>): Promise<Response> {
  return app.request(
    `/api/admin/labelling/batch${query}`,
    { headers: headers ?? (await adminHeaders()) },
    env,
  );
}

interface Batch {
  images: Array<{
    id: number;
    video_id: string;
    r2_key: string;
    url: string;
    predictions: Array<{ id: number; class_name: string; confidence: number }>;
  }>;
  url_mode: "signed" | "proxy";
  expires_at: number;
  remaining: number;
}

describe("the frames a session is handed", () => {
  it("returns a frame with its un-ruled boxes", async () => {
    const { imageId, predictionId, videoId } = await seedPool();

    const batch = (await (await getBatch()).json()) as Batch;

    expect(batch.images).toHaveLength(1);
    expect(batch.images[0]).toMatchObject({ id: imageId, video_id: videoId });
    expect(batch.images[0]?.predictions).toHaveLength(1);
    expect(batch.images[0]?.predictions[0]).toMatchObject({
      id: predictionId,
      class_name: "Paimon",
      confidence: 0.87,
    });
    expect(batch.remaining).toBe(1);
  });

  it("drops a frame once every box has an admin verdict", async () => {
    const { predictionId } = await seedPool();
    await seedVerdict(predictionId);

    const batch = (await (await getBatch()).json()) as Batch;

    expect(batch.images).toEqual([]);
    expect(batch.remaining).toBe(0);
  });

  it("keeps a partly-ruled frame, carrying only what is left", async () => {
    // The case that decides the predicate: an operator who ruled on one of two
    // boxes and stopped must get the other one back, not lose it with the
    // frame.
    const { imageId, classId, predictionId } = await seedPool();
    const untouched = await seedPrediction(imageId, classId);
    await seedVerdict(predictionId);

    const batch = (await (await getBatch()).json()) as Batch;

    expect(batch.images).toHaveLength(1);
    expect(batch.images[0]?.predictions.map((box) => box.id)).toEqual([untouched]);
  });

  it("ignores an anonymous verdict when deciding what an admin still owes", async () => {
    // CONTEXT.md §Q10's two tiers. A stranger clicking on the public page must
    // not remove a box from the authoritative annotator's queue.
    const { predictionId } = await seedPool();
    await seedVerdict(predictionId, { source: "anon", annotatorId: "session-abc" });

    const batch = (await (await getBatch()).json()) as Batch;

    expect(batch.images).toHaveLength(1);
  });

  it("never returns a frame that has no boxes at all", async () => {
    const { videoId } = await seedPool();
    await seedImage(videoId, 2);

    const batch = (await (await getBatch()).json()) as Batch;

    expect(batch.images).toHaveLength(1);
    expect(batch.remaining).toBe(1);
  });

  it("pages by limit and reports how many are left overall", async () => {
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    const classId = await seedClass("Paimon");
    for (const second of [1, 2, 3]) {
      await seedPrediction(await seedImage(videoId, second), classId);
    }

    const batch = (await (await getBatch("?limit=2")).json()) as Batch;

    expect(batch.images).toHaveLength(2);
    // Not `1`: `remaining` is the whole pool, so a session can show progress
    // rather than only how much of this page is left.
    expect(batch.remaining).toBe(3);
  });

  it("refuses a limit outside the range", async () => {
    expect((await getBatch("?limit=0")).status).toBe(400);
    expect((await getBatch("?limit=101")).status).toBe(400);
  });

  it("is gated: no assertion, no batch", async () => {
    await seedPool();

    expect((await getBatch("", {})).status).toBe(401);
  });
});

describe("where the bytes come from", () => {
  it("presigns against R2 when a credential is configured", async () => {
    const { imageId } = await seedPool();
    configureSigning();

    const batch = (await (await getBatch()).json()) as Batch;

    expect(batch.url_mode).toBe("signed");

    const url = new URL(batch.images[0]?.url ?? "");
    expect(url.origin).toBe("https://accountid.r2.cloudflarestorage.com");
    // The key's slashes stay slashes: encoding the whole key would sign a
    // request for an object whose name contains %2F, which does not exist.
    expect(url.pathname).toBe(`/crowdmon-frames/frames/${"dQw4w9WgXcQ"}/00001.000.jpg`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(PRESIGN_TTL_SECONDS));
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("X-Amz-Credential")).toContain("AKIAIOSFODNN7EXAMPLE");
    expect(batch.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

    expect(imageId).toBeGreaterThan(0);
  });

  it("falls back to the Access-gated proxy when no credential is configured", async () => {
    await seedPool();

    const batch = (await (await getBatch()).json()) as Batch;

    expect(batch.url_mode).toBe("proxy");
    expect(batch.images[0]?.url).toBe("/api/admin/image?key=frames%2FdQw4w9WgXcQ%2F00001.000.jpg");
    // Still populated, so the UI has one refresh rule rather than a branch.
    expect(batch.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("falls back when the credential is only half configured", async () => {
    await seedPool();
    configureSigning();
    env.R2_SECRET_ACCESS_KEY = undefined;

    const batch = (await (await getBatch()).json()) as Batch;

    // Signing with a missing half produces URLs R2 rejects — broken images in
    // the UI rather than anything an operator could read.
    expect(batch.url_mode).toBe("proxy");
  });

  it("says which mode an empty batch would have used", async () => {
    configureSigning();

    const batch = (await (await getBatch()).json()) as Batch;

    expect(batch.images).toEqual([]);
    expect(batch.url_mode).toBe("signed");
  });
});
