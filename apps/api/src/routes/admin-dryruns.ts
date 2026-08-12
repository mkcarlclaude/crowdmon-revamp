import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../bindings";
import {
  ClassIdParam,
  CreateDryRunRequest,
  DRYRUN_HISTORY,
  DRYRUN_SAMPLE_SIZE,
  DryRun,
  DryRunList,
  type DryRunRow,
  errorResponse,
  ListDryRunsQuery,
} from "../schemas";
import { currentTraceparent } from "../tracing";

/**
 * Prompt dry-runs behind Access (M12.2; M17 plan §A adds the single-frame
 * mode).
 *
 * The milestone's own sentence: run a candidate prompt against a sample of
 * frames and show the boxes, writing nothing — available *before*
 * activation, because the alternative is discovering a bad prompt after it
 * has pre-labelled a video.
 *
 * "Writing nothing" is a claim about the dataset, and it is literal: a dry-run
 * inserts a `jobs` row and a `dryruns` row and touches nothing else. No
 * `predictions`, no `images.selection_reason` stamp — contrast
 * `reportPredictionsHandler`, which writes both. Boxes from a wording nobody
 * has approved must not be indistinguishable from boxes an active class
 * produced, and the way to guarantee that is for them never to enter the table
 * where predictions live (migration 0007's `dryruns.boxes`).
 *
 * A dry-run is a queued job rather than a synchronous call because the
 * detector is on the home box behind a pull topology (CONTEXT.md §Q4) — there
 * is nothing for a Worker to call. What that buys, for free, is everything v1
 * built: the lease, the heartbeat, the reaper, the attempt ceiling, the trace,
 * and a `queue_depth` series that already zero-fills the new kind.
 *
 * Two modes, one route (M17). `CreateDryRunRequest` accepts either `image_id`
 * (iterate wordings against one fixed frame, comparable run over run) or
 * `video_id` (the original random draw across a whole video, kept as the
 * confirmation step before a wording is accepted — see `DRYRUN_SAMPLE_SIZE`'s
 * own comment on why the wide path was not deleted). The two share a handler
 * because they share everything downstream of "what does `dryruns.image_id`
 * and `dryruns.sample_size` get written as" — a class lookup, a `jobs` +
 * `dryruns` batch insert, a 201 echoing what was written. What differs is
 * only how `video_id` and `sample_size` are arrived at, which is exactly what
 * the branch below isolates.
 */

/** The shape D1 returns for the join in `listDryRuns`. */
interface DryRunJoinRow {
  id: number;
  job_id: number;
  class_id: number;
  class_name: string;
  video_id: string;
  image_id: number | null;
  appearance_prompt: string;
  sample_size: number;
  status: "pending" | "claimed" | "done" | "failed";
  failure_reason: string | null;
  model_id: string | null;
  boxes: string | null;
  sampled_keys: string | null;
  requested_by: string;
  created_at: number;
  reported_at: number | null;
}

/**
 * `boxes` and `sampled_keys` are JSON text in D1 (migration 0007 argues why a
 * dry-run's result is a blob rather than rows). Parsed here rather than by the
 * browser, so the shape the contract declares is the shape that goes over the
 * wire — a client receiving a string it had to parse itself would be a client
 * the OpenAPI document lies to.
 *
 * A `null` column stays `null`: it means the worker has not reported, which is
 * a different fact from an empty array (see `DryRun`'s own comment).
 */
function parseJson<T>(value: string | null): T | null {
  return value === null ? null : (JSON.parse(value) as T);
}

const toDryRun = (row: DryRunJoinRow): DryRunRow => ({
  id: row.id,
  job_id: row.job_id,
  class_id: row.class_id,
  class_name: row.class_name,
  video_id: row.video_id,
  image_id: row.image_id,
  appearance_prompt: row.appearance_prompt,
  sample_size: row.sample_size,
  status: row.status,
  failure_reason: row.failure_reason,
  model_id: row.model_id,
  boxes: parseJson<DryRunRow["boxes"]>(row.boxes),
  sampled_keys: parseJson<string[]>(row.sampled_keys),
  requested_by: row.requested_by,
  created_at: row.created_at,
  reported_at: row.reported_at,
});

const SELECT_DRYRUNS = `
  SELECT d.id, d.job_id, d.class_id, c.name AS class_name, j.video_id, d.image_id,
         d.appearance_prompt, d.sample_size, j.status, j.failure_reason,
         d.model_id, d.boxes, d.sampled_keys, d.requested_by, d.created_at,
         d.reported_at
    FROM dryruns d
    JOIN jobs j    ON j.id = d.job_id
    JOIN classes c ON c.id = d.class_id`;

