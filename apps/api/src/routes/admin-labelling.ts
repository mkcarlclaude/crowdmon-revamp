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

/**
 * Any box on this image that the admin tier has not ruled on.
 *
 * Stays `source = 'admin'` even after M20 gave contributors their own verdict
 * source (plan §C3) — deliberately, and asymmetric with `CONTRIBUTOR_UNRULED_BOX`
 * (`routes/contribute.ts`) on purpose. A contributor's ruling, trusted or not,
 * must never remove a box from *this* pool: the admin is the tier that
 * overrides everyone else's verdict (`WINNING_VERDICT`, `routes/jobs.ts`), so
 * the admin must be able to see and re-rule anything, including a box a
 * trusted user already ruled on. `CONTRIBUTOR_UNRULED_BOX` is not this
 * predicate reused — it additionally excludes a box a trusted user has ruled
 * on, so contributors are not routinely handed each other's already-settled
 * work — and that asymmetry is the kind of thing that reads as a bug in six
 * months. It is documented at both definitions for exactly that reason.
 *
 * No longer read by either query below (M25.1, plan §B1) — `images.unruled_admin`
 * is the same fact, denormalised onto the row so it can be indexed. Exported
 * and kept, rather than deleted now that nothing here evaluates it, because it
 * is still the *definition* the counter has to agree with: the plan's own §B2
 * reconciliation query is this predicate, recomputed and compared against the
 * column it now stands in for, and a test built any other way could drift
 * from what "unruled" actually means without ever being told.
 */
