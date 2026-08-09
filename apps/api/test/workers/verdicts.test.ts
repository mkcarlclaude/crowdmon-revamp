import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { MAX_VERDICTS_PER_IMAGE } from "../../src/schemas";
import { ADMIN_EMAIL, adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";
import { seedImage, seedPool, seedPrediction, seedVerdict } from "./labelling-seed";

/**
 * Verdict writes behind Access (M13.2).
 *
 * One call per frame, never one per box. That is a UI constraint that reached
 * the contract: a screen writing each ruling as it was clicked had to remove
 * the box it had just ruled on, renumbering every box below it under a moving
 * cursor, so rulings are staged and submitted together.
 *
 * Four properties carry the milestone and each is asserted here rather than
 * left to the UI:
 *
 * 1. **Append-only.** A second verdict on one prediction is a legal state
 *    (migration 0003 refuses a uniqueness constraint on `prediction_id` on
 *    purpose), so the test that submits twice and expects two rows is the test
 *    that would fail if somebody ever "fixed" that with an upsert.
 * 2. **An `adjust` leaves the prediction byte-for-byte unchanged.** Asserted
 *    against the row, not against the response, because a handler that
 *    mutated `predictions` could still echo the original coordinates back.
 * 3. **Source and identity come from the assertion, never the body.** A caller
 *    that could name its own `source` could write an admin verdict from the
 *    public page M14 mounts the same component on.
 * 4. **A submission is atomic and belongs to its frame.** Half a frame's
 *    rulings landing is indistinguishable afterwards from an operator's own
 *    partial submit, and a ruling naming a box on another frame would attach a
 *    verdict to something nobody looked at.
 */

beforeAll(installAdminIdentity);
beforeEach(configureAccess);

async function submit(
  imageId: number,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return app.request(
    `/api/admin/images/${imageId}/verdicts`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers ?? (await adminHeaders())) },
      body: JSON.stringify(body),
    },
    env,
  );
}

const ruling = (predictionId: number, over: Record<string, unknown> = {}) => ({
  prediction_id: predictionId,
  verdict: "accept",
  ...over,
});

const adjustment = (predictionId: number, over: Record<string, unknown> = {}) => ({
  prediction_id: predictionId,
  verdict: "adjust",
  adjusted_x_min: 0.14,
  adjusted_y_min: 0.22,
  adjusted_x_max: 0.48,
  adjusted_y_max: 0.61,
  ...over,
});

