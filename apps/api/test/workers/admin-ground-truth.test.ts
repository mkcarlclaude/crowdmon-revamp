import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { ADMIN_EMAIL, adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";
import { seedImage, seedPool } from "./labelling-seed";
import { seedVideo } from "./seed";

/**
 * Ground truth (M26, #175): boxes an annotator drew because they are in the
 * frame, not because a model proposed them, and the fact that an (image,
 * class) pair has been looked at exhaustively. `seedPool()`'s frame carries
 * no `selection_reason`, so tests that exercise the frozen-pool worklist
 * stamp `selection_reason = 'random'` directly — the same thing
 * `reportPredictionsHandler` would have stamped on a real eval-pool frame.
 */

beforeAll(installAdminIdentity);
beforeEach(configureAccess);

async function drawBox(
  imageId: number,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return app.request(
    `/api/admin/images/${imageId}/ground-truth`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers ?? (await adminHeaders())) },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function deleteBox(id: number, headers?: Record<string, string>): Promise<Response> {
  return app.request(
    `/api/admin/ground-truth/${id}`,
    { method: "DELETE", headers: headers ?? (await adminHeaders()) },
    env,
  );
}

async function setExhaustive(
  imageId: number,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return app.request(
    `/api/admin/images/${imageId}/ground-truth/exhaustive`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(headers ?? (await adminHeaders())) },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function getAnnotation(imageId: number, headers?: Record<string, string>): Promise<Response> {
  return app.request(
    `/api/admin/images/${imageId}/ground-truth`,
    { headers: headers ?? (await adminHeaders()) },
    env,
  );
}

async function getPool(query = "", headers?: Record<string, string>): Promise<Response> {
  return app.request(
    `/api/admin/ground-truth/pool${query}`,
    { headers: headers ?? (await adminHeaders()) },
    env,
  );
}

describe("drawing a ground-truth box", () => {
  it("records a box no prediction covers", async () => {
    const { imageId, classId } = await seedPool();

    const res = await drawBox(imageId, {
      class_id: classId,
      x_min: 0.1,
      y_min: 0.15,
      x_max: 0.4,
      y_max: 0.5,
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      image_id: imageId,
      class_id: classId,
      class_name: "Paimon",
      x_min: 0.1,
      y_min: 0.15,
      x_max: 0.4,
      y_max: 0.5,
      annotator_id: ADMIN_EMAIL,
    });

    const { results } = await env.DB.prepare("SELECT * FROM ground_truth WHERE image_id = ?")
      .bind(imageId)
      .all();
    expect(results).toHaveLength(1);
  });

  it("does not need a prediction to already exist on the frame — the whole point", async () => {
    const { imageId, classId, predictionId } = await seedPool();
    await env.DB.prepare("DELETE FROM predictions WHERE id = ?").bind(predictionId).run();

    const res = await drawBox(imageId, {
      class_id: classId,
      x_min: 0,
      y_min: 0,
      x_max: 1,
      y_max: 1,
    });

    expect(res.status).toBe(201);
  });

  it("answers 400 for a box whose max is below its min", async () => {
    const { imageId, classId } = await seedPool();

    const res = await drawBox(imageId, {
      class_id: classId,
      x_min: 0.5,
      y_min: 0.5,
      x_max: 0.1,
      y_max: 0.6,
    });

    expect(res.status).toBe(400);
  });

  it("answers 404 for an image that does not exist", async () => {
    const { classId } = await seedPool();

    const res = await drawBox(9_999, { class_id: classId, x_min: 0, y_min: 0, x_max: 1, y_max: 1 });

    expect(res.status).toBe(404);
  });

  it("answers 404 for a class that does not exist", async () => {
    const { imageId } = await seedPool();

    const res = await drawBox(imageId, { class_id: 9_999, x_min: 0, y_min: 0, x_max: 1, y_max: 1 });

    expect(res.status).toBe(404);
  });

  it("is gated: no assertion, no box", async () => {
    const { imageId, classId } = await seedPool();

    const res = await drawBox(
      imageId,
      { class_id: classId, x_min: 0, y_min: 0, x_max: 1, y_max: 1 },
      {},
    );

    expect(res.status).toBe(401);
  });
});

describe("undoing a mis-drawn box", () => {
  it("deletes the row and answers with its id", async () => {
    const { imageId, classId } = await seedPool();
    const created = await drawBox(imageId, {
      class_id: classId,
      x_min: 0,
      y_min: 0,
      x_max: 1,
      y_max: 1,
    });
    const { id } = (await created.json()) as { id: number };

    const res = await deleteBox(id);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id });
    const { results } = await env.DB.prepare("SELECT id FROM ground_truth WHERE id = ?")
      .bind(id)
      .all();
    expect(results).toHaveLength(0);
  });

  it("answers 404 for a box that does not exist", async () => {
    const res = await deleteBox(9_999);

    expect(res.status).toBe(404);
  });
});

