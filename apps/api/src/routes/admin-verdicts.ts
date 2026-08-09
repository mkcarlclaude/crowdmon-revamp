import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../bindings";
import { chunkForBinding, placeholders } from "../d1";
import {
  CreateMissingReportRequest,
  CreateVerdictsRequest,
  errorResponse,
  ImageIdParam,
  MissingReport,
  VerdictBatch,
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
 *
 *    Rulings arrive a frame at a time rather than a box at a time, and that
 *    is a UI constraint that reached the contract: writing each click as it
 *    happened meant removing the box just ruled on, which renumbered every
 *    box below it while the operator's cursor was still moving. The staging
 *    area holds the frame still; this endpoint is the shape staging needs.
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

/**
 * The verified identity `requireAccess` left behind.
 *
 * The fallback is not a reachable state — every route in this file is under
 * `/api/admin/*`, which the middleware gates by prefix — only the one the type
 * system insists on being told about, exactly as `createDryRunHandler` does.
 */
const annotator = (c: { get: (key: "adminEmail") => string | undefined }) =>
  c.get("adminEmail") ?? "unknown";

export const submitVerdictsRoute = createRoute({
  method: "post",
  path: "/api/admin/images/{id}/verdicts",
  operationId: "submitVerdicts",
  tags: ["admin"],
  summary: "Submit a frame's rulings, all at once",
  description:
    "Appends one verdict row per ruling, as a single atomic batch. One call per frame " +
    "rather than one per box: the UI stages rulings so that a frame holds still while it " +
    "is being judged, and a screen that wrote each click immediately had to remove and " +
    "renumber boxes under the cursor. Never updates — an `adjust` carries its corrected " +
    "coordinates on the verdict and leaves the prediction unchanged, and ruling twice on " +
    "one prediction appends a second row rather than replacing the first. `source` and " +
    "`annotator_id` are read off the Access assertion and cannot be set by the caller. " +
    "Requires a Cloudflare Access assertion.",
  request: {
    params: ImageIdParam,
    body: { content: { "application/json": { schema: CreateVerdictsRequest } }, required: true },
  },
  responses: {
    201: {
      description: "How many verdicts the submission wrote",
      content: { "application/json": { schema: VerdictBatch } },
    },
    400: errorResponse(
      "A malformed body, an empty submission, coordinates that disagree with a verdict, " +
        "or a duplicated prediction",
    ),
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    404: errorResponse("No image with this id, or a prediction that is not on this frame"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const submitVerdictsHandler: RouteHandler<typeof submitVerdictsRoute, AppEnv> = async (
  c,
) => {
  const { id } = c.req.valid("param");
  const { verdicts } = c.req.valid("json");

  const image = await c.env.DB.prepare("SELECT id FROM images WHERE id = ?")
    .bind(id)
    .first<{ id: number }>();

  if (!image) return c.json({ error: `no image with id ${id}` }, 404);

  const ids = verdicts.map((ruling) => ruling.prediction_id);

  // A frame twice in one submission is a UI bug, not an operator changing
  // their mind — the staging area holds one ruling per box by construction.
  // Refused rather than written, because two rows appended in one batch is
  // indistinguishable afterwards from a deliberate re-ruling, which is a state
  // this schema does allow and does not want invented by accident.
  const duplicated = ids.filter((value, index) => ids.indexOf(value) !== index);
  if (duplicated.length > 0) {
    return c.json({ error: `prediction ruled more than once: ${[...new Set(duplicated)]}` }, 400);
  }

  // Every prediction must be on *this* frame. The ids come from a batch the
  // caller was handed, so a mismatch is a stale screen or a bug rather than an
  // attack — but writing them anyway would attach a verdict to a box the
  // operator never saw, and that is a corrupted row in the one table nothing
  // else can correct. Chunked against D1's per-statement parameter ceiling:
  // `MAX_VERDICTS_PER_IMAGE` is 100 and the `image_id` reserves one.
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

  // One batch: every ruling on the frame lands or none does. A partial write
  // would leave the frame in the pool with some boxes ruled and some not —
  // which is a legal state, since that is exactly how a partly-submitted frame
  // comes back, and therefore one nothing downstream could tell apart from an
  // operator's own deliberate partial submit.
  //
  // `?? null` rather than leaving the coordinates undefined: D1 rejects an
  // `undefined` binding, and the columns are nullable precisely so an accept or
  // a reject has nothing in them (migration 0003's CHECK ties the two
  // together).
  const written = await c.env.DB.batch(
    verdicts.map((ruling) =>
      c.env.DB.prepare(
        `INSERT INTO verdicts
              (prediction_id, verdict, adjusted_x_min, adjusted_y_min, adjusted_x_max,
               adjusted_y_max, source, annotator_id)
              VALUES (?, ?, ?, ?, ?, ?, 'admin', ?)`,
      ).bind(
        ruling.prediction_id,
        ruling.verdict,
        ruling.adjusted_x_min ?? null,
        ruling.adjusted_y_min ?? null,
        ruling.adjusted_x_max ?? null,
        ruling.adjusted_y_max ?? null,
        annotator(c),
      ),
    ),
  );

  return c.json(
    { image_id: id, verdicts: written.reduce((total, one) => total + (one.meta.changes ?? 0), 0) },
    201,
  );
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
