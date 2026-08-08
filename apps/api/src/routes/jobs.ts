import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import { trace } from "@opentelemetry/api";
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
  JobStats,
  ListVideoImagesQuery,
  PredictionReport,
  ReportImagesRequest,
  ReportPredictionsRequest,
  SEGMENT_SECONDS,
  VideoIdParam,
  VideoImages,
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

export const reportPredictionsRoute = createRoute({
  method: "post",
  path: "/api/jobs/{id}/predictions",
  operationId: "reportPredictions",
  tags: ["jobs"],
  summary: "Report the boxes a prelabel worker's detector proposed",
  description:
    "M10.3: one call per job, not one per box — a prelabel job (M11.1) covers a whole " +
    "video's sampled frames in a single report, the same shape `reportImages` established " +
    "for chunk jobs. Writes every row in one D1 batch, so a partial write can never leave " +
    "predictions nobody's provenance covers. Insert-only: nothing here issues an UPDATE " +
    "against `predictions` (migration 0003), and unlike `reportImages` there is no " +
    "`ON CONFLICT` — a re-run after a reap writes the same boxes again as new rows rather " +
    "than replacing anything, a gap left open deliberately rather than closed here (see the " +
    "handler's own comment).",
  request: {
    params: JobIdParam,
    body: {
      content: { "application/json": { schema: ReportPredictionsRequest } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "The prediction rows exist",
      content: { "application/json": { schema: PredictionReport } },
    },
    400: errorResponse(
      "Malformed job id or body, or a prediction naming an r2_key or class_name that does not exist",
    ),
    404: errorResponse("No job with this id is held by this worker"),
  },
});

export const listVideoImagesRoute = createRoute({
  method: "get",
  path: "/api/videos/{video_id}/images",
  operationId: "listVideoImages",
  tags: ["jobs"],
  summary: "The candidate pool a prelabel job's sampler draws from",
  description:
    "M11.3: every row `reportImages` has written for this video, oldest timestamp " +
    "first — the whole pool `ImageSampler.Sample` (worker/internal/worker/pipeline.go) " +
    "draws its bounded, timeline-spread subset from. Scoped by video id rather than by " +
    "job id, unlike every other worker-facing route in this file: `Sample`'s signature " +
    "is handed only a video id (it is called once per video, not once per job — the " +
    "same reason `prelabel` is one job per video rather than one per chunk), so the " +
    "lease check below reads `idx_jobs_one_prelabel_per_video` (migration 0005) instead " +
    "of a job's primary key. That partial unique index already guarantees at most one " +
    "held prelabel job per video, which is exactly the lease this read needs to prove — " +
    "the same strength of guarantee `HELD_BY` gives every job-id-scoped route here, " +
    "just proved through a different column. No Access assertion and no credential " +
    "beyond `worker_id`: the same trust tier as the rest of `/api/jobs/*` " +
    "(`jobStatsRoute`'s own comment explains why that boundary is where it is).",
  request: { params: VideoIdParam, query: ListVideoImagesQuery },
  responses: {
    200: {
      description: "Every image row for this video",
      content: { "application/json": { schema: VideoImages } },
    },
    400: errorResponse("Malformed video id or worker id"),
    404: errorResponse("No prelabel job for this video is held by this worker"),
  },
});

export const jobStatsRoute = createRoute({
  method: "get",
  path: "/api/jobs/stats",
  operationId: "jobStats",
  tags: ["jobs"],
  summary: "Job counts by status and kind",
  description:
    "The only place queue depth can be read from (CONTEXT.md §6: Workers export traces " +
    "only, and Prometheus cannot scrape a Worker). The Go worker polls this once per " +
    "metrics export interval and republishes it as the `queue_depth{status,kind}` gauge " +
    "Prometheus actually scrapes (worker/internal/telemetry/metrics.go) — the dashboard's " +
    "queue-depth panel reads that gauge, never this endpoint directly. Sits beside claim, " +
    "heartbeat and complete rather than under `/api/admin/*`: same trust boundary as the " +
    "rest of `/api/jobs/*`, which carries no Access assertion and no worker-id credential " +
    "today, and this endpoint is read-only besides — a stray caller learns nothing here " +
    "it could not already infer by polling claim until it stopped returning 200.",
  responses: {
    200: {
      description: "Every (status, kind) combination, zero-filled where D1 has no rows",
      content: { "application/json": { schema: JobStats } },
    },
  },
});

export const jobStatsHandler: RouteHandler<typeof jobStatsRoute, { Bindings: Bindings }> = async (
  c,
) => {
  // One statement, one GROUP BY — the task's own constraint, and it is enough:
  // this is a dashboard read on an interval, not a lease operation, so there
  // is nothing here that needs a transaction or a second round trip.
  const { results } = await c.env.DB.prepare(
    "SELECT status, kind, COUNT(*) AS count FROM jobs GROUP BY status, kind",
  ).all<{
    status: "pending" | "claimed" | "done" | "failed";
    kind: "download" | "chunk" | "prelabel";
    count: number;
  }>();

  // Every combination starts at zero and only the ones D1 actually returned
  // overwrite it. This is the zero-fill `JobStats`' own comment (schemas.ts)
  // promises the Go worker's gauge callback it will never have to do itself —
  // seeing this shape is what lets that callback report a drained queue as
  // twelve zeros instead of twelve absences. `GROUP BY status, kind` itself
  // needed no change for `prelabel` to show up in `results` — only this
  // literal, naming every combination up front, has to grow with the kind.
  const counts = {
    pending: { download: 0, chunk: 0, prelabel: 0 },
    claimed: { download: 0, chunk: 0, prelabel: 0 },
    done: { download: 0, chunk: 0, prelabel: 0 },
    failed: { download: 0, chunk: 0, prelabel: 0 },
  };

  for (const row of results) {
    counts[row.status][row.kind] = row.count;
  }

  return c.json(counts, 200);
};

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
  RETURNING id, kind, video_id, attempts, traceparent, created_at`,
  )
    .bind(worker_id, claimedAt, claimedAt, claimedAt)
    .first<{
      id: number;
      kind: "download" | "chunk" | "prelabel";
      video_id: string;
      attempts: number;
      // Whatever the row that created this job stamped onto it (M9.2) — the
      // submit request for a download, the fan-out request for a chunk.
      // Genuinely null for a job with no stored context, not merely absent.
      traceparent: string | null;
      // Free on this statement — one more column on a `RETURNING` clause the
      // claim already pays for — and the only way to compute queue wait
      // without a second round trip (M9.2's `job.claimed` span).
      created_at: number;
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
      // `claimedAt` came from this isolate's clock (`now()`, above);
      // `created_at` was stamped
      // by D1's own `strftime('%s','now')` at insert time, on a different
      // clock than this Worker's. The two are close enough in practice that
      // this is worth reporting, but not provably monotonic against each
      // other, so the subtraction is clamped rather than trusted to always
      // land on the right side of zero — `queue_wait_seconds` is declared
      // `.nonnegative()` in the contract, and a claim landing within the same
      // second a fast-drifting clock pair disagreed about would otherwise
      // fail that validation on the way out.
      queue_wait_seconds: Math.max(0, claimedAt - job.created_at),
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
    .first<{ kind: "download" | "chunk" | "prelabel"; video_id: string }>();

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
      kind: "download" | "chunk" | "prelabel";
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

/**
 * Builds a `column IN (?, ?, ...)` fragment sized to `values`, so the lookups
 * below resolve a whole report's worth of handles in a handful of statements
 * rather than one `SELECT` per prediction.
 */
const placeholders = (values: unknown[]) => values.map(() => "?").join(",");

/**
 * D1 rejects a query carrying more than 100 bound parameters, and that limit
 * is per *statement* — batching does not pool it.
 *
 * This is a real bound on the lookups below, not a theoretical one. M11.3
 * samples 200 images per video by default, so a report naming a distinct
 * `r2_key` for each would put 200 of them into one `IN (...)` and be rejected
 * by D1 before a single row was read. The tests that exercise a handful of
 * keys cannot see it, which is exactly why the chunking is stated here rather
 * than left to whatever size the first report happens to be.
 */
const D1_MAX_BOUND_PARAMS = 100;

/** Splits `values` into runs no query built from one of them can exceed D1's limit. */
function chunkForBinding<T>(values: T[], reservedParams = 0): T[][] {
  const size = D1_MAX_BOUND_PARAMS - reservedParams;
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

export const reportPredictionsHandler: RouteHandler<
  typeof reportPredictionsRoute,
  { Bindings: Bindings }
> = async (c) => {
  const { id } = c.req.valid("param");
  const { worker_id, model_id, predictions, sampled_images } = c.req.valid("json");

  // Same lease check as every other write on a held job (heartbeat, complete,
  // fanout, report-images): a request that only knew a job id could write
  // prediction rows against somebody else's job.
  const job = await c.env.DB.prepare(`SELECT kind, video_id FROM jobs WHERE ${HELD_BY}`)
    .bind(id, worker_id)
    .first<{ kind: "download" | "chunk" | "prelabel"; video_id: string }>();

  if (!job) return notHeldByCaller(c);

  // M11.1 (migration 0005) is what makes this check possible: `jobs.kind`
  // admitted only `download` and `chunk` before it, so there was nothing to
  // assert `prelabel` against and any held lease qualified. 400, not 404, for
  // the same reason `reportImages` answers a wrong-kind request this way: the
  // lease is genuine and the worker is who it says it is, and what is wrong
  // is the request — a 404 would send it hunting for a lost lease it still
  // holds.
  if (job.kind !== "prelabel") {
    return c.json({ error: "only a prelabel job can report predictions" }, 400);
  }

  // A genuinely empty report is well-formed (a detector finding nothing is a
  // real outcome, not an error) and skipping straight to the answer avoids an
  // `IN ()` with no placeholders below, which is invalid SQL. Both arrays have
  // to be empty for this to fire: `predictions` alone being empty is the
  // common case (M11.3's whole sample can come back with nothing detected),
  // but `sampled_images` still needs its stamp written in that case, so only
  // "nothing was sampled and nothing was found" short-circuits here.
  if (predictions.length === 0 && sampled_images.length === 0) {
    return c.json({ video_id: job.video_id, predictions: 0 }, 200);
  }

  // Resolves the worker's natural handles — `r2_key` and `classes.name`
  // (`PredictionBox`'s own comment explains why those, not `image_id` and
  // `class_id`) — into the ids `predictions` actually stores, before writing
  // anything. Two lookups rather than trusting the request or letting a bad
  // reference surface as an FK error from the insert: this is what turns
  // "worker named an image or class that does not exist" into a 400 that
  // names which one, instead of a D1 constraint failure with no field to
  // point at.
  //
  // `r2Keys` is the union of `predictions`' and `sampled_images`' keys, not
  // just the former: `sampled_images` gets no insert of its own (the stamp
  // below is an UPDATE against rows that already exist), but a worker naming
  // an r2_key that does not exist is exactly as much a bug there as it is in
  // `predictions`, and folding the two into one lookup means one unified
  // "unknown r2_key" 400 covers both instead of the stamp silently no-op'ing
  // on a typo'd key.
  //
  // Images are scoped to `job.video_id`, the same way `reportImages` reads
  // `video_id` off the held job rather than the body: an r2_key that is real
  // but belongs to a different video must not resolve here, or a worker
  // could write predictions against a video it was never assigned.
  const r2Keys = [...new Set([...predictions.map((p) => p.r2_key), ...sampled_images])];
  const classNames = [...new Set(predictions.map((p) => p.class_name))];

  // Chunked against D1_MAX_BOUND_PARAMS. The image lookup reserves one
  // parameter for `video_id`, which every chunk has to re-bind.
  const lookups = await c.env.DB.batch<{ id: number; handle: string }>([
    ...chunkForBinding(r2Keys, 1).map((keys) =>
      c.env.DB.prepare(
        `SELECT id, r2_key AS handle FROM images
          WHERE video_id = ? AND r2_key IN (${placeholders(keys)})`,
      ).bind(job.video_id, ...keys),
    ),
    ...chunkForBinding(classNames).map((names) =>
      c.env.DB.prepare(
        `SELECT id, name AS handle FROM classes WHERE name IN (${placeholders(names)})`,
      ).bind(...names),
    ),
  ]);

  // Split back apart by position: the image chunks were queued first, so the
  // first `imageChunks` results are theirs and the rest are the classes'.
  const imageChunks = chunkForBinding(r2Keys, 1).length;
  const rowsOf = (results: (typeof lookups)[number][]) =>
    new Map(results.flatMap((result) => result.results.map((row) => [row.handle, row.id])));

  const imageIdByKey = rowsOf(lookups.slice(0, imageChunks));
  const classIdByName = rowsOf(lookups.slice(imageChunks));

  const unknownKeys = r2Keys.filter((key) => !imageIdByKey.has(key));
  const unknownClasses = classNames.filter((name) => !classIdByName.has(name));

  if (unknownKeys.length > 0 || unknownClasses.length > 0) {
    const parts: string[] = [];
    if (unknownKeys.length > 0) parts.push(`unknown r2_key: ${unknownKeys.join(", ")}`);
    if (unknownClasses.length > 0) {
      parts.push(`unknown class_name: ${unknownClasses.join(", ")}`);
    }
    return c.json({ error: parts.join("; ") }, 400);
  }

  // One batch: every row and every stamp lands together or none does.
  //
  // `sampled_images`' stamp — `images.selection_reason = 'random'` (M11.3;
  // `'random'` is the only value v2 ever writes, CONTEXT.md §Q16) — is
  // written here, in the same batch as the boxes, and deliberately not back
  // in `Sample`'s own read or in a call of its own issued the moment the
  // sample was drawn. Three things are true at once: sampling happens before
  // detection, so at selection time this handler cannot yet know the job
  // will finish; a prelabel job can fail (a missing object, a lost lease, a
  // detector timeout) after sampling but before this call ever arrives; and
  // `Sample` deterministically redraws the same frames for the same video on
  // a retry (worker/internal/sample's own comment on why). Stamping at
  // selection time would mean a job that samples and then fails leaves
  // `selection_reason` set on rows whose "entry into the pool" never actually
  // produced anything — and worse, if `Sample` were ever non-deterministic, a
  // reap-and-rerun could stamp two different partial samples on top of each
  // other. Stamping here instead means the stamp exists exactly when the
  // dataset is honest about it: a row reads `selection_reason = 'random'`
  // only once a real, complete prelabel run looked at it, the same way
  // `images.dedup_threshold` is stamped when `reportImages` runs — after
  // extraction and dedup finished — and not the instant ffmpeg wrote a frame
  // to disk.
  //
  // Insert-only for `predictions`, and deliberately without `reportImages`'
  // `ON CONFLICT`: a prelabel job reaped mid-report and re-run writes its
  // boxes a second time as new rows. There is no natural key to collide on
  // the way `images` has `(video_id, timestamp_seconds)` — the same detector
  // on the same frame legitimately proposes several boxes, so "one row per
  // (image, class)" would be a constraint on the data, not a statement about
  // re-runs. Still left open rather than guessed at here even though M11.1
  // (migration 0005) is what makes `prelabel` a real, reapable job kind: a
  // re-run genuinely duplicating a whole video's boxes is a dataset-quality
  // question for whichever milestone first reads `predictions` for training
  // or review, not a correctness question this insert-only endpoint can
  // answer on its own — answering it here would mean guessing at a dedup rule
  // (nearest box? latest `model_id`? every row kept and left for a query to
  // filter?) with no reader yet to say which one is right.
  //
  // The stamp UPDATE, by contrast, is naturally idempotent: it always sets
  // the same literal, `'random'`, so a re-run restamping the same
  // deterministically-redrawn keys is a no-op in every way that matters,
  // unlike an insert that would duplicate.
  const statements = [
    ...predictions.map((prediction) =>
      c.env.DB.prepare(
        `INSERT INTO predictions
              (image_id, class_id, x_min, y_min, x_max, y_max, confidence, prompt_version, model_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        imageIdByKey.get(prediction.r2_key),
        classIdByName.get(prediction.class_name),
        prediction.x_min,
        prediction.y_min,
        prediction.x_max,
        prediction.y_max,
        prediction.confidence,
        prediction.prompt_version,
        model_id,
      ),
    ),
    ...chunkForBinding(sampled_images, 1).map((keys) =>
      c.env.DB.prepare(
        `UPDATE images SET selection_reason = 'random'
          WHERE video_id = ? AND r2_key IN (${placeholders(keys)})`,
      ).bind(job.video_id, ...keys),
    ),
  ];

  await c.env.DB.batch(statements);

  return c.json({ video_id: job.video_id, predictions: predictions.length }, 200);
};

