import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../bindings";
import { chunkForBinding, placeholders } from "../d1";
import { EvalSource, errorResponse } from "../schemas";

/**
 * `worker/cmd/eval`'s input (#177, M26.3), behind Access.
 *
 * See `EvalSource`'s own comment in `schemas.ts` for why this is a route of
 * its own rather than the existing `snapshotSourceRoute` widened: that
 * route's labels are verdict-derived (`WINNING_VERDICT`, `routes/jobs.ts`)
 * and it also feeds `worker/cmd/snapshot`'s training-dataset build, so
 * teaching it to refuse on incomplete eval annotation would block an
 * unrelated training rebuild on a labelling sitting that has nothing to do
 * with it. This route touches none of that: it reads `ground_truth`,
 * `ground_truth_exhaustive` and `predictions` directly, and
 * `snapshotSourceHandler` is unchanged by its existence.
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
  summary: "The frozen pool's ground truth and predictions, for the scorer",
  description:
    "Every image with `selection_reason = 'random'` (CONTEXT.md §Q16's frozen pool), " +
    "with its ground-truth boxes (migration 0014, model-independent) and the predictions " +
    "being measured against them, both restricted to active classes. Refuses with 409, " +
    "the whole call, if any active class is not marked exhaustively annotated on any pool " +
    "image — the plan's own requirement that an incomplete pool be refused outright rather " +
    "than silently scored on whatever happens to be marked yet. Requires a Cloudflare " +
    "Access assertion.",
  responses: {
    200: {
      description: "The eval pool's ground truth and predictions",
      content: { "application/json": { schema: EvalSource } },
    },
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    409: errorResponse(
      "At least one active class is not yet marked exhaustively annotated on at least one " +
        "pool image — named in the message, up to a limit",
    ),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

/** How many incomplete (image, class) pairs the 409 names before it just gives the count. */
const MAX_NAMED_GAPS = 20;

export const getEvalSourceHandler: RouteHandler<typeof getEvalSourceRoute, AppEnv> = async (c) => {
  const [classesResult, imagesResult] = await c.env.DB.batch<ActiveClassRow | EvalImageRow>([
    c.env.DB.prepare("SELECT id, name FROM classes WHERE active = 1 ORDER BY name"),
    c.env.DB.prepare("SELECT id FROM images WHERE selection_reason = 'random' ORDER BY id"),
  ]);

  const classes = (classesResult?.results ?? []) as ActiveClassRow[];
  const images = (imagesResult?.results ?? []) as EvalImageRow[];

  if (classes.length === 0 || images.length === 0) {
    return c.json({ images: [] }, 200);
  }

  const imageIds = images.map((image) => image.id);
  const classIds = classes.map((klass) => klass.id);

  // One reserved slot per active class — `MAX_ACTIVE_CLASSES` (schemas.ts)
  // bounds that at 30, so a chunk still carries most of its budget for
  // image ids even at the roster's ceiling.
  const exhaustiveResults = await c.env.DB.batch<ExhaustivePairRow>(
    chunkForBinding(imageIds, classIds.length).map((chunk) =>
      c.env.DB.prepare(
        `SELECT image_id, class_id FROM ground_truth_exhaustive
          WHERE image_id IN (${placeholders(chunk)}) AND class_id IN (${placeholders(classIds)})`,
      ).bind(...chunk, ...classIds),
    ),
  );

  const covered = new Set(
    exhaustiveResults.flatMap((result) =>
      result.results.map((row) => `${row.image_id}:${row.class_id}`),
    ),
  );

  const gaps: string[] = [];
  for (const imageId of imageIds) {
    for (const klass of classes) {
      if (!covered.has(`${imageId}:${klass.id}`)) {
        gaps.push(`image ${imageId} / class ${klass.name}`);
      }
    }
  }

  if (gaps.length > 0) {
    const named = gaps.slice(0, MAX_NAMED_GAPS).join(", ");
    const suffix =
      gaps.length > MAX_NAMED_GAPS ? ` (and ${gaps.length - MAX_NAMED_GAPS} more)` : "";
    return c.json({ error: `not exhaustively annotated: ${named}${suffix}` }, 409);
  }

  const [predictionResults, groundTruthResults] = await Promise.all([
    c.env.DB.batch<PredictionBoxRow>(
      chunkForBinding(imageIds, classIds.length).map((chunk) =>
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
      chunkForBinding(imageIds, classIds.length).map((chunk) =>
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
      images: imageIds.map((imageId) => ({
        image_id: imageId,
        predictions: (predictionsByImage.get(imageId) ?? []).map(({ image_id: _, ...box }) => box),
        ground_truth: (groundTruthByImage.get(imageId) ?? []).map(({ image_id: _, ...box }) => box),
      })),
    },
    200,
  );
};
