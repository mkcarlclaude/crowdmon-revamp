import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../bindings";
import { chunkForBinding, placeholders } from "../d1";
import { frameUrls } from "../frame-urls";
import {
  CONTRIBUTE_BATCH_SIZE,
  ContributeBatch,
  ContributeBatchQuery,
  ContributeMe,
  CreateVerdictsRequest,
  errorResponse,
  ImageIdParam,
  VerdictBatch,
} from "../schemas";

/**
 * The signed-in contributor tier (M20, plan §B4) — a third mount of
 * `VerificationCard`, the mount M13.1's own comment predicted from the start.
 *
 * Gated by `requireUser` (`app.ts` registers it by the `/api/contribute/*`
 * prefix, matching `requireAccess`'s own idiom for `/api/admin/*`), which is
 * a different question from `requireAccess`: "is this a signed-in
 * contributor," not "is this one of the fixed admin allowlist." An admin
 * hitting these routes with no session cookie gets the same 401 anyone else
 * would — `/admin/verify` is that tier's own surface, and CONTEXT.md §7's v4
 * amendment is explicit that the two are not the same thing.
 *
 * Compared with `admin-labelling.ts` and `admin-verdicts.ts`, this file
 * differs in exactly the ways plan §B4's table says it should and nowhere
 * else:
 *
 * - **Frame pool: everything unruled, not the curated `public_sample` pool**
 *   `/api/public/*` draws from — a signed-in, rate-limited, named account is
 *   a different exposure from an anonymous one, and CONTEXT.md §Q25's three
 *   bounds on the public pool exist for exactly the anonymous case (see that
 *   section's own reasoning). Restricting contributors to the small curated
 *   pool would cap contribution at the size of a hand-picked list.
 * - **`allowAdjust` stays true.** A contributor's ruling is a label a later
 *   snapshot can select (plan §C1), not a click recorded and discarded the
 *   way an anonymous one is — a tier that can only say "wrong" with no way to
 *   say what the right box was is the weakest signal `missing_reports`'
 *   own note already warns about for a different gap.
 * - **No missing-object reporting.** `admin-verdicts.ts`'s own comment is
 *   why: naming a class from the roster is an authoring act, not a
 *   verification one, and stays admin-only exactly as plan §B4 says.
 * - **`source = 'user'`, `annotator_id` = the contributor's numeric
 *   `users.id` as text — never their email.** Migration 0012's own comment on
 *   `verdicts.annotator_id` explains why: this column is what
 *   `CONTRIBUTOR_UNRULED_BOX` below joins against `users.id` to decide
 *   whether a *trusted* contributor has already ruled on a box, and an email
 *   can change out from under that join in a way a stable numeric id cannot.
 *
 * **The pool predicate is asymmetric with the admin one, on purpose.**
 * `admin-labelling.ts`'s `UNRULED_BOX` stays `source = 'admin'` — a
 * contributor's ruling must never remove a box from the admin's own queue,
 * because the admin is the tier that overrides and must be able to see and
 * re-rule anything (plan §C3). `CONTRIBUTOR_UNRULED_BOX` below is not that
 * predicate reused: it excludes a box the moment *either* an admin *or* a
 * trusted user has ruled on it, so two contributors are not routinely handed
 * the same box to re-decide once someone whose ruling already counts has
 * settled it. An untrusted contributor's own verdicts do not remove a box
 * from this pool for anyone — only a trusted ruling does — which is what
 * keeps an unpromoted account from being able to single-handedly exhaust the
 * pool with verdicts nothing will ever select as a label. That asymmetry is
 * the kind of thing that reads as a bug in six months; it is documented
 * again at `UNRULED_BOX` in `admin-labelling.ts` for whoever reads that file
 * first.
 */

