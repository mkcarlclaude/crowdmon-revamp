import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { seedClass, seedImage, seedPrediction } from "./labelling-seed";
import { seedVideo } from "./seed";

/**
 * The public page's write side (M14.2, M14.4).
 *
 * Every rule `admin-verdicts.ts` states for the admin tier holds here too —
 * append-only, one call per frame, a stranger's rulings on strangers'
 * predictions only. Three more are specific to having no Access assertion to
 * lean on: `source` is hardcoded `'anon'` regardless of what the body claims
 * (there is no field to claim it in — `PublicStagedVerdict` has none), an
 * `adjust` verdict is refused at the schema layer, and the target image must
 * itself be in `public_sample` — a verdict cannot land on a frame this
 * surface never would have shown.
 */

async function seedPublicPool(videoId = "dQw4w9WgXcQ", className = "Paimon") {
  await seedVideo(videoId);
  const classId = await seedClass(className);
  const imageId = await seedImage(videoId, 1, { publicSample: 1 });
  const predictionId = await seedPrediction(imageId, classId);
  return { videoId, classId, imageId, predictionId };
}

async function submit(imageId: number, body: unknown): Promise<Response> {
  return app.request(
    `/api/public/images/${imageId}/verdicts`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

function verdictRows(predictionId: number) {
  return env.DB.prepare(
    "SELECT verdict, source, annotator_id FROM verdicts WHERE prediction_id = ?",
  )
    .bind(predictionId)
    .all<{ verdict: string; source: string; annotator_id: string }>();
}

describe("submitting an anonymous verdict", () => {
  it("writes source='anon' and the caller's session id, never trusting either from elsewhere", async () => {
    const { imageId, predictionId } = await seedPublicPool();

    const res = await submit(imageId, {
      session_id: "session-abc",
      verdicts: [{ prediction_id: predictionId, verdict: "accept" }],
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ image_id: imageId, verdicts: 1 });

    const { results } = await verdictRows(predictionId);
    expect(results).toEqual([{ verdict: "accept", source: "anon", annotator_id: "session-abc" }]);
  });

  it("refuses an adjust verdict — there is no coordinate field for it to carry", async () => {
    const { imageId, predictionId } = await seedPublicPool();

    const res = await submit(imageId, {
      session_id: "session-abc",
      verdicts: [{ prediction_id: predictionId, verdict: "adjust" }],
    });

    expect(res.status).toBe(400);
    expect((await verdictRows(predictionId)).results).toEqual([]);
  });

  it("404s on an image outside the public sample", async () => {
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    const classId = await seedClass("Paimon");
    const imageId = await seedImage(videoId, 1); // not flagged
    const predictionId = await seedPrediction(imageId, classId);

    const res = await submit(imageId, {
      session_id: "session-abc",
      verdicts: [{ prediction_id: predictionId, verdict: "accept" }],
    });

    expect(res.status).toBe(404);
  });

  it("404s on a prediction that is not on this frame", async () => {
    const { imageId } = await seedPublicPool();
    const { predictionId: strangerPrediction } = await seedPublicPool("bbbbbbbbbbb", "Nahida");

    const res = await submit(imageId, {
      session_id: "session-abc",
      verdicts: [{ prediction_id: strangerPrediction, verdict: "accept" }],
    });

    expect(res.status).toBe(404);
  });

  it("400s on a prediction ruled twice in one submission", async () => {
    const { imageId, predictionId } = await seedPublicPool();

    const res = await submit(imageId, {
      session_id: "session-abc",
      verdicts: [
        { prediction_id: predictionId, verdict: "accept" },
        { prediction_id: predictionId, verdict: "reject" },
      ],
    });

    expect(res.status).toBe(400);
  });

  it("400s on an empty submission", async () => {
    const { imageId } = await seedPublicPool();

    expect((await submit(imageId, { session_id: "session-abc", verdicts: [] })).status).toBe(400);
  });

  it("400s on a missing session_id", async () => {
    const { imageId, predictionId } = await seedPublicPool();

    const res = await submit(imageId, {
      verdicts: [{ prediction_id: predictionId, verdict: "accept" }],
    });

    expect(res.status).toBe(400);
  });

  it("requires no Access assertion at all", async () => {
    const { imageId, predictionId } = await seedPublicPool();

    // No `Cf-Access-Jwt-Assertion` header anywhere in this file's requests —
    // the 201 above already proves it, this just states the claim by name.
    const res = await submit(imageId, {
      session_id: "session-abc",
      verdicts: [{ prediction_id: predictionId, verdict: "reject" }],
    });

    expect(res.status).toBe(201);
  });
});
