import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { ADMIN_EMAIL, adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";
import { seedImage, seedPool, seedPrediction, seedVerdict } from "./labelling-seed";

/**
 * Verdict writes behind Access (M13.2).
 *
 * Three properties carry the milestone and each is asserted here rather than
 * left to the UI:
 *
 * 1. **Append-only.** A second verdict on one prediction is a legal state
 *    (migration 0003 refuses a uniqueness constraint on `prediction_id` on
 *    purpose), so the test that writes two and expects two rows is the test
 *    that would fail if somebody ever "fixed" that with an upsert.
 * 2. **An `adjust` leaves the prediction byte-for-byte unchanged.** Asserted
 *    against the row, not against the response, because a handler that
 *    mutated `predictions` could still echo the original coordinates back.
 * 3. **Source and identity come from the assertion, never the body.** A caller
 *    that could name its own `source` could write an admin verdict from the
 *    public page M14 mounts the same component on.
 */

beforeAll(installAdminIdentity);
beforeEach(configureAccess);

async function postVerdict(
  predictionId: number,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return app.request(
    `/api/admin/predictions/${predictionId}/verdict`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers ?? (await adminHeaders())) },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function rejectImage(imageId: number, headers?: Record<string, string>): Promise<Response> {
  return app.request(
    `/api/admin/images/${imageId}/reject`,
    { method: "POST", headers: headers ?? (await adminHeaders()) },
    env,
  );
}

const adjustment = {
  verdict: "adjust" as const,
  adjusted_x_min: 0.14,
  adjusted_y_min: 0.22,
  adjusted_x_max: 0.48,
  adjusted_y_max: 0.61,
};

describe("recording a verdict", () => {
  it("writes an accept with the admin's own identity", async () => {
    const { predictionId } = await seedPool();

    const res = await postVerdict(predictionId, { verdict: "accept" });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      prediction_id: predictionId,
      verdict: "accept",
      source: "admin",
      annotator_id: ADMIN_EMAIL,
      adjusted_x_min: null,
      adjusted_y_min: null,
      adjusted_x_max: null,
      adjusted_y_max: null,
    });
  });

  it("puts an adjustment's coordinates on the verdict and leaves the prediction alone", async () => {
    const { predictionId } = await seedPool();
    const before = await env.DB.prepare("SELECT * FROM predictions WHERE id = ?")
      .bind(predictionId)
      .first();

    const res = await postVerdict(predictionId, adjustment);

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      verdict: "adjust",
      adjusted_x_min: 0.14,
      adjusted_y_min: 0.22,
      adjusted_x_max: 0.48,
      adjusted_y_max: 0.61,
    });

    // The whole row, not just the coordinates: `prompt_version` and `model_id`
    // are the provenance a later exclusion of an annotator falls back to, and
    // an UPDATE that touched them would be as unrecoverable as one that moved
    // the box.
    const after = await env.DB.prepare("SELECT * FROM predictions WHERE id = ?")
      .bind(predictionId)
      .first();
    expect(after).toEqual(before);
  });

  it("keeps both verdicts when the same prediction is ruled on twice", async () => {
    const { predictionId } = await seedPool();

    expect((await postVerdict(predictionId, { verdict: "accept" })).status).toBe(201);
    expect((await postVerdict(predictionId, { verdict: "reject" })).status).toBe(201);

    const { results } = await env.DB.prepare(
      "SELECT verdict FROM verdicts WHERE prediction_id = ? ORDER BY id",
    )
      .bind(predictionId)
      .all<{ verdict: string }>();

    expect(results.map((row) => row.verdict)).toEqual(["accept", "reject"]);
  });

  it("ignores a source the caller tries to name", async () => {
    const { predictionId } = await seedPool();

    const res = await postVerdict(predictionId, {
      verdict: "accept",
      source: "anon",
      annotator_id: "somebody-else",
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      source: "admin",
      annotator_id: ADMIN_EMAIL,
    });
  });

  it("refuses an adjust with no coordinates", async () => {
    const { predictionId } = await seedPool();

    const res = await postVerdict(predictionId, { verdict: "adjust" });

    expect(res.status).toBe(400);
  });

  it("refuses an accept that carries coordinates", async () => {
    const { predictionId } = await seedPool();

    const res = await postVerdict(predictionId, { ...adjustment, verdict: "accept" });

    expect(res.status).toBe(400);
  });

  it("refuses an inverted adjusted box", async () => {
    const { predictionId } = await seedPool();

    const res = await postVerdict(predictionId, { ...adjustment, adjusted_x_max: 0.01 });

    expect(res.status).toBe(400);
  });

  it("answers 404 for a prediction that does not exist", async () => {
    await seedPool();

    const res = await postVerdict(9_999, { verdict: "accept" });

    expect(res.status).toBe(404);
    // A foreign-key failure would also stop the write, but with no field to
    // point at — the reason the handler resolves the reference itself.
    const { results } = await env.DB.prepare("SELECT id FROM verdicts").all();
    expect(results).toHaveLength(0);
  });

  it("is gated: no assertion, no verdict", async () => {
    const { predictionId } = await seedPool();

    const res = await postVerdict(predictionId, { verdict: "accept" }, {});

    expect(res.status).toBe(401);
  });
});

describe("rejecting a whole frame", () => {
  it("writes one reject per proposed box in a single action", async () => {
    const { imageId, classId, predictionId } = await seedPool();
    const second = await seedPrediction(imageId, classId);

    const res = await rejectImage(imageId);

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ image_id: imageId, verdicts: 2 });

    const { results } = await env.DB.prepare(
      `SELECT v.prediction_id, v.verdict, v.source, v.annotator_id
         FROM verdicts v ORDER BY v.prediction_id`,
    ).all<{ prediction_id: number; verdict: string; source: string; annotator_id: string }>();

    expect(results).toEqual([
      {
        prediction_id: predictionId,
        verdict: "reject",
        source: "admin",
        annotator_id: ADMIN_EMAIL,
      },
      { prediction_id: second, verdict: "reject", source: "admin", annotator_id: ADMIN_EMAIL },
    ]);
  });

  it("does not touch another frame's boxes", async () => {
    const { videoId, classId, imageId } = await seedPool();
    const otherImage = await seedImage(videoId, 2);
    const untouched = await seedPrediction(otherImage, classId);

    await rejectImage(imageId);

    const survivor = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM verdicts WHERE prediction_id = ?",
    )
      .bind(untouched)
      .first<{ count: number }>();

    expect(survivor?.count).toBe(0);
  });

  it("reports zero on a frame whose boxes are already ruled on", async () => {
    // A menu frame somebody rejected from another tab. The button is still
    // there and pressing it must not be an error — a stale screen is the
    // normal case, not a bug worth a 409.
    const { imageId, predictionId } = await seedPool();
    await seedVerdict(predictionId, { verdict: "reject" });

    const res = await rejectImage(imageId);

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ image_id: imageId, verdicts: 0 });
  });

  it("answers 404 for an image that does not exist", async () => {
    const res = await rejectImage(9_999);

    expect(res.status).toBe(404);
  });

  it("is gated: no assertion, no rejection", async () => {
    const { imageId } = await seedPool();

    const res = await rejectImage(imageId, {});

    expect(res.status).toBe(401);
  });
});
