import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { Bindings } from "../bindings";
import { errorResponse, SubmitVideoRequest, SubmitVideoResponse } from "../schemas";

export const submitVideoRoute = createRoute({
  method: "post",
  path: "/api/admin/videos",
  tags: ["admin"],
  summary: "Submit a YouTube URL for processing",
  description:
    "Creates the video row and enqueues its download job. Admin-only: M3.5 puts " +
    "Cloudflare Access in front of `/api/admin/*`.",
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
    400: errorResponse("Malformed request body"),
    // Migration 0001 makes this outcome certain rather than incidental:
    // `videos.id` is the YouTube id and `idx_jobs_one_download_per_video` is
    // unique, so re-submitting a URL collides by design. Without a status for
    // it the one thing the schema deliberately guarantees has no way to be
    // reported.
    409: errorResponse("This video has already been submitted"),
    // Declared because the handler is a stub until M3.4. Keeping the response
    // in the contract rather than casting past the types means the spec never
    // claims behaviour the deployed Worker does not have, and M3.4 deleting
    // this entry is a visible contract change.
    501: errorResponse("Not implemented until M3.4"),
  },
});

export const submitVideoHandler: RouteHandler<typeof submitVideoRoute, { Bindings: Bindings }> = (
  c,
) => c.json({ error: "not implemented" }, 501);
