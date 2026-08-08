import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedVideo } from "./seed";

/**
 * Migration 0003 (M10.1): the five v2 labelling tables — classes,
 * predictions, verdicts, missing_reports, snapshots.
 *
 * There is no route surface yet; these tables are schema only until the
 * milestones that read and write them land. So unlike the other
 * `test/workers` files, this one talks to `env.DB` directly rather than
 * through `app.request`, and it is the schema's own constraints under test,
 * not an endpoint's.
 *
 * Cleanup between tests is `test/workers/setup.ts`'s, not this file's — see
 * the note there about `classes.name` being UNIQUE.
 */

/** Inserts a class row and returns its id. */
async function seedClass(overrides: Record<string, unknown> = {}): Promise<number> {
  const row = {
    name: "Paimon",
    appearance_prompt: "a small white-haired flying companion with pointed ears",
    prompt_version: "2026-08-08-a",
    ...overrides,
  };
  const result = await env.DB.prepare(
    `INSERT INTO classes (name, appearance_prompt, prompt_version)
          VALUES (?, ?, ?)
       RETURNING id`,
  )
    .bind(row.name, row.appearance_prompt, row.prompt_version)
    .first<{ id: number }>();
  if (!result) throw new Error("seedClass inserted nothing");
  return result.id;
}

/** Inserts an image row (bypassing the report-images endpoint) and returns its id. */
async function seedImage(
  videoId: string,
  overrides: Record<string, unknown> = {},
): Promise<number> {
  await seedVideo(videoId);
  const row = {
    r2_key: `${videoId}/0000000.jpg`,
    timestamp_seconds: 1,
    phash: "af3c9e1b2d4f7a80",
    dedup_threshold: 8,
    ...overrides,
  };
  const result = await env.DB.prepare(
    `INSERT INTO images (r2_key, video_id, timestamp_seconds, phash, dedup_threshold)
          VALUES (?, ?, ?, ?, ?)
       RETURNING id`,
  )
    .bind(row.r2_key, videoId, row.timestamp_seconds, row.phash, row.dedup_threshold)
    .first<{ id: number }>();
  if (!result) throw new Error("seedImage inserted nothing");
  return result.id;
}

