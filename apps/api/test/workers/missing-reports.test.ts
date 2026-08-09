import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { ADMIN_EMAIL, adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";
import { seedPool } from "./labelling-seed";

/**
 * Missing-object reports (M13.3).
 *
 * The escape hatch for the one thing a verify-only UI cannot see. A frame the
 * detector missed produces no prediction, is never shown with a box, and in
 * the table is indistinguishable from a frame where the character was truly
 * absent — so the report is its own row type rather than a verdict on a
 * prediction that does not exist (migration 0003).
 *
 * The class is optional and that is the case worth a test of its own: a
 * reporter who has spotted a character not in `classes` at all still has
 * something worth recording, and forcing a `class_id` would either lose that
 * report or invent a class to hold it.
 */

beforeAll(installAdminIdentity);
beforeEach(configureAccess);

async function reportMissing(
  imageId: number,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return app.request(
    `/api/admin/images/${imageId}/missing`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers ?? (await adminHeaders())) },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("reporting a missed object", () => {
  it("records the class when the reporter knows it", async () => {
    const { imageId, classId } = await seedPool();

    const res = await reportMissing(imageId, { class_id: classId });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      image_id: imageId,
      class_id: classId,
      reporter: ADMIN_EMAIL,
    });
  });

  it("records a report with no class at all", async () => {
    const { imageId } = await seedPool();

    const res = await reportMissing(imageId, {});

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ image_id: imageId, class_id: null });
  });

  it("accepts an explicit null the same way as an absent field", async () => {
    const { imageId } = await seedPool();

    const res = await reportMissing(imageId, { class_id: null });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ class_id: null });
  });

  it("does not need the frame to carry any prediction", async () => {
    // The whole point: a frame nothing was proposed on is exactly the frame a
    // recall failure lives on, and it is not in any verification batch.
    const { imageId, predictionId } = await seedPool();
    await env.DB.prepare("DELETE FROM predictions WHERE id = ?").bind(predictionId).run();

    const res = await reportMissing(imageId, {});

    expect(res.status).toBe(201);
  });

  it("answers 404 for a class that does not exist", async () => {
    const { imageId } = await seedPool();

    const res = await reportMissing(imageId, { class_id: 9_999 });

    expect(res.status).toBe(404);
    const { results } = await env.DB.prepare("SELECT id FROM missing_reports").all();
    expect(results).toHaveLength(0);
  });

  it("answers 404 for an image that does not exist", async () => {
    await seedPool();

    const res = await reportMissing(9_999, {});

    expect(res.status).toBe(404);
  });

  it("is gated: no assertion, no report", async () => {
    const { imageId } = await seedPool();

    const res = await reportMissing(imageId, {}, {});

    expect(res.status).toBe(401);
  });
});
