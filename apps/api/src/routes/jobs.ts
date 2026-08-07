import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { Bindings } from "../bindings";
import {
  ChunkFanOut,
  ClaimRequest,
  CompleteRequest,
  errorResponse,
  FanOutRequest,
  HeartbeatRequest,
  ImageReport,
  Job,
  JobIdParam,
  ReportImagesRequest,
  SEGMENT_SECONDS,
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
  operationId: "claimJob",
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
  operationId: "heartbeatJob",
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
  operationId: "completeJob",
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

export const fanOutJobRoute = createRoute({
  method: "post",
  path: "/api/jobs/{id}/fanout",
  operationId: "fanOutJob",
  tags: ["jobs"],
  summary: "Record what a download probed, and enqueue its chunk jobs",
  description:
    "Phase two of CONTEXT.md §Q13's two-phase fan-out. Idempotent on " +
    "`(video_id, segment_index)`, so a download reaped mid-fan-out re-runs " +
    "without duplicating the segments that already exist.",
  request: {
    params: JobIdParam,
    body: { content: { "application/json": { schema: FanOutRequest } }, required: true },
  },
  responses: {
    200: {
      description: "The video's chunk jobs exist",
      content: { "application/json": { schema: ChunkFanOut } },
    },
    400: errorResponse("Malformed job id or body, or a job that is not a download"),
    404: errorResponse("No job with this id is held by this worker"),
  },
});

export const reportImagesRoute = createRoute({
  method: "post",
  path: "/api/jobs/{id}/images",
  operationId: "reportImages",
  tags: ["jobs"],
  summary: "Report the frames a chunk worker extracted, deduplicated and uploaded",
  description:
    "M8.4: writes the image rows and stamps the threshold and config version that " +
    "produced them in the same batch, so a report can never leave the dataset with " +
    "rows nobody's provenance covers. Idempotent on (video_id, timestamp_seconds), " +
    "so a chunk reaped mid-report re-runs without duplicating rows (CONTEXT.md §Q14).",
  request: {
    params: JobIdParam,
    body: { content: { "application/json": { schema: ReportImagesRequest } }, required: true },
  },
  responses: {
    200: {
      description: "The rows exist, and chunks/jobs carry this run's provenance",
      content: { "application/json": { schema: ImageReport } },
    },
    400: errorResponse(
      "Malformed job id or body, frames_kept disagreeing with images.length, or a job that is not a chunk",
    ),
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
  RETURNING id, kind, video_id, attempts, traceparent`,
  )
    .bind(worker_id, claimedAt, claimedAt, claimedAt)
    .first<{
      id: number;
      kind: "download" | "chunk";
      video_id: string;
      attempts: number;
      // Whatever the row that created this job stamped onto it (M9.2) — the
      // submit request for a download, the fan-out request for a chunk.
      // Genuinely null for a job with no stored context, not merely absent.
      traceparent: string | null;
    }>();

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
  // download.
  //
  // Since M7.2 a chunk job with no `chunks` row is corruption rather than a
  // reachable state: the fan-out below writes the pair in one `batch()`. This
  // stays because it is the check that lets that guarantee be a guarantee — if
  // it ever fires, something outside the fan-out wrote a job row, and retiring
  // it is better than handing it out on every poll forever.
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
      // Handed back as stored, not re-derived: the worker extracts it with
      // `propagation.TraceContext` into the context its job spans start from,
      // so a job whose row carries no context (or one that fails to parse)
      // falls back to the root span it would have started anyway (M9.2).
      traceparent: job.traceparent,
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

export const fanOutJobHandler: RouteHandler<typeof fanOutJobRoute, { Bindings: Bindings }> = async (
  c,
) => {
  const { id } = c.req.valid("param");
  const { worker_id, duration_seconds, width, height, title } = c.req.valid("json");

  // Read before writing, which is the one place in this file that happens.
  // The lease cannot be carried into the batch below: the inserts are
  // conditioned on the chunk rows, not on the job, and conditioning each of
  // them on the lease as well would double every statement's bindings to buy
  // very little. If the reaper takes the job back in the gap, the fan-out it
  // was about to do happens anyway and the re-run finds the work already
  // done — the same outcome M7.3 exists to make safe.
  const job = await c.env.DB.prepare(`SELECT kind, video_id FROM jobs WHERE ${HELD_BY}`)
    .bind(id, worker_id)
    .first<{ kind: "download" | "chunk"; video_id: string }>();

  if (!job) return notHeldByCaller(c);

  // 400 rather than 404: the lease is genuine and the worker is who it claims
  // to be. Answering "you do not hold this job" would send it hunting for a
  // lost lease it still holds.
  if (job.kind !== "download") {
    return c.json({ error: "only a download job can be fanned out" }, 400);
  }

  const segments = segmentsFor(duration_seconds);
  const at = now();

  // The trace this request arrived inside (M9.2), read straight off the
  // header rather than through `trace.getActiveSpan()`. The Go worker injects
  // `traceparent` on its outbound call using whichever span was active when
  // it fanned out — a child of the download job's own span, which was itself
  // extracted from what submit stamped on that job's row — so forwarding the
  // header verbatim is what carries the whole chain's trace id onto every
  // chunk this call creates. Absent when tracing produced nothing upstream,
  // in which case every chunk job gets the same null a pre-M9.2 row would
  // have, and the worker's fallback (a root span) is unchanged.
  const traceparent = c.req.header("traceparent") ?? null;

  // One batch, and that is a constraint M3.4 imposed on this endpoint rather
  // than a preference: the claim handler retires a chunk job whose `chunks`
  // row is missing as corruption, which is only correct if the pair can never
  // be observed half-written. D1 wraps a batch in a transaction.
  //
  // Each segment is two statements guarded by the same `NOT EXISTS`, so they
  // insert together or not at all. `last_insert_rowid()` is why the guards
  // have to match: it returns the previous insert's id when a statement
  // inserted nothing, so a chunk insert that ran while its job insert was
  // skipped would attach itself to some other job's row.
  const statements = [
    c.env.DB.prepare(
      `UPDATE videos
          SET duration_seconds = ?,
              width            = ?,
              height           = ?,
              title            = COALESCE(?, title),
              updated_at       = ?
        WHERE id = ?`,
    ).bind(duration_seconds, width, height, title ?? null, at, job.video_id),
  ];

  for (const segment of segments) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO jobs (kind, video_id, traceparent)
              SELECT 'chunk', ?, ?
               WHERE NOT EXISTS (SELECT 1 FROM chunks WHERE video_id = ? AND segment_index = ?)`,
      ).bind(job.video_id, traceparent, job.video_id, segment.index),
      c.env.DB.prepare(
        `INSERT INTO chunks (job_id, video_id, segment_index, start_seconds, end_seconds)
              SELECT last_insert_rowid(), ?, ?, ?, ?
               WHERE NOT EXISTS (SELECT 1 FROM chunks WHERE video_id = ? AND segment_index = ?)`,
      ).bind(job.video_id, segment.index, segment.start, segment.end, job.video_id, segment.index),
    );
  }

  const results = await c.env.DB.batch(statements);

  // Counted from what the database did, not from what was asked for. The
  // difference between the two is the whole of M7.3, and reporting the
  // requested count would make a re-run indistinguishable from a first run.
  // The chunk inserts are every second statement after the metadata update.
  let created = 0;
  for (let i = 2; i < results.length; i += 2) {
    created += results[i]?.meta.changes ?? 0;
  }

  return c.json({ video_id: job.video_id, segments: segments.length, created }, 200);
};

