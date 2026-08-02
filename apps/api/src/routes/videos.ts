import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { Bindings } from "../bindings";
import { errorResponse, SubmitVideoRequest, SubmitVideoResponse } from "../schemas";
import { youtubeVideoId } from "../youtube";

export const submitVideoRoute = createRoute({
  method: "post",
  path: "/api/admin/videos",
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
      content: { "application/json": { schema: SubmitVideoResponse } },
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

export const submitVideoHandler: RouteHandler<
  typeof submitVideoRoute,
  { Bindings: Bindings }
> = async (c) => {
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
  const job = await c.env.DB.prepare(
    "INSERT INTO jobs (kind, video_id) VALUES ('download', ?) ON CONFLICT DO NOTHING RETURNING id",
  )
    .bind(videoId)
    .first<{ id: number }>();

  if (!job) {
    return c.json({ error: "this video has already been submitted" }, 409);
  }

  return c.json({ video_id: videoId, job_id: job.id }, 201);
};
