import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../bindings";
import {
  CreateMissingReportRequest,
  CreateVerdictRequest,
  errorResponse,
  ImageIdParam,
  ImageRejection,
  MissingReport,
  PredictionIdParam,
  Verdict,
  type VerdictRow,
} from "../schemas";

/**
 * Human rulings on model predictions, behind Access (M13.2, M13.3).
 *
 * The milestone's own sentence: an admin can accept, adjust or reject a
 * proposed box and the verdict is a row in D1. Three rules run through this
 * file and each is a constraint rather than a convenience.
 *
 * 1. **Append-only, and nothing here updates anything.** There is no UPDATE
 *    and no DELETE in this file, and no later milestone should add one. An
 *    `adjust` writes its corrected coordinates onto the *verdict* row and
 *    leaves `predictions` byte-for-byte unchanged, which is what keeps "every
 *    annotation is a human verdict on a model prediction" checkable rather
 *    than asserted — and what makes excluding an annotator later a `WHERE`
 *    clause instead of an unrecoverable loss (CONTEXT.md §12).
 * 2. **Source and identity come from the assertion, never the body.**
 *    `verdicts.source` is `'admin'` here because `requireAccess` verified an
 *    identity on the allowlist, and `annotator_id` is that identity. M14
 *    mounts the same UI component against unauthenticated routes that write
 *    `'anon'`; a body field either handler trusted would let the public page
 *    write authoritative labels, which is the single decision CONTEXT.md §Q10
 *    says would force consensus resolution, agreement scoring and trust
 *    weighting into scope.
 * 3. **A missed object is its own row type.** `missing_reports` exists
 *    because a verdict needs a prediction to rule on, and the whole point of
 *    a missing report is that no prediction was made (migration 0003).
 *
 * Under `/api/admin` so the Access gate and the Worker's own allowlist both
 * apply with no new auth code — `app.ts` registers `requireAccess` by path
 * prefix, so these routes are gated by existing rather than by remembering.
 */

/** The shape D1 returns for a verdict — every adjusted column is nullable there and here. */
interface VerdictDbRow {
  id: number;
  prediction_id: number;
  verdict: "accept" | "adjust" | "reject";
  adjusted_x_min: number | null;
  adjusted_y_min: number | null;
  adjusted_x_max: number | null;
  adjusted_y_max: number | null;
  source: "admin" | "anon";
  annotator_id: string;
  created_at: number;
}

const toVerdict = (row: VerdictDbRow): VerdictRow => ({
  id: row.id,
  prediction_id: row.prediction_id,
  verdict: row.verdict,
  adjusted_x_min: row.adjusted_x_min,
  adjusted_y_min: row.adjusted_y_min,
  adjusted_x_max: row.adjusted_x_max,
  adjusted_y_max: row.adjusted_y_max,
  source: row.source,
  annotator_id: row.annotator_id,
  created_at: row.created_at,
});

/**
 * The verified identity `requireAccess` left behind.
 *
 * The fallback is not a reachable state — every route in this file is under
 * `/api/admin/*`, which the middleware gates by prefix — only the one the type
 * system insists on being told about, exactly as `createDryRunHandler` does.
 */
const annotator = (c: { get: (key: "adminEmail") => string | undefined }) =>
  c.get("adminEmail") ?? "unknown";