export const listVideoImagesHandler: RouteHandler<
  typeof listVideoImagesRoute,
  { Bindings: Bindings }
> = async (c) => {
  const { video_id } = c.req.valid("param");
  const { worker_id } = c.req.valid("query");

  // idx_jobs_one_prelabel_per_video (migration 0005) is what makes this a
  // real lease check rather than an approximation of one: at most one
  // prelabel job can ever be 'claimed' for a given video, so finding a row
  // here is exactly as strong a guarantee as HELD_BY gives every job-id-scoped
  // route in this file, even though no primary key enters this query.
  const held = await c.env.DB.prepare(
    `SELECT 1 FROM jobs
      WHERE video_id = ? AND kind = 'prelabel' AND status = 'claimed' AND claimed_by = ?`,
  )
    .bind(video_id, worker_id)
    .first();

  if (!held) {
    return c.json({ error: "no prelabel job for this video is held by this worker" }, 404);
  }

  const { results } = await c.env.DB.prepare(
    "SELECT r2_key, timestamp_seconds FROM images WHERE video_id = ? ORDER BY timestamp_seconds",
  )
    .bind(video_id)
    .all<{ r2_key: string; timestamp_seconds: number }>();

  return c.json({ video_id, images: results }, 200);
};

/** A job whose worker reported it as unrecoverable, rather than one the reaper retired. */
export const FAILED_SPAN = "job.failed";

