import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../bindings";
import { chunkForBinding, placeholders } from "../d1";
import { AdminVideoIdParam, CreatePrelabelRequest, errorResponse, PrelabelJob } from "../schemas";
import { currentTraceparent } from "../tracing";

/**
 * On-demand supplementary prelabel (M17, plan §B).
 *
 * The verification pool (`admin-labelling.ts`'s `UNRULED_BOX`) drains
 * monotonically as an admin works, and nothing before this milestone could
 * refill it: `prelabel` ran exactly once per video, automatically, enforced
 * by a unique index (migration 0005). This route is the refill — an admin
 * queues a second (or third, or Nth) `prelabel` job over an explicit set of
 * not-yet-sampled frames, chosen either by hand or by a random draw over the
 * remainder.
 *
 * **The automatic first pass is untouched.** v2's done-claim ("a submitted
 * video becomes pre-labelled frames with no human trigger", `PRD.md` §9) is
 * about that pass, and this route adds work on top of it rather than
 * replacing anything `completeJobHandler`'s auto-enqueue does.
 *
 * **The two modes stamp two different `selection_reason` values, and that
 * distinction is the entire point.** `CONTEXT.md` §Q16: `random` images form
 * a permanent evaluation pool excluded from training forever, and an image
 * can never be retro-declared unbiased once it is chosen some other way. A
 * hand-picked set is a biased sample by construction, so it stamps `manual`
 * — a value outside `splitFor`'s (`worker/internal/snapshot/builder.go`)
 * one-line rule only in name, since anything that is not `random` already
 * lands in `train`. A random draw over the not-yet-sampled remainder is
 * still an unbiased draw over what is left, so it keeps writing `random` and
 * lands in `eval`, same as the automatic first pass always has.
 *
 * **The write-once guard lives in the same migration as the index it
 * replaces (0011), and this route is the reason.** Before this route
 * existed, `idx_jobs_one_prelabel_per_video` guaranteed an image could only
 * ever be sampled once, which was what made
 * `reportPredictionsHandler`'s unconditional `selection_reason = 'random'`
 * write safe. This route is the second, on-demand pass the index used to
 * forbid outright — so before it could exist at all, the stamp had to become
 * conditional (`AND selection_reason IS NULL`, `jobs.ts`). This route is the
 * *backstop's* backstop: it refuses to enqueue a job over an
 * already-sampled image in the first place, so the SQL guard should never
 * actually have to fire for a request that came through here. Both layers
 * stay, because a caller that bypassed this route (or a future one that
 * forgets to check) still hits the guard in SQL rather than the dataset.
 */

interface CandidateImageRow {
  id: number;
  selection_reason: string | null;
}

