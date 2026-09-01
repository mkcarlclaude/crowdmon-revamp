import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import { trace } from "@opentelemetry/api";
import type { Context } from "hono";
import type { AppEnv } from "../bindings";
import { chunkForBinding, placeholders, randomShuffleKey } from "../d1";
import {
  ChunkFanOut,
  ClaimRequest,
  CompleteRequest,
  DEFAULT_INCLUSION_POLICY,
  DryRunReport,
  errorResponse,
  FanOutRequest,
  HeartbeatRequest,
  ImageReport,
  Job,
  JobIdParam,
  JobStats,
  ListVideoImagesQuery,
  PredictionReport,
  ReportDryRunRequest,
  ReportImagesRequest,
  ReportPredictionsRequest,
  ReportSnapshotRequest,
  SEGMENT_SECONDS,
  SnapshotReport,
  SnapshotSource,
  VideoIdParam,
  VideoImages,
} from "../schemas";
import { resolveScoredEvalPool } from "./admin-eval";

/** Every value `jobs.kind` may hold, in one place so a fifth kind is one edit. */
type JobKindValue = "download" | "chunk" | "prelabel" | "dryrun" | "snapshot";

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
const notHeldByCaller = (c: Context<AppEnv>) =>
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
    "lease check below reads `jobs` for a claimed row of the right kind rather than a " +
    "job's primary key. Before migration 0011 (M17, plan §B), that read was provably " +
    "*exact* — `idx_jobs_one_prelabel_per_video` (migration 0005) guaranteed at most " +
    "one held prelabel job per video, so finding a row proved this worker held *the* " +
    "one. That index is gone now, dropped so an admin can queue a genuinely second " +
    "prelabel job for the same video (`createPrelabelHandler`), so this read proves the " +
    "same thing `dryrun`'s own case always proved: this worker holds *a* claimed " +
    "sampling job for this video, not provably the only one there could be. That is " +
    "still the whole guarantee this endpoint needs — the response is the video's entire " +
    "image pool, identical for every job that asks, so a second concurrently-claimed " +
    "prelabel or dry-run job on the same video would get the identical answer this one " +
    "does. In practice this endpoint is now only ever reached by the automatic first " +
    "pass anyway: a supplementary job's claim carries its selection inline " +
    "(`Job.prelabel`), so its worker never calls this route at all. No Access assertion " +
    "and no credential beyond `worker_id`: the same trust tier as the rest of " +
    "`/api/jobs/*` (`jobStatsRoute`'s own comment explains why that boundary is where " +
    "it is).",
  request: { params: VideoIdParam, query: ListVideoImagesQuery },
  responses: {
    200: {
      description: "Every image row for this video",
      content: { "application/json": { schema: VideoImages } },
    },
    400: errorResponse("Malformed video id or worker id"),
    404: errorResponse("No prelabel or dry-run job for this video is held by this worker"),
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

export const jobStatsHandler: RouteHandler<typeof jobStatsRoute, AppEnv> = async (c) => {
  // One statement, one GROUP BY — the task's own constraint, and it is enough:
  // this is a dashboard read on an interval, not a lease operation, so there
  // is nothing here that needs a transaction or a second round trip.
  const { results } = await c.env.DB.prepare(
    "SELECT status, kind, COUNT(*) AS count FROM jobs GROUP BY status, kind",
  ).all<{
    status: "pending" | "claimed" | "done" | "failed";
    kind: JobKindValue;
    count: number;
  }>();

  // Every combination starts at zero and only the ones D1 actually returned
  // overwrite it. This is the zero-fill `JobStats`' own comment (schemas.ts)
  // promises the Go worker's gauge callback it will never have to do itself —
  // seeing this shape is what lets that callback report a drained queue as
  // twenty zeros instead of twenty absences. `GROUP BY status, kind` itself
  // needed no change for `prelabel` to show up in `results` — only this
  // literal, naming every combination up front, has to grow with the kind —
  // which it did again for `dryrun` (M12.2) and `snapshot` (M15.1), making it
  // twenty combinations.
  const counts = {
    pending: { download: 0, chunk: 0, prelabel: 0, dryrun: 0, snapshot: 0 },
    claimed: { download: 0, chunk: 0, prelabel: 0, dryrun: 0, snapshot: 0 },
    done: { download: 0, chunk: 0, prelabel: 0, dryrun: 0, snapshot: 0 },
    failed: { download: 0, chunk: 0, prelabel: 0, dryrun: 0, snapshot: 0 },
  };

  for (const row of results) {
    counts[row.status][row.kind] = row.count;
  }

  return c.json(counts, 200);
};

export const claimJobHandler: RouteHandler<typeof claimJobRoute, AppEnv> = async (c) => {
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
      kind: JobKindValue;
      // Null exactly for `kind === "snapshot"` (migration 0008's CHECK) — the
      // one kind this handler does not look a video up for, below.
      video_id: string | null;
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
  //
  // Skipped for a `snapshot` job: it names no video (migration 0008), so
  // there is nothing here to look up — `video` stays `null`, which the check
  // below must not read as "video row missing" the way it does for every
  // other kind.
  const video =
    job.video_id === null
      ? null
      : await c.env.DB.prepare("SELECT url FROM videos WHERE id = ?")
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

  // The dry-run's candidate wording (M12.2), read the same way and for the
  // same reason: `RETURNING` cannot join, and the job is already this worker's
  // by the time this runs. Joined to `classes` for the name the boxes will be
  // labelled with — the wording itself is deliberately the `dryruns` row's
  // copy, not the class's current text (migration 0007's own comment).
  //
  // Also `LEFT JOIN`ed to `images` (M17, plan §A): a single-frame dry-run's
  // `image_id` names the frame, and this is the one place that id is turned
  // into the R2 key a worker can actually fetch. Deliberately not left for
  // the worker to resolve — selection moved server-side entirely, so the
  // worker's whole job is running the wording against the key it was handed,
  // never deciding which key that is. `LEFT` rather than `JOIN`: `image_id`
  // is null for the wide mode, and an inner join would silently drop every
  // wide-mode dry-run's claim.
  const dryrun =
    job.kind === "dryrun"
      ? await c.env.DB.prepare(
          `SELECT c.name AS class_name, d.appearance_prompt, d.sample_size, d.image_id, i.r2_key
             FROM dryruns d
             JOIN classes c      ON c.id = d.class_id
             LEFT JOIN images i  ON i.id = d.image_id
            WHERE d.job_id = ?`,
        )
          .bind(job.id)
          .first<{
            class_name: string;
            appearance_prompt: string;
            sample_size: number;
            image_id: number | null;
            r2_key: string | null;
          }>()
      : null;

  // A supplementary prelabel job's explicit frame list (M17, plan §B), read
  // the same way and for the same reason as `dryrun` above: `RETURNING`
  // cannot join, and the job is already this worker's by the time this
  // runs. `.all()` rather than `.first()` — unlike `chunk` and `dryrun`,
  // which each hydrate one row per job, a `prelabel` job's work definition
  // is a *list*, exactly `listVideoImagesHandler`'s own response shape (the
  // reason it reuses `VideoImage`, `schemas.ts`'s own comment).
  //
  // Zero rows is not an error and not a reason to retire this job — it is
  // the automatic first pass (M11.1), which writes no `prelabel_images` rows
  // at all. `prelabelImages.results` being empty is exactly what turns
  // `prelabel` absent below, and that absence is what tells the worker to
  // fall back to `GET /api/videos/{video_id}/images` plus its own
  // `Sampler`, unchanged from before this milestone.
  const prelabelImages =
    job.kind === "prelabel"
      ? await c.env.DB.prepare(
          `SELECT i.r2_key, i.timestamp_seconds
             FROM prelabel_images pi
             JOIN images i ON i.id = pi.image_id
            WHERE pi.job_id = ?
            ORDER BY i.timestamp_seconds`,
        )
          .bind(job.id)
          .all<{ r2_key: string; timestamp_seconds: number }>()
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
  if (job.kind !== "snapshot" && !video) {
    return failUnrunnable(c, job.id, "video row missing");
  }
  if (job.kind === "chunk" && !chunk) {
    return failUnrunnable(c, job.id, "chunk row missing");
  }
  // Reachable, unlike the chunk case above: `createDryRun` writes the job and
  // its `dryruns` row in two statements rather than one batch (it needs the
  // job id for the second), so a failure between them leaves exactly this.
  // Retiring it is the same answer, for the same reason — the alternative is
  // handing an unrunnable job out on every poll forever.
  if (job.kind === "dryrun" && !dryrun) {
    return failUnrunnable(c, job.id, "dryrun row missing");
  }
  // No equivalent check for a single-frame dry-run whose `images` row has
  // vanished: migration 0010's own comment is why — D1 enforces
  // `dryruns.image_id REFERENCES images(id)` unconditionally, with no
  // opt-out (migration 0005's finding), so `image_id` can only ever be
  // written pointing at a row that exists, and there is no `ON DELETE
  // CASCADE` to let that row disappear out from under it later either. The
  // `LEFT JOIN` above still has to be a `LEFT JOIN` (for the wide mode's
  // `image_id IS NULL`), but `dryrun.image_id !== null` and
  // `dryrun.r2_key === null` together is not a reachable combination, so
  // there is nothing here to retire against.

  return c.json(
    {
      id: job.id,
      kind: job.kind,
      video_id: job.video_id,
      video_url: video?.url ?? null,
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
      // Built explicitly rather than spread from the join row: `dryrun` above
      // also carries `image_id` and `r2_key: null` (the wide mode's shape),
      // neither of which belongs in `DryRunWork` — `r2_key` is only present
      // when there is one to hand over, never a literal null on the wire.
      ...(dryrun
        ? {
            dryrun: {
              class_name: dryrun.class_name,
              appearance_prompt: dryrun.appearance_prompt,
              sample_size: dryrun.sample_size,
              ...(dryrun.r2_key !== null ? { r2_key: dryrun.r2_key } : {}),
            },
          }
        : {}),
      // Present only when this job carries an explicit selection (M17, plan
      // §B) — `prelabelImages.results.length > 0`, not merely
      // `prelabelImages !== null`: an automatic first pass is `kind ===
      // 'prelabel'` too, so its `prelabelImages` is a real (empty) result
      // set rather than `null`, and including a `prelabel: { images: [] }`
      // on the wire for it would tell the worker "selection happened
      // server-side, and it selected nothing" — a false statement about a
      // job that never had server-side selection at all. Omitting the field
      // entirely is what `Job.prelabel`'s own contract comment documents as
      // the fall-back-to-Sampler signal.
      ...(prelabelImages && prelabelImages.results.length > 0
        ? { prelabel: { images: prelabelImages.results } }
        : {}),
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
async function failUnrunnable(c: Context<AppEnv>, jobId: number, reason: string) {
  await c.env.DB.prepare(
    "UPDATE jobs SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?",
  )
    .bind(reason, now(), jobId)
    .run();

  return c.body(null, 204);
}

export const heartbeatHandler: RouteHandler<typeof heartbeatRoute, AppEnv> = async (c) => {
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

export const fanOutJobHandler: RouteHandler<typeof fanOutJobRoute, AppEnv> = async (c) => {
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
    .first<{ kind: JobKindValue; video_id: string | null }>();

  if (!job) return notHeldByCaller(c);

  // 400 rather than 404: the lease is genuine and the worker is who it claims
  // to be. Answering "you do not hold this job" would send it hunting for a
  // lost lease it still holds.
  if (job.kind !== "download") {
    return c.json({ error: "only a download job can be fanned out" }, 400);
  }

  // Non-null past this point: `snapshot` (migration 0008's CHECK) is the
  // only kind whose `video_id` may be null, and the check above already
  // excluded every kind but `download`.
  const videoId = job.video_id as string;

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
    ).bind(duration_seconds, width, height, title ?? null, at, videoId),
  ];

  for (const segment of segments) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO jobs (kind, video_id, traceparent)
              SELECT 'chunk', ?, ?
               WHERE NOT EXISTS (SELECT 1 FROM chunks WHERE video_id = ? AND segment_index = ?)`,
      ).bind(videoId, traceparent, videoId, segment.index),
      c.env.DB.prepare(
        `INSERT INTO chunks (job_id, video_id, segment_index, start_seconds, end_seconds)
              SELECT last_insert_rowid(), ?, ?, ?, ?
               WHERE NOT EXISTS (SELECT 1 FROM chunks WHERE video_id = ? AND segment_index = ?)`,
      ).bind(videoId, segment.index, segment.start, segment.end, videoId, segment.index),
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

  return c.json({ video_id: videoId, segments: segments.length, created }, 200);
};

export const reportImagesHandler: RouteHandler<typeof reportImagesRoute, AppEnv> = async (c) => {
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
      kind: JobKindValue;
      video_id: string | null;
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

  // Non-null past this point: `snapshot` is the only kind whose `video_id`
  // may be null, and the check above already excluded every kind but `chunk`.
  const videoId = job.video_id as string;

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
  //
  // `shuffle_key` is bound but never named in the `DO UPDATE SET` list — the
  // one column here that must not move on a re-run. Migration 0013 (M25.1,
  // plan §A2) explains why a NULL one is dangerous rather than merely wrong:
  // `shuffle_key > ?` is NULL, not true, so an image that never got a key
  // would silently drop out of the labelling queue forever. Writing it here,
  // explicitly, on every insert is one of the migration's three named
  // defences against exactly that; the other two are the migration's own
  // backfill and a test asserting a freshly-reported image's key is
  // non-NULL. A re-run must never regenerate it — reshuffling an
  // already-served frame's position mid-session is the "ordering isn't
  // stable across a session" bug the keyset cursor exists to avoid, not a
  // difference between a first and a repeat report.
  const statements = [
    ...images.map((image) =>
      c.env.DB.prepare(
        `INSERT INTO images (r2_key, video_id, timestamp_seconds, phash, dedup_threshold, shuffle_key)
              VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(video_id, timestamp_seconds) DO UPDATE SET
              r2_key          = excluded.r2_key,
              phash           = excluded.phash,
              dedup_threshold = excluded.dedup_threshold`,
      ).bind(
        image.r2_key,
        videoId,
        image.timestamp_seconds,
        image.phash,
        dedup_threshold,
        randomShuffleKey(),
      ),
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
  return c.json({ video_id: videoId, images: images.length }, 200);
};

export const reportPredictionsHandler: RouteHandler<typeof reportPredictionsRoute, AppEnv> = async (
  c,
) => {
  const { id } = c.req.valid("param");
  const { worker_id, model_id, predictions, sampled_images } = c.req.valid("json");

  // Same lease check as every other write on a held job (heartbeat, complete,
  // fanout, report-images): a request that only knew a job id could write
  // prediction rows against somebody else's job.
  //
  // `selection_reason` travels with the lease read (M17, plan §B, migration
  // 0011): this is what the stamp below writes, decided by the API at
  // enqueue time and never by the worker — `createPrelabelHandler` for a
  // supplementary pass, `completeJobHandler`'s auto-enqueue for the
  // automatic first pass. NULL for a job written before this migration, or
  // by a test that seeds one directly with SQL (several in this suite do);
  // the stamp below falls back to `'random'` for exactly that case, which is
  // the only value any prelabel job ever wrote before this column existed.
  const job = await c.env.DB.prepare(
    `SELECT kind, video_id, selection_reason FROM jobs WHERE ${HELD_BY}`,
  )
    .bind(id, worker_id)
    .first<{ kind: JobKindValue; video_id: string | null; selection_reason: string | null }>();

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

  // Non-null past this point: `snapshot` is the only kind whose `video_id`
  // may be null, and the check above already excluded every kind but
  // `prelabel`.
  const videoId = job.video_id as string;

  // A genuinely empty report is well-formed (a detector finding nothing is a
  // real outcome, not an error) and skipping straight to the answer avoids an
  // `IN ()` with no placeholders below, which is invalid SQL. Both arrays have
  // to be empty for this to fire: `predictions` alone being empty is the
  // common case (M11.3's whole sample can come back with nothing detected),
  // but `sampled_images` still needs its stamp written in that case, so only
  // "nothing was sampled and nothing was found" short-circuits here.
  if (predictions.length === 0 && sampled_images.length === 0) {
    return c.json({ video_id: videoId, predictions: 0 }, 200);
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
      ).bind(videoId, ...keys),
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
  // `sampled_images`' stamp — `images.selection_reason` (M11.3) — is written
  // here, in the same batch as the boxes, and deliberately not back in
  // `Sample`'s own read or in a call of its own issued the moment the sample
  // was drawn. Three things are true at once: sampling happens before
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
  // dataset is honest about it: a row reads `selection_reason` only once a
  // real, complete prelabel run looked at it, the same way
  // `images.dedup_threshold` is stamped when `reportImages` runs — after
  // extraction and dedup finished — and not the instant ffmpeg wrote a frame
  // to disk.
  //
  // The *value* written is `job.selection_reason ?? 'random'` (M17, plan
  // §B), not the literal `'random'` this UPDATE hard-coded before migration
  // 0011: which reason to stamp is a fact about the job that ran, decided by
  // the API at enqueue time (`createPrelabelHandler`'s hand-picked-vs-random
  // branch, or `completeJobHandler`'s auto-enqueue), never guessed at here.
  // The `?? 'random'` fallback covers every prelabel job written before this
  // column existed, and any job a test seeds directly with SQL rather than
  // through those two call sites — `'random'` is the only value any prelabel
  // job ever wrote before M17, so a NULL column reads as exactly that.
  //
  // `AND selection_reason IS NULL` makes the stamp write-once — the fix for
  // the hazard the plan's "Contradictions" §3 names. Before migration 0011,
  // this UPDATE was unconditional, which was only safe because
  // `idx_jobs_one_prelabel_per_video` made a second pass over any image
  // unreachable. Once that index is gone, an unconditional UPDATE here would
  // let a later hand-picked pass silently rewrite an already-`random` image
  // to `manual` — moving a permanently-frozen evaluation-pool image into the
  // train split, which is precisely what `PRD.md` §9's falsification table
  // names for the *split manifest* clause of the done-claim. The guard is a
  // backstop, not the only defence: `createPrelabelHandler` already refuses
  // to include an already-sampled image in a hand-picked set, so this
  // `WHERE` clause exists for whatever bypasses that check (a bug in a
  // future caller, a test exercising this handler directly) rather than for
  // the request path this milestone actually ships.
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
  // The stamp UPDATE, by contrast, is idempotent on a re-run by construction
  // now: `AND selection_reason IS NULL` means the second attempt at
  // restamping the same deterministically-redrawn keys simply matches zero
  // rows rather than writing anything, unlike an insert that would
  // duplicate.
  const stampValue = job.selection_reason ?? "random";

  // `unruled_admin`'s first writer (M25.1, plan §B2): every prediction this
  // call inserts is brand new, so it is unruled by definition — there is no
  // verdict row yet that could reference an id that does not exist until
  // this same batch creates it — which is what makes this increment
  // unconditional where `admin-verdicts.ts`'s decrement below cannot be.
  // Grouped by resolved image id rather than one `UPDATE` per prediction: a
  // detector proposing several boxes on one frame is the ordinary case, not
  // an edge one, and `unruled_admin` counts predictions, not report lines.
  const predictionsPerImage = new Map<number, number>();
  for (const prediction of predictions) {
    const imageId = imageIdByKey.get(prediction.r2_key) as number;
    predictionsPerImage.set(imageId, (predictionsPerImage.get(imageId) ?? 0) + 1);
  }

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
    ...[...predictionsPerImage].map(([imageId, count]) =>
      c.env.DB.prepare(`UPDATE images SET unruled_admin = unruled_admin + ? WHERE id = ?`).bind(
        count,
        imageId,
      ),
    ),
    ...chunkForBinding(sampled_images, 2).map((keys) =>
      c.env.DB.prepare(
        `UPDATE images SET selection_reason = ?
          WHERE video_id = ? AND r2_key IN (${placeholders(keys)}) AND selection_reason IS NULL`,
      ).bind(stampValue, videoId, ...keys),
    ),
  ];

  await c.env.DB.batch(statements);

  return c.json({ video_id: videoId, predictions: predictions.length }, 200);
};

export const listVideoImagesHandler: RouteHandler<typeof listVideoImagesRoute, AppEnv> = async (
  c,
) => {
  const { video_id } = c.req.valid("param");
  const { worker_id } = c.req.valid("query");

  // Both sampling kinds, not just `prelabel` (M12.2): a dry-run draws its
  // frames from the same pool through the same client, and a check that named
  // only `prelabel` would fail every dry-run ever queued — the worker holds a
  // `dryrun` lease, gets a 404 here, and reports it as a lost lease.
  //
  // Before migration 0011 (M17, plan §B), `idx_jobs_one_prelabel_per_video`
  // made this an *exact* lease check for a prelabel job: at most one could
  // ever be 'claimed' for a video, so finding a row was as strong a
  // guarantee as HELD_BY gives every job-id-scoped route here, even with no
  // primary key entering this query. That index is gone now — dropped so an
  // admin can queue a genuinely second prelabel job for a video that already
  // has one — so a prelabel job proves what a dry-run always did: this
  // worker holds *a* claimed sampling job for this video, not provably the
  // only one there could be. That is still the whole guarantee this
  // endpoint needs: the response is the video's entire image pool, identical
  // for every job that asks, so there is nothing here that a more precise
  // identity would gate differently. In practice a supplementary prelabel
  // job never reaches this handler at all — its claim carries its selection
  // inline (`Job.prelabel`), so its worker has no reason to call this route.
  const held = await c.env.DB.prepare(
    `SELECT 1 FROM jobs
      WHERE video_id = ? AND kind IN ('prelabel', 'dryrun')
        AND status = 'claimed' AND claimed_by = ?`,
  )
    .bind(video_id, worker_id)
    .first();

  if (!held) {
    return c.json(
      { error: "no prelabel or dry-run job for this video is held by this worker" },
      404,
    );
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
  kind: JobKindValue;
  // Null for a failed `snapshot` job (migration 0008) — the one kind this
  // span has no video to name, see the attribute spread below.
  video_id: string | null;
  attempts: number;
  failure_reason: string | null;
}): void {
  trace
    .getTracer(TRACER)
    .startSpan(FAILED_SPAN, {
      attributes: {
        "crowdmon.job.id": job.id,
        "crowdmon.job.kind": job.kind,
        // Omitted entirely rather than sent as `null`: OTel attribute values
        // are typed as string | number | boolean (plus array forms), and a
        // key present with no value would be a span attribute this codebase
        // has never had to represent before `snapshot` existed.
        ...(job.video_id ? { "crowdmon.video.id": job.video_id } : {}),
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

export const completeJobHandler: RouteHandler<typeof completeJobRoute, AppEnv> = async (c) => {
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
    kind: JobKindValue;
    // Null for a `snapshot` job (migration 0008) — see recordJobFailed's own
    // comment on why the failure span handles that rather than assuming it
    // away.
    video_id: string | null;
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
    //     its second completion and try to insert a second *automatic*
    //     prelabel job. `idx_jobs_one_prelabel_per_video` (migration 0005)
    //     used to be a schema backstop for exactly this guard — but M17
    //     (plan §B) drops that index in migration 0011, precisely so an
    //     admin can queue genuinely additional, *supplementary* prelabel
    //     jobs for a video that already has one. That trade only works
    //     because this guard was never protecting the supplementary case in
    //     the first place: `createPrelabelHandler` (`admin-prelabel.ts`)
    //     never touches this statement, and this `NOT EXISTS` still names
    //     "any prelabel job for this video", not "any *automatic* one" — so
    //     it continues to do exactly what it always did, stop the automatic
    //     path from ever enqueuing a second automatic pass, whether or not a
    //     supplementary pass has run in the meantime. What changed is only
    //     that a genuine race on this specific guard now fails open (a
    //     silent no-op, same as today) rather than also being caught by a
    //     unique-index constraint failure — a weaker second line of defence,
    //     not a different first one. D1 serialises writers, so two
    //     concurrent completions racing to close out the same video's last
    //     chunk still cannot both observe `NOT EXISTS` as true at once: the
    //     loser's `SELECT` runs inside its own transaction, after the
    //     winner's has already committed a `prelabel` row this guard sees. A
    //     worker that lost this race sees its completion answered exactly as
    //     if it had won: the duplicate enqueue attempt is silently a no-op,
    //     not an error routed back to a caller who did nothing wrong —
    //     reporting a chunk done is not the worker's fault just because
    //     another chunk's completion happened to close out the video first.
    //   - `selection_reason` is stamped `'random'` unconditionally here
    //     (M17, plan §B): the automatic first pass is, and stays, an
    //     unbiased draw across the whole timeline — CONTEXT.md §Q16's rule
    //     is unchanged by this milestone, only the mechanism that used to
    //     assume it (an unconditional literal in `reportPredictionsHandler`)
    //     moved. Explicit here rather than left to that handler's own `??
    //     'random'` fallback for a NULL column: every prelabel job this
    //     handler creates from this point forward should say what it is
    //     honestly on its own row, and the fallback exists for jobs written
    //     before this column did, not as the steady-state path for new ones.
    c.env.DB.prepare(
      `INSERT INTO jobs (kind, video_id, traceparent, selection_reason)
            SELECT 'prelabel', j.video_id, ?, 'random'
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

export const reportDryRunRoute = createRoute({
  method: "post",
  path: "/api/jobs/{id}/dryrun",
  operationId: "reportDryRun",
  tags: ["jobs"],
  summary: "Report what a candidate prompt found (M12.2)",
  description:
    "One call per dry-run job, the shape `reportImages` and `reportPredictions` " +
    "established. **Writes nothing to `predictions`**: the boxes land on the dry-run's " +
    "own row as JSON and are never label data (migration 0007). A re-run after a reap " +
    "overwrites the row rather than appending, which is safe precisely because nothing " +
    "downstream references it.",
  request: {
    params: JobIdParam,
    body: { content: { "application/json": { schema: ReportDryRunRequest } }, required: true },
  },
  responses: {
    200: {
      description: "The dry-run's result is recorded",
      content: { "application/json": { schema: DryRunReport } },
    },
    400: errorResponse("A malformed body, or a job that is not a dry-run"),
    404: errorResponse("No job with this id is held by this worker"),
  },
});

export const reportDryRunHandler: RouteHandler<typeof reportDryRunRoute, AppEnv> = async (c) => {
  const { id } = c.req.valid("param");
  const { worker_id, model_id, boxes, sampled_images } = c.req.valid("json");

  // The same lease check every other write on a held job makes.
  const job = await c.env.DB.prepare(`SELECT kind FROM jobs WHERE ${HELD_BY}`)
    .bind(id, worker_id)
    .first<{ kind: JobKindValue }>();

  if (!job) return notHeldByCaller(c);

  // 400 rather than 404, matching `reportImages` and `reportPredictions`: the
  // lease is genuine and the worker is who it says it is; what is wrong is the
  // request, and a 404 would send it hunting for a lease it still holds.
  if (job.kind !== "dryrun") {
    return c.json({ error: "only a dry-run job can report a dry-run result" }, 400);
  }

  // One UPDATE against one row — no key or class resolution, unlike
  // `reportPredictions`, because none of this becomes a foreign key. That is
  // the whole difference between a dry-run and a pre-label, and it is why this
  // handler is twenty lines where that one is two hundred.
  //
  // Overwrite rather than append: a reaped-and-rerun dry-run should show its
  // latest attempt's boxes, and there is nothing referencing the previous
  // attempt's to lose. `reportPredictions` cannot say the same, which is why
  // it deliberately writes new rows instead.
  const updated = await c.env.DB.prepare(
    `UPDATE dryruns
        SET model_id = ?, boxes = ?, sampled_keys = ?, reported_at = ?
      WHERE job_id = ? RETURNING id`,
  )
    .bind(model_id, JSON.stringify(boxes), JSON.stringify(sampled_images), now(), id)
    .first<{ id: number }>();

  // Unreachable through the claim path — a `dryrun` job with no `dryruns` row
  // is retired at claim time rather than handed out — so this is the answer
  // for a row deleted underneath a running job, not a state the API produces.
  if (!updated) return c.json({ error: "this job has no dry-run to report against" }, 400);

  return c.json({ dryrun_id: updated.id, boxes: boxes.length }, 200);
};

/**
 * The verdict that decides one prediction's fate under the default
 * inclusion policy (M15.3, reordered in M20 plan §C1) — the label a
 * `snapshot` reads back, if it is an `accept` or `adjust`. Shared between
 * `snapshotSourceHandler`'s two queries below so the definition of "this
 * prediction is in" cannot drift between "which images qualify" and "which
 * labels do".
 *
 * A total, static ordering, expressed as one scalar subquery rather than two
 * queries merged in TypeScript, so there is never a tie for application code
 * to arbitrate:
 *
 *   1. Any `admin` verdict on the prediction — the *latest* one wins.
 *   2. Otherwise, the latest verdict from a `trusted` user wins.
 *   3. Otherwise the prediction has no label.
 *
 * `anon` never reaches either rank — it satisfies neither branch of the
 * `WHERE`, so it drops out before the `ORDER BY` ever sees it. Latest, not
 * "any admin accept" or "any trusted-user accept" — several verdicts on one
 * prediction are a legal state (migration 0003), and a box an admin accepted
 * and later rejected on reflection must not still count as accepted just
 * because an older row says so.
 *
 * The `LEFT JOIN` to `users` carries the same condition
 * `CONTRIBUTOR_UNRULED_BOX` (`routes/contribute.ts`) uses to decide whether a
 * *trusted* contributor has already ruled on a box: `u2.id = CAST(v2.
 * annotator_id AS INTEGER)`, gated to `v2.source = 'user'` rows only, so an
 * admin's email or an anonymous session id in `annotator_id` is never cast to
 * an integer and joined against `users` at all — the join predicate never
 * evaluates for a row it would not apply to, matching `contribute.ts`'s own
 * reasoning for why that `CAST` is safe.
 *
 * `p.id` is the correlation: this is a scalar subquery, one row per
 * prediction, ordered by rank (admin 0, trusted user 1) then `v2.id DESC`
 * within a rank, cut to one. `idx_verdicts_prediction` (migration 0003) turns
 * `v2.prediction_id = p.id` into an index search rather than a table scan of
 * `verdicts`, so this subquery reads a handful of rows per prediction, not
 * the whole table — the read-amplification shape `listVideosHandler`'s own
 * comment documents. `users` is joined by its `INTEGER PRIMARY KEY`, a rowid
 * lookup, so the added join costs one B-tree probe per candidate verdict
 * row, not a scan of `users`.
 *
 * Benchmarked against a seeded dataset scaled up from production (10,000
 * images, 1,055 predictions, ~2,000 verdicts, 50 trusted and 50 untrusted
 * users) via `meta.rows_read`, both of `snapshotSourceHandler`'s queries
 * together — not this subquery in isolation, per `memory/measure-cost-not-
 * just-win.md`: the single-table `source = 'admin'` form this replaces reads
 * 19,357 rows; this form reads 27,673, a real increase (+43%) rather than a
 * wash. `EXPLAIN QUERY PLAN` shows why: the old `ORDER BY v2.id DESC` was
 * satisfied by `idx_verdicts_prediction`'s own row order, so the old plan
 * never sorted; this one orders by a `CASE` expression no index can satisfy,
 * so SQLite adds `USE TEMP B-TREE FOR ORDER BY`, plus one `users` primary-key
 * probe per candidate verdict row for the `LEFT JOIN`. Adding
 * `verdicts(prediction_id, source)` was tried and produced an identical plan
 * and an identical row count — the sort key is the `CASE`, not `source`
 * alone, so a composite index on `source` cannot help it, and it was left
 * out rather than shipped as dead weight. The increase is bounded by verdict
 * count, not image count, and this handler runs once per admin-triggered
 * snapshot build, not on a request path — nowhere near the order-of-
 * magnitude regression that memory file warns about, so it was accepted
 * rather than chased further.
 */
const WINNING_VERDICT = `(
  SELECT v2.id FROM verdicts v2
   LEFT JOIN users u2
     ON v2.source = 'user' AND u2.id = CAST(v2.annotator_id AS INTEGER)
   WHERE v2.prediction_id = p.id
     AND (v2.source = 'admin' OR (v2.source = 'user' AND u2.trusted = 1))
   ORDER BY (CASE v2.source WHEN 'admin' THEN 0 ELSE 1 END), v2.id DESC
   LIMIT 1
)`;

interface SnapshotImageRow {
  id: number;
  r2_key: string;
  video_id: string;
  timestamp_seconds: number;
  selection_reason: string | null;
}

interface SnapshotLabelRow {
  image_id: number;
  class_name: string;
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
}

/**
 * The train half of M15.2's split rule, restated in SQL (M26.7 plan §A).
 *
 * The same predicate as `CONTRIBUTOR_TRAIN_SPLIT` (`routes/contribute.ts`)
 * and `splitFor` (`worker/internal/snapshot/builder.go`) each express
 * independently — not imported from either, on purpose. The split rule now
 * lives in three places, each pointing at the others in its own comment
 * rather than one being a shared source the other two call: a rename here
 * that silently forgot to update the other two would still be caught,
 * because `splitFor` re-derives the same answer from `selection_reason` and
 * fails the build if it disagrees (see this handler's own comment below).
 *
 * This is the filter that keeps a `selection_reason = 'random'` image out
 * of the verdict-derived query entirely, rather than letting it match and
 * then relying on the worker to route it to `eval` afterward — as of M26.7,
 * an eval image's labels come from `ground_truth`, not from a verdict, so a
 * random image matching this query too would produce a second, wrongly
 * sourced entry for the same image rather than the one this route now
 * guarantees.
 */
const SNAPSHOT_TRAIN_SPLIT = `(i.selection_reason IS NULL OR i.selection_reason != 'random')`;

export const snapshotSourceRoute = createRoute({
  method: "get",
  path: "/api/jobs/{id}/snapshot-source",
  operationId: "snapshotSource",
  tags: ["jobs"],
  summary: "Every image and label the current inclusion policy admits (M15.1, M26.7)",
  description:
    "The whole input to one snapshot build, both splits (M26.7 plan §A/§B). `split` is " +
    "resolved here rather than left for the worker to infer from `selection_reason` — " +
    "the worker's `splitFor` now only checks that its own answer agrees, and fails the " +
    "build if it does not. A `train`-split image is unchanged from M15.3: verdict-derived " +
    "under the default inclusion policy (the latest `admin` verdict wins outright; absent " +
    "one, the latest verdict from a `trusted` user; `accept` or `adjust` either way), and " +
    "always carries at least one label. An `eval`-split image's labels come from " +
    "`ground_truth` instead, gated on `ground_truth_exhaustive` covering every active " +
    "class, and may carry zero labels — a frozen-pool frame examined and found to contain " +
    "nothing. No refusal on an incomplete eval pool: an empty eval half alongside a " +
    "populated train half is a correct 200 for a deployment mid-annotation. No Access " +
    "assertion and no credential beyond `worker_id`, the same trust tier as the rest of " +
    "`/api/jobs/*` — a stray caller learns nothing here it could not already infer by " +
    "polling claim.",
  request: { params: JobIdParam, query: ListVideoImagesQuery },
  responses: {
    200: {
      description: "Every admitted image and its labels",
      content: { "application/json": { schema: SnapshotSource } },
    },
    400: errorResponse("Malformed job id or worker id"),
    404: errorResponse("No snapshot job with this id is held by this worker"),
  },
});

export const snapshotSourceHandler: RouteHandler<typeof snapshotSourceRoute, AppEnv> = async (
  c,
) => {
  const { id } = c.req.valid("param");
  const { worker_id } = c.req.valid("query");

  // Scoped by job id and kind, unlike `listVideoImagesHandler`'s scope-by-
  // video: a snapshot job names no video to scope by (migration 0008), so
  // its own primary key is the only handle this lease check has.
  const held = await c.env.DB.prepare(
    `SELECT 1 FROM jobs WHERE id = ? AND kind = 'snapshot' AND status = 'claimed' AND claimed_by = ?`,
  )
    .bind(id, worker_id)
    .first();

  if (!held) {
    return c.json({ error: "no snapshot job with this id is held by this worker" }, 404);
  }

  // The train half (M15.3, unchanged except for `SNAPSHOT_TRAIN_SPLIT`
  // above, which M26.7 adds to keep this query's images from also being
  // eligible for the eval half below). Two queries merged in JS,
  // `labellingBatchHandler`'s own idiom: SQLite has no nested-row
  // projection, and building the label arrays here rather than with
  // `json_group_array` keeps every label shape declared once, in the
  // contract, rather than duplicated into a SQL string this file would have
  // to keep in sync with `SnapshotLabel` by hand.
  const [images, labels] = await c.env.DB.batch<SnapshotImageRow | SnapshotLabelRow>([
    c.env.DB.prepare(
      `SELECT i.id, i.r2_key, i.video_id, i.timestamp_seconds, i.selection_reason
         FROM images i
        WHERE ${SNAPSHOT_TRAIN_SPLIT}
          AND EXISTS (
              SELECT 1 FROM predictions p
                JOIN verdicts v ON v.id = ${WINNING_VERDICT}
               WHERE p.image_id = i.id AND v.verdict IN ('accept', 'adjust'))
        ORDER BY i.id`,
    ),
    c.env.DB.prepare(
      `SELECT p.image_id,
              c.name AS class_name,
              CASE WHEN v.verdict = 'adjust' THEN v.adjusted_x_min ELSE p.x_min END AS x_min,
              CASE WHEN v.verdict = 'adjust' THEN v.adjusted_y_min ELSE p.y_min END AS y_min,
              CASE WHEN v.verdict = 'adjust' THEN v.adjusted_x_max ELSE p.x_max END AS x_max,
              CASE WHEN v.verdict = 'adjust' THEN v.adjusted_y_max ELSE p.y_max END AS y_max
         FROM predictions p
         JOIN classes c  ON c.id = p.class_id
         JOIN verdicts v ON v.id = ${WINNING_VERDICT}
        WHERE v.verdict IN ('accept', 'adjust')`,
    ),
  ]);

  const labelsByImage = new Map<number, SnapshotLabelRow[]>();
  for (const label of (labels?.results ?? []) as SnapshotLabelRow[]) {
    labelsByImage.set(label.image_id, [...(labelsByImage.get(label.image_id) ?? []), label]);
  }

  // The eval half (M26.7 plan §B). `resolveScoredEvalPool` is the exact
  // computation `getEvalSourceHandler` (`admin-eval.ts`) uses to decide
  // which frozen-pool images are exhaustively annotated for every active
  // class — reused rather than re-derived, per that function's own comment,
  // so "exhaustive for every active class" has exactly one implementation.
  // Unlike that route, an empty result here is not refused: a training
  // rebuild has no business waiting on an eval annotation sitting
  // (`admin-eval.ts`'s own module comment, and this route's own description
  // above), so a mid-annotation deployment simply gets an empty eval half
  // and a populated train half, both under one 200.
  const { classIds, scoredImageIds } = await resolveScoredEvalPool(c.env.DB);

  let evalImages: SnapshotImageRow[] = [];
  const groundTruthByImage = new Map<number, SnapshotLabelRow[]>();
  if (scoredImageIds.length > 0) {
    const [evalImageResults, groundTruthResults] = await Promise.all([
      c.env.DB.batch<SnapshotImageRow>(
        chunkForBinding(scoredImageIds).map((chunk) =>
          c.env.DB.prepare(
            `SELECT id, r2_key, video_id, timestamp_seconds, selection_reason
               FROM images WHERE id IN (${placeholders(chunk)})
              ORDER BY id`,
          ).bind(...chunk),
        ),
      ),
      // One reserved slot per active class, matching `resolveScoredEvalPool`'s
      // own reservation for the same D1 hundred-bound-parameter ceiling
      // (`memory/d1-bound-param-limit`).
      c.env.DB.batch<SnapshotLabelRow>(
        chunkForBinding(scoredImageIds, classIds.length).map((chunk) =>
          c.env.DB.prepare(
            `SELECT g.image_id, c.name AS class_name, g.x_min, g.y_min, g.x_max, g.y_max
               FROM ground_truth g
               JOIN classes c ON c.id = g.class_id
              WHERE g.image_id IN (${placeholders(chunk)}) AND g.class_id IN (${placeholders(classIds)})`,
          ).bind(...chunk, ...classIds),
        ),
      ),
    ]);

    for (const result of evalImageResults) {
      evalImages = evalImages.concat(result.results);
    }
    for (const result of groundTruthResults) {
      for (const row of result.results) {
        groundTruthByImage.set(row.image_id, [
          ...(groundTruthByImage.get(row.image_id) ?? []),
          row,
        ]);
      }
    }
  }

  return c.json(
    {
      // Train first, then eval — the order the two halves were queried in.
      // Nothing about the contract promises this ordering; it is simply
      // deterministic, which is what lets a test assert on it.
      images: [
        ...((images?.results ?? []) as SnapshotImageRow[]).map((image) => ({
          r2_key: image.r2_key,
          video_id: image.video_id,
          timestamp_seconds: image.timestamp_seconds,
          selection_reason: image.selection_reason,
          split: "train" as const,
          labels: (labelsByImage.get(image.id) ?? []).map(({ image_id: _, ...label }) => label),
        })),
        ...evalImages.map((image) => ({
          r2_key: image.r2_key,
          video_id: image.video_id,
          timestamp_seconds: image.timestamp_seconds,
          selection_reason: image.selection_reason,
          split: "eval" as const,
          // Never defaulted to a placeholder: an empty array here is the
          // 171-true-negative case this milestone exists to admit (plan's
          // own numbers), and `SnapshotSourceImage`'s comment states the
          // invariant that makes it safe — this array is empty only because
          // `scoredImageIds` already excludes every image that was not
          // examined for every active class.
          labels: (groundTruthByImage.get(image.id) ?? []).map(
            ({ image_id: _, ...label }) => label,
          ),
        })),
      ],
    },
    200,
  );
};

export const reportSnapshotRoute = createRoute({
  method: "post",
  path: "/api/jobs/{id}/snapshot",
  operationId: "reportSnapshot",
  tags: ["jobs"],
  summary: "Record a finished snapshot build (M15.1)",
  description:
    "Writes the `snapshots` row once the worker has confirmed the artifact is in R2. " +
    "The one call this job kind ever makes to this route — there is no dry-run-style " +
    "overwrite semantics here, because a snapshot job runs once and its row is written " +
    "once, the same insert-once posture `reportPredictions` gives `predictions`.",
  request: {
    params: JobIdParam,
    body: { content: { "application/json": { schema: ReportSnapshotRequest } }, required: true },
  },
  responses: {
    200: {
      description: "The snapshot row exists",
      content: { "application/json": { schema: SnapshotReport } },
    },
    400: errorResponse("Malformed job id or body, or a job that is not a snapshot job"),
    404: errorResponse("No job with this id is held by this worker"),
  },
});

export const reportSnapshotHandler: RouteHandler<typeof reportSnapshotRoute, AppEnv> = async (
  c,
) => {
  const { id } = c.req.valid("param");
  const { worker_id, r2_key, image_count, label_count } = c.req.valid("json");

  // The same lease check every other write on a held job makes.
  const job = await c.env.DB.prepare(`SELECT kind FROM jobs WHERE ${HELD_BY}`)
    .bind(id, worker_id)
    .first<{ kind: JobKindValue }>();

  if (!job) return notHeldByCaller(c);

  // 400, not 404, matching every other wrong-kind report in this file: the
  // lease is genuine and the worker is who it says it is; what is wrong is
  // the request.
  if (job.kind !== "snapshot") {
    return c.json({ error: "only a snapshot job can report a snapshot" }, 400);
  }

  // `DEFAULT_INCLUSION_POLICY` rather than a value the request carries: v2
  // has exactly one inclusion policy (M15.3), and stamping it here, from the
  // one constant `snapshotSourceHandler`'s query also embodies, is what keeps
  // the two from ever describing two different policies by accident — see
  // that constant's own comment.
  const created = await c.env.DB.prepare(
    `INSERT INTO snapshots (r2_key, image_count, label_count, inclusion_policy)
          VALUES (?, ?, ?, ?) RETURNING id`,
  )
    .bind(r2_key, image_count, label_count, DEFAULT_INCLUSION_POLICY)
    .first<{ id: number }>();

  if (!created) return c.json({ error: "could not record the snapshot" }, 400);

  return c.json({ snapshot_id: created.id }, 200);
};
