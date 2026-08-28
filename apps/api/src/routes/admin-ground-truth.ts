import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../bindings";
import { chunkForBinding, placeholders } from "../d1";
import { frameUrls } from "../frame-urls";
import {
  CreateGroundTruthBoxRequest,
  errorResponse,
  GroundTruthBox,
  GroundTruthBoxDeleted,
  GroundTruthExhaustive,
  GroundTruthIdParam,
  GroundTruthPool,
  GroundTruthPoolQuery,
  ImageAnnotation,
  ImageIdParam,
  SetGroundTruthExhaustiveRequest,
} from "../schemas";

/**
 * Model-independent labels for the frozen evaluation pool, behind Access
 * (M26, #175). Plan: docs/superpowers/plans/2026-08-28-eval-harness.md §A2.
 *
 * `ground_truth` (migration 0014) is not `predictions` plus a synthetic
 * verdict — that shape was considered and rejected in the migration's own
 * comment, because it would make `predictions.model_id` and `.confidence`
 * lies on rows no model produced. This file is the one place that writes
 * and reads it.
 *
 * **Deletable, unlike `verdicts`.** Every other admin write route in this
 * repo is explicit that nothing it does issues an UPDATE or a DELETE
 * (`admin-verdicts.ts`'s own module comment) — because a prediction and a
 * verdict on it are historical facts about what a model said and what a
 * human ruled, and rewriting either would rewrite history. A hand-drawn
 * ground-truth box is not that: it is one annotator's attempt to record
 * what is actually in a frame, and a mis-drawn box is a mistake to correct,
 * not a fact to preserve. `deleteGroundTruthBoxHandler` below is this
 * schema's one legitimate DELETE.
 */

const annotator = (c: { get: (key: "adminEmail") => string | undefined }) =>
  c.get("adminEmail") ?? "unknown";

/** The shape every query below joins `ground_truth` to `classes` as. */
interface GroundTruthRow {
  id: number;
  image_id: number;
  class_id: number;
  class_name: string;
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
  annotator_id: string;
  created_at: number;
}