describe("marking an (image, class) pair exhaustively annotated", () => {
  it("upserts the fact, then retracts it", async () => {
    const { imageId, classId } = await seedPool();

    const marked = await setExhaustive(imageId, { class_id: classId, exhaustive: true });
    expect(marked.status).toBe(200);
    await expect(marked.json()).resolves.toEqual({
      image_id: imageId,
      class_id: classId,
      exhaustive: true,
    });

    const row = await env.DB.prepare(
      "SELECT annotator_id FROM ground_truth_exhaustive WHERE image_id = ? AND class_id = ?",
    )
      .bind(imageId, classId)
      .first<{ annotator_id: string }>();
    expect(row?.annotator_id).toBe(ADMIN_EMAIL);

    const unmarked = await setExhaustive(imageId, { class_id: classId, exhaustive: false });
    expect(unmarked.status).toBe(200);
    await expect(unmarked.json()).resolves.toMatchObject({ exhaustive: false });

    const gone = await env.DB.prepare(
      "SELECT 1 FROM ground_truth_exhaustive WHERE image_id = ? AND class_id = ?",
    )
      .bind(imageId, classId)
      .first();
    expect(gone).toBeNull();
  });

  it("re-marking does not duplicate the row — the composite key is the fact", async () => {
    const { imageId, classId } = await seedPool();

    await setExhaustive(imageId, { class_id: classId, exhaustive: true });
    await setExhaustive(imageId, { class_id: classId, exhaustive: true });

    const { results } = await env.DB.prepare(
      "SELECT * FROM ground_truth_exhaustive WHERE image_id = ? AND class_id = ?",
    )
      .bind(imageId, classId)
      .all();
    expect(results).toHaveLength(1);
  });

  it("answers 404 for an image that does not exist", async () => {
    const { classId } = await seedPool();

    const res = await setExhaustive(9_999, { class_id: classId, exhaustive: true });

    expect(res.status).toBe(404);
  });

  it("is gated: no assertion, no write", async () => {
    const { imageId, classId } = await seedPool();

    const res = await setExhaustive(imageId, { class_id: classId, exhaustive: true }, {});

    expect(res.status).toBe(401);
  });
});

describe("reading one image's annotation state", () => {
  it("carries predictions, ground truth and the exhaustive flag together", async () => {
    const { imageId, classId, predictionId } = await seedPool();
    const drawn = await drawBox(imageId, {
      class_id: classId,
      x_min: 0,
      y_min: 0,
      x_max: 0.3,
      y_max: 0.3,
    });
    const { id: groundTruthId } = (await drawn.json()) as { id: number };
    await setExhaustive(imageId, { class_id: classId, exhaustive: true });

    const res = await getAnnotation(imageId);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      predictions: Array<{ id: number }>;
      ground_truth: Array<{ id: number }>;
      classes: Array<{ class_id: number; exhaustive: boolean }>;
    };
    expect(body.predictions.map((p) => p.id)).toEqual([predictionId]);
    expect(body.ground_truth.map((g) => g.id)).toEqual([groundTruthId]);
    expect(body.classes).toEqual([{ class_id: classId, name: "Paimon", exhaustive: true }]);
  });

  it("an untouched image reads as not exhaustive, not as an error", async () => {
    const { imageId, classId } = await seedPool();

    const res = await getAnnotation(imageId);

    const body = (await res.json()) as {
      classes: Array<{ class_id: number; exhaustive: boolean }>;
    };
    expect(body.classes).toEqual([{ class_id: classId, name: "Paimon", exhaustive: false }]);
  });

  it("answers 404 for an image that does not exist", async () => {
    const res = await getAnnotation(9_999);

    expect(res.status).toBe(404);
  });
});

describe("the frozen-pool worklist", () => {
  it("lists only images sampled as selection_reason = 'random'", async () => {
    const { imageId: randomImageId } = await seedPool();
    await env.DB.prepare("UPDATE images SET selection_reason = 'random' WHERE id = ?")
      .bind(randomImageId)
      .run();

    // A second frame from a second video, sampled `diverse` — train, not
    // eval (CONTEXT.md §Q16) — reusing the class `seedPool` already seeded
    // rather than seeding "Paimon" a second time, which `classes.name
    // UNIQUE` would refuse.
    await seedVideo("otherVideoId");
    const trainImageId = await seedImage("otherVideoId", 1);
    await env.DB.prepare("UPDATE images SET selection_reason = 'diverse' WHERE id = ?")
      .bind(trainImageId)
      .run();

    const res = await getPool();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { images: Array<{ id: number }>; total: number };
    expect(body.images.map((i) => i.id)).toEqual([randomImageId]);
    expect(body.total).toBe(1);
  });

  it("carries each image's ground-truth count and per-class exhaustive state", async () => {
    const { imageId, classId } = await seedPool();
    await env.DB.prepare("UPDATE images SET selection_reason = 'random' WHERE id = ?")
      .bind(imageId)
      .run();
    await drawBox(imageId, { class_id: classId, x_min: 0, y_min: 0, x_max: 0.2, y_max: 0.2 });
    await drawBox(imageId, { class_id: classId, x_min: 0.3, y_min: 0.3, x_max: 0.5, y_max: 0.5 });
    await setExhaustive(imageId, { class_id: classId, exhaustive: true });

    const res = await getPool();

    const body = (await res.json()) as {
      images: Array<{
        id: number;
        ground_truth_count: number;
        classes: Array<{ exhaustive: boolean }>;
      }>;
    };
    expect(body.images).toEqual([
      {
        id: imageId,
        video_id: expect.any(String),
        r2_key: expect.any(String),
        timestamp_seconds: expect.any(Number),
        ground_truth_count: 2,
        classes: [{ class_id: classId, name: "Paimon", exhaustive: true }],
      },
    ]);
  });

  it("is gated: no assertion, no listing", async () => {
    const res = await getPool("", {});

    expect(res.status).toBe(401);
  });
});
