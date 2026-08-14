import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../bindings";
import {
  AdminVideoList,
  errorResponse,
  SubmitVideoRequest,
  VIDEO_PICKER_LIMIT,
  VideoSubmission,
} from "../schemas";
import { currentTraceparent } from "../tracing";
import { youtubeVideoId } from "../youtube";

export const submitVideoRoute = createRoute({
  method: "post",
  path: "/api/admin/videos",
  operationId: "submitVideo",
  tags: ["admin"],
  summary: "Submit a YouTube URL for processing",
  description:
    "Creates the video row and enqueues its download job. Requires a Cloudflare " +
    "Access assertion in `Cf-Access-Jwt-Assertion` for an identity on the Worker's " +
    "admin allowlist.",
  request: {
    body: {
      content: { "application/json": { schema: SubmitVideoRequest } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Video accepted and a download job enqueued",
      content: { "application/json": { schema: VideoSubmission } },
    },
    400: errorResponse("Malformed body, or a URL that names no YouTube video"),
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    // Migration 0001 makes this outcome certain rather than incidental:
    // `videos.id` is the YouTube id and `idx_jobs_one_download_per_video` is
    // unique, so re-submitting a URL collides by design. Without a status for
    // it the one thing the schema deliberately guarantees has no way to be
    // reported.
    409: errorResponse("This video has already been submitted"),
    // Declared, not hidden: a Worker deployed without its Access configuration
    // fails closed, and a client that gets this needs to know the endpoint is
    // misconfigured rather than that its request was wrong.
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const submitVideoHandler: RouteHandler<typeof submitVideoRoute, AppEnv> = async (c) => {
  const { url } = c.req.valid("json");

  const videoId = youtubeVideoId(url);
  if (!videoId) {
    return c.json({ error: "that URL does not name a YouTube video" }, 400);
  }

  // Two statements, not a transaction. D1 has `batch()`, but the pair is
  // idempotent without one: re-inserting the video is a no-op, and the unique
  // index means the job insert either creates the only download job for this
  // video or creates nothing. A partial failure leaves a videos row with no
  // job, which a resubmit repairs.
  await c.env.DB.prepare("INSERT INTO videos (id, url) VALUES (?, ?) ON CONFLICT(id) DO NOTHING")
    .bind(videoId, url)
    .run();

  // `DO NOTHING ... RETURNING` returns no row on conflict, so the duplicate is
  // detected by the database rather than by a SELECT the next request could
  // race past.
  //
  // The submit request's own trace context (M9.2) is stamped onto the row it
  // creates here, because there is nowhere else for it to live: the worker
  // that claims this job does so minutes or hours later, in an unrelated
  // request, so a header cannot carry the connection — only the row can.
  // `currentTraceparent()` returns null with tracing disabled or no active
  // span, which the claim handler treats exactly like a job from before this
  // column existed: start a root trace.
  const job = await c.env.DB.prepare(
    "INSERT INTO jobs (kind, video_id, traceparent) VALUES ('download', ?, ?) ON CONFLICT DO NOTHING RETURNING id",
  )
    .bind(videoId, currentTraceparent())
    .first<{ id: number }>();

  if (!job) {
    return c.json({ error: "this video has already been submitted" }, 409);
  }

  return c.json({ video_id: videoId, job_id: job.id }, 201);
};

export const listVideosRoute = createRoute({
  method: "get",
  path: "/api/admin/videos",
  operationId: "listVideos",
  tags: ["admin"],
  summary: "Submitted videos, their frame counts, and their prelabel coverage",
  description:
    "What the dry-run form picks from (M12.2) and what `/admin/videos` (M16; M19 plan §B " +
    "folded the table in from the since-deleted `/admin/detection`) tables as coverage " +
    "per video. `image_count` rather than a boolean, because a video still being " +
    "extracted has some frames and will have more, and how many there are decides how " +
    "meaningful a sample off it is — the same reasoning `frames_sampled` extends to " +
    "M11.3's actual sample rather than the whole pool. Requires a Cloudflare Access " +
    "assertion.",
  responses: {
    200: {
      description: "Videos, newest first",
      content: { "application/json": { schema: AdminVideoList } },
    },
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const listVideosHandler: RouteHandler<typeof listVideosRoute, AppEnv> = async (c) => {
  // One aggregate pass per table, joined onto `videos` — not the four
  // correlated scalar subqueries this used to run per video row. That form
  // was written to avoid a `LEFT JOIN ... GROUP BY`, on the theory that the
  // join "applies `LIMIT` after aggregating, so it scans every row in both
  // tables," while the correlated form "touches only what
  // `idx_images_identity` ... need for fifty videos." `wrangler d1 insights`
  // disproved the second half of that: production was reading 39,652 rows
  // per call against 9,714 images and 1,055 predictions across 7 videos —
  // within 2% of 4 × 9,714. `idx_images_identity` does turn each correlated
  // subquery into an index *search* rather than a table scan, so it's not
  // wrong that the form "touches only what the index needs" — but two of
  // the four subqueries join through to `predictions`, and they pay for an
  // `idx_predictions_image` probe per *image* in the video (mostly misses),
  // not per prediction. Four scans of `images`' worth of work, run once per
  // video row, however it's indexed.
  //
  // The join form's "scans every row" complaint is real, but it only costs
  // once, not four times, and `videos` itself is tiny (7 rows in production,
  // growing by hours of extraction work each) — so "every row of `images`
  // and `predictions`, once" is a fixed, cheap cost that does not scale with
  // how many videos exist, only with how many frames and predictions do.
  // Measured against a seeded dataset scaled up from production (10,000
  // images, 1,055 predictions, 7 videos, via `meta.rows_read`): the
  // correlated form reads 45,311 rows; this form reads 16,385 — roughly the
  // one-time cost of `SCAN images USING INDEX idx_images_identity` for
  // `image_count`/`frames_sampled`, plus one pass over `predictions` joined
  // to `images` by primary key for `model_id`/`prelabelled_at`, which stays
  // cheap because `predictions` is two orders of magnitude smaller than
  // `images`. `EXPLAIN QUERY PLAN` confirms the shape: one `SCAN images`,
  // not one per video, and no per-image probe into `predictions` at all.
  //
  // `model_id` needs an argmax, not `MAX(model_id)` — the model that logged
  // the *most recent* prediction for a video, not the alphabetically
  // greatest model name. `ROW_NUMBER() OVER (PARTITION BY video_id ORDER BY
  // created_at DESC, id DESC)` picks that row directly; `id DESC` is a
  // deterministic tie-break for two predictions in the same second, which
  // the old `ORDER BY created_at DESC LIMIT 1` left to whatever order SQLite
  // happened to visit rows in. (SQLite's bare-column-follows-`MAX()` idiom —
  // `SELECT p.model_id, MAX(p.created_at) ... GROUP BY i.video_id` — gives
  // the same answer with a plain `GROUP BY` and no window function, but
  // measured worse here: 22,163 rows. The planner drives that form off
  // `images` to get `GROUP BY`'s ordering for free, which reintroduces a
  // per-image probe into `idx_predictions_image` — the exact cost this
  // rewrite exists to remove.)
  //
  // `image_count` and `frames_sampled` must read zero, never NULL, for a
  // video with no images yet — the dry-run picker depends on that video
  // still appearing in the list so it can explain why it cannot run there.
  // A `LEFT JOIN` to the `images` aggregate produces NULL for such a video,
  // so both are COALESCEd to 0. `model_id` and `prelabelled_at` stay
  // nullable: MIN/MAX (and this argmax) over zero rows is SQL's own honest
  // "nothing yet," not a sentinel this handler has to invent.
  const { results } = await c.env.DB.prepare(
    `SELECT v.id, v.title, v.created_at,
            COALESCE(img.image_count, 0) AS image_count,
            COALESCE(img.frames_sampled, 0) AS frames_sampled,
            latest.model_id,
            latest.prelabelled_at
       FROM videos v
       LEFT JOIN (
         SELECT video_id,
                COUNT(*) AS image_count,
                SUM(CASE WHEN selection_reason IS NOT NULL THEN 1 ELSE 0 END) AS frames_sampled
           FROM images
          GROUP BY video_id
       ) img ON img.video_id = v.id
       LEFT JOIN (
         SELECT video_id, model_id, created_at AS prelabelled_at
           FROM (
             SELECT i.video_id AS video_id,
                    p.model_id AS model_id,
                    p.created_at AS created_at,
                    ROW_NUMBER() OVER (
                      PARTITION BY i.video_id ORDER BY p.created_at DESC, p.id DESC
                    ) AS rn
               FROM predictions p
               JOIN images i ON i.id = p.image_id
           )
          WHERE rn = 1
       ) latest ON latest.video_id = v.id
      ORDER BY v.created_at DESC, v.id DESC
      LIMIT ?`,
  )
    .bind(VIDEO_PICKER_LIMIT)
    .all<{
      id: string;
      title: string | null;
      created_at: number;
      image_count: number;
      frames_sampled: number;
      model_id: string | null;
      prelabelled_at: number | null;
    }>();

  return c.json({ videos: results }, 200);
};
