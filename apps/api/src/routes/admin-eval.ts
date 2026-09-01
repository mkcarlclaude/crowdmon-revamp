import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../bindings";
import { chunkForBinding, placeholders } from "../d1";
import { EvalSource, errorResponse } from "../schemas";

/**
 * `worker/cmd/eval`'s input (#177, M26.3), behind Access.
 *
 * See `EvalSource`'s own comment in `schemas.ts` for why this is a route of
 * its own rather than the existing `snapshotSourceRoute` widened: that
 * route's *train*-split labels are still verdict-derived (`WINNING_VERDICT`,
 * `routes/jobs.ts`), so teaching this route to refuse on incomplete eval
 * annotation would block an unrelated training rebuild on a labelling
 * sitting that has nothing to do with it — `snapshotSourceHandler`'s own
 * comment on its eval half restates the same reasoning for why *it* adds no
 * refusal either. What the two routes now share, as of M26.7 plan §B, is
 * `resolveScoredEvalPool` below: the same "exhaustive for every active
 * class" computation, because a second implementation of that predicate is
 * a second thing to keep true. They still differ in what they do with an
 * empty result — this route's whole reason to keep existing is the 409
 * below, which `snapshotSourceHandler` deliberately does not have — and in
 * everything downstream of the pool: this route also reads `predictions` to
 * hand the scorer both sides of the comparison, which the snapshot route has
 * no reason to do.
 *
 * **The gate is per image, not all-or-nothing across the pool.** The
 * original shape refused the entire call unless every frozen-pool image
 * (`selection_reason = 'random'`) was marked exhaustive for every active
 * class. Read against production, that pool is 2,298 images — the plan's
 * "95 images, one class, tractable in a single sitting" was the count of
 * *labelled* images, not the pool itself — so the all-or-nothing gate could
 * never be satisfied by the sitting the plan actually budgeted. Narrowing
 * the pool to the 95 (or to the 1,025 the detector proposed something on)
 * is not an option either: an image with no prediction on it is exactly
 * where a missed instance lives, and scoring only where a prediction
 * already exists reconstructs the inverted metric this milestone exists to
 * fix, one layer down. So `images` below is whatever *has* been marked
 * exhaustive, not the whole pool — see `EvalSource`'s own comment for the
 * numbers and the full reasoning.
 */

interface ActiveClassRow {
  id: number;
  name: string;
}

interface EvalImageRow {
  id: number;
}

/** One row of the exhaustiveness check below — just enough to build the covered-pairs set. */
interface ExhaustivePairRow {
  image_id: number;
  class_id: number;
}

interface BoxRow {
  image_id: number;
  class_name: string;
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
}

interface PredictionBoxRow extends BoxRow {
  confidence: number;
}

