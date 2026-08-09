import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";
import { seedImage } from "./labelling-seed";
import { seedVideo } from "./seed";

/**
 * Curating the public pool (M14.1).
 *
 * The only claim under test: this route writes `public_sample` and nothing
 * else. `selection_reason` is a different actor's column (M11) and this
 * route must never touch it — asserted against the row rather than the
 * response, the same discipline `verdicts.test.ts` uses for `adjust`.
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