/** Inserts a prediction row and returns its id. */
async function seedPrediction(
  imageId: number,
  classId: number,
  overrides: Record<string, unknown> = {},
): Promise<number> {
  const row = {
    x_min: 0.1,
    y_min: 0.2,
    x_max: 0.5,
    y_max: 0.6,
    confidence: 0.42,
    prompt_version: "2026-08-08-a",
    model_id: "owlvit-base-patch32.onnx",
    ...overrides,
  };
  const result = await env.DB.prepare(
    `INSERT INTO predictions
          (image_id, class_id, x_min, y_min, x_max, y_max, confidence, prompt_version, model_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
  )
    .bind(
      imageId,
      classId,
      row.x_min,
      row.y_min,
      row.x_max,
      row.y_max,
      row.confidence,
      row.prompt_version,
      row.model_id,
    )
    .first<{ id: number }>();
  if (!result) throw new Error("seedPrediction inserted nothing");
  return result.id;
}

describe("migration 0003: v2 labelling schema", () => {
  it("accepts a well-formed row in each of the five tables", async () => {
    const classId = await seedClass();
    const imageId = await seedImage("aaaaaaaaaaa");
    const predictionId = await seedPrediction(imageId, classId);

    const verdict = await env.DB.prepare(
      `INSERT INTO verdicts (prediction_id, verdict, source, annotator_id)
            VALUES (?, 'accept', 'admin', 'carl@example.com')
         RETURNING id`,
    )
      .bind(predictionId)
      .first<{ id: number }>();
    expect(verdict?.id).toBeTypeOf("number");

    const report = await env.DB.prepare(
      `INSERT INTO missing_reports (image_id, class_id, reporter)
            VALUES (?, ?, 'carl@example.com')
         RETURNING id`,
    )
      .bind(imageId, classId)
      .first<{ id: number }>();
    expect(report?.id).toBeTypeOf("number");

    const snapshot = await env.DB.prepare(
      `INSERT INTO snapshots (r2_key, image_count, label_count, inclusion_policy)
            VALUES ('snapshots/1.tar', 1, 1, 'admin-only, eval pool excluded')
         RETURNING id`,
    ).first<{ id: number }>();
    expect(snapshot?.id).toBeTypeOf("number");

    const counts = await env.DB.batch([
      env.DB.prepare("SELECT COUNT(*) AS n FROM classes"),
      env.DB.prepare("SELECT COUNT(*) AS n FROM predictions"),
      env.DB.prepare("SELECT COUNT(*) AS n FROM verdicts"),
      env.DB.prepare("SELECT COUNT(*) AS n FROM missing_reports"),
      env.DB.prepare("SELECT COUNT(*) AS n FROM snapshots"),
    ]);
    for (const result of counts) {
      expect(result.results[0]).toEqual({ n: 1 });
    }
  });

  it("allows two verdicts on the same prediction — several verdicts on one prediction is legal", async () => {
    const classId = await seedClass();
    const imageId = await seedImage("bbbbbbbbbbb");
    const predictionId = await seedPrediction(imageId, classId);

    await env.DB.prepare(
      `INSERT INTO verdicts (prediction_id, verdict, source, annotator_id)
            VALUES (?, 'accept', 'anon', 'session-1')`,
    )
      .bind(predictionId)
      .run();

    // A second, independent verdict on the very same prediction — the public
    // page showing it to a second visitor, or an admin re-reviewing what an
    // anonymous visitor already ruled on. This must not collide: there is no
    // uniqueness constraint on prediction_id, and the migration comment says
    // there must never be one.
    const second = await env.DB.prepare(
      `INSERT INTO verdicts (prediction_id, verdict, source, annotator_id)
            VALUES (?, 'reject', 'anon', 'session-2')
         RETURNING id`,
    )
      .bind(predictionId)
      .run();
    expect(second.success).toBe(true);

    const { results } = await env.DB.prepare(
      "SELECT verdict, source, annotator_id FROM verdicts WHERE prediction_id = ? ORDER BY id",
    )
      .bind(predictionId)
      .all();
    expect(results).toEqual([
      { verdict: "accept", source: "anon", annotator_id: "session-1" },
      { verdict: "reject", source: "anon", annotator_id: "session-2" },
    ]);
  });

  it("an adjust verdict never mutates the prediction row it judges", async () => {
    const classId = await seedClass();
    const imageId = await seedImage("ccccccccccc");
    const predictionId = await seedPrediction(imageId, classId, {
      x_min: 0.1,
      y_min: 0.1,
      x_max: 0.4,
      y_max: 0.4,
    });

    await env.DB.prepare(
      `INSERT INTO verdicts
            (prediction_id, verdict, adjusted_x_min, adjusted_y_min, adjusted_x_max, adjusted_y_max, source, annotator_id)
            VALUES (?, 'adjust', 0.2, 0.2, 0.5, 0.5, 'admin', 'carl@example.com')`,
    )
      .bind(predictionId)
      .run();

    const prediction = await env.DB.prepare(
      "SELECT x_min, y_min, x_max, y_max FROM predictions WHERE id = ?",
    )
      .bind(predictionId)
      .first();
    expect(prediction).toEqual({ x_min: 0.1, y_min: 0.1, x_max: 0.4, y_max: 0.4 });

    const verdict = await env.DB.prepare(
      "SELECT adjusted_x_min, adjusted_y_min, adjusted_x_max, adjusted_y_max FROM verdicts WHERE prediction_id = ?",
    )
      .bind(predictionId)
      .first();
    expect(verdict).toEqual({
      adjusted_x_min: 0.2,
      adjusted_y_min: 0.2,
      adjusted_x_max: 0.5,
      adjusted_y_max: 0.5,
    });
  });

  it("rejects a verdict value outside accept/adjust/reject", async () => {
    const classId = await seedClass();
    const imageId = await seedImage("ddddddddddd");
    const predictionId = await seedPrediction(imageId, classId);

    await expect(
      env.DB.prepare(
        `INSERT INTO verdicts (prediction_id, verdict, source, annotator_id)
              VALUES (?, 'maybe', 'admin', 'carl@example.com')`,
      )
        .bind(predictionId)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM verdicts WHERE prediction_id = ?")
      .bind(predictionId)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("rejects an adjust verdict with no adjusted coordinates", async () => {
    const classId = await seedClass();
    const imageId = await seedImage("eeeeeeeeeee");
    const predictionId = await seedPrediction(imageId, classId);

    await expect(
      env.DB.prepare(
        `INSERT INTO verdicts (prediction_id, verdict, source, annotator_id)
              VALUES (?, 'adjust', 'admin', 'carl@example.com')`,
      )
        .bind(predictionId)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("rejects a source value outside admin/anon", async () => {
    const classId = await seedClass();
    const imageId = await seedImage("fffffffffff");
    const predictionId = await seedPrediction(imageId, classId);

    await expect(
      env.DB.prepare(
        `INSERT INTO verdicts (prediction_id, verdict, source, annotator_id)
              VALUES (?, 'accept', 'friend', 'carl@example.com')`,
      )
        .bind(predictionId)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("rejects a confidence outside [0, 1]", async () => {
    const classId = await seedClass();
    const imageId = await seedImage("ggggggggggg");

    await expect(seedPrediction(imageId, classId, { confidence: 1.5 })).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it("rejects a duplicate class name", async () => {
    await seedClass({ name: "Paimon" });

    await expect(seedClass({ name: "Paimon" })).rejects.toThrow(/UNIQUE constraint failed/);
  });
});