export const getEvalSourceRoute = createRoute({
  method: "get",
  path: "/api/admin/eval-source",
  operationId: "getEvalSource",
  tags: ["admin"],
  summary: "The scored set's ground truth and predictions, for the scorer",
  description:
    "Every frozen-pool image (`selection_reason = 'random'`, CONTEXT.md §Q16) that is " +
    "marked exhaustively annotated for every active class, with its ground-truth boxes " +
    "(migration 0014, model-independent) and the predictions being measured against them. " +
    "An image not yet marked for every active class is omitted, not scored as empty — it " +
    "is not yet part of the instrument. Refuses with 409 only when no pool image is marked " +
    "exhaustive for any active class yet, i.e. there is nothing to score at all. Requires " +
    "a Cloudflare Access assertion.",
  responses: {
    200: {
      description: "The scored set's ground truth and predictions",
      content: { "application/json": { schema: EvalSource } },
    },
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    409: errorResponse("No pool image is marked exhaustively annotated for any active class yet"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

/** What `resolveScoredEvalPool` hands both its callers. */
export interface ScoredEvalPool {
  /**
   * The active-class roster exhaustiveness was computed against. Empty
   * means no roster at all — a different situation from a roster existing
   * with nothing scored yet, and a caller checking `classIds.length` can
   * tell the two apart (see `resolveScoredEvalPool`'s own comment).
   */
  classIds: number[];
  /** The frozen-pool (`selection_reason = 'random'`) image ids marked exhaustive for every one of `classIds`. */
  scoredImageIds: number[];
}

/**
 * The computation this route's own module comment describes as shared with
 * `snapshotSourceHandler` (`routes/jobs.ts`, M26.7 plan §B): which
 * frozen-pool images are exhaustively annotated for every active class.
 * Pulled out of `getEvalSourceHandler` rather than left inline once a second
 * caller needed the identical answer — "exhaustive for every active class"
 * is exactly the kind of predicate this repo's own memory
 * (`d1-bound-param-limit`) warns is easy to get right once and wrong the
 * second time it is retyped, so there is now exactly one implementation.
 *
 * Callers differ only in what an empty `scoredImageIds` means to them:
 * `getEvalSourceHandler` refuses with 409 (this file's own module comment
 * explains why that refusal is scoped to this route); `snapshotSourceHandler`
 * treats it as a correct answer for a deployment mid-annotation and adds no
 * refusal of its own.
 */
export async function resolveScoredEvalPool(db: D1Database): Promise<ScoredEvalPool> {
  const [classesResult, imagesResult] = await db.batch<ActiveClassRow | EvalImageRow>([
    db.prepare("SELECT id, name FROM classes WHERE active = 1 ORDER BY name"),
    db.prepare("SELECT id FROM images WHERE selection_reason = 'random' ORDER BY id"),
  ]);

  const classes = (classesResult?.results ?? []) as ActiveClassRow[];
  const images = (imagesResult?.results ?? []) as EvalImageRow[];

  // No roster at all: a different precondition from "nobody has finished
  // annotating anything yet" — there is no (image, class) pair to be
  // incomplete, so there is nothing to refuse either, and — just as
  // important — nothing to vacuously satisfy. `classIds.every(...)` below
  // is true for every image when `classIds` is empty, so returning early
  // here is what stops an empty roster from reading as "every image is
  // fully annotated."
  if (classes.length === 0) {
    return { classIds: [], scoredImageIds: [] };
  }

  const imageIds = images.map((image) => image.id);
  const classIds = classes.map((klass) => klass.id);

  // Empty when the pool itself is empty — `chunkForBinding` over zero ids
  // produces zero chunks, so this skips straight to an empty `covered` set
  // rather than issuing a query with nothing to bind.
  let covered = new Set<string>();
  if (imageIds.length > 0) {
    // One reserved slot per active class — `MAX_ACTIVE_CLASSES` (schemas.ts)
    // bounds that at 30, so a chunk still carries most of its budget for
    // image ids even at the roster's ceiling.
    const exhaustiveResults = await db.batch<ExhaustivePairRow>(
      chunkForBinding(imageIds, classIds.length).map((chunk) =>
        db
          .prepare(
            `SELECT image_id, class_id FROM ground_truth_exhaustive
            WHERE image_id IN (${placeholders(chunk)}) AND class_id IN (${placeholders(classIds)})`,
          )
          .bind(...chunk, ...classIds),
      ),
    );
    covered = new Set(
      exhaustiveResults.flatMap((result) =>
        result.results.map((row) => `${row.image_id}:${row.class_id}`),
      ),
    );
  }

  // The scored set (this route's own module comment, and `EvalSource`'s in
  // schemas.ts): an image is in it once every active class is marked
  // exhaustive on it, and stays out — not refused, not scored as empty,
  // simply not yet part of the instrument — until then.
  const scoredImageIds = imageIds.filter((imageId) =>
    classIds.every((classId) => covered.has(`${imageId}:${classId}`)),
  );

  return { classIds, scoredImageIds };
}

export const getEvalSourceHandler: RouteHandler<typeof getEvalSourceRoute, AppEnv> = async (c) => {
  const { classIds, scoredImageIds } = await resolveScoredEvalPool(c.env.DB);

  // No roster at all — see `resolveScoredEvalPool`'s own comment.
  if (classIds.length === 0) {
    return c.json({ images: [] }, 200);
  }

  // The one refusal this route still makes: nothing marked at all means
  // there is genuinely nothing to score, which is a different situation
  // from a partially-annotated pool returning a smaller-than-hoped-for set.
  if (scoredImageIds.length === 0) {
    return c.json(
      { error: "no pool image is marked exhaustively annotated for any active class yet" },
      409,
    );
  }

  const [predictionResults, groundTruthResults] = await Promise.all([
    c.env.DB.batch<PredictionBoxRow>(
      chunkForBinding(scoredImageIds, classIds.length).map((chunk) =>
        c.env.DB.prepare(
          `SELECT p.image_id, c.name AS class_name, p.x_min, p.y_min, p.x_max, p.y_max, p.confidence
             FROM predictions p
             JOIN classes c ON c.id = p.class_id
            WHERE p.image_id IN (${placeholders(chunk)}) AND p.class_id IN (${placeholders(classIds)})
            ORDER BY p.id`,
        ).bind(...chunk, ...classIds),
      ),
    ),
    c.env.DB.batch<BoxRow>(
      chunkForBinding(scoredImageIds, classIds.length).map((chunk) =>
        c.env.DB.prepare(
          `SELECT g.image_id, c.name AS class_name, g.x_min, g.y_min, g.x_max, g.y_max
             FROM ground_truth g
             JOIN classes c ON c.id = g.class_id
            WHERE g.image_id IN (${placeholders(chunk)}) AND g.class_id IN (${placeholders(classIds)})
            ORDER BY g.id`,
        ).bind(...chunk, ...classIds),
      ),
    ),
  ]);

  const predictionsByImage = new Map<number, PredictionBoxRow[]>();
  for (const result of predictionResults) {
    for (const row of result.results) {
      predictionsByImage.set(row.image_id, [...(predictionsByImage.get(row.image_id) ?? []), row]);
    }
  }

  const groundTruthByImage = new Map<number, BoxRow[]>();
  for (const result of groundTruthResults) {
    for (const row of result.results) {
      groundTruthByImage.set(row.image_id, [...(groundTruthByImage.get(row.image_id) ?? []), row]);
    }
  }

  return c.json(
    {
      images: scoredImageIds.map((imageId) => ({
        image_id: imageId,
        predictions: (predictionsByImage.get(imageId) ?? []).map(({ image_id: _, ...box }) => box),
        ground_truth: (groundTruthByImage.get(imageId) ?? []).map(({ image_id: _, ...box }) => box),
      })),
    },
    200,
  );
};
