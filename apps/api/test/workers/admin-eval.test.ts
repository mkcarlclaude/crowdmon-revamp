import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";
import { seedImage, seedPool } from "./labelling-seed";
import { seedVideo } from "./seed";

/**
 * `GET /api/admin/eval-source` (M26, #177): the scorer's whole input.
 *
 * The gate is per image, not all-or-nothing across the pool — see this
 * route's own module comment (`admin-eval.ts`) and `EvalSource`'s in
 * `schemas.ts` for why: the frozen pool is 2,298 images in production, and
 * refusing the entire call until every one of them is marked exhaustive
 * could never be satisfied by the single sitting the plan actually
 * budgeted (95 *labelled* images, not the pool). `images` below is
 * whatever has actually been marked exhaustive; the 409 survives for
 * exactly the case where that set is empty.
 */

beforeAll(installAdminIdentity);
beforeEach(configureAccess);

async function evalSource(headers?: Record<string, string>): Promise<Response> {
  return app.request("/api/admin/eval-source", { headers: headers ?? (await adminHeaders()) }, env);
}

async function drawGroundTruth(imageId: number, classId: number) {
  await app.request(
    `/api/admin/images/${imageId}/ground-truth`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(await adminHeaders()) },
      body: JSON.stringify({ class_id: classId, x_min: 0.1, y_min: 0.1, x_max: 0.4, y_max: 0.4 }),
    },
    env,
  );
}

async function markExhaustive(imageId: number, classId: number) {
  await app.request(
    `/api/admin/images/${imageId}/ground-truth/exhaustive`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(await adminHeaders()) },
      body: JSON.stringify({ class_id: classId, exhaustive: true }),
    },
    env,
  );
}

async function markRandom(imageId: number) {
  await env.DB.prepare("UPDATE images SET selection_reason = 'random' WHERE id = ?")
    .bind(imageId)
    .run();
}

describe("the eval scorer's source", () => {
  it("409s only when nothing in the pool has been marked exhaustive at all", async () => {
    const { imageId } = await seedPool();
    await markRandom(imageId);
    // Ground truth drawn, but never marked exhaustive — this image is
    // simply not part of the scored set yet, and with nothing else in the
    // pool there is genuinely nothing to score.

    const res = await evalSource();

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no pool image is marked exhaustively annotated");
  });

  it("returns only the images marked exhaustive, and omits the rest of the pool", async () => {
    const { imageId: markedId, classId } = await seedPool();
    await markRandom(markedId);
    await drawGroundTruth(markedId, classId);
    await markExhaustive(markedId, classId);

    // A second pool image, ground truth drawn but never marked exhaustive
    // — the exact gap this milestone's finding is about (a box exists, but
    // nobody has said "this is everything"). It must not appear at all,
    // and its presence must not turn the whole call into a 409 the way the
    // all-or-nothing gate used to.
    await seedVideo("secondVideoId");
    const unmarkedId = await seedImage("secondVideoId", 1);
    await markRandom(unmarkedId);
    await drawGroundTruth(unmarkedId, classId);

    const res = await evalSource();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { images: Array<{ image_id: number }> };
    expect(body.images.map((image) => image.image_id)).toEqual([markedId]);
  });

  it("carries ground truth and predictions together once an image is marked", async () => {
    const { imageId, classId, predictionId } = await seedPool();
    await markRandom(imageId);
    await drawGroundTruth(imageId, classId);
    await markExhaustive(imageId, classId);
    void predictionId;

    const res = await evalSource();

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      images: Array<{
        image_id: number;
        predictions: Array<{ class_name: string; confidence: number }>;
        ground_truth: Array<{ class_name: string }>;
      }>;
    };
    expect(body.images).toHaveLength(1);
    expect(body.images[0]?.image_id).toBe(imageId);
    expect(body.images[0]?.predictions).toEqual([
      { class_name: "Paimon", x_min: 0.1, y_min: 0.2, x_max: 0.5, y_max: 0.6, confidence: 0.87 },
    ]);
    expect(body.images[0]?.ground_truth).toEqual([
      { class_name: "Paimon", x_min: 0.1, y_min: 0.1, x_max: 0.4, y_max: 0.4 },
    ]);
  });

  it("an exhaustively-marked image with nothing drawn still scores — a real zero, not a gap", async () => {
    const { imageId, classId } = await seedPool();
    await markRandom(imageId);
    // No ground truth drawn at all, but marked exhaustive: "somebody looked
    // and there is genuinely nothing here" (migration 0014's own words).
    await markExhaustive(imageId, classId);

    const res = await evalSource();

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      images: Array<{ image_id: number; ground_truth: unknown[] }>;
    };
    expect(body.images).toHaveLength(1);
    expect(body.images[0]?.ground_truth).toEqual([]);
  });

  it("never includes a train-split image, even if it is marked exhaustive", async () => {
    const { imageId: trainImageId, classId } = await seedPool();
    // Not marked `random` — an ordinary train-split frame, per `splitFor`
    // (worker/internal/snapshot/builder.go). Marked exhaustive anyway, to
    // prove the exclusion is driven by `selection_reason`, not by whether
    // an annotator happened to reach it.
    await markExhaustive(trainImageId, classId);

    await seedVideo("secondVideoId");
    const evalImageId = await seedImage("secondVideoId", 1);
    await markRandom(evalImageId);
    await markExhaustive(evalImageId, classId);

    const res = await evalSource();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { images: Array<{ image_id: number }> };
    expect(body.images.map((image) => image.image_id)).toEqual([evalImageId]);
  });

  it("reads ground_truth, never verdicts — an accepted prediction does not substitute for an exhaustive mark", async () => {
    const { imageId, predictionId } = await seedPool();
    await markRandom(imageId);
    // The label `snapshotSourceHandler` would read for the *train* split:
    // an admin `accept` verdict on the prediction. Written directly rather
    // than through the verdicts endpoint — this route must never treat it
    // as ground truth or as satisfying the exhaustive gate, no matter how
    // it landed.
    await env.DB.prepare(
      `INSERT INTO verdicts (prediction_id, verdict, source, annotator_id) VALUES (?, 'accept', 'admin', 'admin@example.com')`,
    )
      .bind(predictionId)
      .run();

    const res = await evalSource();

    // No `ground_truth_exhaustive` row exists, so the accepted prediction
    // buys this image nothing — the pool has nothing scored at all.
    expect(res.status).toBe(409);
  });

  it("excludes predictions and ground truth from a class that is not active", async () => {
    const { imageId } = await seedPool();
    await markRandom(imageId);

    const inactiveClass = await env.DB.prepare(
      `INSERT INTO classes (name, appearance_prompt, prompt_version, active)
            VALUES ('Hu Tao', 'a red-eyed pyromaniac', '2026-08-08-a', 0)
         RETURNING id`,
    ).first<{ id: number }>();
    if (!inactiveClass) throw new Error("seeding the inactive class inserted nothing");

    await env.DB.prepare(
      `INSERT INTO predictions (image_id, class_id, x_min, y_min, x_max, y_max, confidence, prompt_version, model_id)
            VALUES (?, ?, 0, 0, 1, 1, 0.9, '2026-08-08-a', 'owlvit-base-patch32.onnx')`,
    )
      .bind(imageId, inactiveClass.id)
      .run();

    const res = await evalSource();

    // Paimon (the only active class) has no exhaustive mark yet, so
    // nothing is scored — the inactive class's prediction existing must
    // not smuggle the image into the scored set.
    expect(res.status).toBe(409);
  });

  it("is gated: no assertion, no source", async () => {
    const res = await evalSource({});

    expect(res.status).toBe(401);
  });
});