const TRACER = "crowdmon.jobs";

/**
 * Records one span for a worker-reported terminal failure — the half of the
 * failure taxonomy `reclaim-spans.ts` does not cover, since a reported
 * failure never touches the reaper at all (CONTEXT.md §Q14/M6 amendment:
 * "the ceiling covers crashes, not reported failures"). That file explains
 * why a reclaim is one span per job rather than a count folded into an
 * attribute, and why `job.reclaimed`/`job.retired` are two span *names*
 * rather than one name plus an `outcome` attribute — Tempo's metrics-
 * generator keys on service, span name, kind and status, and neither a count
 * nor an attribute survives that translation into a Grafana series. The
 * same argument holds here without restating it: `job.failed` needs its own
 * name for the same reason `job.retired` does, because the dashboard's
 * "Failure rate" panel has to be able to sum the two together.
 *
 * Unlike `reclaim-spans.ts`, this lives beside the SQL that decides whether
 * to call it, rather than in its own module tested on Node. That split
 * existed because `@opentelemetry/api`'s ESM build was believed not to
 * resolve under workerd's module loader (this file's own
 * `reclaim-spans.ts` and `vitest.config.ts` both say so) — a belief this
 * function's own test disproves. `tracing.ts` (M9.2) already imports `trace`
 * from the same package and runs inside every `test/workers/*.test.ts` via
 * `nameSpanAfterRoute`, and a probe that called
 * `trace.getTracer(...).startSpan(...).end()` — plus the full Node-style
 * `BasicTracerProvider`/`InMemorySpanExporter` recording setup
 * `traceparent.test.ts` uses — directly inside the `workers` vitest project
 * passed cleanly. Whatever broke this originally is not broken today, so
 * there is no correctness reason left to keep new code like this out of the
 * module its SQL already lives in.
 */