/**
 * Any box on this image that no admin verdict and no *trusted* user verdict
 * has ruled on. See this file's module comment for why this differs from
 * `admin-labelling.ts`'s `UNRULED_BOX` rather than reusing it.
 *
 * The join to `users` is on `u.id = CAST(v.annotator_id AS INTEGER)`, not on
 * email — `annotator_id` stores the contributor's `users.id` as text for
 * exactly this join (migration 0012's own comment). `CAST` is safe here
 * because every `source = 'user'` row was written by `submitContributeVerdictsHandler`
 * below, which always writes a numeric id; an `admin` or `anon` row's
 * `annotator_id` never reaches this branch because the join is only ever
 * evaluated inside a subquery already filtered to `v.source = 'user'`.
 */
const CONTRIBUTOR_UNRULED_BOX = `
  SELECT 1 FROM predictions p
   WHERE p.image_id = i.id
     AND NOT EXISTS (
           SELECT 1 FROM verdicts v
            WHERE v.prediction_id = p.id AND v.source = 'admin')
     AND NOT EXISTS (
           SELECT 1 FROM verdicts v
            JOIN users u ON u.id = CAST(v.annotator_id AS INTEGER)
            WHERE v.prediction_id = p.id AND v.source = 'user' AND u.trusted = 1)`;

/**
 * Why this pool has no `unruled_admin`-style denormalised counter of its own
 * (M25.1, plan §C), stated here rather than only in `CLAUDE.md` — this is the
 * file whoever changes the predicate above will actually be looking at.
 * `admin-labelling.ts`'s `unruled_admin` stays true because every write that
 * can change it — a prediction inserted, an admin verdict inserted — is a
 * column on a row this codebase's own endpoints touch. `CONTRIBUTOR_UNRULED_BOX`
 * has a third dependency neither of those do: `users.trusted`, flipped by
 * hand in production D1 with no endpoint of its own. Promoting a user
 * retroactively removes boxes from this pool with no write to `images` at
 * all, which means a denormalised counter here would drift the instant
 * anybody is promoted, through no bug in any write path — the exact failure
 * mode migration 0013's own comment on `unruled_admin` warns a naive counter
 * into. `CLAUDE.md` documents promoting a user as requiring
 * `admin-labelling.ts`'s reconciliation query precisely because there is no
 * counter here for a promotion to silently break.
 */

/**
 * The verified contributor `requireUser` left behind.
 *
 * Not a reachable-undefined case in practice — every route in this file is
 * under `/api/contribute/*`, gated by `requireUser` at the prefix (`app.ts`)
 * — but the type says "possibly absent" because `Variables` also describes
 * every route where it never runs, matching `admin-verdicts.ts`'s own
 * `annotator` helper for the equivalent non-guarantee on `adminEmail`.
 */
function contributor(c: { get: (key: "user") => AppEnv["Variables"]["user"] }) {
  const user = c.get("user");
  if (!user) throw new Error("requireUser did not run before this handler");
  return user;
}

interface BatchImageRow {
  id: number;
  video_id: string;
  r2_key: string;
  timestamp_seconds: number;
  shuffle_key: number;
}

/**
 * The bounded-count cap this pool's `remaining` answers instead of an exact
 * number (M25.1, plan §C). `admin-labelling.ts`'s equivalent field is an
 * index-only `COUNT(*)` because `unruled_admin` denormalises pool membership
 * onto the row; this pool has no such column (see the module comment on
 * `CONTRIBUTOR_UNRULED_BOX` above for why it cannot), so an *exact* count here
 * is still the full correlated scan this milestone exists to stop paying for
 * — and unlike the admin count, this one sits behind unauthenticated public
 * traffic. `LIMIT CONTRIBUTOR_REMAINING_CAP + 1` bounds the scan to a fixed
 * cost regardless of how large the true pool is: the inner query stops
 * looking the moment it has found one more than the cap, so the outer
 * `COUNT(*)` comes back as either the true count (below the cap) or exactly
 * `CONTRIBUTOR_REMAINING_CAP + 1` (at or past it) — the second case is what a
 * caller renders as "500+" rather than a number that would otherwise imply a
 * precision this pool does not offer. A contributor does not need the exact
 * figure either way: `ContributeVerify.tsx`'s own comment already decrements
 * this client-side as frames are ruled rather than refetching it.
 */
