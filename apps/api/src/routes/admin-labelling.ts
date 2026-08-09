import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../bindings";
import { chunkForBinding, placeholders } from "../d1";
import { frameUrls } from "../frame-urls";
import {
  errorResponse,
  LABELLING_BATCH_SIZE,
  LabellingBatch,
  LabellingBatchQuery,
  LabellingStats,
  type LabellingStatsRow,
} from "../schemas";

/**
 * What a labelling session reads (M13.4).
 *
 * Two routes with one thing in common: they answer questions about *rows*, not
 * about the system. How long a prelabel job took and how deep the queue is are
 * already on the Grafana dashboard, and §7's "do not rebuild Grafana inside
 * /admin" is why nothing here reports either. How many frames are left to rule
 * on is a question Grafana cannot answer and this endpoint can.
 *
 * **What makes a frame unverified.** A frame is in the pool while it carries at
 * least one box this tier has not ruled on, and the boxes it comes back with
 * are exactly those. That definition, rather than "no verdict on the frame at
 * all", is what makes a partly-ruled frame legal: an operator who accepts one
 * of three boxes and closes the tab gets the other two back next session
 * instead of the frame vanishing with two boxes nobody ever saw. It is also
 * what makes M13.2's whole-frame reject work as an exit — rejecting every box
 * leaves nothing unruled, so the frame drops out of the pool.
 *
 * The tier is `source = 'admin'`. An anonymous visitor having clicked on a box
 * (M14) must not remove it from an admin's queue: the two tiers are kept apart
 * everywhere they meet (CONTEXT.md §Q10), and pooling them here would let
 * public traffic decide what the authoritative annotator never sees.
 */

/** Any box on this image that the admin tier has not ruled on. */
const UNRULED_BOX = `
  SELECT 1 FROM predictions p
   WHERE p.image_id = i.id
     AND NOT EXISTS (
           SELECT 1 FROM verdicts v WHERE v.prediction_id = p.id AND v.source = 'admin')`;

interface BatchImageRow {
  id: number;
  video_id: string;
  r2_key: string;
  timestamp_seconds: number;
  public_sample: number | null;
}

interface BatchBoxRow {
  id: number;
  image_id: number;
  class_id: number;
  class_name: string;
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
  confidence: number;
  prompt_version: string;
  model_id: string;
}