export const reportImagesHandler: RouteHandler<
  typeof reportImagesRoute,
  { Bindings: Bindings }
> = async (c) => {
  const { id } = c.req.valid("param");
  const { worker_id, frames_extracted, frames_kept, dedup_threshold, config_version, images } =
    c.req.valid("json");

  // Checked before touching D1: it costs nothing to verify and a mismatch is
  // always a worker bug, never a race with the reaper. Accepting it would put
  // a dedup ratio in the metrics that no row in `images` backs up — the exact
  // failure this field exists to catch.
  if (frames_kept !== images.length) {
    return c.json(
      { error: `frames_kept (${frames_kept}) must equal images.length (${images.length})` },
      400,
    );
  }

  // One SELECT carries the lease check and the chunk's window in the same
  // round trip — a LEFT JOIN rather than a second query, since the window is
  // exactly what the validation below needs and this handler otherwise has no
  // other reason to read `chunks` before the batch.
  //
  // `video_id` comes from here, not from the request body: a worker that only
  // had to name a video could write image rows against a video it was never
  // assigned, and nothing downstream would catch it before the dashboards did.
  const job = await c.env.DB.prepare(
    `SELECT jobs.kind AS kind, jobs.video_id AS video_id,
            chunks.start_seconds AS start_seconds, chunks.end_seconds AS end_seconds
       FROM jobs
       LEFT JOIN chunks ON chunks.job_id = jobs.id
      WHERE jobs.id = ? AND jobs.status = 'claimed' AND jobs.claimed_by = ?`,
  )
    .bind(id, worker_id)
    .first<{
      kind: "download" | "chunk";
      video_id: string;
      start_seconds: number | null;
      end_seconds: number | null;
    }>();

  if (!job) return notHeldByCaller(c);

  // 400, not 404, for the same reason fan-out answers a download-only request
  // this way: the lease is real, the worker is who it says it is, and what is
  // wrong is the request. A download job has no `chunks` row for this
  // endpoint to update.
  if (job.kind !== "chunk") {
    return c.json({ error: "only a chunk job can report images" }, 400);
  }

  // `start_seconds`/`end_seconds` are only null if this chunk job's `chunks`
  // row is missing — the corruption case M3.4's claim handler already retires
  // before a worker could ever hold this job. Skipped rather than defended
  // again here: there is no reachable path that reaches this line with a null
  // window, and adding one would just be dead code pretending to be a check.
  if (job.start_seconds != null && job.end_seconds != null) {
    const outOfWindow = images.find(
      (image) =>
        image.timestamp_seconds < (job.start_seconds as number) ||
        image.timestamp_seconds > (job.end_seconds as number),
    );
    if (outOfWindow) {
      return c.json(
        {
          error:
            `timestamp_seconds ${outOfWindow.timestamp_seconds} falls outside this chunk's ` +
            `[${job.start_seconds}, ${job.end_seconds}] window`,
        },
        400,
      );
    }
  }

  const at = now();

  // One batch, for the reason M8.4 exists at all: a report that wrote the
  // image rows but failed to stamp `jobs.config_version` would leave rows in
  // `images` whose `dedup_threshold` no `jobs` row corroborates, which is the
  // provenance gap this milestone closes. D1 wraps a batch in a transaction,
  // so the rows and the stamp land together or not at all.
  //
  // `ON CONFLICT(video_id, timestamp_seconds) DO UPDATE` rather than
  // `DO NOTHING`: a reaped chunk re-runs (CONTEXT.md §Q14), and a re-run under
  // a changed threshold must leave the row describing the regime that
  // actually produced the object now sitting in R2 at that row's `r2_key` —
  // `DO NOTHING` would leave the old threshold on a row whose bytes just
  // changed underneath it.
  //
  // `idx_images_identity (video_id, timestamp_seconds)` is the conflict target,
  // but `r2_key` also carries a `UNIQUE`. The two never fight: `r2_key` is
  // derived deterministically from `(video_id, timestamp_seconds)` (migration
  // 0001's comment on the column), so any two rows with the same key already
  // have the same identity, and the conflict clause above fires first.
  const statements = [
    ...images.map((image) =>
      c.env.DB.prepare(
        `INSERT INTO images (r2_key, video_id, timestamp_seconds, phash, dedup_threshold)
              VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(video_id, timestamp_seconds) DO UPDATE SET
              r2_key          = excluded.r2_key,
              phash           = excluded.phash,
              dedup_threshold = excluded.dedup_threshold`,
      ).bind(image.r2_key, job.video_id, image.timestamp_seconds, image.phash, dedup_threshold),
    ),
    // Both updates carry the lease in their `WHERE`, for the reason heartbeat
    // and complete do: the `SELECT` above proved the lease at one instant, and
    // the reaper can take the job back in the gap before the batch runs. The
    // image rows deliberately do not — they are the same deterministic keys
    // and the same bytes whoever holds the lease, so writing them late is
    // harmless, while stamping this run's `config_version` onto a job somebody
    // else is now re-running would describe the wrong regime.
    c.env.DB.prepare(
      `UPDATE chunks SET frames_extracted = ?, frames_kept = ?
        WHERE job_id = ?
          AND EXISTS (SELECT 1 FROM jobs WHERE ${HELD_BY})`,
    ).bind(frames_extracted, frames_kept, id, id, worker_id),
    c.env.DB.prepare(`UPDATE jobs SET config_version = ?, updated_at = ? WHERE ${HELD_BY}`).bind(
      config_version,
      at,
      id,
      worker_id,
    ),
  ];

  await c.env.DB.batch(statements);

  // Every row in the request was written, insert or update — unlike fan-out's
  // `created`, there is no "this already existed" outcome worth surfacing
  // here, because an update still means this run's provenance is now correct
  // on that row.
  return c.json({ video_id: job.video_id, images: images.length }, 200);
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

/**
 * The 60s segments covering a video of `duration` seconds.
 *
 * The last one is short rather than running past the end of the file: ffmpeg
 * would simply stop early, but the row would then claim to cover time the
 * video does not have, and the extracted frame count for it would look wrong
 * against every other chunk.
 */
function segmentsFor(duration: number): { index: number; start: number; end: number }[] {
  const segments = [];

  for (let start = 0, index = 0; start < duration; start += SEGMENT_SECONDS, index++) {
    segments.push({ index, start, end: Math.min(start + SEGMENT_SECONDS, duration) });
  }

  return segments;
}