export const createPrelabelRoute = createRoute({
  method: "post",
  path: "/api/admin/videos/{id}/prelabel",
  operationId: "createPrelabel",
  tags: ["admin"],
  summary: "Queue a supplementary prelabel pass over a hand-picked or randomised frame set",
  description:
    "Enqueues a `prelabel` job over an explicit set of not-yet-sampled frames from one " +
    "video — `image_ids` for a hand-picked set (stamps `manual`), or `{count, " +
    "strategy:'random'}` for a server-drawn random sample of the not-yet-sampled " +
    "remainder (stamps `random`, same as the automatic first pass). One `batch()`: the " +
    "job and its `prelabel_images` rows are written atomically, so the claim handler can " +
    "never observe a prelabel job whose selection is half-written. Requires a Cloudflare " +
    "Access assertion.",
  request: {
    params: AdminVideoIdParam,
    body: { content: { "application/json": { schema: CreatePrelabelRequest } }, required: true },
  },
  responses: {
    201: {
      description: "The supplementary prelabel job, queued",
      content: { "application/json": { schema: PrelabelJob } },
    },
    400: errorResponse(
      "A malformed body, an image already carrying a selection_reason, or a random draw " +
        "with nothing left to sample",
    ),
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    404: errorResponse("No video with this id, or a hand-picked image id this video does not have"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const createPrelabelHandler: RouteHandler<typeof createPrelabelRoute, AppEnv> = async (
  c,
) => {
  const { id: videoId } = c.req.valid("param");
  const body = c.req.valid("json");

  const video = await c.env.DB.prepare("SELECT id FROM videos WHERE id = ?")
    .bind(videoId)
    .first<{ id: string }>();

  if (!video) return c.json({ error: `no video with id ${videoId}` }, 404);

  // The two modes converge here: whichever the caller gave, this block's job
  // is to arrive at `imageIds` (the rows `prelabel_images` will carry) and
  // `selectionReason` (what this job's report will stamp onto every one of
  // them) — `createDryRunHandler`'s own two-`if`-arms shape, for the same
  // reason: `CreatePrelabelRequest`'s `superRefine` already guarantees
  // exactly one mode, so there is no third case to unify against.
  let imageIds: number[];
  let selectionReason: "random" | "manual";

  if (body.image_ids !== undefined) {
    selectionReason = "manual";

    // De-duplicated before it ever reaches D1: a caller naming the same id
    // twice must not collide against `prelabel_images`' own
    // `(job_id, image_id)` primary key, and de-duplicating here answers that
    // once rather than asking every statement below to tolerate a repeat.
    const requested = [...new Set(body.image_ids)];

    // Scoped by `video_id` in the same query as the existence check, the way
    // `reportPredictionsHandler` resolves `r2_key` scoped to `job.video_id`:
    // an id that is real but belongs to a different video must not resolve
    // here, or a hand-picked set could reach across videos through a typo.
    const lookups = await c.env.DB.batch<CandidateImageRow>(
      chunkForBinding(requested, 1).map((ids) =>
        c.env.DB.prepare(
          `SELECT id, selection_reason FROM images
            WHERE video_id = ? AND id IN (${placeholders(ids)})`,
        ).bind(videoId, ...ids),
      ),
    );

    const found = new Map(
      lookups.flatMap((result) => result.results.map((row) => [row.id, row.selection_reason])),
    );

    const unknown = requested.filter((imageId) => !found.has(imageId));
    if (unknown.length > 0) {
      return c.json({ error: `no image with id in ${videoId}: ${unknown.join(", ")}` }, 404);
    }

    // The API-side half of the write-once guard (see this module's own
    // comment): refused here, by name, rather than left for the SQL guard in
    // `reportPredictionsHandler` to silently no-op on later. A caller
    // reading "already sampled: 7, 12" learns something a silent no-op two
    // steps later never would.
    const alreadySampled = requested.filter((imageId) => found.get(imageId) != null);
    if (alreadySampled.length > 0) {
      return c.json(
        {
          error: `already sampled by an earlier pass, refusing to re-include: ${alreadySampled.join(", ")}`,
        },
        400,
      );
    }

    imageIds = requested;
  } else {
    selectionReason = "random";
    const count = body.count as number;

    // The unsampled remainder this video has left, in the same order
    // `listVideoImagesHandler` reads its own candidate pool — `ORDER BY
    // RANDOM()` draws uniformly from it, matching what the automatic first
    // pass's own `Sampler` intends (a draw with no bias toward any part of
    // the timeline), just performed in SQL instead of Go, because the whole
    // point of this endpoint is that selection happens here rather than in
    // the worker.
    const { results } = await c.env.DB.prepare(
      `SELECT id FROM images
        WHERE video_id = ? AND selection_reason IS NULL
        ORDER BY RANDOM() LIMIT ?`,
    )
      .bind(videoId, count)
      .all<{ id: number }>();

    imageIds = results.map((row) => row.id);

    if (imageIds.length === 0) {
      return c.json({ error: `${videoId} has no un-sampled frames left to draw from` }, 400);
    }
    // Fewer than `count` available is not an error: a pool of 30 un-sampled
    // frames answering a request for 50 with "here are the 30 I have" is a
    // more useful response than a 400 that makes the caller re-ask for the
    // exact remaining size, which they would have to query for separately
    // to learn in the first place.
  }

  const traceparent = currentTraceparent();

  // One batch, for `createDryRunHandler`'s reason and a sharper one: the
  // claim endpoint is kind-agnostic and polls continuously, so two separate
  // round trips would leave a window in which a `prelabel` job exists with
  // no `prelabel_images` rows behind it yet — worse than a merely-unrunnable
  // job, because nothing here retires it as corruption the way the claim
  // handler does for a chunk job missing its `chunks` row. The plan's own
  // "Rollout hazard" section is about a *different* half-written state (an
  // old worker ignoring a list it does not know how to read); this batch is
  // what keeps the list itself from ever being observed half-written.
  //
  // `(SELECT id FROM jobs ORDER BY id DESC LIMIT 1)` stands in for
  // `last_insert_rowid()` here rather than reusing it directly.
  // `fanOutJobHandler` (`jobs.ts`) can use `last_insert_rowid()` because it
  // alternates one `jobs` insert with exactly one dependent row, over and
  // over — the id it needs is always the *previous* statement's. This
  // handler's shape is one `jobs` row followed by up to
  // `MAX_SAMPLED_IMAGES_PER_JOB` dependent rows, chunked below to respect
  // D1's 100-bound-param ceiling per statement; the *second* chunk's insert
  // would see `last_insert_rowid()` pointing at whichever `prelabel_images`
  // row the *first* chunk inserted last, not at the job. The subquery does
  // not have that problem: every statement in this batch runs inside one
  // transaction, so "the highest `jobs.id` that exists right now" can only
  // ever be the row this batch's own first statement just inserted — no
  // concurrent writer can interleave a higher one, because D1 serialises
  // writers and this whole batch is one write.
  const statements = [
    c.env.DB.prepare(
      `INSERT INTO jobs (kind, video_id, traceparent, selection_reason)
            VALUES ('prelabel', ?, ?, ?)
       RETURNING id`,
    ).bind(videoId, traceparent, selectionReason),
    // One statement per image rather than a chunked multi-row `VALUES`
    // list: each statement here binds exactly one parameter (the image id;
    // `job_id` comes from the subquery above, not a bound value), so the
    // 100-bound-param ceiling `D1_MAX_BOUND_PARAMS` exists to guard against
    // is not something a batch of these can ever approach — `predictions`
    // rows already commit this codebase to "one statement per row, however
    // many rows, in one batch" for exactly this reason
    // (`reportPredictionsHandler`, up to `MAX_PREDICTIONS_PER_JOB`
    // statements). This *is* "chunking the inserts" in the sense the D1 ceiling
    // asks for — chunked down to one row per statement, which is the
    // smallest chunk there is.
    ...imageIds.map((imageId) =>
      c.env.DB.prepare(
        `INSERT INTO prelabel_images (job_id, image_id)
              VALUES ((SELECT id FROM jobs ORDER BY id DESC LIMIT 1), ?)`,
      ).bind(imageId),
    ),
  ];

  const results = await c.env.DB.batch<{ id: number }>(statements);
  const jobId = results[0]?.results[0]?.id;

  if (!jobId) return c.json({ error: "could not enqueue the prelabel job" }, 400);

  return c.json(
    {
      job_id: jobId,
      video_id: videoId,
      selection_reason: selectionReason,
      images: imageIds.length,
    },
    201,
  );
};