export const createDryRunRoute = createRoute({
  method: "post",
  path: "/api/admin/classes/{id}/dryrun",
  operationId: "createDryRun",
  tags: ["admin"],
  summary: "Try a candidate prompt against one frame, or a sample of a whole video",
  description:
    "Enqueues a `dryrun` job, either against one named frame (`image_id`, iterated " +
    "repeatedly to compare wordings on a fixed input) or a random sample across a whole " +
    "video (`video_id`, the confirmation step before a wording is accepted). Writes " +
    "nothing to `predictions` — the boxes land on the dry-run's own row and are never " +
    "label data. The wording is the candidate, not the class's current prompt: trying " +
    "text before saving it is the point. Requires a Cloudflare Access assertion.",
  request: {
    params: ClassIdParam,
    body: { content: { "application/json": { schema: CreateDryRunRequest } }, required: true },
  },
  responses: {
    201: {
      description: "The dry-run, queued and not yet reported",
      content: { "application/json": { schema: DryRun } },
    },
    400: errorResponse("A malformed body, or a video with no extracted frames to sample"),
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    404: errorResponse("No class with this id, or no such video or image"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const createDryRunHandler: RouteHandler<typeof createDryRunRoute, AppEnv> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const { appearance_prompt } = body;

  const klass = await c.env.DB.prepare("SELECT id, name FROM classes WHERE id = ?")
    .bind(id)
    .first<{ id: number; name: string }>();

  if (!klass) return c.json({ error: `no class with id ${id}` }, 404);

  // The two modes converge here: whichever the caller gave, this block's job
  // is to arrive at the same three facts the batch insert below needs —
  // `video_id` (migration 0008's `CHECK` requires a non-null one for every
  // `dryrun` job), `image_id` (null for the wide mode, `dryruns.image_id`'s
  // own meaning — see migration 0010), and `sample_size`. Two `if` arms
  // rather than a shared helper: `CreateDryRunRequest`'s `superRefine` already
  // guarantees exactly one of `image_id`/`video_id` is set, so there is no
  // third case to unify against, and each arm's lookup is a one-line query
  // with its own 404 message — pulling that into a function would need to
  // return a discriminated result anyway.
  let videoId: string;
  let imageId: number | null;
  let sampleSize: number;

  if (body.image_id !== undefined) {
    // `video_id` is *derived*, not merely looked up for validation: the job
    // this handler is about to write needs it (migration 0008's `CHECK
    // ((kind = 'snapshot') = (video_id IS NULL))` makes it non-optional for a
    // `dryrun` row), and an image already carries the video it was extracted
    // from — there is no second source of truth to reconcile with.
    const image = await c.env.DB.prepare("SELECT video_id FROM images WHERE id = ?")
      .bind(body.image_id)
      .first<{ video_id: string }>();

    if (!image) return c.json({ error: `no image with id ${body.image_id}` }, 404);

    videoId = image.video_id;
    imageId = body.image_id;
    // Always one: the whole point of naming a frame is running the detector
    // on that frame and nothing else. Not `DRYRUN_SAMPLE_SIZE` under any
    // circumstance, even if the caller's video happens to have exactly one
    // extracted frame — this row's `sample_size` has to describe what this
    // run actually did, and a single-frame run never draws a sample.
    sampleSize = 1;
  } else {
    // `body.video_id` — `CreateDryRunRequest`'s `superRefine` guarantees it is
    // set here, since `image_id` was not.
    const video_id = body.video_id as string;

    const video = await c.env.DB.prepare("SELECT id FROM videos WHERE id = ?")
      .bind(video_id)
      .first<{ id: string }>();

    if (!video) return c.json({ error: `no video with id ${video_id}` }, 404);

    // Checked here rather than left for the worker to discover: a dry-run
    // against a video whose extraction has not produced a frame yet samples
    // nothing, reports nothing, and looks on screen exactly like a prompt
    // that matched nothing — the one confusion this whole surface exists to
    // avoid. The single-frame mode above needs no equivalent check: a 404 on
    // the named image already covers "there is nothing to run this against."
    const pool = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM images WHERE video_id = ?")
      .bind(video_id)
      .first<{ count: number }>();

    if ((pool?.count ?? 0) === 0) {
      return c.json({ error: `${video_id} has no extracted frames to sample yet` }, 400);
    }

    videoId = video_id;
    imageId = null;
    sampleSize = DRYRUN_SAMPLE_SIZE;
  }

  // One batch, and it has to be: the job is claimable the instant its row
  // commits, and the worker polls continuously. Two separate round trips leave
  // a window — small, but wide open under a live worker — in which the claim
  // handler finds a `dryrun` job with no `dryruns` row and retires it as
  // unrunnable, while this handler goes on to write the work definition and
  // answer 201. The operator would see a dry-run fail the moment they asked
  // for it, for a reason that is nobody's fault.
  //
  // `last_insert_rowid()` is what makes one batch possible at all: the second
  // statement needs the id the first assigned, and D1 runs a batch as one
  // transaction on one connection, which is exactly the scope that function is
  // defined over. Nothing else in this file needs it — every other two-step
  // write in the API is either idempotent (`submitVideo`) or conditioned on a
  // lease.
  const requestedBy =
    // Set by `requireAccess`, which cannot have been skipped: this path is
    // under `/api/admin/*`. The fallback is not a real state, only the one the
    // type system insists on being told about.
    c.get("adminEmail") ?? "unknown";

  const [job, dryrun] = await c.env.DB.batch<{ id: number; created_at: number }>([
    c.env.DB.prepare(
      "INSERT INTO jobs (kind, video_id, traceparent) VALUES ('dryrun', ?, ?) RETURNING id",
    ).bind(videoId, currentTraceparent()),
    c.env.DB.prepare(
      `INSERT INTO dryruns (job_id, class_id, appearance_prompt, sample_size, requested_by, image_id)
            VALUES (last_insert_rowid(), ?, ?, ?, ?, ?) RETURNING id, created_at`,
    ).bind(klass.id, appearance_prompt, sampleSize, requestedBy, imageId),
  ]);

  const jobId = job?.results[0]?.id;
  const created = dryrun?.results[0];

  if (!jobId || !created) return c.json({ error: "could not enqueue the dry-run job" }, 400);

  return c.json(
    {
      id: created.id,
      job_id: jobId,
      class_id: klass.id,
      class_name: klass.name,
      video_id: videoId,
      image_id: imageId,
      appearance_prompt,
      sample_size: sampleSize,
      status: "pending" as const,
      failure_reason: null,
      model_id: null,
      // Null, not empty: nothing has run yet, and the difference between that
      // and "the prompt matched nothing" is the whole reading of the screen.
      boxes: null,
      sampled_keys: null,
      requested_by: requestedBy,
      created_at: created.created_at,
      reported_at: null,
    },
    201,
  );
};

export const listDryRunsRoute = createRoute({
  method: "get",
  path: "/api/admin/classes/{id}/dryruns",
  operationId: "listDryRuns",
  tags: ["admin"],
  summary: "This class's recent dry-runs, newest first",
  description:
    `The ${DRYRUN_HISTORY} most recent dry-runs for one class, with their boxes inline. ` +
    "`status` is joined from the job rather than duplicated onto the dry-run, so a run " +
    "the reaper took back reads as `pending` here without anything having to update a " +
    "second column. An optional `image_id` narrows this to one frame's own attempts (M17, " +
    "plan §A) — what a comparison strip iterating wordings against a fixed frame actually " +
    "wants, rather than `DRYRUN_HISTORY` rows that might mix in a different frame's runs. " +
    "Requires a Cloudflare Access assertion.",
  request: { params: ClassIdParam, query: ListDryRunsQuery },
  responses: {
    200: {
      description: "Dry-runs, newest first",
      content: { "application/json": { schema: DryRunList } },
    },
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const listDryRunsHandler: RouteHandler<typeof listDryRunsRoute, AppEnv> = async (c) => {
  const { id } = c.req.valid("param");
  const { image_id } = c.req.valid("query");

  // No 404 for an unknown class: an empty list is the honest answer to "what
  // has this class been tried with", and a class id that does not exist has
  // been tried with nothing. Same posture extends to `image_id`: a frame
  // nobody has dry-run yet (or that does not exist) simply has no rows.
  //
  // `idx_dryruns_class (class_id, id DESC)` (migration 0007) already serves
  // the ordering for both the filtered and unfiltered query — adding
  // `d.image_id = ?` to the `WHERE` clause narrows what the index scan
  // returns without changing which index SQLite reaches for.
  const { results } = await c.env.DB.prepare(
    image_id === undefined
      ? `${SELECT_DRYRUNS} WHERE d.class_id = ? ORDER BY d.id DESC LIMIT ?`
      : `${SELECT_DRYRUNS} WHERE d.class_id = ? AND d.image_id = ? ORDER BY d.id DESC LIMIT ?`,
  )
    .bind(...(image_id === undefined ? [id, DRYRUN_HISTORY] : [id, image_id, DRYRUN_HISTORY]))
    .all<DryRunJoinRow>();

  return c.json({ dryruns: results.map(toDryRun) }, 200);
};
