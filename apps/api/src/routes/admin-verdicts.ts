import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../bindings";
import { chunkForBinding, placeholders } from "../d1";
import {
  ADMIN_PAGE_LIMIT_DEFAULT,
  AdminAnnotatorList,
  AdminVerdictList,
  AdminVerdictListQuery,
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

/** The shape D1 returns for the join in `listVerdicts`. */
interface AdminVerdictRow {
  id: number;
  prediction_id: number;
  verdict: "accept" | "adjust" | "reject";
  adjusted_x_min: number | null;
  adjusted_y_min: number | null;
  adjusted_x_max: number | null;
  adjusted_y_max: number | null;
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
  confidence: number;
  source: "admin" | "anon";
  annotator_id: string;
  created_at: number;
  image_id: number;
  video_id: string;
  r2_key: string;
  timestamp_seconds: number;
  class_id: number;
  class_name: string;
}

/**
 * The join every filtered read of `verdicts` below shares.
 *
 * Extracted so the page query and the count query can never drift into
 * disagreeing about what they are counting: both interpolate the exact same
 * `${VERDICT_JOIN} ${where}` text, and the only thing that differs between
 * them is what gets projected. A hand-copied `WHERE` between two statements
 * is exactly how "142 results" and "37 rows on the page" would quietly stop
 * describing the same query.
 */
const VERDICT_JOIN = `
    FROM verdicts v
    JOIN predictions p ON p.id = v.prediction_id
    JOIN images i      ON i.id = p.image_id
    JOIN classes c     ON c.id = p.class_id`;

/**
 * "What did the pool get ruled on, and by whom" (M16, ROADMAP M16 — reading
 * back what was labelled; M18, plan §A — six filters instead of one, plus a
 * total). Everything `submitVerdictsHandler` above writes, read back joined
 * to the frame and class it belongs to, newest first.
 *
 * Filters on `source` and five more, never on the caller's own identity:
 * `verdicts` already carries `source` and `annotator_id` on every row
 * (CONTEXT.md §Q10's two-tier split), and "what did I submit" is that same
 * query with `source=admin` plus a client-side glance at `annotator_id` —
 * not a second code path that would have to agree with this one about what a
 * verdict is.
 */
export const listVerdictsRoute = createRoute({
  method: "get",
  path: "/api/admin/verdicts",
  operationId: "listVerdicts",
  tags: ["admin"],
  summary: "Every verdict, newest first, joined to its frame and class, filterable six ways",
  description:
    "Reads `verdicts` back joined to `predictions`, `images` and `classes` — the row an " +
    "annotations page renders needs all four without a second request per row, and now " +
    "also carries the prediction's original box (`x_min`..`confidence`) alongside the " +
    "verdict's adjusted one, so a preview can show what the detector proposed next to what " +
    "an admin ruled. `source`, `verdict`, `class_id`, `video_id`, `annotator_id` and a " +
    "`from`/`to` time range all narrow independently and combine with AND; any omitted " +
    "narrows nothing. `total` is the count over the same combination, not cut off by " +
    "`limit`, so a filtered page and an empty one are distinguishable. Requires a " +
    "Cloudflare Access assertion.",
  request: { query: AdminVerdictListQuery },
  responses: {
    200: {
      description: "One page of verdicts, newest first, and the total matching the filter",
      content: { "application/json": { schema: AdminVerdictList } },
    },
    400: errorResponse("An out-of-range limit or offset, or an invalid filter value"),
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const listVerdictsHandler: RouteHandler<typeof listVerdictsRoute, AppEnv> = async (c) => {
  const { limit, offset, source, verdict, class_id, video_id, annotator_id, from, to } =
    c.req.valid("query");

  // A conditions array joined by AND and a parallel bindings array, rather
  // than the single optional string this route used to build — the same
  // idiom `listJobsHandler` uses for its own one-filter `WHERE`, extended to
  // six independent filters that can be present in any combination. The rule
  // that idiom exists to keep holds exactly as before: every filter value is
  // bound, never interpolated, and what varies in the SQL text is only
  // whether a clause is present — with one exception below, where the text
  // itself has to vary in length rather than presence.
  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (source) {
    conditions.push("v.source = ?");
    bindings.push(source);
  }
  if (verdict) {
    // The one clause whose SQL text varies with input length rather than
    // just its presence: an `IN (...)` needs one placeholder per value. Still
    // bound, never interpolated — `placeholders` only ever emits `?`
    // characters — and the placeholder count this can ever reach is capped
    // by `MAX_VERDICT_FILTER_VALUES`, which is `VerdictKind`'s own
    // cardinality, not a guess about caller behaviour.
    conditions.push(`v.verdict IN (${placeholders(verdict)})`);
    bindings.push(...verdict);
  }
  if (class_id !== undefined) {
    conditions.push("p.class_id = ?");
    bindings.push(class_id);
  }
  if (video_id) {
    conditions.push("i.video_id = ?");
    bindings.push(video_id);
  }
  if (annotator_id) {
    conditions.push("v.annotator_id = ?");
    bindings.push(annotator_id);
  }
  if (from !== undefined) {
    conditions.push("v.created_at >= ?");
    bindings.push(from);
  }
  if (to !== undefined) {
    conditions.push("v.created_at <= ?");
    bindings.push(to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Every filter combined tops out at one placeholder per condition plus up
  // to `MAX_VERDICT_FILTER_VALUES` for `verdict` — nowhere near D1's 100-bound
  // -parameter ceiling (`d1-bound-param-limit`), unlike `chunkForBinding`'s
  // callers elsewhere in this file, which chunk because their list length is
  // however many predictions a caller happened to submit. This list's length
  // is bounded by the schema, not by the caller, so no chunking is needed —
  // stated explicitly because D1's local SQLite test harness does not enforce
  // the ceiling and would let a violation of it pass silently.
  //
  // One batch, two statements: the page and its total over the identical
  // filter, the same idiom `listAdminVideoImagesHandler` uses for the same
  // reason — D1 has no cheap "count regardless of LIMIT" primitive short of a
  // second pass over the same predicate. `bindings` is reused for both
  // statements' filter values; `limit`/`offset` are appended to the page
  // query alone, since a total is not paged.
  const [pageResult, countResult] = await c.env.DB.batch<AdminVerdictRow | { total: number }>([
    c.env.DB.prepare(
      `SELECT v.id, v.prediction_id, v.verdict,
              v.adjusted_x_min, v.adjusted_y_min, v.adjusted_x_max, v.adjusted_y_max,
              p.x_min, p.y_min, p.x_max, p.y_max, p.confidence,
              v.source, v.annotator_id, v.created_at,
              i.id AS image_id, i.video_id, i.r2_key, i.timestamp_seconds,
              c.id AS class_id, c.name AS class_name
         ${VERDICT_JOIN}
         ${where}
        ORDER BY v.id DESC
        LIMIT ? OFFSET ?`,
    ).bind(...bindings, limit ?? ADMIN_PAGE_LIMIT_DEFAULT, offset ?? 0),
    c.env.DB.prepare(`SELECT COUNT(*) AS total ${VERDICT_JOIN} ${where}`).bind(...bindings),
  ]);

  const verdicts = (pageResult?.results ?? []) as AdminVerdictRow[];
  const total = ((countResult?.results ?? []) as { total: number }[])[0]?.total ?? 0;

  return c.json({ verdicts, total }, 200);
};

/** The shape D1 returns for `listVerdictAnnotators`'s grouped read. */
interface AdminAnnotatorRow {
  annotator_id: string;
  source: "admin" | "anon";
  verdicts: number;
}

/**
 * Populates the annotator filter's dropdown on `/admin/annotations` (M18,
 * plan §A).
 *
 * Grouped by `(annotator_id, source)` rather than a flat list of ids: an
 * admin's Access email and an anonymous session id are drawn from disjoint
 * spaces in practice, but nothing enforces that at the schema level, so the
 * pair is what actually names one contributor — the same pairing
 * `listVerdictsHandler`'s own `source` and `annotator_id` filters keep apart.
 *
 * This is also the surface that makes ROADMAP M14.4's "excluding one bad
 * actor does not mean discarding every anonymous contribution" operable
 * rather than aspirational: the anon rows here, each with its own verdict
 * count, are exactly the set a moderation decision would act on one row at a
 * time, and a dropdown of forty raw `crypto.randomUUID()`s would make that
 * decision unusable — the web layer renders admin emails as themselves and
 * anonymous ids truncated (`anon · 3f2c…`) for exactly that reason.
 */
export const listVerdictAnnotatorsRoute = createRoute({
  method: "get",
  path: "/api/admin/verdicts/annotators",
  operationId: "listVerdictAnnotators",
  tags: ["admin"],
  summary: "Every annotator who has ruled on something, grouped by source, with a count",
  description:
    "`SELECT annotator_id, source, COUNT(*) FROM verdicts GROUP BY annotator_id, source` — " +
    "everyone who has ever ruled on a prediction, admin and anonymous alike, with how many " +
    "rulings each has made. Built for the annotator filter's dropdown on `/admin/annotations` " +
    "rather than any operator-facing leaderboard, though CONTEXT.md §Q10's own \"plain " +
    'counts, not rank-percentile theatre" would apply if one were ever built from this. ' +
    "Requires a Cloudflare Access assertion.",
  responses: {
    200: {
      description:
        "Every distinct annotator with a verdict count, most active first within a source",
      content: { "application/json": { schema: AdminAnnotatorList } },
    },
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const listVerdictAnnotatorsHandler: RouteHandler<
  typeof listVerdictAnnotatorsRoute,
  AppEnv
> = async (c) => {
  // No `IN (...)`, no caller-supplied list to chunk against D1's bound-
  // parameter ceiling — this binds nothing at all, which is what keeps it
  // safe regardless of how many distinct annotators `verdicts` ever grows to.
  const { results } = await c.env.DB.prepare(
    `SELECT annotator_id, source, COUNT(*) AS verdicts
       FROM verdicts
      GROUP BY annotator_id, source
      ORDER BY source, verdicts DESC`,
  ).all<AdminAnnotatorRow>();

  return c.json({ annotators: results }, 200);
};
