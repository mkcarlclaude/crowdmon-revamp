import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../bindings";
import { chunkForBinding, placeholders } from "../d1";
import { frameUrls } from "../frame-urls";
import {
  CreatePublicVerdictsRequest,
  errorResponse,
  ImageIdParam,
  PublicFrame,
  VerdictBatch,
} from "../schemas";

/**
 * A stranger tries the interface, no account required (M14, CONTEXT.md §12).
 *
 * The milestone's own sentence: an unauthenticated visitor verifies a frame
 * and the verdict is recorded with `source = 'anon'`. Two routes, and every
 * rule in `admin-verdicts.ts`'s module comment still holds here — append-only,
 * source and identity constrained by the handler rather than the body — plus
 * three that exist only because this surface has no Access assertion behind
 * it to lean on:
 *
 * 1. **Drawn only from `public_sample`, never from the labelling pool.**
 *    CONTEXT.md §12's three bounds on this surface — a hand-curated flag
 *    rather than the bucket, one signed URL per request, rate limiting plus
 *    `noindex` — exist so that a public verification page reads as a curated
 *    sample rather than the dataset with the login page removed. Reusing the
 *    admin pool here would draw from the frozen evaluation set too, which
 *    must stay untouched by untrusted traffic.
 * 2. **No `adjust`.** `PublicStagedVerdict` carries no coordinate fields at
 *    all, and this file rejects the kind at the schema layer rather than
 *    relying on `VerificationCard`'s `allowAdjust={false}` to keep the button
 *    off screen — a UI affordance is not an access control.
 * 3. **Signed or nothing.** `frameUrls`' proxy fallback is the Access-gated
 *    `/api/admin/image` route; a visitor with no Access session cannot reach
 *    it. A deployment with no R2 credential configured answers `503` on the
 *    frame route rather than handing out a URL that will 401 in the browser.
 *
 * Outside `/api/admin`, so `requireAccess` never runs against these paths —
 * and `publicRateLimit` runs instead (`app.ts`), which is what CONTEXT.md
 * §Q25's "rate limiting" bound actually is rather than a sentence about it.
 */

interface RandomPublicImageRow {
  id: number;
  r2_key: string;
}

interface PublicBoxRow {
  id: number;
  class_id: number;
  class_name: string;
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
  confidence: number;
}

export const publicFrameRoute = createRoute({
  method: "get",
  path: "/api/public/frame",
  operationId: "publicFrame",
  tags: ["public"],
  summary: "One frame from the hand-curated public sample, for a visitor with no account",
  description:
    "A single frame drawn at random from `images.public_sample = 1`, with a presigned " +
    "R2 URL good for `PRESIGN_TTL_SECONDS` and every box the model proposed on it. Never " +
    "batched, unlike `/api/admin/labelling/batch` — CONTEXT.md §Q25's public bound is " +
    "one short-lived signed URL per request. Only images that already carry at least " +
    "one prediction are eligible, so a frame flagged before pre-labelling ran is never " +
    "handed to a visitor with nothing to rule on. No Access assertion; rate limited.",
  responses: {
    200: {
      description: "One frame, its boxes, and where to fetch its bytes",
      content: { "application/json": { schema: PublicFrame } },
    },
    404: errorResponse("No image is currently flagged into the public sample"),
    429: errorResponse("Too many requests from this visitor"),
    503: errorResponse("This deployment has no R2 signing credential configured"),
  },
});

export const publicFrameHandler: RouteHandler<typeof publicFrameRoute, AppEnv> = async (c) => {
  // `ORDER BY RANDOM()` over a hand-curated pool rather than the paged,
  // stateful walk `labellingBatchHandler` does over the labelling queue: the
  // public page is not a queue an operator drains, it is the same small
  // sample shown again to whoever loads it next, so there is no "remaining"
  // to track and no reason to prefer one frame's turn over another's.
  const image = await c.env.DB.prepare(
    `SELECT i.id, i.r2_key FROM images i
      WHERE i.public_sample = 1
        AND EXISTS (SELECT 1 FROM predictions p WHERE p.image_id = i.id)
      ORDER BY RANDOM() LIMIT 1`,
  ).first<RandomPublicImageRow>();

  if (!image) {
    return c.json({ error: "no image is currently flagged into the public sample" }, 404);
  }

  const { mode, expiresAt, byKey } = await frameUrls(c.env, [image.r2_key]);

  // Never the proxy fallback here — see this file's module comment. Failing
  // loudly with the same shape `requireAccess` uses for a missing gate: the
  // alternative is a URL that resolves to a login redirect in the visitor's
  // browser, which is a worse failure than an honest 503.
  if (mode === "proxy") {
    return c.json({ error: "this deployment has no R2 signing credential configured" }, 503);
  }

  const { results: boxes } = await c.env.DB.prepare(
    `SELECT p.id, p.class_id, c.name AS class_name, p.x_min, p.y_min, p.x_max, p.y_max, p.confidence
       FROM predictions p
       JOIN classes c ON c.id = p.class_id
      WHERE p.image_id = ?
      ORDER BY p.id`,
  )
    .bind(image.id)
    .all<PublicBoxRow>();

  return c.json(
    {
      id: image.id,
      r2_key: image.r2_key,
      // The `?? ""` is unreachable, matching `labellingBatchHandler`'s own —
      // the key just signed is the only key in the map.
      url: byKey.get(image.r2_key) ?? "",
      predictions: boxes,
      expires_at: expiresAt,
    },
    200,
  );
};

