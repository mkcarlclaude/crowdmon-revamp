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
} from "../schemas";
import { currentTraceparent } from "../tracing";

/**
 * Prompt dry-runs behind Access (M12.2).
 *
 * The milestone's own sentence: run a candidate prompt against ~50 frames and
 * show the boxes, writing nothing — available *before* activation, because the
 * alternative is discovering a bad prompt after it has pre-labelled a video.
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
 */

/** The shape D1 returns for the join in `listDryRuns`. */
interface DryRunJoinRow {
  id: number;
  job_id: number;
  class_id: number;
  class_name: string;
  video_id: string;
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
  SELECT d.id, d.job_id, d.class_id, c.name AS class_name, j.video_id,
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
  summary: "Try a candidate prompt against a sample of one video's frames",
  description:
    "Enqueues a `dryrun` job. Writes nothing to `predictions` — the boxes land on the " +
    "dry-run's own row and are never label data. The wording is the candidate, not the " +
    "class's current prompt: trying text before saving it is the point. Requires a " +
    "Cloudflare Access assertion.",
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
    404: errorResponse("No class with this id, or no such video"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const createDryRunHandler: RouteHandler<typeof createDryRunRoute, AppEnv> = async (c) => {
  const { id } = c.req.valid("param");
  const { video_id, appearance_prompt } = c.req.valid("json");

  const klass = await c.env.DB.prepare("SELECT id, name FROM classes WHERE id = ?")
    .bind(id)
    .first<{ id: number; name: string }>();

  if (!klass) return c.json({ error: `no class with id ${id}` }, 404);

  const video = await c.env.DB.prepare("SELECT id FROM videos WHERE id = ?")
    .bind(video_id)
    .first<{ id: string }>();

  if (!video) return c.json({ error: `no video with id ${video_id}` }, 404);

  // Checked here rather than left for the worker to discover: a dry-run
  // against a video whose extraction has not produced a frame yet samples
  // nothing, reports nothing, and looks on screen exactly like a prompt that
  // matched nothing — the one confusion this whole surface exists to avoid.
  const pool = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM images WHERE video_id = ?")
    .bind(video_id)
    .first<{ count: number }>();

  if ((pool?.count ?? 0) === 0) {
    return c.json({ error: `${video_id} has no extracted frames to sample yet` }, 400);
  }

  // Two statements, not a batch: the `dryruns` row needs the job id, which
  // only exists once the job insert has run. A failure between them leaves a
  // `dryrun` job with no work definition, which the claim handler retires the
  // same way it retires a chunk job with no `chunks` row — the pre-existing
  // mechanism for exactly this shape of partial write.
  const job = await c.env.DB.prepare(
    "INSERT INTO jobs (kind, video_id, traceparent) VALUES ('dryrun', ?, ?) RETURNING id",
  )
    .bind(video_id, currentTraceparent())
    .first<{ id: number }>();

  if (!job) return c.json({ error: "could not enqueue the dry-run job" }, 400);

  const dryrun = await c.env.DB.prepare(
    `INSERT INTO dryruns (job_id, class_id, appearance_prompt, sample_size, requested_by)
          VALUES (?, ?, ?, ?, ?) RETURNING id, created_at`,
  )
    .bind(
      job.id,
      klass.id,
      appearance_prompt,
      DRYRUN_SAMPLE_SIZE,
      // Set by `requireAccess`, which cannot have been skipped: this path is
      // under `/api/admin/*`. The fallback is not a real state, only the one
      // the type system insists on being told about.
      c.get("adminEmail") ?? "unknown",
    )
    .first<{ id: number; created_at: number }>();

  if (!dryrun) return c.json({ error: "could not record the dry-run" }, 400);

  return c.json(
    {
      id: dryrun.id,
      job_id: job.id,
      class_id: klass.id,
      class_name: klass.name,
      video_id,
      appearance_prompt,
      sample_size: DRYRUN_SAMPLE_SIZE,
      status: "pending" as const,
      failure_reason: null,
      model_id: null,
      // Null, not empty: nothing has run yet, and the difference between that
      // and "the prompt matched nothing" is the whole reading of the screen.
      boxes: null,
      sampled_keys: null,
      requested_by: c.get("adminEmail") ?? "unknown",
      created_at: dryrun.created_at,
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
    "second column. Requires a Cloudflare Access assertion.",
  request: { params: ClassIdParam },
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

  // No 404 for an unknown class: an empty list is the honest answer to "what
  // has this class been tried with", and a class id that does not exist has
  // been tried with nothing.
  const { results } = await c.env.DB.prepare(
    `${SELECT_DRYRUNS} WHERE d.class_id = ? ORDER BY d.id DESC LIMIT ?`,
  )
    .bind(id, DRYRUN_HISTORY)
    .all<DryRunJoinRow>();

  return c.json({ dryruns: results.map(toDryRun) }, 200);
};
