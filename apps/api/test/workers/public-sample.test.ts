import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { PUBLIC_SAMPLE_MIN_SPACING_SECONDS } from "../../src/routes/admin-images";
import { adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";
import { seedImage } from "./labelling-seed";
import { seedVideo } from "./seed";

/**
 * Curating the public pool (M14.1; M18, plan §C's spacing rule).
 *
 * Two claims under test. First, the one this route always made: it writes
 * `public_sample` and nothing else — `selection_reason` is a different
 * actor's column (M11) and this route must never touch it, asserted against
 * the row rather than the response, the same discipline `verdicts.test.ts`
 * uses for `adjust`. Second, the new one: flagging a frame in is refused
 * with 409 when it would land within `PUBLIC_SAMPLE_MIN_SPACING_SECONDS` of
 * an already-flagged frame from the same video, and flagging out never is.
 */

beforeAll(installAdminIdentity);
beforeEach(configureAccess);

async function setPublicSample(
  id: number,
  publicSample: boolean,
  headers?: Record<string, string>,
): Promise<Response> {
  return app.request(
    `/api/admin/images/${id}/public-sample`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(headers ?? (await adminHeaders())) },
      body: JSON.stringify({ public_sample: publicSample }),
    },
    env,
  );
}

function imageRow(id: number) {
  return env.DB.prepare("SELECT public_sample, selection_reason FROM images WHERE id = ?")
    .bind(id)
    .first<{ public_sample: number | null; selection_reason: string | null }>();
}

describe("flagging an image into the public sample", () => {
  it("sets public_sample and leaves selection_reason untouched", async () => {
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    const id = await seedImage(videoId, 1);
    await env.DB.prepare("UPDATE images SET selection_reason = 'random' WHERE id = ?")
      .bind(id)
      .run();

    const res = await setPublicSample(id, true);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id, public_sample: true });

    const row = await imageRow(id);
    expect(row).toEqual({ public_sample: 1, selection_reason: "random" });
  });

  it("unflags an image already in the sample", async () => {
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    const id = await seedImage(videoId, 1, { publicSample: 1 });

    const res = await setPublicSample(id, false);

    await expect(res.json()).resolves.toEqual({ id, public_sample: false });
    expect((await imageRow(id))?.public_sample).toBe(0);
  });

  it("404s for an image that does not exist", async () => {
    expect((await setPublicSample(999_999, true)).status).toBe(404);
  });

  it("is gated: no assertion, no write", async () => {
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    const id = await seedImage(videoId, 1);

    expect((await setPublicSample(id, true, {})).status).toBe(401);
  });
});

describe("the minimum-spacing rule (M18, plan §C)", () => {
  it("refuses to flag a frame within the floor of an already-flagged frame from the same video", async () => {
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    const existing = await seedImage(videoId, 100, { publicSample: 1 });
    const tooClose = await seedImage(videoId, 100 + PUBLIC_SAMPLE_MIN_SPACING_SECONDS - 1);

    const res = await setPublicSample(tooClose, true);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    // The conflicting frame is named, not just the refusal — an operator
    // staring at a 409 needs to know which existing flag it collided with.
    expect(body.error).toContain(String(existing));
    expect(body.error).toContain(String(tooClose));

    expect((await imageRow(tooClose))?.public_sample).toBeNull();
  });

  it("allows flagging a frame exactly at the floor", async () => {
    // `< N`, not `<= N`: the floor is the closest two frames may legally
    // sit, not the closest they may sit minus one.
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    await seedImage(videoId, 100, { publicSample: 1 });
    const atFloor = await seedImage(videoId, 100 + PUBLIC_SAMPLE_MIN_SPACING_SECONDS);

    const res = await setPublicSample(atFloor, true);

    expect(res.status).toBe(200);
    expect((await imageRow(atFloor))?.public_sample).toBe(1);
  });

  it("checks spacing in both directions along the timeline", async () => {
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    await seedImage(videoId, 100, { publicSample: 1 });
    // Earlier than the existing flag, not later — the rule is about
    // distance, not direction.
    const tooClose = await seedImage(videoId, 100 - (PUBLIC_SAMPLE_MIN_SPACING_SECONDS - 1));

    expect((await setPublicSample(tooClose, true)).status).toBe(409);
  });

  it("does not compare against a different video's flagged frames", async () => {
    const videoId = "dQw4w9WgXcQ";
    const otherVideoId = "aaaaaaaaaaa";
    await seedVideo(videoId);
    await seedVideo(otherVideoId);
    await seedImage(videoId, 100, { publicSample: 1 });
    const sameTimestampOtherVideo = await seedImage(otherVideoId, 100);

    const res = await setPublicSample(sameTimestampOtherVideo, true);

    expect(res.status).toBe(200);
  });

  it("does not refuse flagging a frame out, however close it sits to another flagged frame", async () => {
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    await seedImage(videoId, 100, { publicSample: 1 });
    const adjacent = await seedImage(videoId, 101, { publicSample: 1 });

    const res = await setPublicSample(adjacent, false);

    expect(res.status).toBe(200);
    expect((await imageRow(adjacent))?.public_sample).toBe(0);
  });

  it("does not trip over its own existing flag when re-flagging a frame that is already in", async () => {
    // A no-op PATCH — flagging in a frame that is already flagged in — must
    // not read as a conflict with itself. `id != ?` in the spacing query is
    // what this pins down.
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    const id = await seedImage(videoId, 100, { publicSample: 1 });

    const res = await setPublicSample(id, true);

    expect(res.status).toBe(200);
  });

  it("ignores an unflagged frame from the same video however close it sits", async () => {
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    await seedImage(videoId, 100); // not flagged
    const close = await seedImage(videoId, 105);

    const res = await setPublicSample(close, true);

    expect(res.status).toBe(200);
  });
});
