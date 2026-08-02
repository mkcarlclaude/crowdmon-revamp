import { createRoute, type RouteHandler, z } from "@hono/zod-openapi";
import type { Bindings } from "../bindings";
import { ErrorResponse, SubmitVideoRequest } from "../schemas";

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
      content: {
        "application/json": {
          schema: z
            .object({
              video_id: z.string().openapi({ example: "dQw4w9WgXcQ" }),
              job_id: z.number().int().openapi({ example: 1 }),
            })
            .openapi("SubmitVideoResponse"),
        },
      },
    },
    400: {
      description: "Malformed request body",
      content: { "application/json": { schema: ErrorResponse } },
    },
    // Declared because the handler is a stub until M3.4. Keeping the response
    // in the contract rather than casting past the types means the spec never
    // claims behaviour the deployed Worker does not have, and M3.4 deleting
    // this entry is a visible contract change.
    501: {
      description: "Not implemented until M3.4",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

export const submitVideoHandler: RouteHandler<typeof submitVideoRoute, { Bindings: Bindings }> = (
  c,
) => c.json({ error: "not implemented" }, 501);
