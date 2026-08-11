import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../bindings";
import {
  ADMIN_PAGE_LIMIT_DEFAULT,
  AdminVideoIdParam,
  AdminVideoImages,
  AdminVideoImagesQuery,
  errorResponse,
} from "../schemas";

/**
 * The browsable frame grid `/admin/videos/:id` reads (M16, ROADMAP M16.5).
 *
 * A new route, not a reuse of `listVideoImagesHandler`
 * (`apps/api/src/routes/jobs.ts`). That route answers a different question —
 * "what can `ImageSampler` draw from" — and proves it by requiring a
 * `worker_id` holding a claimed `prelabel` or `dryrun` lease
 * (`idx_jobs_one_prelabel_per_video`, migration 0005). A browser holds no
 * such lease and never will; gating this route the same way would mean an
 * admin can only browse a video's frames while a worker happens to be
 * mid-job on it, which is not a real constraint this screen should have. The
 * two routes share a table, not a trust boundary — this one sits under
 * `/api/admin/*` and is gated by `requireAccess` like every other admin read.
 *
 * `verdict_state` exists because a prediction count alone cannot tell "the
 * detector found nothing here" apart from "the detector found three boxes and
 * nobody has looked at them yet" — the first needs no operator attention, the
 * second is exactly what `LabellingSession` exists to work through, and a
 * grid that could not tell them apart would be a worse version of the pool
 * count `labellingStatsHandler` already reports in aggregate.
 */

/**
 * `unruled` only means something once there is at least one prediction to
 * rule on — a frame with none is not "unverified", it is a frame the
 * detector had nothing to say about. A named function rather than the
 * ternary inline: `Array.prototype.map`'s callback return does not get
 * contextually typed against `c.json`'s schema, so an inline ternary widens
 * to `string` and fails against the generated `verdict_state` union; a
 * function with its return type spelled out here narrows it explicitly
 * instead.
 */
function verdictState(
  predictions: number,
  unruled: number,
): "no_predictions" | "unverified" | "verified" {
  if (predictions === 0) return "no_predictions";
  return unruled > 0 ? "unverified" : "verified";
}

/** The shape D1 returns for the join in `listAdminVideoImages`. */
interface AdminVideoImageRow {
  id: number;
  r2_key: string;
  timestamp_seconds: number;
  public_sample: number | null;
  predictions: number;
  unruled: number;
}

export const listAdminVideoImagesRoute = createRoute({
  method: "get",
  path: "/api/admin/videos/{id}/images",
  operationId: "listAdminVideoImages",
  tags: ["admin"],
  summary: "One video's frames, with prediction counts and verdict state",
  description:
    "Every `images` row for this video, oldest timestamp first, with how many predictions " +
    "each carries and whether an admin has ruled on all of them. Unlike `listVideoImages` " +
    "(`/api/videos/{video_id}/images`), this route needs no worker lease — it is a browser " +
    "read behind Cloudflare Access, not a sampler's candidate pool. No 404 for a video id " +
    "that does not exist: an empty page is the honest answer, the same choice " +
    "`listDryRuns` makes for an unknown class. Requires a Cloudflare Access assertion.",
  request: { params: AdminVideoIdParam, query: AdminVideoImagesQuery },
  responses: {
    200: {
      description: "This video's frame count and one page of its frames",
      content: { "application/json": { schema: AdminVideoImages } },
    },
    400: errorResponse("An out-of-range limit or offset"),
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const listAdminVideoImagesHandler: RouteHandler<
  typeof listAdminVideoImagesRoute,
  AppEnv
> = async (c) => {
  const { id } = c.req.valid("param");
  const { limit, offset } = c.req.valid("query");

  // Two statements in one batch rather than a single query with a window
  // function: D1 is SQLite, which has no cheap "total rows regardless of
  // LIMIT" primitive short of a second pass over the same predicate, so this
  // just runs that second pass explicitly instead of pretending one query
  // could do it.
  const [totalResult, pageResult] = await c.env.DB.batch<{ total: number } | AdminVideoImageRow>([
    c.env.DB.prepare("SELECT COUNT(*) AS total FROM images WHERE video_id = ?").bind(id),
    c.env.DB.prepare(
      `SELECT i.id, i.r2_key, i.timestamp_seconds, i.public_sample,
              (SELECT COUNT(*) FROM predictions p WHERE p.image_id = i.id) AS predictions,
              (SELECT COUNT(*) FROM predictions p
                 WHERE p.image_id = i.id
                   AND NOT EXISTS (
                         SELECT 1 FROM verdicts v
                          WHERE v.prediction_id = p.id AND v.source = 'admin')
              ) AS unruled
         FROM images i
        WHERE i.video_id = ?
        ORDER BY i.timestamp_seconds
        LIMIT ? OFFSET ?`,
    ).bind(id, limit ?? ADMIN_PAGE_LIMIT_DEFAULT, offset ?? 0),
  ]);

  const total = (totalResult?.results[0] as { total: number } | undefined)?.total ?? 0;
  const page = (pageResult?.results ?? []) as AdminVideoImageRow[];

  return c.json(
    {
      video_id: id,
      total,
      images: page.map((row) => ({
        id: row.id,
        r2_key: row.r2_key,
        timestamp_seconds: row.timestamp_seconds,
        public_sample: row.public_sample === 1,
        predictions: row.predictions,
        verdict_state: verdictState(row.predictions, row.unruled),
      })),
    },
    200,
  );
};
