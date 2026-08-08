import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../bindings";
import { errorResponse, ImageQuery } from "../schemas";

/**
 * Frame bytes for an admin screen (M12.2).
 *
 * CONTEXT.md §Q25 settles image serving as **batched short-lived presigned
 * URLs**, with the browser fetching from R2 directly, and that decision still
 * stands for the path it was made about: M13.4's labelling session, where a
 * couple of hundred images per sitting is the throughput and keeping bytes off
 * Worker CPU is worth real infrastructure.
 *
 * This is not that path, and proxying here does not reopen the decision. §Q25's
 * argument is posture first — "§7 rejects a public browsable gallery to avoid
 * republishing copyrighted game frames at scale; a public bucket does
 * substantially the same thing without an index page" — and an Access-gated
 * proxy is exactly as private as a signed URL: the bucket stays private, there
 * is no enumeration, and the gate is the same allowlist every other admin
 * route sits behind. §Q25 itself computes the request budget and calls it
 * "noise against 100,000/day"; fifty frames per dry-run is well inside that
 * noise.
 *
 * What it does avoid is minting an R2 S3 credential and hand-rolling SigV4 in
 * a Worker to serve fifty images to one operator. The `FRAMES` binding is
 * already bound here (M1.3's Terraform) and needs no new secret; presigning
 * would need one that only a human can create. Deferring that until M13.4 is
 * the milestone where it earns its keep is the same reasoning that keeps
 * everything else in this project cheap.
 */
export const getImageRoute = createRoute({
  method: "get",
  path: "/api/admin/image",
  operationId: "getImage",
  tags: ["admin"],
  summary: "One frame's bytes, by R2 key",
  description:
    "Streams an object out of the frames bucket for an admin screen to render. Requires " +
    "a Cloudflare Access assertion — the bucket stays private and there is no way to " +
    "enumerate it through this route.",
  request: { query: ImageQuery },
  responses: {
    200: {
      description: "The object's bytes",
      content: { "image/jpeg": { schema: { type: "string", format: "binary" } } },
    },
    400: errorResponse("A missing or empty key"),
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    404: errorResponse("No object under this key"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const getImageHandler: RouteHandler<typeof getImageRoute, AppEnv> = async (c) => {
  const { key } = c.req.valid("query");

  const object = await c.env.FRAMES.get(key);

  // A key that is in `images` but not in R2 is the orphan case M11.1 calls
  // terminal for a prelabel job. Here it is one blank frame in a grid of
  // fifty, so it answers 404 and lets the browser's own broken-image handling
  // show which one — a failure worth seeing, not worth failing the page over.
  if (!object) return c.json({ error: "no object under that key" }, 404);

  // Extraction writes JPEGs (`frames.Key`), so the type is known rather than
  // guessed from the extension — and R2's own stored metadata is preferred
  // when it has any, because the object is the authority on what it contains.
  const contentType = object.httpMetadata?.contentType ?? "image/jpeg";

  return c.body(object.body, 200, {
    "content-type": contentType,
    // Frames are immutable: `frames.Key` is deterministic from (video,
    // timestamp) and a re-run overwrites the same bytes (M8.3). A dry-run grid
    // re-rendered on every poll would otherwise re-fetch fifty objects a
    // second time for nothing.
    "cache-control": "private, max-age=3600",
  });
};