export const UNRULED_BOX = `
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
  shuffle_key: number;
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
    "those boxes. Frames come back shuffled by a per-image random key, not extraction " +
    "order (M25.1); pass `cursor` back as `next_cursor` came from the previous call to " +
    "keep advancing through the pool instead of re-fetching its start, and omit it to " +
    "start over. The pool wraps rather than running dry once a session's cursor passes " +
    "every key still in it. Requires a Cloudflare Access assertion.",
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

/**
 * The admin pool's forward page query, exported so `labelling-batch.test.ts`
 * can run `EXPLAIN QUERY PLAN` against the exact statement production
 * issues, not a hand-copied stand-in that could quietly drift from it. Plan
 * §B1 names why that drift matters here specifically: a query that stops
 * matching `idx_images_admin_pool`'s predicate reads identically from the
 * response, so the one place a regression would actually show up is a plan
 * assertion against this precise text.
 *
 * `hasCursor` selects the same two shapes `labellingBatchHandler` builds —
 * bounded below by the caller's cursor, or not, when there isn't one yet —
 * rather than always binding a placeholder for it: a query with an unused
 * `?` is a different statement to the planner than one without, and the
 * un-cursored shape is what a session's first call actually runs.
 */
export function adminPoolPageQuery(hasCursor: boolean): string {
  return `SELECT i.id, i.video_id, i.r2_key, i.timestamp_seconds, i.public_sample, i.shuffle_key
       FROM images i
      WHERE unruled_admin > 0
      ${hasCursor ? "AND shuffle_key > ?" : ""}
      ORDER BY shuffle_key
      LIMIT ?`;
}

export const labellingBatchHandler: RouteHandler<typeof labellingBatchRoute, AppEnv> = async (
  c,
) => {
  const { limit = LABELLING_BATCH_SIZE, cursor } = c.req.valid("query");

  // Shuffled, by `shuffle_key` (M25.1, plan §A) — not extraction order. The
  // sequential order this replaced was deliberate once: an operator verifying
  // consecutive frames of one scene is reading context they already have, and
  // a shuffled pool makes every frame a cold start. That argument is still
  // real and is overridden anyway, because the operator asked for the
  // opposite once M25's `diverse` frames started entering this same pool
  // alongside `random` ones — a varied cross-section per session is worth
  // more than scene context now. Safe to change at all only because ordering
  // has never been where randomness is load-bearing: the train/eval split is
  // fixed at *selection* time by `selection_reason` (CONTEXT.md §Q16), so no
  // labelling order, sequential or shuffled, can move a frame across it.
  //
  // `unruled_admin > 0` is `EXISTS (${UNRULED_BOX})`, denormalised (plan §B1)
  // — the join `UNRULED_BOX` reads is invisible to any index on `images`
  // alone, and this column is what makes both queries below index walks
  // instead of the two full scans of `images` this endpoint used to cost.
  //
  // `cursor` is the caller's last-seen `shuffle_key`, absent on a session's
  // first call. Forward progress is `shuffle_key > cursor`; nothing bounds it
  // from below when there is no cursor yet, so the first call is free to
  // start anywhere in the key space the query planner likes.
  const forwardBindings = cursor !== undefined ? [cursor] : [];

  const [pageResult, remainingResult] = await c.env.DB.batch<BatchImageRow | { remaining: number }>(
    [
      c.env.DB.prepare(adminPoolPageQuery(cursor !== undefined)).bind(...forwardBindings, limit),
      c.env.DB.prepare(`SELECT COUNT(*) AS remaining FROM images WHERE unruled_admin > 0`),
    ],
  );

  let images = (pageResult?.results ?? []) as BatchImageRow[];
  const remaining =
    ((remainingResult?.results ?? []) as { remaining: number }[])[0]?.remaining ?? 0;

  // Wrapping (plan §A3), not an edge case deferred: a session that has ruled
  // its way to the top of the key space gets a short page here — fewer rows
  // than `limit`, sometimes zero — with `remaining` above still positive,
  // because nothing is left with a shuffle_key *greater* than the cursor.
  // Refusing to wrap would mean the session simply stops with frames still
  // waiting on the other side of where it started.
  //
  // The wrap query is bounded by the *same* cursor value, the other
  // direction: `shuffle_key > cursor` above and `shuffle_key <= cursor` here
  // partition the whole key space at exactly one point, so the two queries
  // can never both return the same row — no de-duplication needed regardless
  // of how small the pool has shrunk to. Only fired when there was a cursor
  // to bound it by: a first call with none already saw the entire pool in
  // the query above, and has nothing left to wrap into.
  if (cursor !== undefined && images.length < limit) {
    const wrapResult = await c.env.DB.prepare(
      `SELECT i.id, i.video_id, i.r2_key, i.timestamp_seconds, i.public_sample, i.shuffle_key
         FROM images i
        WHERE unruled_admin > 0
          AND shuffle_key <= ?
        ORDER BY shuffle_key
        LIMIT ?`,
    )
      .bind(cursor, limit - images.length)
      .all<BatchImageRow>();
    images = [...images, ...(wrapResult.results ?? [])];
  }

  // Whatever this call actually returned, last — whether that is the forward
  // page alone or a forward page topped up by a wrap. A session that never
  // wraps advances monotonically; one that does is deliberately handed a
  // *smaller* cursor than it started with, because that is the position a
  // wrapped lap actually ended at, and the next call has to resume from
  // there, not from where this one began.
  const nextCursor = images.length > 0 ? (images[images.length - 1]?.shuffle_key ?? null) : null;

  if (images.length === 0) {
    // Signed or not, an empty batch has nothing to sign — and `frameUrls`
    // would still have to be asked which mode it is in, which is a question
    // with no consequence when there is no URL to hold.
    const { mode, expiresAt } = await frameUrls(c.env, []);
    return c.json(
      { images: [], url_mode: mode, expires_at: expiresAt, remaining, next_cursor: nextCursor },
      200,
    );
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
      next_cursor: nextCursor,
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
    // `unruled_admin > 0`, not `EXISTS (${UNRULED_BOX})` (M25.1, plan §B1):
    // this is the second of the four full-scan sites the plan's own
    // "finding" names — reached on every stats poll rather than every batch
    // request, but the same `idx_images_admin_pool` partial index answers it
    // in one, since the index holds exactly the rows this predicate would
    // otherwise have to visit all 19,352 to find.
    c.env.DB.prepare(`SELECT COUNT(*) AS images_remaining FROM images WHERE unruled_admin > 0`),
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