export const submitPublicVerdictsRoute = createRoute({
  method: "post",
  path: "/api/public/images/{id}/verdicts",
  operationId: "submitPublicVerdicts",
  tags: ["public"],
  summary: "Submit an anonymous visitor's rulings on one frame",
  description:
    "Appends one `source = 'anon'` verdict row per ruling, exactly as `submitVerdicts` " +
    "does for `source = 'admin'` — append-only, one call per frame. `annotator_id` is " +
    "the caller-supplied `session_id`, not an Access identity: this surface has none. " +
    "Only `accept` and `reject` are legal here; `PublicStagedVerdict` has no adjusted- " +
    "coordinate fields for an `adjust` verdict to carry. The image must be in " +
    "`public_sample` — a verdict cannot be attached to a frame this visitor was never " +
    "shown. No Access assertion; rate limited.",
  request: {
    params: ImageIdParam,
    body: {
      content: { "application/json": { schema: CreatePublicVerdictsRequest } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "How many verdicts the submission wrote",
      content: { "application/json": { schema: VerdictBatch } },
    },
    400: errorResponse("A malformed body, an empty submission, or a duplicated prediction"),
    404: errorResponse("No public-sample image with this id, or a prediction not on this frame"),
    429: errorResponse("Too many requests from this visitor"),
  },
});

export const submitPublicVerdictsHandler: RouteHandler<
  typeof submitPublicVerdictsRoute,
  AppEnv
> = async (c) => {
  const { id } = c.req.valid("param");
  const { session_id, verdicts } = c.req.valid("json");

  // Scoped to `public_sample = 1` in the same query that checks the image
  // exists: a visitor's session has no way to have been shown any other
  // image, so a verdict aimed at one is a stale link or a probe, not a
  // legitimate late submission. Both get the same 404 an unknown id would.
  const image = await c.env.DB.prepare("SELECT id FROM images WHERE id = ? AND public_sample = 1")
    .bind(id)
    .first<{ id: number }>();

  if (!image) return c.json({ error: `no public-sample image with id ${id}` }, 404);

  const ids = verdicts.map((ruling) => ruling.prediction_id);

  const duplicated = ids.filter((value, index) => ids.indexOf(value) !== index);
  if (duplicated.length > 0) {
    return c.json({ error: `prediction ruled more than once: ${[...new Set(duplicated)]}` }, 400);
  }

  const found = await c.env.DB.batch<{ id: number }>(
    chunkForBinding(ids, 1).map((chunk) =>
      c.env.DB.prepare(
        `SELECT id FROM predictions WHERE image_id = ? AND id IN (${placeholders(chunk)})`,
      ).bind(id, ...chunk),
    ),
  );

  const onThisFrame = new Set(found.flatMap((result) => result.results.map((row) => row.id)));
  const strangers = ids.filter((predictionId) => !onThisFrame.has(predictionId));

  if (strangers.length > 0) {
    return c.json({ error: `not a prediction on image ${id}: ${strangers.join(", ")}` }, 404);
  }

  const written = await c.env.DB.batch(
    verdicts.map((ruling) =>
      c.env.DB.prepare(
        `INSERT INTO verdicts (prediction_id, verdict, source, annotator_id)
              VALUES (?, ?, 'anon', ?)`,
      ).bind(ruling.prediction_id, ruling.verdict, session_id),
    ),
  );

  return c.json(
    { image_id: id, verdicts: written.reduce((total, one) => total + (one.meta.changes ?? 0), 0) },
    201,
  );
};