const CONTRIBUTOR_REMAINING_CAP = 500;

interface BatchBoxRow {
  id: number;
  image_id: number;
  class_id: number;
  class_name: string;
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
  confidence: number;
  prompt_version: string;
  model_id: string;
}

export const contributeBatchRoute = createRoute({
  method: "get",
  path: "/api/contribute/batch",
  operationId: "contributeBatch",
  tags: ["contribute"],
  summary: "The next N frames for a contributor to verify, with their boxes and their URLs",
  description:
    "The whole unruled pool, not the curated public sample — see this file's module " +
    "comment for why. A frame is returned while any of its boxes carries neither an " +
    "admin verdict nor a trusted user's, and carries only those boxes. Shuffled by a " +
    "per-image random key, not extraction order (M25.1); pass `cursor` back as " +
    "`next_cursor` came from the previous call to keep advancing, and omit it to start " +
    "over — the pool wraps rather than running dry once a cursor passes every key still " +
    "in it. `remaining` is capped rather than exact past 500, since this route is public " +
    "and unauthenticated. Requires a contributor session.",
  request: { query: ContributeBatchQuery },
  responses: {
    200: {
      description: "The next frames, their boxes and their URLs",
      content: { "application/json": { schema: ContributeBatch } },
    },
    400: errorResponse("A limit outside 1..100"),
    401: errorResponse("Missing or expired contributor session"),
  },
});

