import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { Bindings } from "../bindings";
import {
  ClaimRequest,
  CompleteRequest,
  errorResponse,
  HeartbeatRequest,
  Job,
  JobIdParam,
} from "../schemas";

/**
 * The queue endpoints the Go worker drives (CONTEXT.md §Q14).
 *
 * The queue is a D1 table because Cloudflare Queues needs the Workers Paid
 * plan. Everything here leans on SQLite serialising writers: the claim is one
 * `UPDATE ... RETURNING`, and heartbeat and complete carry their ownership
 * check in the `WHERE` clause rather than reading the row first and writing it
 * back.
 */

/**
 * Unix epoch seconds, matching the schema's `strftime('%s','now')` defaults.
 * The reaper compares `heartbeat_at` against now on every tick, and integer
 * comparison needs no parsing.
 */
const now = () => Math.floor(Date.now() / 1000);

/**
 * The predicate that means "this worker currently holds this job".
 *
 * Shared by heartbeat and complete, and inlined into their `UPDATE`s rather
 * than checked first with a `SELECT`: a read-then-write would let the reaper
 * take the job back in between, and the worker would go on writing to a lease
 * it no longer holds.
 */
const HELD_BY = "id = ? AND status = 'claimed' AND claimed_by = ?";

/**
 * The answer when `HELD_BY` matched nothing — the other half of that predicate,
 * kept beside it so the two cannot drift.
 *
 * Zero rows changed covers both "no such job" and "the reaper took it back",
 * and the two are deliberately not distinguished: the worker's response is the
 * same either way, which is to stop.
 */
const notHeldByCaller = (c: Context<{ Bindings: Bindings }>) =>
  c.json({ error: "no job with this id is held by this worker" }, 404);

export const claimJobRoute = createRoute({
  method: "post",
  path: "/api/jobs/claim",
  tags: ["jobs"],
  summary: "Claim the next pending job",
  description:
    "Atomic: the claim is a single `UPDATE ... WHERE status='pending' ... RETURNING`, " +
    "so two workers polling at once cannot take the same row.",
  request: {
    body: { content: { "application/json": { schema: ClaimRequest } }, required: true },
  },
  responses: {
    200: {
      description: "A job was claimed",
      content: { "application/json": { schema: Job } },
    },
    // Distinct from 200-with-null so the worker's backoff (CONTEXT.md §Q20)
    // branches on the status line rather than parsing a body to find out that
    // there was nothing in it. Empty polls are the common case by far.
    204: { description: "Nothing to claim" },
    400: errorResponse("Malformed request body"),
  },
});

export const heartbeatRoute = createRoute({
  method: "post",
  path: "/api/jobs/{id}/heartbeat",
  tags: ["jobs"],
  summary: "Renew the lease on a held job",
  description:
    "Called every 30s while a job is held. Missing heartbeats are what the reaper " +
    "watches for; a job whose `heartbeat_at` goes stale returns to `pending`.",
  request: {
    params: JobIdParam,
    body: { content: { "application/json": { schema: HeartbeatRequest } }, required: true },
  },
  responses: {
    204: { description: "Lease renewed" },
    400: errorResponse("Malformed job id or body"),
    // Also the answer when the job exists but this worker no longer holds it,
    // because the reaper took it back. Deliberately not distinguished from a
    // missing job: the worker's response is identical either way — stop.
    404: errorResponse("No job with this id is held by this worker"),
  },
});

export const completeJobRoute = createRoute({
  method: "post",
  path: "/api/jobs/{id}/complete",
  tags: ["jobs"],
  summary: "Report a held job as done or failed",
  request: {
    params: JobIdParam,
    body: { content: { "application/json": { schema: CompleteRequest } }, required: true },
  },
  responses: {
    204: { description: "Outcome recorded" },
    400: errorResponse("Malformed job id or body"),
    404: errorResponse("No job with this id is held by this worker"),
  },
});