export const labellingBatchRoute = createRoute({
  method: "get",
  path: "/api/admin/labelling/batch",
  operationId: "labellingBatch",
  tags: ["admin"],
  summary: "The next N frames to verify, with their boxes and their URLs",
  description:
    "One call returns a session's next frames, the model's un-ruled boxes on each, and a " +
    "URL per frame — presigned against R2 when this deployment has an S3 credential, and " +
    "this Worker's own Access-gated proxy path when it does not (`url_mode` says which). " +
    "A frame is returned while any of its boxes has no admin verdict, and carries only " +
    "those boxes. Requires a Cloudflare Access assertion.",
  request: { query: LabellingBatchQuery },
  responses: {
    200: {
      description: "The next frames, their boxes and their URLs",
      content: { "application/json": { schema: LabellingBatch } },
    },
    400: errorResponse("A limit outside 1..100"),
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const labellingBatchHandler: RouteHandler<typeof labellingBatchRoute, AppEnv> = async (
  c,
) => {
  const { limit = LABELLING_BATCH_SIZE } = c.req.valid("query");

  // `ORDER BY i.id` — the order frames were extracted in, which for a sampled
  // timeline is chronological within a video and grouped by video across them.
  // Deliberately not random: an operator verifying consecutive frames of one
  // scene is reading context they already have, and a shuffled pool makes
  // every frame a cold start. The frozen evaluation pool is where randomness
  // is load-bearing (CONTEXT.md §Q16), and it is drawn by `selection_reason`,
  // not by this ordering.
  const [pageResult, remainingResult] = await c.env.DB.batch<BatchImageRow | { remaining: number }>(
    [
      c.env.DB.prepare(
        `SELECT i.id, i.video_id, i.r2_key, i.timestamp_seconds, i.public_sample
         FROM images i
        WHERE EXISTS (${UNRULED_BOX})
        ORDER BY i.id
        LIMIT ?`,
      ).bind(limit),
      c.env.DB.prepare(`SELECT COUNT(*) AS remaining FROM images i WHERE EXISTS (${UNRULED_BOX})`),
    ],
  );

  const images = (pageResult?.results ?? []) as BatchImageRow[];
  const remaining =
    ((remainingResult?.results ?? []) as { remaining: number }[])[0]?.remaining ?? 0;

  if (images.length === 0) {
    // Signed or not, an empty batch has nothing to sign — and `frameUrls`
    // would still have to be asked which mode it is in, which is a question
    // with no consequence when there is no URL to hold.
    const { mode, expiresAt } = await frameUrls(c.env, []);
    return c.json({ images: [], url_mode: mode, expires_at: expiresAt, remaining }, 200);
  }

  const imageIds = images.map((image) => image.id);

  // Chunked against D1's per-statement parameter ceiling: `limit` may be 100,
  // which is the ceiling exactly, and an `IN (...)` of 100 ids plus nothing
  // else fits only because there is nothing else to bind.
  const boxResults = await c.env.DB.batch<BatchBoxRow>(
    chunkForBinding(imageIds).map((ids) =>
      c.env.DB.prepare(
        `SELECT p.id, p.image_id, p.class_id, c.name AS class_name,
                p.x_min, p.y_min, p.x_max, p.y_max, p.confidence,
                p.prompt_version, p.model_id
           FROM predictions p
           JOIN classes c ON c.id = p.class_id
          WHERE p.image_id IN (${placeholders(ids)})
            AND NOT EXISTS (
                  SELECT 1 FROM verdicts v
                   WHERE v.prediction_id = p.id AND v.source = 'admin')
          ORDER BY p.id`,
      ).bind(...ids),
    ),
  );

  const boxesByImage = new Map<number, BatchBoxRow[]>();
  for (const result of boxResults) {
    for (const box of result.results) {
      boxesByImage.set(box.image_id, [...(boxesByImage.get(box.image_id) ?? []), box]);
    }
  }

  const { mode, expiresAt, byKey } = await frameUrls(
    c.env,
    images.map((image) => image.r2_key),
  );

  return c.json(
    {
      images: images.map((image) => ({
        id: image.id,
        video_id: image.video_id,
        r2_key: image.r2_key,
        timestamp_seconds: image.timestamp_seconds,
        // The `?? ""` is unreachable — every key in the batch was just signed
        // — and is here because a Map lookup is typed as possibly absent.
        url: byKey.get(image.r2_key) ?? "",
        predictions: (boxesByImage.get(image.id) ?? []).map(({ image_id: _, ...box }) => box),
        public_sample: image.public_sample === 1,
      })),
      url_mode: mode,
      expires_at: expiresAt,
      remaining,
    },
    200,
  );
};

/** One row of the per-class aggregate below. `active` is an INTEGER in D1. */
interface ClassStatsRow {
  class_id: number;
  name: string;
  active: number;
  predictions: number;
  accepted: number;
  adjusted: number;
  rejected: number;
  anon_accepted: number;
  anon_adjusted: number;
  anon_rejected: number;
}

export const labellingStatsRoute = createRoute({
  method: "get",
  path: "/api/admin/labelling/stats",
  operationId: "labellingStats",
  tags: ["admin"],
  summary: "Verdict counts, class coverage and pool size",
  description:
    "Business data about the labelling pool: how many frames carry predictions, how many " +
    "have been ruled on, and per class how many boxes were accepted, adjusted or " +
    "rejected and how many missing-object reports name it. The missing-report rate per " +
    "class is the number that says whether a prompt is good enough — its numerator is " +
    "here and its denominator is `pool.images_verified`. Requires a Cloudflare Access " +
    "assertion.",
  responses: {
    200: {
      description: "The pool and the per-class counts",
      content: { "application/json": { schema: LabellingStats } },
    },
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const labellingStatsHandler: RouteHandler<typeof labellingStatsRoute, AppEnv> = async (
  c,
) => {
  // One batch, four statements, and the per-class numbers come from a single
  // grouped pass rather than six correlated subqueries per class: the join
  // `classes -> predictions -> verdicts` is walked once and the verdict kinds
  // fall out as conditional counts.
  //
  // `missing_reports` cannot join into that pass — a class with three reports
  // and forty predictions would multiply into 120 rows and inflate every other
  // count in the row — so it is its own statement and merged below.
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS images_with_predictions,
              (SELECT COUNT(*) FROM missing_reports) AS missing_reports
         FROM images i
        WHERE EXISTS (SELECT 1 FROM predictions p WHERE p.image_id = i.id)`,
    ),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS images_remaining FROM images i WHERE EXISTS (${UNRULED_BOX})`,
    ),
    c.env.DB.prepare(
      // Every count is over `predictions.id`, never over `verdicts.id`. A
      // prediction may legally carry several verdicts (migration 0003 refuses
      // a uniqueness constraint on `prediction_id`, and an admin re-ruling on
      // a box is an ordinary thing to do), so counting verdict rows against a
      // `predictions` denominator would render "1 box, 2 accepted". These
      // columns answer "how many boxes were accepted", which means a box ruled
      // the same way twice counts once — and a box accepted and later rejected
      // counts in both columns, because both are true of it.
      `SELECT c.id AS class_id, c.name, c.active,
              COUNT(DISTINCT p.id) AS predictions,
              COUNT(DISTINCT CASE WHEN v.source = 'admin' AND v.verdict = 'accept'
                                  THEN p.id END) AS accepted,
              COUNT(DISTINCT CASE WHEN v.source = 'admin' AND v.verdict = 'adjust'
                                  THEN p.id END) AS adjusted,
              COUNT(DISTINCT CASE WHEN v.source = 'admin' AND v.verdict = 'reject'
                                  THEN p.id END) AS rejected,
              COUNT(DISTINCT CASE WHEN v.source = 'anon' AND v.verdict = 'accept'
                                  THEN p.id END) AS anon_accepted,
              COUNT(DISTINCT CASE WHEN v.source = 'anon' AND v.verdict = 'adjust'
                                  THEN p.id END) AS anon_adjusted,
              COUNT(DISTINCT CASE WHEN v.source = 'anon' AND v.verdict = 'reject'
                                  THEN p.id END) AS anon_rejected
         FROM classes c
         LEFT JOIN predictions p ON p.class_id = c.id
         LEFT JOIN verdicts v    ON v.prediction_id = p.id
        GROUP BY c.id
        ORDER BY c.name`,
    ),
    // Grouped by class rather than counted per class: a report with no class
    // (migration 0003 makes `class_id` nullable on purpose — "something is
    // missing here" for a character not in the roster) has no row to land on
    // here, and is counted in `pool.missing_reports` instead. A per-class sum
    // that equalled the pool total would mean those reports had been silently
    // attributed to some class.
    c.env.DB.prepare(
      `SELECT class_id, COUNT(*) AS missing_reports
         FROM missing_reports
        WHERE class_id IS NOT NULL
        GROUP BY class_id`,
    ),
  ]);

  // `D1Database.batch` types its result array by position only as far as its
  // length, so each statement's rows are cast where they are read — the same
  // one-liner four times rather than four differently-shaped guards.
  const rowsOf = <T>(index: number): T[] => (results[index]?.results ?? []) as T[];

  const pool = rowsOf<{ images_with_predictions: number; missing_reports: number }>(0)[0];
  const remaining = rowsOf<{ images_remaining: number }>(1)[0]?.images_remaining ?? 0;
  const withPredictions = pool?.images_with_predictions ?? 0;

  const missingByClass = new Map(
    rowsOf<{ class_id: number; missing_reports: number }>(3).map((row) => [
      row.class_id,
      row.missing_reports,
    ]),
  );

  const stats: LabellingStatsRow = {
    pool: {
      images_with_predictions: withPredictions,
      // Derived rather than counted separately, so the two can never disagree:
      // "verified" is defined as *not remaining*, which is the same predicate
      // the batch endpoint pages through.
      images_verified: withPredictions - remaining,
      images_remaining: remaining,
      missing_reports: pool?.missing_reports ?? 0,
    },
    classes: rowsOf<ClassStatsRow>(2).map((row) => ({
      class_id: row.class_id,
      name: row.name,
      active: row.active === 1,
      predictions: row.predictions,
      accepted: row.accepted,
      adjusted: row.adjusted,
      rejected: row.rejected,
      anon_accepted: row.anon_accepted,
      anon_adjusted: row.anon_adjusted,
      anon_rejected: row.anon_rejected,
      missing_reports: missingByClass.get(row.class_id) ?? 0,
    })),
  };

  return c.json(stats, 200);
};
