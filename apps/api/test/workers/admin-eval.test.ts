import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";
import { seedPool } from "./labelling-seed";

/**
 * `GET /api/admin/eval-source` (M26, #177): the scorer's whole input, and
 * the one place M26's actual gate — "an image that is not marked
 * exhaustively annotated must be refused, not skipped silently" (plan §B) —
 * is enforced.
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
  it("refuses outright when an eval-pool image is not exhaustively annotated", async () => {
    const { imageId } = await seedPool();
    await markRandom(imageId);
    // Ground truth drawn, but never marked exhaustive — the exact gap the
    // plan's own finding is about: a box exists, but nobody has said "this
    // is everything."

    const res = await evalSource();

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(`image ${imageId}`);
    expect(body.error).toContain("Paimon");
  });

  it("carries ground truth and predictions together once the pool is complete", async () => {
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

  it("never includes a train-split image, whether or not it is annotated", async () => {
    const { imageId } = await seedPool();
    // Not marked `random` — an ordinary train-split frame, per `splitFor`
    // (worker/internal/snapshot/builder.go): must never appear here
    // regardless of its ground_truth state.

    const res = await evalSource();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { images: unknown[] };
    expect(body.images).toEqual([]);
    void imageId;
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

    // Paimon (the only active class) has no exhaustive mark yet, so the
    // whole pool is still refused — the inactive class's prediction existing
    // must not smuggle the image past the gate that matters.
    expect(res.status).toBe(409);
  });

  it("is gated: no assertion, no source", async () => {
    const res = await evalSource({});

    expect(res.status).toBe(401);
  });
});
