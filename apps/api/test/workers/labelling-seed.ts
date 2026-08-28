import { env } from "cloudflare:test";
import { seedVideo } from "./seed";

/**
 * The rows a verification screen reads, written straight to D1 (M13).
 *
 * Everything M13 serves is downstream of a prelabel run: a video, its frames,
 * the classes in force and the boxes the detector proposed. None of that has
 * an admin-facing write endpoint — `reportPredictions` is the only way boxes
 * enter the system and it needs a held `prelabel` lease — so a test about
 * verdicts would otherwise spend most of its length standing up a queue it is
 * not testing.
 *
 * Shared across `verdicts`, `missing-reports`, `labelling-batch` and
 * `labelling-stats` rather than copied into each: the four suites need the
 * same shape of pool, and four drifting copies of it is four different
 * definitions of "an unverified frame".
 */

export async function seedClass(
  name: string,
  { active = 1 }: { active?: 0 | 1 } = {},
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO classes (name, appearance_prompt, prompt_version, active)
          VALUES (?, 'a small white-haired flying companion with pointed ears', '2026-08-08-a', ?)
       RETURNING id`,
  )
    .bind(name, active)
    .first<{ id: number }>();

  if (!row) throw new Error(`seeding the class ${name} inserted nothing`);
  return row.id;
}

/**
 * Hands out a strictly increasing `shuffle_key` to every `seedImage` call
 * that does not name its own (M25.1, plan §A). A test-seeded image bypasses
 * `reportImagesHandler`, the endpoint that would otherwise stamp one, so
 * something here has to — a NULL key is not a lesser default, it is the
 * exact hazard migration 0013's own comment names: invisible to any query
 * filtering on `shuffle_key`, forever, with nothing failing.
 *
 * Monotonic rather than random by default so that a suite written before
 * M25.1 — which seeded frames in the order it wanted them served, back when
 * serving order followed `images.id` — keeps working unmodified: insertion
 * order and `shuffle_key` order agree unless a test overrides one to
 * exercise shuffling or the cursor directly (`labelling-batch.test.ts`'s own
 * ordering and wraparound cases do).
 */
let nextShuffleKey = 1;

/**
 * One frame. `timestampSeconds` is explicit rather than defaulted because
 * `idx_images_identity` (migration 0001) is unique on `(video_id,
 * timestamp_seconds)`, so a suite seeding several frames for one video has to
 * choose them — and a silent default would make the second call fail in a way
 * that reads as the code under test rejecting something.
 */
export async function seedImage(
  videoId: string,
  timestampSeconds: number,
  { publicSample, shuffleKey }: { publicSample?: 0 | 1; shuffleKey?: number } = {},
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO images (r2_key, video_id, timestamp_seconds, phash, dedup_threshold, public_sample, shuffle_key)
          VALUES (?, ?, ?, 'af3c9e1b2d4f7a80', 8, ?, ?)
       RETURNING id`,
  )
    .bind(
      `frames/${videoId}/${String(timestampSeconds).padStart(5, "0")}.000.jpg`,
      videoId,
      timestampSeconds,
      publicSample ?? null,
      shuffleKey ?? nextShuffleKey++,
    )
    .first<{ id: number }>();

  if (!row) throw new Error("seeding an image inserted nothing");
  return row.id;
}

export async function seedPrediction(
  imageId: number,
  classId: number,
  overrides: { confidence?: number; modelId?: string } = {},
): Promise<number> {
  const { confidence = 0.87, modelId = "owlvit-base-patch32.onnx" } = overrides;

  const row = await env.DB.prepare(
    `INSERT INTO predictions
          (image_id, class_id, x_min, y_min, x_max, y_max, confidence, prompt_version, model_id)
          VALUES (?, ?, 0.1, 0.2, 0.5, 0.6, ?, '2026-08-08-a', ?)
       RETURNING id`,
  )
    .bind(imageId, classId, confidence, modelId)
    .first<{ id: number }>();

  if (!row) throw new Error("seeding a prediction inserted nothing");

  // Mirrors `reportPredictionsHandler`'s own write to `images.unruled_admin`
  // (M25.1, plan §B2). A prediction inserted directly here, bypassing the
  // real endpoint, would otherwise leave the counter at its `ADD COLUMN
  // DEFAULT 0` forever — invisible to `idx_images_admin_pool` regardless of
  // how many un-ruled boxes the row actually carries, which would look like
  // the endpoint under test was broken rather than the fixture.
  await env.DB.prepare("UPDATE images SET unruled_admin = unruled_admin + 1 WHERE id = ?")
    .bind(imageId)
    .run();

  return row.id;
}

/**
 * A video, one class, one frame and one box on it — the smallest pool a
 * verification screen has anything to show for.
 */
export async function seedPool(videoId = "dQw4w9WgXcQ") {
  await seedVideo(videoId);
  const classId = await seedClass("Paimon");
  const imageId = await seedImage(videoId, 1);
  const predictionId = await seedPrediction(imageId, classId);

  return { videoId, classId, imageId, predictionId };
}

/**
 * A verdict written without going through the endpoint under test.
 *
 * `source` admits `'user'` (migration 0012, M20 plan §B1) alongside the
 * original two — `annotatorId` for that source should be a `users.id` as
 * text, matching what `submitContributeVerdictsHandler` actually writes, not
 * an email; see that migration's own comment on `verdicts.annotator_id`.
 */
export async function seedVerdict(
  predictionId: number,
  {
    verdict = "accept",
    source = "admin",
    annotatorId = "someone@example.com",
  }: {
    verdict?: "accept" | "reject";
    source?: "admin" | "anon" | "user";
    annotatorId?: string;
  } = {},
): Promise<void> {
  // Mirrors `submitVerdictsHandler`'s own guarded decrement (M25.1, plan
  // §B2), run before the insert below for the same reason that handler
  // orders it first: the guard's `NOT EXISTS` has to see the state before
  // *this* verdict lands. Only for `source = 'admin'` — `unruled_admin`
  // counts admin verdicts alone (`UNRULED_BOX`'s own predicate), so a
  // seeded `anon` or `user` verdict must not move it, the same asymmetry
  // `admin-labelling.ts` and `contribute.ts` document at their own
  // predicates. A test that seeds two admin verdicts on one prediction —
  // exercising a re-ruling directly, without going through the endpoint —
  // would otherwise drift this fixture's counter negative exactly the way
  // the plan warns an unguarded decrement would in production.
  if (source === "admin") {
    await env.DB.prepare(
      `UPDATE images SET unruled_admin = unruled_admin - 1
        WHERE id = (SELECT image_id FROM predictions WHERE id = ?)
          AND NOT EXISTS (
                SELECT 1 FROM verdicts v WHERE v.prediction_id = ? AND v.source = 'admin')`,
    )
      .bind(predictionId, predictionId)
      .run();
  }

  await env.DB.prepare(
    `INSERT INTO verdicts (prediction_id, verdict, source, annotator_id) VALUES (?, ?, ?, ?)`,
  )
    .bind(predictionId, verdict, source, annotatorId)
    .run();
}
