import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../bindings";
import { AdminVideoDetail, AdminVideoIdParam, errorResponse } from "../schemas";

/**
 * `/admin/videos/:id`'s header (M19, plan §A). Everything above the frame
 * grid `listAdminVideoImagesHandler` already renders — a video's own
 * YouTube-derived metadata and the per-video counts that answer "how much of
 * this video exists, and how far has it been worked through."
 *
 * A new route rather than an extension of `listVideosHandler`: that handler
 * computes one row per video, up to `VIDEO_PICKER_LIMIT` of them, for a
 * picker and a table — every field this route adds beyond `AdminVideo`
 * (`predictions` joined to `images`, `verdicts`, a `jobs` scan) is per-video
 * work no list of fifty videos should pay for on every mount. Separate route,
 * separate cost.
 *
 * **404, not an empty page.** `listAdminVideoImagesHandler` answers an
 * unknown video id with an empty page on purpose — that is a true statement
 * about a video that exists and has no frames yet. There is no equivalent
 * honest answer for a video that was never submitted: every field on
 * `AdminVideoDetail` would be a null pretending to be a fact about a row that
 * is not there.
 */
export const adminVideoDetailRoute = createRoute({
  method: "get",
  path: "/api/admin/videos/{id}",
  operationId: "getAdminVideoDetail",
  tags: ["admin"],
  summary: "One video's own metadata and its per-video aggregates",
  description:
    "The `videos` row plus frame, prediction, verdict and extraction-progress counts for " +
    "one video — what `/admin/videos/:id`'s header renders above the frame grid " +
    "`listAdminVideoImages` already serves. 404 for a video id that was never submitted, " +
    "unlike that route's own empty-page answer for one with no frames yet. Requires a " +
    "Cloudflare Access assertion.",
  request: { params: AdminVideoIdParam },
  responses: {
    200: {
      description: "This video's metadata and aggregates",
      content: { "application/json": { schema: AdminVideoDetail } },
    },
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    404: errorResponse("No video with this id"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

interface VideoRow {
  id: string;
  url: string;
  title: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  created_at: number;
}

/**
 * SQLite's `SUM()` over zero rows returns `NULL`, not `0` — unlike
 * `COUNT(*)`, which is `0` honestly. `images` has no row for a video that has
 * none yet, so both sums are coalesced to `0` in the handler rather than the
 * query, matching `listVideosHandler`'s own `COALESCE` for the same reason.
 */
interface ImagesRollupRow {
  image_count: number;
  frames_sampled: number | null;
  public_samples: number | null;
}

/**
 * `predictions` joined to `images` by primary key, never a correlated
 * subquery per frame — the exact read-amplification shape `listVideosHandler`
 * documents at length (production read 39,652 rows against 9,714 images and
 * 1,055 predictions before that rewrite; the correlated form pays for an
 * `idx_predictions_image` probe per *frame*, mostly misses, instead of one
 * pass over the much smaller `predictions` table). `admin-video-images.ts`
 * uses the correlated form legitimately — it is bounded to 24 rows by
 * `AdminVideoImagesQuery`'s limit — but the predicate here is a whole video,
 * which is exactly the case that comment warns against copying it into.
 *
 * `frames_unverified` counts distinct `image_id`s with at least one
 * prediction carrying no `source = 'admin'` verdict. `source = 'admin'` sits
 * in the `LEFT JOIN`'s `ON` clause, not a `WHERE` — an anon verdict must
 * neither make a frame count as ruled nor drop the prediction row from the
 * join, which is exactly what pushing the filter into `WHERE` would do
 * (`INNER JOIN`-like behaviour on the null side). This is the same admin-tier
 * definition `verdictState()` (`admin-video-images.ts`) already encodes for
 * the frame grid one screen below this header; if the two ever disagreed the
 * page would contradict itself.
 */
interface PredictionsRollupRow {
  predictions: number;
  frames_with_predictions: number;
  frames_unverified: number;
}

interface JobsRollupRow {
  kind: "download" | "chunk" | "prelabel" | "dryrun" | "snapshot";
  status: "pending" | "claimed" | "done" | "failed";
  n: number;
}

interface LatestPredictionRow {
  model_id: string;
  prelabelled_at: number;
}

type BatchRow =
  | VideoRow
  | ImagesRollupRow
  | PredictionsRollupRow
  | JobsRollupRow
  | LatestPredictionRow;

/**
 * Folds `jobs` rows (`GROUP BY kind, status`, scoped to this video) into the
 * `download`/`chunks_*`/`prelabel` summary the header actually reads.
 *
 * `download` and `prelabel` each collapse to at most one row —
 * `idx_jobs_one_download_per_video` and `idx_jobs_one_prelabel_per_video`
 * guarantee it (see `AdminVideoJobsSummary`'s own comment in `schemas.ts`) —
 * so there is nothing to sum for either kind, only a status to read off
 * whichever single row shows up. `chunk` has no such index; fan-out creates
 * one per 60-second segment, so those rows are summed across every status
 * this video's chunks have ever been in. `dryrun` and `snapshot` rows (a
 * video can carry `dryrun` jobs) are dropped silently — this summary answers
 * "is extraction finished," not "every job kind this video has ever run,"
 * which is `/admin/queue`'s question (plan §C).
 */
function summarizeJobs(rows: JobsRollupRow[]) {
  let download: JobsRollupRow["status"] | null = null;
  let prelabel: JobsRollupRow["status"] | null = null;
  let chunksTotal = 0;
  let chunksDone = 0;
  let chunksFailed = 0;

  for (const row of rows) {
    if (row.kind === "download") download = row.status;
    else if (row.kind === "prelabel") prelabel = row.status;
    else if (row.kind === "chunk") {
      chunksTotal += row.n;
      if (row.status === "done") chunksDone += row.n;
      if (row.status === "failed") chunksFailed += row.n;
    }
  }

  return {
    download,
    chunks_total: chunksTotal,
    chunks_done: chunksDone,
    chunks_failed: chunksFailed,
    prelabel,
  };
}

export const adminVideoDetailHandler: RouteHandler<typeof adminVideoDetailRoute, AppEnv> = async (
  c,
) => {
  const { id } = c.req.valid("param");

  // One `DB.batch`, one round trip — five statements rather than the video
  // lookup followed by four more once it is known to exist. D1 has no way to
  // make a later batched statement conditional on an earlier one's result, so
  // the images/predictions/jobs/latest-prediction queries run unconditionally
  // even for an id that turns out not to exist; that is four cheap no-op
  // scans against an empty predicate, not four extra round trips, and it
  // buys back the round trip a "check first, then batch the rest" shape would
  // spend instead.
  const [videoResult, imagesResult, predictionsResult, jobsResult, latestResult] =
    await c.env.DB.batch<BatchRow>([
      c.env.DB.prepare(
        "SELECT id, url, title, duration_seconds, width, height, created_at FROM videos WHERE id = ?",
      ).bind(id),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS image_count,
                SUM(CASE WHEN selection_reason IS NOT NULL THEN 1 ELSE 0 END) AS frames_sampled,
                SUM(CASE WHEN public_sample = 1 THEN 1 ELSE 0 END) AS public_samples
           FROM images WHERE video_id = ?`,
      ).bind(id),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS predictions,
                COUNT(DISTINCT p.image_id) AS frames_with_predictions,
                COUNT(DISTINCT CASE WHEN v.id IS NULL THEN p.image_id END) AS frames_unverified
           FROM predictions p
           JOIN images i ON i.id = p.image_id
           LEFT JOIN verdicts v ON v.prediction_id = p.id AND v.source = 'admin'
          WHERE i.video_id = ?`,
      ).bind(id),
      // No `idx_jobs_video` — migrations 0001/0005/0007/0008 index `jobs` on
      // `(status, kind, id)` and `heartbeat_at` only, so this is a scan of
      // `jobs`. Deliberately not fixed here: this plan carries no migration,
      // `jobs` is thousands of rows today rather than millions, and it is one
      // scan on a page load, not per-row work. Revisit if `jobs` grows an
      // order of magnitude.
      c.env.DB.prepare(
        "SELECT kind, status, COUNT(*) AS n FROM jobs WHERE video_id = ? GROUP BY kind, status",
      ).bind(id),
      // `model_id`/`prelabelled_at` do not ride along on the predictions
      // rollup above as a fifth and sixth column — an argmax does not compose
      // with an aggregate over the same rows. `listVideosHandler` solves the
      // same problem with `ROW_NUMBER() OVER (PARTITION BY video_id ...)`
      // because it computes the argmax for every video in one query; scoped
      // to a single video here, a plain `ORDER BY ... LIMIT 1` reaches the
      // same row without the window function — `id DESC` breaks a tie
      // between two predictions in the same second deterministically, the
      // same reason that handler gives for it. This has to be its own
      // statement (not read from a cached list query) so the page is correct
      // on a hard refresh at `/admin/videos/:id`, where nothing has already
      // fetched `/api/admin/videos`.
      c.env.DB.prepare(
        `SELECT p.model_id, p.created_at AS prelabelled_at
           FROM predictions p
           JOIN images i ON i.id = p.image_id
          WHERE i.video_id = ?
          ORDER BY p.created_at DESC, p.id DESC
          LIMIT 1`,
      ).bind(id),
    ]);

  // `?.` throughout, matching `listAdminVideoImagesHandler`'s own batch: D1's
  // types allow a batched result to be absent even though every statement
  // above always returns one, since nothing in the type system knows the
  // statements ran together.
  const video = videoResult?.results[0] as VideoRow | undefined;
  if (!video) return c.json({ error: `no video with id ${id}` }, 404);

  const images = imagesResult?.results[0] as ImagesRollupRow;
  const predictions = predictionsResult?.results[0] as PredictionsRollupRow;
  const latest = latestResult?.results[0] as LatestPredictionRow | undefined;
  const jobs = (jobsResult?.results ?? []) as JobsRollupRow[];

  return c.json(
    {
      id: video.id,
      url: video.url,
      title: video.title,
      duration_seconds: video.duration_seconds,
      width: video.width,
      height: video.height,
      created_at: video.created_at,
      image_count: images.image_count,
      frames_sampled: images.frames_sampled ?? 0,
      public_samples: images.public_samples ?? 0,
      predictions: predictions.predictions,
      frames_with_predictions: predictions.frames_with_predictions,
      frames_verified: predictions.frames_with_predictions - predictions.frames_unverified,
      frames_unverified: predictions.frames_unverified,
      model_id: latest?.model_id ?? null,
      prelabelled_at: latest?.prelabelled_at ?? null,
      jobs: summarizeJobs(jobs),
    },
    200,
  );
};