export const claimJobHandler: RouteHandler<typeof claimJobRoute, { Bindings: Bindings }> = async (
  c,
) => {
  const { worker_id } = c.req.valid("json");
  const claimedAt = now();

  // One statement, and that is the whole concurrency argument: SQLite
  // serialises writers, so two workers racing here cannot both come back with
  // the same row. A `SELECT` followed by an `UPDATE` would hand the same job
  // out twice under exactly the polling pattern the worker is designed around.
  //
  // The subquery picks the oldest pending job; `idx_jobs_claimable` covers it.
  // `attempts` is incremented on the claim, not on a later failure, so a
  // worker that dies without reporting still counts against the ceiling.
  const job = await c.env.DB.prepare(
    `UPDATE jobs
        SET status       = 'claimed',
            claimed_by   = ?,
            claimed_at   = ?,
            heartbeat_at = ?,
            attempts     = attempts + 1,
            updated_at   = ?
      WHERE id = (SELECT id FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1)
  RETURNING id, kind, video_id, attempts`,
  )
    .bind(worker_id, claimedAt, claimedAt, claimedAt)
    .first<{ id: number; kind: "download" | "chunk"; video_id: string; attempts: number }>();

  if (!job) return c.body(null, 204);

  // The work definition lives across two other tables, and `RETURNING` cannot
  // join. Read after the claim rather than before: the job is already this
  // worker's by the time these run, so nothing can change underneath them.
  const video = await c.env.DB.prepare("SELECT url FROM videos WHERE id = ?")
    .bind(job.video_id)
    .first<{ url: string }>();

  const chunk =
    job.kind === "chunk"
      ? await c.env.DB.prepare(
          "SELECT segment_index, start_seconds, end_seconds FROM chunks WHERE job_id = ?",
        )
          .bind(job.id)
          .first<{ segment_index: number; start_seconds: number; end_seconds: number }>()
      : null;

  // A job whose work definition is incomplete cannot be run, and handing it
  // out anyway only moves the discovery to the worker, an hour later, after a
  // download. Chunk fan-out is not transactional (CONTEXT.md §Q13) — it can be
  // reaped halfway through — so a chunk job with no `chunks` row is a state
  // the system can genuinely reach, not just a hand-edited database.
  if (!video) return failUnrunnable(c, job.id, "video row missing");
  if (job.kind === "chunk" && !chunk) {
    return failUnrunnable(c, job.id, "chunk row missing");
  }

  return c.json(
    {
      id: job.id,
      kind: job.kind,
      video_id: job.video_id,
      video_url: video.url,
      attempts: job.attempts,
      ...(chunk ? { chunk } : {}),
    },
    200,
  );
};

/**
 * Retires a job that can never succeed, and answers as if the queue were
 * empty.
 *
 * Terminal rather than back to `pending`: re-queueing would hand the same
 * broken job out again on the very next poll, forever. 204 rather than an
 * error, because from the worker's side nothing went wrong — there was simply
 * nothing it could be given.
 */
async function failUnrunnable(c: Context<{ Bindings: Bindings }>, jobId: number, reason: string) {
  await c.env.DB.prepare(
    "UPDATE jobs SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?",
  )
    .bind(reason, now(), jobId)
    .run();

  return c.body(null, 204);
}

export const heartbeatHandler: RouteHandler<typeof heartbeatRoute, { Bindings: Bindings }> = async (
  c,
) => {
  const { id } = c.req.valid("param");
  const { worker_id } = c.req.valid("json");

  const at = now();
  const { meta } = await c.env.DB.prepare(
    `UPDATE jobs SET heartbeat_at = ?, updated_at = ? WHERE ${HELD_BY}`,
  )
    .bind(at, at, id, worker_id)
    .run();

  if (meta.changes === 0) return notHeldByCaller(c);

  return c.body(null, 204);
};

export const completeJobHandler: RouteHandler<
  typeof completeJobRoute,
  { Bindings: Bindings }
> = async (c) => {
  const { id } = c.req.valid("param");
  const { worker_id, status, failure_reason } = c.req.valid("json");

  // `claimed_by` is cleared on the way out so a finished row cannot be
  // mistaken for a held one, and the reaper's partial index stops covering it.
  const { meta } = await c.env.DB.prepare(
    `UPDATE jobs
        SET status         = ?,
            failure_reason = ?,
            claimed_by     = NULL,
            heartbeat_at   = NULL,
            updated_at     = ?
      WHERE ${HELD_BY}`,
  )
    .bind(status, status === "failed" ? (failure_reason ?? null) : null, now(), id, worker_id)
    .run();

  if (meta.changes === 0) return notHeldByCaller(c);

  return c.body(null, 204);
};