export const createGroundTruthBoxRoute = createRoute({
  method: "post",
  path: "/api/admin/images/{id}/ground-truth",
  operationId: "createGroundTruthBox",
  tags: ["admin"],
  summary: "Draw a ground-truth box no model proposed",
  description:
    "The capability nothing else in the app has (#176): a box that exists because an " +
    "annotator looked at the frame, not because a prediction was there to rule on. " +
    "`annotator_id` is read off the Access assertion, never the body, matching every " +
    "other admin write in this repo. Requires a Cloudflare Access assertion.",
  request: {
    params: ImageIdParam,
    body: {
      content: { "application/json": { schema: CreateGroundTruthBoxRequest } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "The box as written",
      content: { "application/json": { schema: GroundTruthBox } },
    },
    400: errorResponse("A malformed body"),
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    404: errorResponse("No image with this id, or no class with the given class_id"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const createGroundTruthBoxHandler: RouteHandler<
  typeof createGroundTruthBoxRoute,
  AppEnv
> = async (c) => {
  const { id } = c.req.valid("param");
  const { class_id, x_min, y_min, x_max, y_max } = c.req.valid("json");

  const image = await c.env.DB.prepare("SELECT id FROM images WHERE id = ?")
    .bind(id)
    .first<{ id: number }>();
  if (!image) return c.json({ error: `no image with id ${id}` }, 404);

  // Checked rather than left to the foreign key, `createMissingReportHandler`'s
  // own reason: a class row is also what supplies `class_name` for the
  // response, so this read is not spent purely on validation.
  const klass = await c.env.DB.prepare("SELECT id, name FROM classes WHERE id = ?")
    .bind(class_id)
    .first<{ id: number; name: string }>();
  if (!klass) return c.json({ error: `no class with id ${class_id}` }, 404);

  const row = await c.env.DB.prepare(
    `INSERT INTO ground_truth (image_id, class_id, x_min, y_min, x_max, y_max, annotator_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id, image_id, class_id, x_min, y_min, x_max, y_max, annotator_id, created_at`,
  )
    .bind(id, class_id, x_min, y_min, x_max, y_max, annotator(c))
    .first<Omit<GroundTruthRow, "class_name">>();

  if (!row) return c.json({ error: "the box could not be recorded" }, 400);

  return c.json({ ...row, class_name: klass.name }, 201);
};

export const deleteGroundTruthBoxRoute = createRoute({
  method: "delete",
  path: "/api/admin/ground-truth/{id}",
  operationId: "deleteGroundTruthBox",
  tags: ["admin"],
  summary: "Undo a mis-drawn ground-truth box",
  description:
    "The one DELETE `ground_truth` permits — see this file's own module comment for why " +
    "a hand-drawn box is corrected by removal and redrawing rather than by an UPDATE this " +
    "schema does not have. Requires a Cloudflare Access assertion.",
  request: { params: GroundTruthIdParam },
  responses: {
    200: {
      description: "The deleted box's id",
      content: { "application/json": { schema: GroundTruthBoxDeleted } },
    },
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    404: errorResponse("No ground-truth box with this id"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const deleteGroundTruthBoxHandler: RouteHandler<
  typeof deleteGroundTruthBoxRoute,
  AppEnv
> = async (c) => {
  const { id } = c.req.valid("param");

  const deleted = await c.env.DB.prepare("DELETE FROM ground_truth WHERE id = ? RETURNING id")
    .bind(id)
    .first<{ id: number }>();

  if (!deleted) return c.json({ error: `no ground-truth box with id ${id}` }, 404);

  return c.json({ id: deleted.id }, 200);
};

export const setGroundTruthExhaustiveRoute = createRoute({
  method: "patch",
  path: "/api/admin/images/{id}/ground-truth/exhaustive",
  operationId: "setGroundTruthExhaustive",
  tags: ["admin"],
  summary: "Record that every instance of one class has been found on this image, or retract it",
  description:
    "The fact migration 0014's `ground_truth_exhaustive` exists to hold: zero ground-truth " +
    "boxes for (image, class) is ambiguous on its own — nobody has looked, or somebody " +
    "looked and there is genuinely nothing there — and the scorer (#177) refuses to run " +
    "on a pair this endpoint has not marked. `exhaustive: true` upserts the fact with the " +
    "caller's identity and the current time; `exhaustive: false` retracts it, for an " +
    "annotator revisiting a frame who realises the earlier pass was not actually complete. " +
    "Requires a Cloudflare Access assertion.",
  request: {
    params: ImageIdParam,
    body: {
      content: { "application/json": { schema: SetGroundTruthExhaustiveRequest } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "The (image, class) pair's exhaustiveness state as it now stands",
      content: { "application/json": { schema: GroundTruthExhaustive } },
    },
    400: errorResponse("A malformed body"),
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    404: errorResponse("No image with this id, or no class with the given class_id"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const setGroundTruthExhaustiveHandler: RouteHandler<
  typeof setGroundTruthExhaustiveRoute,
  AppEnv
> = async (c) => {
  const { id } = c.req.valid("param");
  const { class_id, exhaustive } = c.req.valid("json");

  const image = await c.env.DB.prepare("SELECT id FROM images WHERE id = ?")
    .bind(id)
    .first<{ id: number }>();
  if (!image) return c.json({ error: `no image with id ${id}` }, 404);

  const klass = await c.env.DB.prepare("SELECT id FROM classes WHERE id = ?")
    .bind(class_id)
    .first<{ id: number }>();
  if (!klass) return c.json({ error: `no class with id ${class_id}` }, 404);

  if (exhaustive) {
    // Upserts on the composite key migration 0014 gives this table, rather
    // than appending: the pair *is* the fact, and re-marking it is a
    // re-affirmation (a later annotator confirming an earlier pass, or the
    // same annotator after adding a box the first look missed), not a
    // second row for the scorer to reconcile against the first.
    await c.env.DB.prepare(
      `INSERT INTO ground_truth_exhaustive (image_id, class_id, annotator_id)
            VALUES (?, ?, ?)
       ON CONFLICT (image_id, class_id)
       DO UPDATE SET annotator_id = excluded.annotator_id, created_at = strftime('%s', 'now')`,
    )
      .bind(id, class_id, annotator(c))
      .run();
  } else {
    await c.env.DB.prepare(
      "DELETE FROM ground_truth_exhaustive WHERE image_id = ? AND class_id = ?",
    )
      .bind(id, class_id)
      .run();
  }

  return c.json({ image_id: id, class_id, exhaustive }, 200);
};

/** The shape `getImageAnnotationHandler` reads predictions back as — `BatchBoxRow`'s own fields, without the unruled filter. */
interface AnnotationPredictionRow {
  id: number;
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

interface ActiveClassRow {
  class_id: number;
  name: string;
  exhaustive: number;
}

export const getImageAnnotationRoute = createRoute({
  method: "get",
  path: "/api/admin/images/{id}/ground-truth",
  operationId: "getImageAnnotation",
  tags: ["admin"],
  summary: "One frame's predictions and ground truth together — the annotation surface's read path",
  description:
    "What #176's drawing surface needs for one image: every prediction the detector made " +
    "on it (so an annotator sees what was already found and does not redraw it by hand), " +
    "every ground-truth box already drawn, and whether each active class is marked " +
    "exhaustively annotated on this frame. Unlike `labellingBatch`, predictions here are " +
    "not filtered to unruled ones — this screen is not a verification queue, and an " +
    "annotator comparing against the detector's output needs to see all of it. Requires a " +
    "Cloudflare Access assertion.",
  request: { params: ImageIdParam },
  responses: {
    200: {
      description: "The frame, its predictions, its ground truth and its exhaustiveness state",
      content: { "application/json": { schema: ImageAnnotation } },
    },
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    404: errorResponse("No image with this id"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const getImageAnnotationHandler: RouteHandler<
  typeof getImageAnnotationRoute,
  AppEnv
> = async (c) => {
  const { id } = c.req.valid("param");

  const image = await c.env.DB.prepare(
    "SELECT id, video_id, r2_key, timestamp_seconds FROM images WHERE id = ?",
  )
    .bind(id)
    .first<{ id: number; video_id: string; r2_key: string; timestamp_seconds: number }>();
  if (!image) return c.json({ error: `no image with id ${id}` }, 404);

  const [predictions, groundTruth, classes] = await c.env.DB.batch<
    AnnotationPredictionRow | GroundTruthRow | ActiveClassRow
  >([
    c.env.DB.prepare(
      `SELECT p.id, p.class_id, c.name AS class_name,
              p.x_min, p.y_min, p.x_max, p.y_max, p.confidence,
              p.prompt_version, p.model_id
         FROM predictions p
         JOIN classes c ON c.id = p.class_id
        WHERE p.image_id = ?
        ORDER BY p.id`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT g.id, g.image_id, g.class_id, c.name AS class_name,
              g.x_min, g.y_min, g.x_max, g.y_max, g.annotator_id, g.created_at
         FROM ground_truth g
         JOIN classes c ON c.id = g.class_id
        WHERE g.image_id = ?
        ORDER BY g.id`,
    ).bind(id),
    // Every active class, LEFT JOINed to this one image's exhaustiveness
    // row — an active class with no `ground_truth_exhaustive` row for this
    // image comes back `exhaustive = 0`, the honest "nobody has looked yet"
    // migration 0014's own comment describes.
    c.env.DB.prepare(
      `SELECT c.id AS class_id, c.name,
              CASE WHEN ge.image_id IS NULL THEN 0 ELSE 1 END AS exhaustive
         FROM classes c
         LEFT JOIN ground_truth_exhaustive ge ON ge.image_id = ? AND ge.class_id = c.id
        WHERE c.active = 1
        ORDER BY c.name`,
    ).bind(id),
  ]);

  const { byKey } = await frameUrls(c.env, [image.r2_key]);

  return c.json(
    {
      image_id: image.id,
      video_id: image.video_id,
      r2_key: image.r2_key,
      timestamp_seconds: image.timestamp_seconds,
      url: byKey.get(image.r2_key) ?? "",
      predictions: (predictions?.results ?? []) as AnnotationPredictionRow[],
      ground_truth: (groundTruth?.results ?? []) as GroundTruthRow[],
      classes: ((classes?.results ?? []) as ActiveClassRow[]).map((row) => ({
        class_id: row.class_id,
        name: row.name,
        exhaustive: row.exhaustive === 1,
      })),
    },
    200,
  );
};

interface PoolImageRow {
  id: number;
  video_id: string;
  r2_key: string;
  timestamp_seconds: number;
}

export const listGroundTruthPoolRoute = createRoute({
  method: "get",
  path: "/api/admin/ground-truth/pool",
  operationId: "listGroundTruthPool",
  tags: ["admin"],
  summary: "The frozen evaluation pool, as an annotation worklist",
  description:
    "Every image with `selection_reason = 'random'` (CONTEXT.md §Q16's frozen pool), " +
    "paged, with a ground-truth box count and each active class's exhaustiveness state — " +
    "enough for #176's surface to render a worklist without a second request per row. " +
    "Includes images already marked exhaustive for every active class, not only the ones " +
    "still outstanding: an annotator revisiting a finished frame needs the same list a " +
    "first pass does. Requires a Cloudflare Access assertion.",
  request: { query: GroundTruthPoolQuery },
  responses: {
    200: {
      description: "One page of the frozen pool and the total it was drawn from",
      content: { "application/json": { schema: GroundTruthPool } },
    },
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const listGroundTruthPoolHandler: RouteHandler<
  typeof listGroundTruthPoolRoute,
  AppEnv
> = async (c) => {
  const { limit, offset } = c.req.valid("query");

  // Page and total over the identical predicate, `listVerdictsHandler`'s own
  // idiom: D1 has no cheap "count regardless of LIMIT" primitive short of a
  // second pass.
  const [pageResult, countResult] = await c.env.DB.batch<PoolImageRow | { total: number }>([
    c.env.DB.prepare(
      `SELECT id, video_id, r2_key, timestamp_seconds
         FROM images
        WHERE selection_reason = 'random'
        ORDER BY id
        LIMIT ? OFFSET ?`,
    ).bind(limit ?? 50, offset ?? 0),
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM images WHERE selection_reason = 'random'`),
  ]);

  const images = (pageResult?.results ?? []) as PoolImageRow[];
  const total = ((countResult?.results ?? []) as { total: number }[])[0]?.total ?? 0;

  if (images.length === 0) {
    return c.json({ images: [], total }, 200);
  }

  const ids = images.map((image) => image.id);

  // Chunked against D1's 100-bound-parameter ceiling, matching
  // `labellingBatchHandler` — `limit`'s own ceiling is `PAGE_LIMIT_MAX`
  // (200), past the ceiling on its own once a page carries nothing else
  // bound alongside it.
  const [countRows, classRows] = await Promise.all([
    c.env.DB.batch<{ image_id: number; ground_truth_count: number }>(
      chunkForBinding(ids).map((chunk) =>
        c.env.DB.prepare(
          `SELECT image_id, COUNT(*) AS ground_truth_count
             FROM ground_truth
            WHERE image_id IN (${placeholders(chunk)})
            GROUP BY image_id`,
        ).bind(...chunk),
      ),
    ),
    c.env.DB.batch<ActiveClassRow & { image_id: number }>(
      chunkForBinding(ids).map((chunk) =>
        c.env.DB.prepare(
          `SELECT i.id AS image_id, c.id AS class_id, c.name,
                  CASE WHEN ge.image_id IS NULL THEN 0 ELSE 1 END AS exhaustive
             FROM images i
             JOIN classes c ON c.active = 1
             LEFT JOIN ground_truth_exhaustive ge
               ON ge.image_id = i.id AND ge.class_id = c.id
            WHERE i.id IN (${placeholders(chunk)})
            ORDER BY i.id, c.name`,
        ).bind(...chunk),
      ),
    ),
  ]);

  const countByImage = new Map(
    countRows.flatMap((result) =>
      result.results.map((row) => [row.image_id, row.ground_truth_count]),
    ),
  );

  const classesByImage = new Map<
    number,
    Array<{ class_id: number; name: string; exhaustive: boolean }>
  >();
  for (const result of classRows) {
    for (const row of result.results) {
      const entry = { class_id: row.class_id, name: row.name, exhaustive: row.exhaustive === 1 };
      classesByImage.set(row.image_id, [...(classesByImage.get(row.image_id) ?? []), entry]);
    }
  }

  return c.json(
    {
      images: images.map((image) => ({
        id: image.id,
        video_id: image.video_id,
        r2_key: image.r2_key,
        timestamp_seconds: image.timestamp_seconds,
        ground_truth_count: countByImage.get(image.id) ?? 0,
        classes: classesByImage.get(image.id) ?? [],
      })),
      total,
    },
    200,
  );
};