function recordJobFailed(job: {
  id: number;
  kind: "download" | "chunk" | "prelabel";
  video_id: string;
  attempts: number;
  failure_reason: string | null;
}): void {
  trace
    .getTracer(TRACER)
    .startSpan(FAILED_SPAN, {
      attributes: {
        "crowdmon.job.id": job.id,
        "crowdmon.job.kind": job.kind,
        "crowdmon.video.id": job.video_id,
        "crowdmon.job.attempts": job.attempts,
        // Recorded verbatim, same as the column it mirrors (CompleteRequest's
        // own comment): the difference between "a video permanently lost"
        // and "a video permanently lost to a geo-block" is exactly what an
        // operator wants on the span without re-querying D1 for it.
        ...(job.failure_reason ? { "crowdmon.job.failure_reason": job.failure_reason } : {}),
      },
    })
    .end();
}

export const completeJobHandler: RouteHandler<
  typeof completeJobRoute,
  { Bindings: Bindings }
> = async (c) => {
  const { id } = c.req.valid("param");
  const { worker_id, status, failure_reason } = c.req.valid("json");

  const at = now();

  // The trace this completion request arrived inside (M9.2), forwarded onto
  // the prelabel job the second statement below may create — the same idiom
  // `fanOutJobHandler` uses for the chunk jobs it creates. Whichever chunk's
  // completion happens to be the one that finds every sibling done is, by
  // construction, the request the enqueue decision was made inside; which
  // chunk that turns out to be is arbitrary, but the trace it forwards is not
  // — it is genuinely the request that caused the prelabel job to exist.
  const traceparent = c.req.header("traceparent") ?? null;

  // Two statements, one batch, one transaction (D1 wraps `batch()` in one):
  // the completion write and the video's prelabel-enqueue check have to land
  // together or not at all. Done as two separate round trips instead, a crash
  // between them could complete a video's last chunk and never learn it was
  // the last one — the exact gap M8.4 already closed for a chunk's own rows
  // and its `config_version` stamp, reopened here if this pair were not
  // atomic too.
  //
  // `claimed_by` is cleared on the way out so a finished row cannot be
  // mistaken for a held one, and the reaper's partial index stops covering it.
  //
  // `RETURNING` rather than the bare `.run()` this used before M9.1: the
  // failure span needs the job's kind, video id and attempts, and none of
  // them were otherwise in scope here. `HELD_BY` still names exactly one row
  // by primary key, so reading it via `RETURNING` inside a batch changes
  // nothing about how a worker that does not hold the lease is told apart
  // from one that does — both remain "no row came back."
  const results = await c.env.DB.batch<{
    kind: "download" | "chunk" | "prelabel";
    video_id: string;
    attempts: number;
  }>([
    c.env.DB.prepare(
      `UPDATE jobs
          SET status         = ?,
              failure_reason = ?,
              claimed_by     = NULL,
              heartbeat_at   = NULL,
              updated_at     = ?
        WHERE ${HELD_BY}
    RETURNING kind, video_id, attempts`,
    ).bind(status, status === "failed" ? (failure_reason ?? null) : null, at, id, worker_id),

    // M11.1: the video's one prelabel job, enqueued the instant its last
    // chunk finishes — not one per chunk, because a sample drawn across the
    // whole timeline (M11.3) cannot be assembled by any single chunk job,
    // which only ever sees its own sixty seconds.
    //
    // Guarded entirely in SQL, as a `WHERE` on a `SELECT` feeding the
    // `INSERT`, rather than a JS `if` deciding whether to include this
    // statement — the same idiom `fanOutJobHandler`'s per-segment inserts
    // use, and for the same reason: it lets this statement run
    // unconditionally as the batch's second half regardless of what `id`
    // turned out to name, and still do nothing when it should.
    //   - `j.kind = 'chunk' AND j.status = 'done'` reads job `id`'s row as
    //     the UPDATE above just left it — the two statements share one
    //     transaction, so this one sees that write. True only when the row
    //     just completed really was a chunk job reported done; false for a
    //     download or prelabel completion, and false when the UPDATE matched
    //     no row at all (an unheld or nonexistent job leaves `status`
    //     unchanged, and a job already sitting at some other status was
    //     never 'claimed' in the first place).
    //   - the first `NOT EXISTS` is "every chunk job for this video is now
    //     done". It can only become true on the completion that finishes the
    //     *last* one: every earlier chunk's own completion still finds at
    //     least one sibling short of 'done' — itself, before this
    //     transaction — and this whole statement is a no-op for it.
    //   - the second `NOT EXISTS` is what keeps "the last chunk enqueues it"
    //     from enqueuing twice under the reap-and-rerun case M11.1 flags: a
    //     chunk that was already the video's last one, then reaped and
    //     completed again, would otherwise see the same "all done" state on
    //     its second completion and try to insert a second prelabel job.
    //     `idx_jobs_one_prelabel_per_video` (migration 0005) is the schema
    //     backstop if this guard were ever wrong — the design constraint is
    //     that the handler must not be trusted alone — but a genuine
    //     collision there would fail the whole batch, rolling back the
    //     chunk's own completion along with it, so this guard is what is
    //     meant to keep that backstop from ever actually having to fire
    //     rather than a redundant restatement of it. A worker that lost this
    //     race sees its completion answered exactly as if it had won: the
    //     duplicate enqueue attempt is silently a no-op, not an error routed
    //     back to a caller who did nothing wrong — reporting a chunk done is
    //     not the worker's fault just because another chunk's completion
    //     happened to close out the video first.
    c.env.DB.prepare(
      `INSERT INTO jobs (kind, video_id, traceparent)
            SELECT 'prelabel', j.video_id, ?
              FROM jobs j
             WHERE j.id = ?
               AND j.kind = 'chunk'
               AND j.status = 'done'
               AND NOT EXISTS (
                 SELECT 1 FROM jobs c
                  WHERE c.video_id = j.video_id AND c.kind = 'chunk' AND c.status != 'done'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM jobs p WHERE p.video_id = j.video_id AND p.kind = 'prelabel'
               )`,
    ).bind(traceparent, id),
  ]);

  // Indexed twice, both optionally: `batch()` is typed as returning a result
  // per statement, but nothing in the type says how many, and the inner
  // `results` is empty exactly when the UPDATE matched no row — which is the
  // unheld-lease case the next line turns into a 404.
  const job = results[0]?.results[0];
  if (!job) return notHeldByCaller(c);

  // Only a reported failure gets a span. A reported success is not an event
  // this milestone's panel counts, and giving it one would double as a
  // second, differently-named way to ask Tempo "how many jobs finished" that
  // nothing in this dashboard needs.
  if (status === "failed") {
    recordJobFailed({
      id,
      kind: job.kind,
      video_id: job.video_id,
      attempts: job.attempts,
      failure_reason: failure_reason ?? null,
    });
  }

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
