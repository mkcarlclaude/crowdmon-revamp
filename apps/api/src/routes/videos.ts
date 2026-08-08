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
  summary: "Submitted videos and how many frames each has",
  description:
    "What the dry-run form picks from (M12.2). `image_count` rather than a boolean, " +
    "because a video still being extracted has some frames and will have more, and how " +
    "many there are decides how meaningful a 50-frame sample off it is. Requires a " +
    "Cloudflare Access assertion.",
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
  // A LEFT JOIN with a GROUP BY rather than a count per video: the picker is
  // one request and the alternative is one round trip per row. LEFT, not
  // inner, so a video whose extraction has not started yet is listed at zero
  // rather than missing — the form has to be able to say why it cannot be
  // dry-run against.
  const { results } = await c.env.DB.prepare(
    `SELECT v.id, v.title, v.created_at, COUNT(i.id) AS image_count
       FROM videos v
       LEFT JOIN images i ON i.video_id = v.id
      GROUP BY v.id
      ORDER BY v.created_at DESC, v.id DESC
      LIMIT ?`,
  )
    .bind(VIDEO_PICKER_LIMIT)
    .all<{ id: string; title: string | null; created_at: number; image_count: number }>();

  return c.json({ videos: results }, 200);
};