export const createVerdictRoute = createRoute({
  method: "post",
  path: "/api/admin/predictions/{id}/verdict",
  operationId: "createVerdict",
  tags: ["admin"],
  summary: "Accept, adjust or reject one proposed box",
  description:
    "Appends a verdict row. Never updates: an `adjust` carries its corrected coordinates " +
    "on the verdict and leaves the prediction unchanged, and ruling twice on one " +
    "prediction appends a second row rather than replacing the first. `source` and " +
    "`annotator_id` are read off the Access assertion and cannot be set by the caller. " +
    "Requires a Cloudflare Access assertion.",
  request: {
    params: PredictionIdParam,
    body: { content: { "application/json": { schema: CreateVerdictRequest } }, required: true },
  },
  responses: {
    201: {
      description: "The verdict as written",
      content: { "application/json": { schema: Verdict } },
    },
    400: errorResponse("A malformed body, or coordinates that disagree with the verdict"),
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    404: errorResponse("No prediction with this id"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const createVerdictHandler: RouteHandler<typeof createVerdictRoute, AppEnv> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  // Resolved before the insert rather than left to the foreign key, the same
  // reason `reportPredictions` resolves `r2_key` and `class_name` itself: a
  // constraint failure arrives with no field to point at, and the caller here
  // is a UI holding a batch that may simply be stale.
  const prediction = await c.env.DB.prepare("SELECT id FROM predictions WHERE id = ?")
    .bind(id)
    .first<{ id: number }>();

  if (!prediction) return c.json({ error: `no prediction with id ${id}` }, 404);

  // `?? null` rather than leaving them undefined: D1 binds `undefined` as an
  // error, and the columns are nullable precisely so an accept or a reject has
  // nothing in them (migration 0003's CHECK ties the two together).
  const row = await c.env.DB.prepare(
    `INSERT INTO verdicts
          (prediction_id, verdict, adjusted_x_min, adjusted_y_min, adjusted_x_max,
           adjusted_y_max, source, annotator_id)
          VALUES (?, ?, ?, ?, ?, ?, 'admin', ?)
       RETURNING *`,
  )
    .bind(
      id,
      body.verdict,
      body.adjusted_x_min ?? null,
      body.adjusted_y_min ?? null,
      body.adjusted_x_max ?? null,
      body.adjusted_y_max ?? null,
      annotator(c),
    )
    .first<VerdictDbRow>();

  if (!row) return c.json({ error: "the verdict could not be recorded" }, 400);

  return c.json(toVerdict(row), 201);
};

export const rejectImageRoute = createRoute({
  method: "post",
  path: "/api/admin/images/{id}/reject",
  operationId: "rejectImage",
  tags: ["admin"],
  summary: "Reject every box on one frame, in one action",
  description:
    "Appends a `reject` verdict for each of this frame's boxes that the admin tier has " +
    "not already ruled on. Menus, loading screens and black frames are the common case " +
    "in a sampled timeline and must not cost one request per box. A frame with nothing " +
    "left to reject answers 201 with a count of zero rather than an error — a stale " +
    "screen is ordinary, not a conflict. Requires a Cloudflare Access assertion.",
  request: { params: ImageIdParam },
  responses: {
    201: {
      description: "How many verdicts the rejection wrote",
      content: { "application/json": { schema: ImageRejection } },
    },
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    404: errorResponse("No image with this id"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const rejectImageHandler: RouteHandler<typeof rejectImageRoute, AppEnv> = async (c) => {
  const { id } = c.req.valid("param");

  const image = await c.env.DB.prepare("SELECT id FROM images WHERE id = ?")
    .bind(id)
    .first<{ id: number }>();

  if (!image) return c.json({ error: `no image with id ${id}` }, 404);

  // `INSERT ... SELECT`, not a statement per box. Two bound parameters however
  // many boxes the frame carries, so D1's 100-parameter ceiling is not in play
  // and the whole rejection is one atomic write rather than a batch that could
  // be counted while half-applied.
  //
  // The `NOT EXISTS` is what makes pressing this twice harmless: it rejects
  // what this tier has not ruled on yet, so a frame whose boxes were already
  // rejected from another tab writes nothing and answers zero. Scoped to
  // `source = 'admin'` rather than to any verdict at all, because an anonymous
  // visitor having clicked on a box (M14) must not stop an admin from ruling
  // on it — those are the two tiers CONTEXT.md §Q10 keeps apart, and pooling
  // them here would let public traffic silently shrink what an admin's own
  // action does.
  const written = await c.env.DB.prepare(
    `INSERT INTO verdicts (prediction_id, verdict, source, annotator_id)
          SELECT p.id, 'reject', 'admin', ?
            FROM predictions p
           WHERE p.image_id = ?
             AND NOT EXISTS (
                   SELECT 1 FROM verdicts v
                    WHERE v.prediction_id = p.id AND v.source = 'admin')`,
  )
    .bind(annotator(c), id)
    .run();

  return c.json({ image_id: id, verdicts: written.meta.changes ?? 0 }, 201);
};

export const createMissingReportRoute = createRoute({
  method: "post",
  path: "/api/admin/images/{id}/missing",
  operationId: "createMissingReport",
  tags: ["admin"],
  summary: "Report an object the detector never proposed",
  description:
    "Records that this frame contains something no prediction covers — the recall " +
    "failures a verify-only UI cannot otherwise see. `class_id` is optional: a report " +
    "can name a class or just say something is here. Takes any image id, including one " +
    "the labelling session never shows: a frame the detector proposed *nothing* on is " +
    "not in that pool (there would be no box to rule on and no way to leave the frame), " +
    "so a total miss is reportable through this route but not yet reachable from that " +
    "screen. Admin-only. Requires a Cloudflare Access assertion.",
  request: {
    params: ImageIdParam,
    body: {
      content: { "application/json": { schema: CreateMissingReportRequest } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "The report as written",
      content: { "application/json": { schema: MissingReport } },
    },
    400: errorResponse("A malformed body"),
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    404: errorResponse("No image with this id, or no class with the given class_id"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const createMissingReportHandler: RouteHandler<
  typeof createMissingReportRoute,
  AppEnv
> = async (c) => {
  const { id } = c.req.valid("param");
  const { class_id = null } = c.req.valid("json");

  const image = await c.env.DB.prepare("SELECT id FROM images WHERE id = ?")
    .bind(id)
    .first<{ id: number }>();

  if (!image) return c.json({ error: `no image with id ${id}` }, 404);

  // Checked rather than left to the foreign key for this file's usual reason,
  // and here there is a second one: `missing_reports.class_id` is nullable, so
  // a typo'd id and a deliberate "I don't know which class" are one keystroke
  // apart, and only an explicit check can tell the caller which one it sent.
  if (class_id !== null) {
    const klass = await c.env.DB.prepare("SELECT id FROM classes WHERE id = ?")
      .bind(class_id)
      .first<{ id: number }>();

    if (!klass) return c.json({ error: `no class with id ${class_id}` }, 404);
  }

  const row = await c.env.DB.prepare(
    "INSERT INTO missing_reports (image_id, class_id, reporter) VALUES (?, ?, ?) RETURNING *",
  )
    .bind(id, class_id, annotator(c))
    .first<{
      id: number;
      image_id: number;
      class_id: number | null;
      reporter: string;
      created_at: number;
    }>();

  if (!row) return c.json({ error: "the report could not be recorded" }, 400);

  return c.json(row, 201);
};