describe("submitting a frame's rulings", () => {
  it("writes every ruling with the admin's own identity", async () => {
    const { imageId, classId, predictionId } = await seedPool();
    const second = await seedPrediction(imageId, classId);

    const res = await submit(imageId, {
      verdicts: [ruling(predictionId), ruling(second, { verdict: "reject" })],
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ image_id: imageId, verdicts: 2 });

    const { results } = await env.DB.prepare(
      "SELECT prediction_id, verdict, source, annotator_id FROM verdicts ORDER BY prediction_id",
    ).all<{ prediction_id: number; verdict: string; source: string; annotator_id: string }>();

    expect(results).toEqual([
      {
        prediction_id: predictionId,
        verdict: "accept",
        source: "admin",
        annotator_id: ADMIN_EMAIL,
      },
      { prediction_id: second, verdict: "reject", source: "admin", annotator_id: ADMIN_EMAIL },
    ]);
  });

  it("puts an adjustment's coordinates on the verdict and leaves the prediction alone", async () => {
    const { imageId, predictionId } = await seedPool();
    const before = await env.DB.prepare("SELECT * FROM predictions WHERE id = ?")
      .bind(predictionId)
      .first();

    const res = await submit(imageId, { verdicts: [adjustment(predictionId)] });

    expect(res.status).toBe(201);

    const verdict = await env.DB.prepare("SELECT * FROM verdicts WHERE prediction_id = ?")
      .bind(predictionId)
      .first<Record<string, unknown>>();
    expect(verdict).toMatchObject({
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

  it("rejects a whole frame in one submission", async () => {
    // The menu-and-black-frame case. Staging turns it into one request
    // whatever the box count, which is what the dedicated reject endpoint used
    // to buy on its own.
    const { imageId, classId, predictionId } = await seedPool();
    const second = await seedPrediction(imageId, classId);
    const third = await seedPrediction(imageId, classId);

    const res = await submit(imageId, {
      verdicts: [predictionId, second, third].map((id) => ruling(id, { verdict: "reject" })),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ image_id: imageId, verdicts: 3 });
  });

  it("keeps both verdicts when the same prediction is ruled on in two submissions", async () => {
    const { imageId, predictionId } = await seedPool();

    expect((await submit(imageId, { verdicts: [ruling(predictionId)] })).status).toBe(201);
    expect(
      (await submit(imageId, { verdicts: [ruling(predictionId, { verdict: "reject" })] })).status,
    ).toBe(201);

    const { results } = await env.DB.prepare(
      "SELECT verdict FROM verdicts WHERE prediction_id = ? ORDER BY id",
    )
      .bind(predictionId)
      .all<{ verdict: string }>();

    expect(results.map((row) => row.verdict)).toEqual(["accept", "reject"]);
  });

  it("ignores a source the caller tries to name", async () => {
    const { imageId, predictionId } = await seedPool();

    const res = await submit(imageId, {
      verdicts: [ruling(predictionId, { source: "anon", annotator_id: "somebody-else" })],
    });

    expect(res.status).toBe(201);
    const row = await env.DB.prepare("SELECT source, annotator_id FROM verdicts").first();
    expect(row).toEqual({ source: "admin", annotator_id: ADMIN_EMAIL });
  });

  it("refuses an empty submission", async () => {
    // Not a no-op answering 201: a submit button that fired with nothing
    // staged is a bug on the screen, and answering success would hide it.
    const { imageId } = await seedPool();

    expect((await submit(imageId, { verdicts: [] })).status).toBe(400);
  });

  it("refuses more rulings than a frame could carry", async () => {
    const { imageId, predictionId } = await seedPool();

    const res = await submit(imageId, {
      verdicts: Array.from({ length: MAX_VERDICTS_PER_IMAGE + 1 }, () => ruling(predictionId)),
    });

    expect(res.status).toBe(400);
  });

  it("refuses the same prediction ruled on twice in one submission", async () => {
    // The staging area holds one ruling per box by construction, so this is a
    // UI bug — and two rows appended together are indistinguishable afterwards
    // from a deliberate re-ruling, which is a state the schema does allow.
    const { imageId, predictionId } = await seedPool();

    const res = await submit(imageId, {
      verdicts: [ruling(predictionId), ruling(predictionId, { verdict: "reject" })],
    });

    expect(res.status).toBe(400);
    const { results } = await env.DB.prepare("SELECT id FROM verdicts").all();
    expect(results).toHaveLength(0);
  });

  it("refuses an adjust with no coordinates", async () => {
    const { imageId, predictionId } = await seedPool();

    const res = await submit(imageId, { verdicts: [ruling(predictionId, { verdict: "adjust" })] });

    expect(res.status).toBe(400);
  });

  it("refuses an accept that carries coordinates", async () => {
    const { imageId, predictionId } = await seedPool();

    const res = await submit(imageId, {
      verdicts: [adjustment(predictionId, { verdict: "accept" })],
    });

    expect(res.status).toBe(400);
  });

  it("refuses an inverted adjusted box", async () => {
    const { imageId, predictionId } = await seedPool();

    const res = await submit(imageId, {
      verdicts: [adjustment(predictionId, { adjusted_x_max: 0.01 })],
    });

    expect(res.status).toBe(400);
  });

  it("writes nothing when one ruling in the batch is unusable", async () => {
    // Atomicity, from the caller's side: a frame half-ruled is a legal state
    // this schema cannot tell apart from a deliberate partial submit, so a
    // batch that cannot land whole must not land at all.
    const { imageId, classId, predictionId } = await seedPool();
    const second = await seedPrediction(imageId, classId);

    const res = await submit(imageId, {
      verdicts: [ruling(predictionId), ruling(second, { verdict: "not-a-verdict" })],
    });

    expect(res.status).toBe(400);
    const { results } = await env.DB.prepare("SELECT id FROM verdicts").all();
    expect(results).toHaveLength(0);
  });

  it("refuses a prediction that belongs to another frame", async () => {
    const { videoId, imageId, classId } = await seedPool();
    const otherImage = await seedImage(videoId, 2);
    const elsewhere = await seedPrediction(otherImage, classId);

    const res = await submit(imageId, { verdicts: [ruling(elsewhere)] });

    expect(res.status).toBe(404);
    const { results } = await env.DB.prepare("SELECT id FROM verdicts").all();
    expect(results).toHaveLength(0);
  });

  it("answers 404 for an image that does not exist", async () => {
    const { predictionId } = await seedPool();

    expect((await submit(9_999, { verdicts: [ruling(predictionId)] })).status).toBe(404);
  });

  it("does not care that another tier already ruled on the box", async () => {
    // CONTEXT.md §Q10's two tiers: an anonymous visitor's click (M14) is not a
    // reason to refuse the authoritative annotator's.
    const { imageId, predictionId } = await seedPool();
    await seedVerdict(predictionId, { source: "anon", annotatorId: "session-abc" });

    expect((await submit(imageId, { verdicts: [ruling(predictionId)] })).status).toBe(201);
  });

  it("is gated: no assertion, no verdicts", async () => {
    const { imageId, predictionId } = await seedPool();

    const res = await submit(imageId, { verdicts: [ruling(predictionId)] }, {});

    expect(res.status).toBe(401);
  });
});