export const contributeBatchHandler: RouteHandler<typeof contributeBatchRoute, AppEnv> = async (
  c,
) => {
  const { limit = CONTRIBUTE_BATCH_SIZE, cursor } = c.req.valid("query");

  // Shuffled by `shuffle_key` (M25.1, plan §A), the same mechanism and the
  // same reason `labellingBatchHandler` now uses — see that handler's own
  // comment for why the scene-context argument for sequential order is real
  // and is overridden anyway. This pool gets the ordering half of the plan
  // but not the counter half (`CONTRIBUTOR_REMAINING_CAP` above): keyset
  // pagination over `shuffle_key` needs only the column, which every image
  // already carries, while a denormalised membership count would need a
  // write path this predicate does not have one of (`users.trusted` again).
  //
  // `cursor` and the wrap below are `labellingBatchHandler`'s own mechanism,
  // unchanged: forward progress is `shuffle_key > cursor`, absent on a
  // session's first call, and a short page with a cursor still set means the
  // walk reached the top of the key space with pool left over on the other
  // side of where it started.
  const forward = cursor !== undefined ? "AND shuffle_key > ?" : "";
  const forwardBindings = cursor !== undefined ? [cursor] : [];

  const [pageResult, remainingResult] = await c.env.DB.batch<BatchImageRow | { remaining: number }>(
    [
      c.env.DB.prepare(
        `SELECT i.id, i.video_id, i.r2_key, i.timestamp_seconds, i.shuffle_key
           FROM images i
          WHERE EXISTS (${CONTRIBUTOR_UNRULED_BOX})
          ${forward}
          ORDER BY shuffle_key
          LIMIT ?`,
      ).bind(...forwardBindings, limit),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS remaining FROM (
           SELECT 1 FROM images i
            WHERE EXISTS (${CONTRIBUTOR_UNRULED_BOX})
            LIMIT ${CONTRIBUTOR_REMAINING_CAP + 1}
         )`,
      ),
    ],
  );

  let images = (pageResult?.results ?? []) as BatchImageRow[];
  // Clamped to the cap, not the raw `COUNT(*)`: the inner `LIMIT` above stops
  // at `CONTRIBUTOR_REMAINING_CAP + 1`, so the raw value here is either the
  // true count (below the cap) or exactly one past it — `Math.min` collapses
  // that "one past" case down to the cap itself, which is what a caller
  // renders as "500+" rather than a number one larger than the constant it
  // was told the cap is.
  const rawRemaining =
    ((remainingResult?.results ?? []) as { remaining: number }[])[0]?.remaining ?? 0;
  const remaining = Math.min(rawRemaining, CONTRIBUTOR_REMAINING_CAP);
  // The bit the clamp above would otherwise destroy, and the whole reason
  // this field exists. `remaining` alone cannot tell "exactly 500 left" from
  // "at least 500 left" — both arrive as 500 — so a client told to render
  // "500+" past the cap had no way to know when it was past it. M25.1's plan
  // specified the rendering and not the signal, and the result was a pool
  // counter frozen at 500 for the ~600 frames it took to drain below the cap,
  // which reads as a broken number rather than a bounded one.
  const remainingCapped = rawRemaining > CONTRIBUTOR_REMAINING_CAP;

  // Wrapping, `labellingBatchHandler`'s own mechanism and the same reason:
  // bounded by the same cursor value in the other direction, so the forward
  // page and the wrap can never return the same row twice.
  if (cursor !== undefined && images.length < limit) {
    const wrapResult = await c.env.DB.prepare(
      `SELECT i.id, i.video_id, i.r2_key, i.timestamp_seconds, i.shuffle_key
         FROM images i
        WHERE EXISTS (${CONTRIBUTOR_UNRULED_BOX})
          AND shuffle_key <= ?
        ORDER BY shuffle_key
        LIMIT ?`,
    )
      .bind(cursor, limit - images.length)
      .all<BatchImageRow>();
    images = [...images, ...(wrapResult.results ?? [])];
  }

  const nextCursor = images.length > 0 ? (images[images.length - 1]?.shuffle_key ?? null) : null;

  if (images.length === 0) {
    const { mode, expiresAt } = await frameUrls(c.env, []);
    return c.json(
      {
        images: [],
        url_mode: mode,
        expires_at: expiresAt,
        remaining,
        remaining_capped: remainingCapped,
        next_cursor: nextCursor,
      },
      200,
    );
  }

  const imageIds = images.map((image) => image.id);

  const boxResults = await c.env.DB.batch<BatchBoxRow>(
    chunkForBinding(imageIds).map((ids) =>
      c.env.DB.prepare(
        `SELECT p.id, p.image_id, p.class_id, c.name AS class_name,
                p.x_min, p.y_min, p.x_max, p.y_max, p.confidence,
                p.prompt_version, p.model_id
           FROM predictions p
           JOIN classes c ON c.id = p.class_id
          WHERE p.image_id IN (${placeholders(ids)})
            AND NOT EXISTS (
                  SELECT 1 FROM verdicts v WHERE v.prediction_id = p.id AND v.source = 'admin')
            AND NOT EXISTS (
                  SELECT 1 FROM verdicts v
                   JOIN users u ON u.id = CAST(v.annotator_id AS INTEGER)
                  WHERE v.prediction_id = p.id AND v.source = 'user' AND u.trusted = 1)
          ORDER BY p.id`,
      ).bind(...ids),
    ),
  );

  const boxesByImage = new Map<number, BatchBoxRow[]>();
  for (const result of boxResults) {
    for (const box of result.results) {
      boxesByImage.set(box.image_id, [...(boxesByImage.get(box.image_id) ?? []), box]);
    }
  }

  const { mode, expiresAt, byKey } = await frameUrls(
    c.env,
    images.map((image) => image.r2_key),
  );

  return c.json(
    {
      images: images.map((image) => ({
        id: image.id,
        video_id: image.video_id,
        r2_key: image.r2_key,
        timestamp_seconds: image.timestamp_seconds,
        url: byKey.get(image.r2_key) ?? "",
        predictions: (boxesByImage.get(image.id) ?? []).map(({ image_id: _, ...box }) => box),
      })),
      url_mode: mode,
      expires_at: expiresAt,
      remaining,
      remaining_capped: remainingCapped,
      next_cursor: nextCursor,
    },
    200,
  );
};

export const submitContributeVerdictsRoute = createRoute({
  method: "post",
  path: "/api/contribute/images/{id}/verdicts",
  operationId: "submitContributeVerdicts",
  tags: ["contribute"],
  summary: "Submit a contributor's rulings on one frame, all at once",
  description:
    "Appends one `source = 'user'` verdict row per ruling, exactly as `submitVerdicts` " +
    "does for `source = 'admin'` — append-only, one call per frame, `source` and " +
    "`annotator_id` read off the session rather than the body. Adjust is offered, unlike " +
    "the anonymous surface: a contributor's correction is a label a later snapshot can " +
    "select (plan §C1). Requires a contributor session.",
  request: {
    params: ImageIdParam,
    body: {
      content: { "application/json": { schema: CreateVerdictsRequest } },
      required: true,
    },
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
    401: errorResponse("Missing or expired contributor session"),
    404: errorResponse("No image with this id, or a prediction that is not on this frame"),
  },
});

export const submitContributeVerdictsHandler: RouteHandler<
  typeof submitContributeVerdictsRoute,
  AppEnv
> = async (c) => {
  const { id } = c.req.valid("param");
  const { verdicts } = c.req.valid("json");
  const user = contributor(c);

  const image = await c.env.DB.prepare("SELECT id FROM images WHERE id = ?")
    .bind(id)
    .first<{ id: number }>();

  if (!image) return c.json({ error: `no image with id ${id}` }, 404);

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
        `INSERT INTO verdicts
              (prediction_id, verdict, adjusted_x_min, adjusted_y_min, adjusted_x_max,
               adjusted_y_max, source, annotator_id)
              VALUES (?, ?, ?, ?, ?, ?, 'user', ?)`,
      ).bind(
        ruling.prediction_id,
        ruling.verdict,
        ruling.adjusted_x_min ?? null,
        ruling.adjusted_y_min ?? null,
        ruling.adjusted_x_max ?? null,
        ruling.adjusted_y_max ?? null,
        // The contributor's numeric id, as text — never the email. See this
        // file's module comment and migration 0012's comment on
        // `verdicts.annotator_id` for why the join `CONTRIBUTOR_UNRULED_BOX`
        // depends on requires this rather than a human-readable identity.
        String(user.id),
      ),
    ),
  );

  return c.json(
    { image_id: id, verdicts: written.reduce((total, one) => total + (one.meta.changes ?? 0), 0) },
    201,
  );
};

interface ContributeMeRow {
  frames_touched: number;
  accepted: number | null;
  adjusted: number | null;
  rejected: number | null;
}

export const contributeMeRoute = createRoute({
  method: "get",
  path: "/api/contribute/me",
  operationId: "contributeMe",
  tags: ["contribute"],
  summary: "The signed-in contributor's own counts",
  description:
    "Verdicts by kind, distinct frames touched, and whether the account is trusted — " +
    "personal only, no comparison to anyone else's numbers (plan §B5; see `ContributeMe`'s " +
    "own comment for why no ranking surface may ever be built from this route). Requires " +
    "a contributor session.",
  responses: {
    200: {
      description: "This contributor's own counts",
      content: { "application/json": { schema: ContributeMe } },
    },
    401: errorResponse("Missing or expired contributor session"),
  },
});

export const contributeMeHandler: RouteHandler<typeof contributeMeRoute, AppEnv> = async (c) => {
  const user = contributor(c);

  const row = await c.env.DB.prepare(
    `SELECT
        COUNT(DISTINCT p.image_id) AS frames_touched,
        SUM(CASE WHEN v.verdict = 'accept' THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN v.verdict = 'adjust' THEN 1 ELSE 0 END) AS adjusted,
        SUM(CASE WHEN v.verdict = 'reject' THEN 1 ELSE 0 END) AS rejected
       FROM verdicts v
       JOIN predictions p ON p.id = v.prediction_id
      WHERE v.source = 'user' AND v.annotator_id = ?`,
  )
    .bind(String(user.id))
    .first<ContributeMeRow>();

  return c.json(
    {
      email: user.email,
      display_name: user.displayName,
      trusted: user.trusted,
      frames_touched: row?.frames_touched ?? 0,
      verdicts: {
        accept: row?.accepted ?? 0,
        adjust: row?.adjusted ?? 0,
        reject: row?.rejected ?? 0,
      },
    },
    200,
  );
};
