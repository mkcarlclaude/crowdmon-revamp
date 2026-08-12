import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../bindings";
import {
  AdminImage,
  errorResponse,
  ImageIdParam,
  ImageQuery,
  UpdatePublicSampleRequest,
} from "../schemas";

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
 * route sits behind.
 *
 * **What keeps a caller here is how long its URLs have to stay good, not how
 * many of them there are.** The original version of this comment argued from
 * volume — §Q25 computes the request budget, calls it "noise against
 * 100,000/day", and fifty frames per dry-run is well inside that noise — and
 * that argument was wrong in the way size arguments usually are: it silently
 * extends to any number that still feels small. M16's per-video grid
 * (`admin-video-images.ts`) inherited it at twenty-four full-resolution frames
 * a page against videos with hundreds, and nothing objected, because nothing
 * had written down where the line was. That grid now uses `frameUrls` and
 * fetches from R2 directly.
 *
 * The line is `PRESIGN_TTL_SECONDS`: fifteen minutes. `DryRunPanel` is the one
 * admin surface built to be left open — run a candidate wording, read the
 * boxes, edit the wording, run again — so the frames from one run are still on
 * screen well past that, and a signed URL would have to come with the
 * refetch-on-expiry handling M13.4 built for the labelling session to buy
 * nothing but consistency. A proxy URL is good for as long as the Access
 * session is. Any *new* caller that renders a page-sized batch and refetches
 * when it changes belongs on `frameUrls` instead.
 *
 * The other thing this avoids is hand-rolling SigV4 in a Worker to serve
 * twenty images to one operator. The `FRAMES` binding is already bound here
 * (M1.3's Terraform) and needs no new secret.
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

/**
 * The floor a curator has to respect between two public-sample frames from
 * the same video (M18, plan §C).
 *
 * At 1fps extraction, two kept frames within half a minute of each other are
 * adjacent enough that a human cannot tell them apart — the plan's own
 * diagnosis of the "keeps serving near-identical frames" report is that the
 * pool itself is temporally clustered, not that the draw is insufficiently
 * random (`publicFrameHandler` already draws with `ORDER BY RANDOM()` over
 * the whole pool). Thirty seconds is the plan's own floor, not a computed
 * value: it is short enough that a curator scanning one scene for several
 * good frames is not fighting the rule, and long enough that "the same
 * moment, twice" cannot slip through by habit — an admin scanning a video's
 * frame grid naturally clicks a contiguous run of good-looking frames.
 */
export const PUBLIC_SAMPLE_MIN_SPACING_SECONDS = 30;

/**
 * Curating the public pool (M14.1, migration 0004, CONTEXT.md §12; M18, plan
 * §C's spacing rule).
 *
 * The only writer of `images.public_sample`. Never `selection_reason` —
 * that column is written once, at selection time, by a different actor
 * entirely (M11), and this route has no business touching it.
 *
 * No check that the image carries any predictions or has been verified.
 * That invariant belongs to whoever *reads* the public pool
 * (`publicFrameHandler` requires at least one prediction before a frame is
 * eligible to be handed to a visitor), not to the flag itself — an admin
 * flagging a frame before its predictions land is an ordinary sequencing
 * choice, not a state this route needs to refuse.
 *
 * **Flagging in is refused when it would put two public-sample frames from
 * one video within `PUBLIC_SAMPLE_MIN_SPACING_SECONDS` of each other;
 * flagging out never is.** Enforced here, in the handler, rather than left to
 * whichever screen calls it — CONTEXT.md §Q19's amendment already draws
 * `/admin/videos/:id`'s frame grid as one caller of this route and a future
 * curation surface would be another, and the rule has to hold regardless of
 * which one made the request. Unflagging is never refused: removing a frame
 * from the pool cannot make it more clustered, so there is nothing for this
 * check to protect against on the way out.
 */
export const updatePublicSampleRoute = createRoute({
  method: "patch",
  path: "/api/admin/images/{id}/public-sample",
  operationId: "updatePublicSample",
  tags: ["admin"],
  summary: "Flag or unflag an image for the public verification page",
  description:
    "Sets `images.public_sample`, the hand-curated flag CONTEXT.md §12 requires the " +
    "public page draw from instead of the bucket. Kept separate from the frozen " +
    "evaluation pool by construction — this route only ever writes the flag an admin " +
    "chose, never anything selection-time logic wrote. Flagging a frame IN is refused " +
    "with 409 when another public-sample frame from the same video already sits within " +
    `${PUBLIC_SAMPLE_MIN_SPACING_SECONDS} seconds of it — at 1fps extraction that pair is ` +
    "close enough to read as the same frame shown twice, which is what a visitor actually " +
    "reported. Flagging OUT is never refused. Requires a Cloudflare Access assertion.",
  request: {
    params: ImageIdParam,
    body: {
      content: { "application/json": { schema: UpdatePublicSampleRequest } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "The image's id and its public_sample flag as it now stands",
      content: { "application/json": { schema: AdminImage } },
    },
    400: errorResponse("A malformed body"),
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    404: errorResponse("No image with this id"),
    409: errorResponse(
      "Flagging this frame in would put it within the minimum spacing of an already-flagged " +
        "frame from the same video, named in the message",
    ),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const updatePublicSampleHandler: RouteHandler<
  typeof updatePublicSampleRoute,
  AppEnv
> = async (c) => {
  const { id } = c.req.valid("param");
  const { public_sample } = c.req.valid("json");

  // Read first rather than leaning on `UPDATE ... RETURNING` to discover a
  // missing id, unlike this handler's previous shape — the spacing check
  // below needs `video_id` and `timestamp_seconds` before it can run, and a
  // second SELECT just to fetch what the first one already had would be a
  // wasted round trip for the common case of flagging out or flagging in with
  // nothing nearby.
  const image = await c.env.DB.prepare(
    "SELECT id, video_id, timestamp_seconds FROM images WHERE id = ?",
  )
    .bind(id)
    .first<{ id: number; video_id: string; timestamp_seconds: number }>();

  if (!image) return c.json({ error: `no image with id ${id}` }, 404);

  if (public_sample) {
    // The nearest already-flagged frame from the same video, if one is
    // closer than the floor allows. `id != ?` excludes the row being updated
    // itself — an admin re-flagging a frame that is already in the pool (a
    // no-op PATCH) must not trip over its own existing flag.
    const conflict = await c.env.DB.prepare(
      `SELECT id, timestamp_seconds FROM images
        WHERE video_id = ?
          AND public_sample = 1
          AND id != ?
          AND ABS(timestamp_seconds - ?) < ?
        ORDER BY ABS(timestamp_seconds - ?) LIMIT 1`,
    )
      .bind(
        image.video_id,
        id,
        image.timestamp_seconds,
        PUBLIC_SAMPLE_MIN_SPACING_SECONDS,
        image.timestamp_seconds,
      )
      .first<{ id: number; timestamp_seconds: number }>();

    if (conflict) {
      return c.json(
        {
          error:
            `frame ${id} (${image.timestamp_seconds}s) is within ` +
            `${PUBLIC_SAMPLE_MIN_SPACING_SECONDS}s of already-flagged frame ${conflict.id} ` +
            `(${conflict.timestamp_seconds}s) from video ${image.video_id} — a visitor would ` +
            "see them as near-duplicates",
        },
        409,
      );
    }
  }

  const updated = await c.env.DB.prepare(
    "UPDATE images SET public_sample = ? WHERE id = ? RETURNING id, public_sample",
  )
    .bind(public_sample ? 1 : 0, id)
    .first<{ id: number; public_sample: number }>();

  if (!updated) return c.json({ error: `no image with id ${id}` }, 404);

  return c.json({ id: updated.id, public_sample: updated.public_sample === 1 }, 200);
};
