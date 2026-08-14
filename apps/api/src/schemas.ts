import { z } from "@hono/zod-openapi";

/**
 * The wire contract, in one file.
 *
 * These schemas are the single source of truth CONTEXT.md §Q24 commits to:
 * they validate untrusted input at the edge, they generate the OpenAPI
 * document, and M3.3 generates the Go worker's structs from that document.
 * A field renamed here changes both runtimes or fails CI — which is exactly
 * the `storage_url` / `url` class of bug the old three-repo layout produced.
 */

/**
 * Named rather than inlined into `ErrorResponse`: oapi-codegen renders an
 * inline object as an anonymous struct, which callers cannot declare a
 * variable of.
 */
const ValidationIssue = z
  .object({
    path: z.string().openapi({ example: "url" }),
    message: z.string().openapi({ example: "Invalid URL" }),
  })
  .openapi("ValidationIssue");

/**
 * Every non-2xx response in the API. One shape, so a client can parse a
 * failure without first knowing which endpoint it came from.
 */
export const ErrorResponse = z
  .object({
    error: z.string().openapi({ example: "invalid request" }),
    // Present only on validation failures. Free to produce (zod already has
    // them) and it is the difference between a worker author seeing "which
    // field" and seeing "something was wrong".
    issues: z.array(ValidationIssue).optional(),
  })
  .openapi("ErrorResponse");

/**
 * Declares a failure response. Every non-2xx in the API carries
 * `ErrorResponse`, so the routes say what went wrong and never restate the
 * shape — one place to change if the error contract ever moves.
 */
export const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});

export const HealthResponse = z
  .object({
    status: z.literal("ok"),
    service: z.literal("crowdmon-api"),
    // Echoed back so a response proves *which* deployment answered, not just
    // that something did. The deploy workflow curls this after every release.
    environment: z.string().openapi({ example: "production" }),
  })
  .openapi("HealthResponse");

export const SubmitVideoRequest = z
  .object({
    // A URL, not a YouTube id: the id is derived server-side in M3.4. Checking
    // the *host* here would duplicate that extraction in two places and put
    // the definition of "a YouTube URL" in the wire contract, where a change
    // to it becomes a breaking API change rather than a server detail.
    url: z.url().openapi({ example: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
  })
  .openapi("SubmitVideoRequest");

/**
 * Deliberately not named `SubmitVideoResponse`. oapi-codegen owns the
 * `<OperationId>Response` namespace on the Go side — it generates one wrapper
 * type per operation — so a schema named after the `submitVideo` operation's
 * response collides with generated code and stops the module compiling.
 * The rule: schema names must not be an operationId with `Response` appended.
 */
export const VideoSubmission = z
  .object({
    video_id: z.string().openapi({ example: "dQw4w9WgXcQ" }),
    job_id: z.int().positive().openapi({ example: 1 }),
  })
  .openapi("VideoSubmission");

/**
 * Mirrors the `kind` CHECK constraint, widened by migration 0005 (M11.1),
 * 0007 (M12.2's `dryrun`) and 0008 (M15.1's `snapshot`).
 */
export const JobKind = z
  .enum(["download", "chunk", "prelabel", "dryrun", "snapshot"])
  .openapi("JobKind");

/**
 * Identifies the caller holding a lease.
 *
 * On heartbeat and complete this is not decoration: without it any process
 * that knows a job id can keep someone else's lease alive, or close it, and
 * the reaper's guarantee (CONTEXT.md §Q14) stops meaning anything.
 */
const workerId = z.string().min(1).openapi({ example: "carls-ubuntu-1" });

export const ClaimRequest = z.object({ worker_id: workerId }).openapi("ClaimRequest");

/**
 * Structurally identical to `ClaimRequest` today, and deliberately a separate
 * schema: they are separate operations that will diverge (a claim will grow a
 * `kind` filter the day a second worker exists, a heartbeat never will), and
 * one shared schema would have oapi-codegen name the heartbeat's Go struct
 * after claiming.
 */
export const HeartbeatRequest = z.object({ worker_id: workerId }).openapi("HeartbeatRequest");

/**
 * A claimed unit of work, carrying everything the worker needs to run it
 * without a second round trip.
 */
export const Job = z
  .object({
    id: z.int().positive().openapi({ example: 1 }),
    kind: JobKind,
    // `.nullable()`, not `.string()`: every kind before `snapshot` (M15.1) is
    // about exactly one video and this was never null in practice, but a
    // `snapshot` job packages the whole dataset's current qualifying rows
    // across every video at once, and there is no single `videos.id` for it
    // to truthfully name (migration 0008's own comment). `video_url` follows
    // it for the same reason — there is no video to look one up for.
    video_id: z.string().nullable().openapi({ example: "dQw4w9WgXcQ" }),
    video_url: z
      .url()
      .nullable()
      .openapi({ example: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    // Incremented on claim, so the worker can see how close this job is to the
    // ceiling that will retire it as failed.
    attempts: z.int().nonnegative().openapi({ example: 1 }),
    // The trace context (M9.2) whoever wrote this row was inside, in W3C
    // `traceparent` form. `.nullable()` rather than `.optional()`: the column
    // is genuinely nullable in migration 0002 — every row from before it
    // existed, and any job written with no active span — and the worker has
    // to tell "there is no context" apart from "the field was left out",
    // which an absent key and a JSON `null` cannot otherwise be told apart
    // from in JavaScript. A null here means exactly what it means on a job
    // with no `traceparent` today: start a root span.
    traceparent: z.string().nullable().openapi({
      example: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    }),
    // How long this row sat `pending` before this claim, in whole seconds
    // (M9.2's `job.claimed` marker span). Computed here, from `claimed_at`
    // minus `created_at` on the same row the claim's `RETURNING` already
    // reads, rather than left for the worker to derive — the worker only
    // ever sees one instant (whenever this response arrives), and a value
    // computed against its own clock would be skewed by wire latency and any
    // drift between this box and the one that submitted the job. The API
    // computes it once, on the clock that stamped both timestamps.
    queue_wait_seconds: z.int().nonnegative().openapi({ example: 42 }),
    // Present only for `chunk` jobs. Optional rather than a second response
    // schema per kind: one queue, one job type on the wire (CONTEXT.md §Q14),
    // and oapi-codegen renders this as a nil-able pointer the worker can
    // branch on.
    chunk: z
      .object({
        segment_index: z.int().nonnegative().openapi({ example: 0 }),
        start_seconds: z.int().nonnegative().openapi({ example: 0 }),
        end_seconds: z.int().positive().openapi({ example: 60 }),
      })
      .optional()
      .openapi("ChunkWork"),
    // Present only for `dryrun` jobs (M12.2), in `chunk`'s idiom above: one
    // queue, one job type on the wire, and oapi-codegen renders this as a
    // nil-able pointer the worker branches on.
    //
    // The candidate wording travels *with the job* rather than being fetched
    // the way `/api/classes/active` is fetched for a prelabel job. The two
    // reads are not the same shape: every prelabel job wants the identical
    // current answer, whereas a dry-run is defined by the one wording it was
    // created to try — text that is deliberately not what the class says, and
    // that a later edit to the class must not silently replace mid-job.
    dryrun: z
      .object({
        class_name: z.string().min(1).openapi({ example: "Paimon" }),
        appearance_prompt: z.string().min(1).openapi({
          example: "a tiny white-haired floating companion with a dark crown",
        }),
        sample_size: z.int().positive().openapi({ example: 50 }),
        // Present only for the single-frame mode (M17, plan §A) — the claim
        // handler joins `images` on `dryruns.image_id` and hands back the key
        // directly, exactly as `chunk`'s window arrives pre-resolved. This is
        // load-bearing, not a convenience: a worker that had to resolve the
        // id itself would be a second place "which frame" could be decided,
        // and the whole point of this field is that selection happened once,
        // server-side, before the job was ever claimable. Absent for the wide
        // mode (`image_id IS NULL`), where the worker still draws its own
        // sample via `sample_size`.
        r2_key: z.string().min(1).optional().openapi({
          example: "frames/dQw4w9WgXcQ/00042.000.jpg",
        }),
      })
      .optional()
      .openapi("DryRunWork"),
  })
  .openapi("Job");

/** The claim response as the worker sees it. */
export type JobResponse = z.infer<typeof Job>;

/**
 * How a worker reports back. Only the terminal states are accepted — a worker
 * cannot move a job back to `pending`; that is the reaper's job alone, and
 * letting the worker do it would give a live worker and the reaper two ways
 * to race for the same row.
 */
export const CompleteRequest = z
  .object({
    worker_id: workerId,
    status: z.enum(["done", "failed"]),
    // Only meaningful with `failed`. Recorded verbatim so M6.1 can tell a
    // deleted video from a geo-block without re-running anything.
    failure_reason: z.string().max(1000).optional().openapi({ example: "video unavailable" }),
  })
  .openapi("CompleteRequest");

/**
 * The longest video the fan-out will accept, and therefore the longest video
 * this system can process at all.
 *
 * Not a taste judgement about video length: fan-out is one D1 batch
 * (CONTEXT.md §Q13), so segments are statements, and a bound belongs here —
 * where the answer is a 400 naming the limit — rather than in a batch that
 * fails halfway through with whatever D1 says when a batch is too big. Six
 * hours is 360 segments and 721 statements; a test fans out four hours (481
 * statements) against a real D1 rather than trusting that a batch that size
 * works, and another pins the rejection at the boundary.
 */
export const MAX_VIDEO_SECONDS = 6 * 60 * 60;

/** Every chunk covers this many seconds, except the last one (CONTEXT.md §Q13). */
export const SEGMENT_SECONDS = 60;

/**
 * What the download worker learned about the video: yt-dlp's title and
 * ffprobe's duration and resolution (M7.2).
 *
 * `worker_id` is here for the same reason it is on heartbeat and complete —
 * fanning out is writing on a lease, and a request that only knew a job id
 * could enqueue work against somebody else's job.
 */
export const FanOutRequest = z
  .object({
    worker_id: workerId,
    // Whole seconds. ffprobe reports a float and the worker rounds it up: a
    // 150.4s video whose last segment ended at 150 would leave four tenths of
    // a second unextracted, and the rounding belongs where the truncation is
    // visible rather than in SQL.
    duration_seconds: z.int().positive().max(MAX_VIDEO_SECONDS).openapi({ example: 1200 }),
    width: z.int().positive().openapi({ example: 1920 }),
    height: z.int().positive().openapi({ example: 1080 }),
    // Optional because it is the one field nothing downstream depends on:
    // yt-dlp not reporting a title should not fail a download that worked.
    title: z.string().max(500).optional().openapi({ example: "Genshin Impact — Paimon" }),
  })
  .openapi("FanOutRequest");

/**
 * Named `ChunkFanOut` rather than after the operation: oapi-codegen owns the
 * `<OperationId>Response` namespace, and the operation is `fanOutJob`.
 *
 * `created` is deliberately separate from `segments`. A re-run after a reap
 * reports the same `segments` and `created: 0`, which is how M7.3's
 * idempotency is observable from outside instead of inferred from row counts.
 */
export const ChunkFanOut = z
  .object({
    video_id: z.string().openapi({ example: "dQw4w9WgXcQ" }),
    segments: z.int().nonnegative().openapi({ example: 20 }),
    created: z.int().nonnegative().openapi({ example: 20 }),
  })
  .openapi("ChunkFanOut");

/**
 * The `{id}` path parameter. Every path segment arrives as a string and
 * `jobs.id` is an INTEGER PRIMARY KEY, so it has to be converted somewhere.
 *
 * Digits-only, then parsed — deliberately not `z.coerce.number()`. Coercion
 * accepts `0x10`, `1e3`, `+1` and leading whitespace and resolves each to a
 * *different* integer, so a heartbeat naming a malformed id would silently
 * renew some other job's lease instead of being rejected.
 */
export const JobIdParam = z.object({
  id: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .refine((id) => id > 0)
    .openapi({ param: { name: "id", in: "path" }, type: "integer", example: 1 }),
});

/** Mirrors the `status` CHECK constraint in migration 0001. */
export const JobStatus = z.enum(["pending", "claimed", "done", "failed"]).openapi("JobStatus");

/**
 * A job as the operator sees it — the lease and failure columns the worker's
 * own `Job` deliberately omits, because a worker has no use for them.
 *
 * Every nullable column is `.nullable()` rather than `.optional()`. An absent
 * key and a null both arrive as `undefined` in JavaScript, which would make
 * "never claimed" and "the API did not say" indistinguishable in the UI.
 */
export const AdminJob = z
  .object({
    id: z.int().positive().openapi({ example: 1 }),
    kind: JobKind,
    // `.nullable()` for `Job.video_id`'s own reason (M15.1): a `snapshot` job
    // is not about any one video, so this and `video_url` are the one place
    // in this row an admin sees "no video" rather than a real one.
    video_id: z.string().nullable().openapi({ example: "dQw4w9WgXcQ" }),
    video_url: z
      .url()
      .nullable()
      .openapi({ example: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    status: JobStatus,
    attempts: z.int().nonnegative().openapi({ example: 1 }),
    claimed_by: z.string().nullable().openapi({ example: "carls-ubuntu-1" }),
    claimed_at: z.int().nullable().openapi({ example: 1_754_100_000 }),
    heartbeat_at: z.int().nullable().openapi({ example: 1_754_100_030 }),
    failure_reason: z.string().nullable().openapi({ example: "video unavailable" }),
    created_at: z.int().openapi({ example: 1_754_099_000 }),
    updated_at: z.int().openapi({ example: 1_754_100_030 }),
    chunk: z
      .object({
        segment_index: z.int().nonnegative().openapi({ example: 0 }),
        start_seconds: z.int().nonnegative().openapi({ example: 0 }),
        end_seconds: z.int().positive().openapi({ example: 60 }),
      })
      .optional()
      .openapi("AdminChunkWork"),
  })
  .openapi("AdminJob");

export type AdminJobRow = z.infer<typeof AdminJob>;

/**
 * Named `JobList`, not `ListJobsResponse`: oapi-codegen owns the
 * `<OperationId>Response` namespace, and the operation is `listJobs`.
 *
 * `now` is the server's clock. M5.3 shows heartbeat *age*, and computing that
 * from the browser's clock would render a skewed laptop as a dead fleet.
 */
export const JobList = z
  .object({
    now: z.int().openapi({ example: 1_754_100_030 }),
    jobs: z.array(AdminJob),
  })
  .openapi("JobList");

/**
 * Query parameters for the job list. `limit` is bounded rather than free: this
 * endpoint reads D1 on an interval from an open browser tab, so an unbounded
 * limit is a self-inflicted load generator.
 */
/**
 * One extracted-and-uploaded frame, as the chunk worker reports it.
 *
 * `phash` is constrained to exactly what the Go side writes — 16 lowercase hex
 * characters, a 64-bit perceptual hash — rather than accepted as an opaque
 * string. `idx_images_phash` (migration 0001) is only useful as a similarity
 * index if every row in it is actually a hash; a column that took anything
 * would let the index silently stop meaning anything and nothing downstream
 * would fail loudly.
 */
const ImageFrame = z
  .object({
    // The example is the real format, produced by `frames.Key` in the Go
    // worker: a fixed prefix, the video id, and the timestamp zero-padded to
    // three decimals so keys sort in frame order. Deliberately not validated
    // by a pattern here — the key's shape is the worker's to own (it has to
    // match the object it actually wrote), and a regex in the contract would
    // be a second definition of it that could drift.
    r2_key: z.string().min(1).openapi({ example: "frames/dQw4w9WgXcQ/00042.000.jpg" }),
    // A number rather than an integer, matching the column. Extraction is
    // 1fps today so every value is whole, and the column was not narrowed
    // because a future rate that is not 1fps would otherwise be a migration
    // rather than a setting.
    timestamp_seconds: z.number().nonnegative().openapi({ example: 42 }),
    phash: z
      .string()
      .regex(/^[0-9a-f]{16}$/)
      .openapi({ example: "af3c9e1b2d4f7a80" }),
  })
  .openapi("ImageFrame");

/**
 * What a chunk worker reports after extracting, deduplicating and uploading
 * its slice (M8.4).
 *
 * `worker_id` is here for the same reason it is on heartbeat, complete and
 * fanout: this is a write on a lease, and a request that only knew a job id
 * could write image rows against somebody else's job.
 *
 * `dedup_threshold` and `config_version` are not read back from `chunks` or
 * `jobs` because the whole point is provenance *for this run* — the values
 * the worker actually used, stamped onto the rows it actually wrote, so a
 * threshold changed between runs cannot be attributed to the wrong images
 * after the fact.
 */
export const ReportImagesRequest = z
  .object({
    worker_id: workerId,
    frames_extracted: z.int().nonnegative().openapi({ example: 60 }),
    frames_kept: z.int().nonnegative().openapi({ example: 12 }),
    dedup_threshold: z.int().nonnegative().openapi({ example: 8 }),
    config_version: z.string().max(200).openapi({ example: "2026-08-01-a" }),
    // A 60s segment at 1fps cannot produce more than SEGMENT_SECONDS frames;
    // doubled for headroom against a faster sample rate without leaving the
    // bound open enough to be no bound at all. Mirrors MAX_VIDEO_SECONDS's
    // reasoning for fan-out: the answer to an oversized report belongs here,
    // as a 400 naming the limit, not in a batch that fails partway through
    // after the worker already paid for the upload.
    images: z.array(ImageFrame).max(SEGMENT_SECONDS * 2),
  })
  .openapi("ReportImagesRequest");

/**
 * Named `ImageReport`, not after the operation: oapi-codegen owns the
 * `<OperationId>Response` namespace, and the operation is `reportImages`.
 */
export const ImageReport = z
  .object({
    video_id: z.string().openapi({ example: "dQw4w9WgXcQ" }),
    images: z.int().nonnegative().openapi({ example: 12 }),
  })
  .openapi("ImageReport");

/**
 * One status's row count for each job kind (M9.1).
 *
 * Named, not inlined into `JobStats`: oapi-codegen renders an inline object as
 * an anonymous struct, and it would have to do it four times over — once per
 * status — leaving the Go worker's gauge callback with four types it cannot
 * name.
 */
const JobStatusCounts = z
  .object({
    download: z.int().nonnegative().openapi({ example: 1 }),
    chunk: z.int().nonnegative().openapi({ example: 14 }),
    // M11.1: the third job kind. Added here rather than left for the queue
    // gauge to infer, for the same reason the other two are named fields and
    // not an open map — the Go worker's generated struct has to have a field
    // to read a prelabel count off, not just whatever keys happened to come
    // back.
    prelabel: z.int().nonnegative().openapi({ example: 1 }),
    // M12.2's fourth kind, added here for `prelabel`'s reason: the Go worker's
    // gauge callback reads named fields off a generated struct, and a kind
    // with no field is a kind Prometheus never hears about. A dry-run is
    // ordinary queue work — it competes for the same single worker as every
    // prelabel job — so a backlog of them is exactly the thing `queue_depth`
    // exists to make visible.
    dryrun: z.int().nonnegative().openapi({ example: 0 }),
    // M15.1's fifth kind, added here for `dryrun`'s reason: a kind with no
    // field here is a kind Prometheus never hears about. A snapshot build
    // competes for the same single worker as everything else, so a backlog
    // of them belongs in `queue_depth` too.
    snapshot: z.int().nonnegative().openapi({ example: 0 }),
  })
  .openapi("JobStatusCounts");

/**
 * D1's job table, grouped by status and kind — the only place queue depth
 * exists to read from. Prometheus cannot scrape a Worker and there is no
 * metrics pipeline on that side (CONTEXT.md §6), so the Go worker polls this
 * once per metrics export interval and republishes it as the
 * `queue_depth{status,kind}` gauge Prometheus actually scrapes
 * (worker/internal/telemetry/metrics.go) — this endpoint exists for that
 * poll and has no other caller.
 *
 * Fixed shape — twenty named fields, four statuses times five kinds (M11.1
 * added `prelabel`, M12.2 `dryrun`, M15.1 `snapshot`, alongside `download`
 * and `chunk`) — rather than the array
 * of rows `SELECT status, kind, COUNT(*) ... GROUP BY status, kind` naturally
 * produces. That query returns only combinations with at least one row, so a
 * drained `pending` bucket is *absent* from the result set, not present at
 * zero. Handing that straight to the Go worker would make an empty queue and
 * a worker that stopped reporting look identical in Prometheus — the one
 * distinction the dashboard's queue-depth panel exists to show. The
 * zero-fill happens here, in the one place that already knows all sixteen
 * combinations exist, so the gauge callback on the other end of the wire
 * never has to guess which ones it did not hear about.
 */
export const JobStats = z
  .object({
    pending: JobStatusCounts,
    claimed: JobStatusCounts,
    done: JobStatusCounts,
    failed: JobStatusCounts,
  })
  .openapi("JobStats");

/**
 * The bound on `ReportPredictionsRequest.predictions`.
 *
 * M11.3 defaults a prelabel job's timeline sample to 200 images (configurable
 * through the worker's environment — `worker/internal/config/config.go`), and
 * CONTEXT.md §12 puts the whole dataset at "roughly 4-6 characters total" —
 * round that up to 6 classes. Doubled again for headroom against a class
 * detected more than once on the same frame (two background characters of the
 * same kind is plausible; the doubling is not meant to cover much more than
 * that) — the same idiom `ReportImagesRequest.images` uses
 * `SEGMENT_SECONDS * 2` for. One job is one report ("one call per job, not
 * one per box"), so the whole video's worth of boxes has to clear this bound
 * in a single request; an oversized one is a 400 naming the limit here, not a
 * batch that fails partway through after the worker already ran the
 * detector. Left at the 200-image assumption rather than tied to the
 * configurable budget: this is a ceiling on what one request may carry, not a
 * restatement of whatever a deployment happens to have configured, and an
 * operator who raises the budget meaningfully is past the point this bound
 * exists to catch.
 */
export const MAX_PREDICTIONS_PER_JOB = 200 * 6 * 2;

/**
 * The bound on `ReportPredictionsRequest.sampled_images`.
 *
 * One entry per image the sampler drew, regardless of whether the detector
 * found anything on it — unlike `predictions`, this array never multiplies by
 * class count, so it does not share `MAX_PREDICTIONS_PER_JOB`'s reasoning.
 * 5x the 200-image default is generous enough that no sane reconfiguration of
 * `CROWDMON_PRELABEL_SAMPLE_SIZE` trips it, while still rejecting outright a
 * worker whose configured budget is a typo rather than silently accepting and
 * processing whatever it sends.
 */
export const MAX_SAMPLED_IMAGES_PER_JOB = 200 * 5;

/**
 * The `{video_id}` path parameter, for `listVideoImagesRoute` — the one
 * worker-facing route in this file scoped by video rather than by job id
 * (see that route's own comment for why). `videos.id` is a bare TEXT primary
 * key with no format of its own, unlike `JobIdParam`'s integer, so there is
 * nothing to parse or transform here beyond requiring it non-empty.
 */
export const VideoIdParam = z.object({
  video_id: z
    .string()
    .min(1)
    .openapi({ param: { name: "video_id", in: "path" }, example: "dQw4w9WgXcQ" }),
});

/**
 * `worker_id` as a query parameter rather than a body field: `listVideoImages`
 * is the one worker-facing read in this file (`jobStats` is a dashboard read
 * with no caller identity to check), and a GET here carries no body for it to
 * live in the way every other route's `worker_id` does.
 */
export const ListVideoImagesQuery = z.object({
  worker_id: workerId.openapi({ param: { name: "worker_id", in: "query" } }),
});

/**
 * One row of `images` as `listVideoImages` reads it back — just enough for
 * `ImageSampler` (worker/internal/worker/pipeline.go, M11.3) to draw its
 * bounded, timeline-spread subset from: the `r2_key` `Detect` will fetch and
 * the timestamp the spread is computed over.
 *
 * Deliberately not `ImageFrame`: that schema is the chunk worker's *write* —
 * carries `phash`, and its own docblock describes it as "a frame the chunk
 * worker reports" — and reusing it here would describe this response as a
 * frame being written when it is the opposite direction, a frame being read
 * back for a different job kind entirely.
 */
const VideoImage = z
  .object({
    r2_key: z.string().min(1).openapi({ example: "frames/dQw4w9WgXcQ/00042.000.jpg" }),
    timestamp_seconds: z.number().nonnegative().openapi({ example: 42 }),
  })
  .openapi("VideoImage");

/**
 * Named `VideoImages`, not after the operation: oapi-codegen owns the
 * `<OperationId>Response` namespace, and the operation is `listVideoImages`.
 *
 * Bounded by `MAX_VIDEO_SECONDS`, not by the prelabel sample size — this is
 * the whole candidate pool the sampler draws *from* (every row `reportImages`
 * has ever written for the video), not the budget-limited subset it draws
 * *out*. Extraction runs at 1fps and `FanOutRequest.duration_seconds` is
 * capped at `MAX_VIDEO_SECONDS`, so no video can ever have produced more
 * `images` rows than that — dedup only removes rows, never adds them — which
 * makes this a hard ceiling from the extraction rate rather than a guess.
 */
export const VideoImages = z
  .object({
    video_id: z.string().openapi({ example: "dQw4w9WgXcQ" }),
    images: z.array(VideoImage).max(MAX_VIDEO_SECONDS),
  })
  .openapi("VideoImages");

/**
 * One model-proposed box, as a prelabel worker reports it.
 *
 * References its image by `r2_key`, the same handle `ImageFrame.r2_key`
 * uses and for the same reason: the worker knows the object it operated on,
 * not the row `reportImages` assigned it — `ImageReport` never echoes image
 * ids back, so `image_id` is not a value the worker could supply even if
 * this schema asked for one. References its class by `classes.name` rather
 * than `class_id` for the matching reason: no route this milestone adds
 * hands out a `class_id`, and `name` is the class's own natural key
 * (migration 0003's `UNIQUE`). The handler resolves both against D1 and
 * answers an unresolvable reference with a 400 naming it, rather than
 * letting a bad reference surface as a foreign-key failure with no field to
 * point at.
 *
 * `prompt_version` travels with each box rather than with the request as a
 * whole (contrast `model_id` on `ReportPredictionsRequest` below):
 * `classes.prompt_version` is a property of the class, not of the report,
 * and one report can carry boxes for more than one class — each stamped
 * with whichever wording was in force for it when the detector ran
 * (migration 0003: "provenance is stamped, not inferred").
 *
 * The coordinate and confidence bounds mirror migration 0003's CHECK
 * constraints exactly, so a malformed box is a clean 400 from this schema
 * rather than a D1 constraint error the worker would have to parse to
 * understand. `x_max >= x_min` and `y_max >= y_min` are cross-field and so
 * cannot be expressed as a bound on either coordinate alone; the two
 * `.superRefine` checks below are what the individual `.min()`/`.max()`
 * calls cannot cover.
 */
const PredictionBox = z
  .object({
    r2_key: z.string().min(1).openapi({ example: "frames/dQw4w9WgXcQ/00042.000.jpg" }),
    class_name: z.string().min(1).openapi({ example: "Paimon" }),
    x_min: z.number().min(0).max(1).openapi({ example: 0.12 }),
    y_min: z.number().min(0).max(1).openapi({ example: 0.2 }),
    x_max: z.number().min(0).max(1).openapi({ example: 0.5 }),
    y_max: z.number().min(0).max(1).openapi({ example: 0.6 }),
    confidence: z.number().min(0).max(1).openapi({ example: 0.87 }),
    prompt_version: z.string().max(200).openapi({ example: "2026-08-08-a" }),
  })
  .superRefine((box, ctx) => {
    if (box.x_max < box.x_min) {
      ctx.addIssue({ code: "custom", message: "x_max must be >= x_min", path: ["x_max"] });
    }
    if (box.y_max < box.y_min) {
      ctx.addIssue({ code: "custom", message: "y_max must be >= y_min", path: ["y_max"] });
    }
  })
  .openapi("PredictionBox");

/**
 * What a prelabel worker reports after running the detector across its
 * video's sampled frames (M11.2's one-method interface, landing after this
 * milestone) — one call per job, not one per box, the same as
 * `ReportImagesRequest` is one call per chunk and not one per frame.
 *
 * `worker_id` is here for the same reason it is on heartbeat, complete,
 * fanout and report-images: this is a write on a lease, and a request that
 * only knew a job id could write prediction rows against somebody else's
 * job.
 *
 * `model_id` is top-level and stamped onto every row in the batch, the same
 * idiom `ReportImagesRequest.dedup_threshold` uses: one report is one
 * detector run (M11.2: "model identifier recorded on every prediction, so
 * swapping the model is visible in the data"), so there is exactly one
 * value for the whole request to carry — contrast `prompt_version` above,
 * which varies per class and so travels with each box instead.
 */
export const ReportPredictionsRequest = z
  .object({
    worker_id: workerId,
    model_id: z.string().min(1).max(200).openapi({ example: "owlvit-base-patch32.onnx" }),
    predictions: z.array(PredictionBox).max(MAX_PREDICTIONS_PER_JOB),
    // Every r2_key the sampler drew for this job (M11.3), whether or not the
    // detector found a box on it — a detector finding nothing is a real
    // outcome (this file's own `TestPrelabelReportsAnEmptySampleWithoutFailing`
    // equivalent on the API side is the empty-report test in
    // predictions.test.ts), so `predictions` alone can never say which frames
    // were even looked at. Required rather than optional-and-defaulted-to-`[]`:
    // a prelabel job that cannot say what it sampled is a worker bug, not a
    // legitimate "I don't know" — the same argument `ReportImagesRequest.
    // frames_kept` makes for being checked rather than trusted blindly.
    //
    // This is where `images.selection_reason` (migration 0004, M10.2) gets
    // written — see `reportPredictionsHandler`'s own comment for why that
    // stamp happens here, together with the boxes, rather than at the moment
    // the sample was drawn.
    sampled_images: z.array(z.string().min(1)).max(MAX_SAMPLED_IMAGES_PER_JOB),
  })
  .openapi("ReportPredictionsRequest");

/**
 * Named `PredictionReport`, not after the operation: oapi-codegen owns the
 * `<OperationId>Response` namespace, and the operation is `reportPredictions`
 * — the same reason `ImageReport` is not `ReportImagesResponse`.
 */
export const PredictionReport = z
  .object({
    video_id: z.string().openapi({ example: "dQw4w9WgXcQ" }),
    predictions: z.int().nonnegative().openapi({ example: 34 }),
  })
  .openapi("PredictionReport");

/**
 * One active class as the prelabel worker needs to see it: the wording the
 * detector matches on, and the version stamped onto every prediction it
 * produces (migration 0003's `classes` table).
 *
 * Mirrors `worker.ClassPrompt` (worker/internal/worker/pipeline.go) field for
 * field — `name`, `appearance_prompt`/`Appearance`, `prompt_version`/
 * `Version` — which is the point: this is exactly what that struct needs and
 * nothing else. No `id`, no `active`, no timestamps: a worker never needs a
 * class's row id, and it never needs to be told a returned row is active
 * because the query is what guarantees that (see `listActiveClassesRoute`'s
 * own comment).
 */
const PrelabelClass = z
  .object({
    name: z.string().min(1).openapi({ example: "Paimon" }),
    appearance_prompt: z.string().min(1).openapi({
      example: "a small white-haired floating fairy companion with a dark crown and a white cape",
    }),
    prompt_version: z.string().max(200).openapi({ example: "2026-08-08-a" }),
  })
  .openapi("PrelabelClass");

/**
 * The bound on `ActiveClasses.classes`.
 *
 * 5x the 6-class assumption `MAX_PREDICTIONS_PER_JOB` already rounds
 * CONTEXT.md §12's "roughly 4-6 characters total" up to — the same headroom
 * `MAX_SAMPLED_IMAGES_PER_JOB` gives its own 200-image default. Generous
 * enough that M12's roster growth (adding a class without a deploy is the
 * entire point of that milestone) does not trip it, while still catching a
 * runaway seed migration before the mismatch it would cause is silent:
 * `queue.Client.ActiveClasses` feeds this list straight into
 * `worker.Pipeline`'s detector loop, and `MAX_PREDICTIONS_PER_JOB`'s ceiling
 * on one report is only correctly sized while the number of classes it
 * multiplies against stays near the assumption it was derived from.
 */
export const MAX_ACTIVE_CLASSES = 6 * 5;

/**
 * Named `ActiveClasses`, not after the operation: oapi-codegen owns the
 * `<OperationId>Response` namespace, and the operation is `listActiveClasses`
 * — the same reason `ImageReport` and `VideoImages` are not named after
 * theirs.
 */
export const ActiveClasses = z
  .object({
    classes: z.array(PrelabelClass).max(MAX_ACTIVE_CLASSES),
  })
  .openapi("ActiveClasses");

/**
 * The longest an appearance prompt may be.
 *
 * Migration 0006's five seeds run to about a hundred characters each, and the
 * text goes to a CLIP-style tokenizer whose context is 77 tokens — wording
 * past that is silently truncated by the model rather than rejected anywhere,
 * which would make the stored prompt and the prompt that actually ran two
 * different things with nothing to tell them apart. 500 is comfortably past
 * anything that survives tokenization intact, so this bound is the backstop
 * against a paste accident, not an opinion about how to word a prompt.
 */
const MAX_APPEARANCE_PROMPT = 500;

/**
 * One class as the operator sees it (M12.1) — the whole row, unlike
 * `PrelabelClass` above, which is trimmed to exactly what the detector needs.
 *
 * `active` is a boolean here and an INTEGER in D1 (migration 0003's `CHECK
 * (active IN (0, 1))`). The conversion happens in the handler rather than on
 * the wire, because a JSON `1` in a field named `active` is a value a UI has
 * to remember to interpret, and every place that forgets reads it as truthy by
 * accident rather than by contract.
 *
 * Carries `id`, which nothing else in this file hands out: every other route
 * refers to a class by `name` (see `PredictionBox.class_name`'s comment).
 * Admin edits cannot, precisely because renaming is one of the things they
 * might do — an endpoint keyed on the mutable field would lose the row it was
 * editing the moment it succeeded.
 */
export const AdminClass = z
  .object({
    id: z.int().positive().openapi({ example: 1 }),
    name: z.string().openapi({ example: "Paimon" }),
    appearance_prompt: z.string().openapi({
      example: "a small white-haired floating fairy companion with a dark crown and a white cape",
    }),
    prompt_version: z.string().openapi({ example: "2026-08-08-a" }),
    active: z.boolean().openapi({ example: true }),
    created_at: z.int().openapi({ example: 1_754_099_000 }),
    updated_at: z.int().openapi({ example: 1_754_100_030 }),
  })
  .openapi("AdminClass");

export type AdminClassRow = z.infer<typeof AdminClass>;

/**
 * Named `AdminClassList`, not `ListClassesResponse`: oapi-codegen owns the
 * `<OperationId>Response` namespace, and the operation is `listClasses`.
 *
 * Unbounded, deliberately, where `ActiveClasses` is capped at
 * `MAX_ACTIVE_CLASSES`. That cap protects the *worker*, whose per-job
 * prediction ceiling is sized against the number of classes it will run; this
 * is the operator's roster, and it grows by one every time a class is retired
 * rather than deleted (M12.1's "never delete"). A bound here would eventually
 * refuse to show an admin the history they are forbidden from clearing.
 */
export const AdminClassList = z.object({ classes: z.array(AdminClass) }).openapi("AdminClassList");

/**
 * What creating a class takes (M12.1).
 *
 * No `active`: a class is created deactivated, always, and turned on by a
 * separate edit. That is the ordering M12.2 exists for — a prompt is tried
 * against a sample of frames *before* it counts — and an `active: true` on
 * creation would be the one request that skips it.
 *
 * No `prompt_version` either. The server stamps the first tag for the same
 * reason it computes every later one (see `src/prompt-version.ts`): a caller
 * that can choose the tag can choose one already stamped on existing boxes.
 */
export const CreateClassRequest = z
  .object({
    name: z.string().min(1).max(100).openapi({ example: "Nahida" }),
    appearance_prompt: z
      .string()
      .min(1)
      .max(MAX_APPEARANCE_PROMPT)
      .openapi({ example: "a small girl with long white-and-green hair" }),
  })
  .openapi("CreateClassRequest");

/**
 * What editing a class takes (M12.1): the wording, the active flag, or both.
 *
 * Both optional and at least one required. An empty body is refused rather
 * than treated as a no-op — a UI that forgot to send its field would otherwise
 * get a 200 and look like it saved.
 *
 * `name` is absent on purpose, although migration 0003 anticipates renaming.
 * `reportPredictions` resolves a box's class by `name` (`PredictionBox`'s own
 * comment on why), so a rename between a detector run and the report it
 * produces turns that report into a 400 the worker classifies as terminal —
 * a prelabel job lost to an admin's typo fix. The day renaming is worth having
 * is the day predictions are reported by id.
 */
export const UpdateClassRequest = z
  .object({
    appearance_prompt: z
      .string()
      .min(1)
      .max(MAX_APPEARANCE_PROMPT)
      .optional()
      .openapi({ example: "a tiny white-haired floating companion with a dark crown" }),
    active: z.boolean().optional().openapi({ example: true }),
  })
  .refine((body) => body.appearance_prompt !== undefined || body.active !== undefined, {
    message: "give at least one of appearance_prompt or active",
  })
  .openapi("UpdateClassRequest");

/**
 * The `{id}` path parameter for the class-management routes. Same digits-then-
 * parse treatment as `JobIdParam`, and deliberately not `z.coerce.number()`,
 * for that schema's own reason: coercion resolves `0x10`, `1e3` and `+1` to
 * different integers, so a malformed id would edit some other class rather
 * than being rejected.
 */
export const ClassIdParam = z.object({
  id: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .refine((id) => id > 0)
    .openapi({ param: { name: "id", in: "path" }, type: "integer", example: 1 }),
});

/**
 * How many frames the *wide* dry-run mode runs the candidate wording over
 * (M12.2's "~50 frames").
 *
 * M17 (plan §A) added a second, narrower mode — one named frame, iterated
 * repeatedly, so a reworded prompt is compared against the *same* input
 * instead of a fresh random fifty each time. This constant did not shrink to
 * match it: the wide draw stays as the confirmation step before a wording is
 * accepted, because a wording tuned to nail one pose and one lighting
 * condition can still be worse across a whole video. "Iterate narrow,
 * confirm wide" needs both sample sizes to keep existing, not one replacing
 * the other.
 *
 * Fixed here rather than accepted from the caller, and that is a cost
 * decision as much as a contract one: detection is CPU-only on the box's two
 * cores at seconds per image (CONTEXT.md §12), so a caller-chosen 2,000 would
 * be hours of the same queue every real job runs through. Fifty is enough
 * frames to see whether a prompt grounds at all, which is the question a
 * dry-run exists to answer — it is not a measurement of precision, and
 * anything that tried to be would need the eval pool M12 does not have.
 *
 * Stamped onto `dryruns.sample_size` rather than only lived here, in
 * `images.dedup_threshold`'s idiom: raising it later must not make an old
 * dry-run's box count read as a different result than it was.
 */
export const DRYRUN_SAMPLE_SIZE = 50;

/**
 * The bound on `ReportDryRunRequest.boxes`.
 *
 * Sized against the wide mode: one class, `DRYRUN_SAMPLE_SIZE` frames, so 20
 * boxes on a single frame is already far past anything a usable prompt
 * produces — this is sized to reject a detector that has started emitting
 * garbage rather than to accommodate a plausible run, the same posture
 * `MAX_PREDICTIONS_PER_JOB` takes. Left unchanged by M17's single-frame mode
 * on purpose: the wide path still exists and still needs this room, and a
 * single-frame run's own boxes are a small fraction of it — there is nothing
 * to gain by narrowing a ceiling neither mode gets close to on a real prompt.
 */
export const MAX_DRYRUN_BOXES = DRYRUN_SAMPLE_SIZE * 20;

/**
 * One box a dry-run proposed.
 *
 * No `class_name` and no `prompt_version`, unlike `PredictionBox`: a dry-run
 * runs exactly one candidate wording for exactly one class, both of which the
 * `dryruns` row already records, so repeating them per box would be repeating
 * the request back. Nothing stamps these onto a row anywhere — see
 * `dryruns.boxes` in migration 0007 for why a dry-run's output is deliberately
 * not label data.
 */
const DryRunBox = z
  .object({
    r2_key: z.string().min(1).openapi({ example: "frames/dQw4w9WgXcQ/00042.000.jpg" }),
    x_min: z.number().min(0).max(1).openapi({ example: 0.12 }),
    y_min: z.number().min(0).max(1).openapi({ example: 0.2 }),
    x_max: z.number().min(0).max(1).openapi({ example: 0.5 }),
    y_max: z.number().min(0).max(1).openapi({ example: 0.6 }),
    confidence: z.number().min(0).max(1).openapi({ example: 0.41 }),
  })
  .superRefine((box, ctx) => {
    if (box.x_max < box.x_min) {
      ctx.addIssue({ code: "custom", message: "x_max must be >= x_min", path: ["x_max"] });
    }
    if (box.y_max < box.y_min) {
      ctx.addIssue({ code: "custom", message: "y_max must be >= y_min", path: ["y_max"] });
    }
  })
  .openapi("DryRunBox");

/**
 * What starting a dry-run takes (M12.2; M17 plan §A adds the single-frame
 * mode).
 *
 * Exactly one of `image_id` or `video_id`, never both and never neither —
 * enforced by the `superRefine` below rather than a discriminated union,
 * because the two modes share every other field and a discriminant tag would
 * be one more thing this contract asks a caller to think about for no
 * benefit to either runtime.
 *
 * `image_id` is the new, narrow mode: one named frame, so a reworded prompt
 * is compared against the *same* input on the next run instead of a fresh
 * random draw. `video_id` is the original wide mode, kept deliberately (see
 * `DRYRUN_SAMPLE_SIZE`'s own comment on why) — a random sample across the
 * whole video, for confirming a wording before it is accepted rather than
 * for iterating on one.
 *
 * Whichever is given is the caller's pick, not the server's. Which footage
 * (or which frame of it) a prompt is tried against is the judgement being
 * made — a character who appears in one video and not another, or in one
 * pose and not another, is the difference between a prompt that looks broken
 * and one that looks fine — so choosing it silently would hide the variable
 * that matters most in reading the result.
 *
 * No `sample_size`: see `DRYRUN_SAMPLE_SIZE` for the wide mode's value; the
 * narrow mode's is always 1 and the handler writes it, never the caller.
 */
export const CreateDryRunRequest = z
  .object({
    image_id: z.int().positive().optional().openapi({ example: 42 }),
    video_id: z.string().min(1).optional().openapi({ example: "dQw4w9WgXcQ" }),
    appearance_prompt: z
      .string()
      .min(1)
      .max(MAX_APPEARANCE_PROMPT)
      .openapi({ example: "a tiny white-haired floating companion with a dark crown" }),
  })
  .superRefine((body, ctx) => {
    if (Boolean(body.image_id) === Boolean(body.video_id)) {
      ctx.addIssue({
        code: "custom",
        message: "give exactly one of image_id or video_id, never both and never neither",
        path: ["image_id"],
      });
    }
  })
  .openapi("CreateDryRunRequest");

/**
 * A dry-run as the admin screen reads it: the request, and the result once
 * there is one.
 *
 * `status` is `jobs.status`, joined rather than duplicated onto the `dryruns`
 * row. A second status column would be a second thing to keep true, and the
 * reaper — which knows nothing about dry-runs — already moves the one in
 * `jobs` when a lease goes stale.
 *
 * `boxes` and `sampled_keys` are `.nullable()` rather than defaulted to empty
 * arrays, and the distinction is the whole reading of the screen: a run that
 * has not reported yet has *no* result, while a run that reported an empty
 * `boxes` over 50 `sampled_keys` has a very definite one — the wording matched
 * nothing. Collapsing those two into `[]` would make "still running" and "this
 * prompt is useless" render identically.
 *
 * `image_id` is `.nullable()` rather than `.optional()`, matching migration
 * 0010's own column: `null` is the wide mode read back honestly, not an
 * absent field. `video_id` stays required either way — even a narrow,
 * single-frame run has one, derived from the image at creation time (M17,
 * plan §A), because migration 0008's `CHECK` requires a non-null `video_id`
 * for every job kind but `snapshot`.
 */
export const DryRun = z
  .object({
    id: z.int().positive().openapi({ example: 1 }),
    job_id: z.int().positive().openapi({ example: 42 }),
    class_id: z.int().positive().openapi({ example: 1 }),
    class_name: z.string().openapi({ example: "Paimon" }),
    video_id: z.string().openapi({ example: "dQw4w9WgXcQ" }),
    image_id: z.int().positive().nullable().openapi({ example: 42 }),
    appearance_prompt: z.string().openapi({
      example: "a tiny white-haired floating companion with a dark crown",
    }),
    sample_size: z.int().positive().openapi({ example: 50 }),
    status: JobStatus,
    failure_reason: z.string().nullable().openapi({ example: "the detector sidecar is down" }),
    model_id: z.string().nullable().openapi({ example: "owlvit-base-patch32.onnx" }),
    boxes: z.array(DryRunBox).nullable(),
    sampled_keys: z.array(z.string()).nullable(),
    requested_by: z.string().openapi({ example: "admin@example.com" }),
    created_at: z.int().openapi({ example: 1_754_099_000 }),
    reported_at: z.int().nullable().openapi({ example: 1_754_099_400 }),
  })
  .openapi("DryRun");

export type DryRunRow = z.infer<typeof DryRun>;

/**
 * Named `DryRunList`, not after the operation (`listDryRuns`) — oapi-codegen
 * owns the `<OperationId>Response` namespace.
 */
export const DryRunList = z.object({ dryruns: z.array(DryRun) }).openapi("DryRunList");

/**
 * How many of a class's dry-runs the list route returns.
 *
 * Small on purpose. Boxes travel inline (see `DryRun`), so this is the one
 * response in the API whose size scales with how much work somebody has done,
 * and the screen it feeds shows one run at a time anyway. Three is enough to
 * compare a wording against the two before it, which is the actual activity.
 */
export const DRYRUN_HISTORY = 3;

/**
 * `GET /api/admin/classes/{id}/dryruns`'s optional filter (M17, plan §A).
 *
 * Narrows the history to one frame's own attempts, which is what
 * `DryRunPanel`'s comparison strip actually wants once an admin has picked a
 * frame and is iterating wordings against it — without this, `DRYRUN_HISTORY`
 * rows newest-first could show a mix of runs against different frames (or
 * different videos, in the wide mode) interleaved with the ones the operator
 * is actually comparing. Same digits-then-parse treatment as `ClassIdParam`,
 * for that schema's own reason.
 */
export const ListDryRunsQuery = z.object({
  image_id: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .refine((n) => n > 0)
    .optional()
    .openapi({ param: { name: "image_id", in: "query" }, type: "integer", example: 42 }),
});

/**
 * What a dry-run worker reports back (M12.2).
 *
 * `worker_id` is here for the reason it is on every other write in this file:
 * this is a write on a lease, and a request that only knew a job id could
 * overwrite somebody else's dry-run result.
 *
 * `sampled_images` is required rather than optional-and-defaulted, exactly as
 * `ReportPredictionsRequest.sampled_images` is: a run that cannot say what it
 * looked at cannot be told apart from a prompt that matched nothing.
 */
export const ReportDryRunRequest = z
  .object({
    worker_id: workerId,
    model_id: z.string().min(1).max(200).openapi({ example: "owlvit-base-patch32.onnx" }),
    boxes: z.array(DryRunBox).max(MAX_DRYRUN_BOXES),
    sampled_images: z.array(z.string().min(1)).max(DRYRUN_SAMPLE_SIZE),
  })
  .openapi("ReportDryRunRequest");

/** Named `DryRunReport`, not after the `reportDryRun` operation. */
export const DryRunReport = z
  .object({
    dryrun_id: z.int().positive().openapi({ example: 1 }),
    boxes: z.int().nonnegative().openapi({ example: 7 }),
  })
  .openapi("DryRunReport");

/**
 * One label a snapshot admits for one image (M15.1, M15.3).
 *
 * No `id`, no `prompt_version`, no `model_id`: unlike `ProposedBox`, this is
 * not a proposal a screen renders and lets an operator rule on — it is the
 * resolved outcome of a ruling that already happened, exactly the shape a
 * training script needs and nothing about how the box was arrived at. There
 * is also no verdict kind on it. `snapshotSourceHandler` (M15.3's default
 * inclusion policy) only ever emits one label per prediction, resolved to
 * whichever coordinates that prediction's latest admin verdict settled on —
 * the prediction's own box for `accept`, the verdict's adjusted box for
 * `adjust` — so there is nothing left for a reader of this shape to resolve.
 */
const SnapshotLabel = z
  .object({
    class_name: z.string().openapi({ example: "Paimon" }),
    x_min: z.number().min(0).max(1).openapi({ example: 0.12 }),
    y_min: z.number().min(0).max(1).openapi({ example: 0.2 }),
    x_max: z.number().min(0).max(1).openapi({ example: 0.5 }),
    y_max: z.number().min(0).max(1).openapi({ example: 0.6 }),
  })
  .openapi("SnapshotLabel");

/**
 * One image the current inclusion policy admits, and the labels it carries
 * (M15.1).
 *
 * `selection_reason` travels here rather than being resolved into `split` by
 * this response: the worker is what decides how a reason maps onto a split
 * (M15.2's own rule — "holds `selection_reason = 'random'` images out of
 * train" — is a property of the *builder*, not of the contract), and handing
 * back the raw column keeps that decision in one place instead of splitting
 * it across the API and the worker that reads it. `labels` is never empty:
 * `snapshotSourceHandler` only emits an image once it carries at least one
 * (see that handler's own comment).
 */
const SnapshotSourceImage = z
  .object({
    r2_key: z.string().min(1).openapi({ example: "frames/dQw4w9WgXcQ/00042.000.jpg" }),
    video_id: z.string().openapi({ example: "dQw4w9WgXcQ" }),
    timestamp_seconds: z.number().nonnegative().openapi({ example: 42 }),
    selection_reason: z.string().nullable().openapi({ example: "random" }),
    labels: z.array(SnapshotLabel).min(1),
  })
  .openapi("SnapshotSourceImage");

/**
 * The bound on `SnapshotSource.images`.
 *
 * A snapshot is the whole dataset's admitted rows, not a page of it — unlike
 * `AdminVideoList`'s picker or `LabellingBatch`'s session, there is no
 * correct answer smaller than "everything the policy currently admits", so
 * this is not sized against a UI session the way those are. `MAX_VIDEO_
 * SECONDS` is v1's own hard ceiling on how many `images` rows any single
 * video can ever have produced (extraction runs at 1fps); multiplied by a
 * generous headroom for how many videos this deployment can plausibly hold
 * before a bound like this is the least of its problems, it exists only to
 * turn a runaway query into a 200 with a body too large to be useful rather
 * than an unbounded one with no ceiling stated anywhere in the contract.
 */
export const MAX_SNAPSHOT_IMAGES = MAX_VIDEO_SECONDS * 50;

/**
 * Named `SnapshotSource`, not after the `snapshotSource` operation.
 *
 * The whole answer to "what goes in this snapshot" for the current inclusion
 * policy (M15.3's default: `source = 'admin'` verdicts only, latest one per
 * prediction, `accept` or `adjust`). One call rather than a page per video —
 * the same argument `ReportPredictionsRequest` makes for a whole job's boxes
 * in one report — because the worker has to see the entire admitted set
 * before it can compute counts and write one manifest describing all of it.
 */
export const SnapshotSource = z
  .object({
    images: z.array(SnapshotSourceImage).max(MAX_SNAPSHOT_IMAGES),
  })
  .openapi("SnapshotSource");

/**
 * The inclusion policy every snapshot built by this deployment currently
 * uses (M15.3). Free text on the `snapshots` row rather than a versioned
 * policy table (migration 0003's own comment on `snapshots.inclusion_policy`
 * explains why: a snapshot's dataset must be reconstructible from its own
 * row, not from a foreign key into a table that might later change meaning
 * underneath it) — this constant is simply today's one policy, stated once
 * so `snapshotSourceHandler` and `createSnapshotHandler` cannot describe two
 * different policies by accident.
 */
export const DEFAULT_INCLUSION_POLICY =
  "source=admin; verdict=latest per prediction, accept or adjust; " +
  "split: selection_reason='random' -> eval, else train";

/**
 * What a snapshot worker reports after writing the artifact to R2 (M15.1).
 *
 * `worker_id` is here for the reason it is on every other write on a held
 * job: this is a write on a lease, and a request that only knew a job id
 * could write a `snapshots` row against somebody else's job. `r2_key` is the
 * prefix the worker actually wrote under — stamped by the worker, not
 * derived by the API, because the worker is what knows whether the upload
 * genuinely finished (migration 0003's `snapshots.r2_key` comment: not
 * `UNIQUE`, expected to embed an identifier the worker already has, here the
 * job id rather than the eventual `snapshots.id` this insert has not
 * produced yet).
 */
export const ReportSnapshotRequest = z
  .object({
    worker_id: workerId,
    r2_key: z.string().min(1).openapi({ example: "snapshots/job-142" }),
    image_count: z.int().nonnegative().openapi({ example: 254 }),
    label_count: z.int().nonnegative().openapi({ example: 401 }),
  })
  .openapi("ReportSnapshotRequest");

/** Named `SnapshotReport`, not after the `reportSnapshot` operation. */
export const SnapshotReport = z
  .object({
    snapshot_id: z.int().positive().openapi({ example: 1 }),
  })
  .openapi("SnapshotReport");

/**
 * A dataset snapshot as the operator sees it (M15.1's "listable with counts
 * and dates"): the whole `snapshots` row (migration 0003), unmodified — there
 * is nothing this row needs trimmed the way `Job` trims `AdminJob`'s lease
 * columns, because a snapshot has no lease of its own once it exists.
 */
export const Snapshot = z
  .object({
    id: z.int().positive().openapi({ example: 1 }),
    r2_key: z.string().openapi({ example: "snapshots/job-142" }),
    image_count: z.int().nonnegative().openapi({ example: 254 }),
    label_count: z.int().nonnegative().openapi({ example: 401 }),
    inclusion_policy: z.string().openapi({ example: DEFAULT_INCLUSION_POLICY }),
    created_at: z.int().openapi({ example: 1_754_099_000 }),
  })
  .openapi("Snapshot");

/** Named `SnapshotList`, not after the `listSnapshots` operation. */
export const SnapshotList = z.object({ snapshots: z.array(Snapshot) }).openapi("SnapshotList");

/**
 * What triggering a snapshot build returns (M15.1): the job, queued and not
 * yet run. Not `Snapshot` — there is no `snapshots` row yet, precisely
 * because building one is a job rather than something this request does
 * inline (ROADMAP.md M15.1: "building one must not depend on a browser tab
 * staying open").
 */
export const SnapshotJob = z
  .object({
    job_id: z.int().positive().openapi({ example: 142 }),
    status: JobStatus,
  })
  .openapi("SnapshotJob");

/**
 * One video, for two screens that turned out to want almost the same row:
 * the dry-run form's picker (M12.2) and `/admin/videos`'s coverage table
 * (M16, ROADMAP M16 "scope line"; M19 plan §B folded that table in from the
 * since-deleted `/admin/detection`). Extended rather than given that table a
 * route of its own — `listVideosHandler` already computes one row per video
 * on every call, and M16's own plan is explicit that this milestone adds
 * exactly three *new* routes; three more fields on an existing one is not a
 * fourth.
 *
 * `image_count` rather than a boolean: a video whose extraction is still
 * running has some frames and will have more, and an admin choosing between
 * "12 frames so far" and "2,685" is making a real choice about how meaningful
 * a 50-frame sample off it will be.
 *
 * `frames_sampled` is deliberately not derived from "how many frames carry a
 * prediction." M11.4 runs a sampled image against every active class, and a
 * menu, loading screen or black frame — VerificationCard's own comment calls
 * these "the common case in a sampled timeline" — is exactly the frame a
 * zero-shot detector is likeliest to propose nothing on, so counting
 * predictions would undercount sampling specifically for the frames this
 * system already expects to be empty. `images.selection_reason` (migration
 * 0004) is stamped at selection time regardless of what the detector later
 * finds, which is the fact this column exists to answer honestly.
 */
const AdminVideo = z
  .object({
    id: z.string().openapi({ example: "dQw4w9WgXcQ" }),
    title: z.string().nullable().openapi({ example: "Genshin Impact — Archon quest" }),
    image_count: z.int().nonnegative().openapi({ example: 2685 }),
    created_at: z.int().openapi({ example: 1_754_099_000 }),
    frames_sampled: z.int().nonnegative().openapi({ example: 200 }),
    // Null until at least one prediction exists for the video — no prelabel
    // job has reported anything yet, which is a different fact from "reported
    // and found zero classes," the same distinction `DryRun`'s own `boxes`
    // field draws for the same reason.
    model_id: z.string().nullable().openapi({ example: "owlvit-base-patch32.onnx" }),
    prelabelled_at: z.int().nullable().openapi({ example: 1_754_099_500 }),
  })
  .openapi("AdminVideo");

/** Named `AdminVideoList`, not after the `listVideos` operation. */
export const AdminVideoList = z.object({ videos: z.array(AdminVideo) }).openapi("AdminVideoList");

/** How many videos the picker lists — newest first, and nobody scrolls past this. */
export const VIDEO_PICKER_LIMIT = 50;

/**
 * The frame an admin screen wants the bytes of, by R2 key.
 *
 * A query parameter rather than a path segment, because the key contains
 * slashes (`frames/dQw4w9WgXcQ/00042.000.jpg`) and a path that had to swallow
 * them would be a wildcard route this spec could not describe honestly.
 */
export const ImageQuery = z.object({
  key: z
    .string()
    .min(1)
    .openapi({ param: { name: "key", in: "query" }, example: "frames/dQw4w9WgXcQ/00042.000.jpg" }),
});

export const JobListQuery = z.object({
  status: JobStatus.optional().openapi({ param: { name: "status", in: "query" } }),
  limit: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .refine((n) => n >= 1 && n <= 200)
    .optional()
    .openapi({ param: { name: "limit", in: "query" }, type: "integer", example: 50 }),
});

/**
 * The `{id}` path parameter for the routes keyed on an image (M13.1, M13.3).
 *
 * Same digits-then-parse treatment as `JobIdParam` and `ClassIdParam`, for
 * their reason: coercion would resolve `0x10` and `1e3` to integers, so a
 * malformed id would rule on some other frame rather than being refused.
 *
 * There is no prediction-keyed equivalent, and that is the shape of the whole
 * verdict surface: a ruling is submitted with its frame, never on its own.
 */
export const ImageIdParam = z.object({
  id: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .refine((id) => id > 0)
    .openapi({ param: { name: "id", in: "path" }, type: "integer", example: 1 }),
});

/** Mirrors the `verdict` CHECK constraint in migration 0003. */
export const VerdictKind = z.enum(["accept", "adjust", "reject"]).openapi("VerdictKind");

/**
 * A human's ruling on one model-proposed box (M13.2).
 *
 * The adjusted coordinates are four optional top-level fields rather than a
 * nested `adjusted` object, because that is the shape the row has (migration
 * 0003) and a nested object would need unwrapping in the handler for no gain.
 * The `superRefine` below mirrors that migration's CHECK exactly — present on
 * `adjust`, absent otherwise — so a body that disagrees with it is a 400
 * naming the field rather than a D1 constraint failure the caller has to
 * decode.
 *
 * There is no `source` and no `annotator_id`. Both are read off the Access
 * assertion by the handler (`verdicts.source = 'admin'`, `annotator_id` = the
 * verified email): a caller that could name its own source could write an
 * admin verdict from the public page, which is the one thing keeping untrusted
 * input out of the dataset (CONTEXT.md §Q10).
 */
const StagedVerdict = z
  .object({
    prediction_id: z.int().positive().openapi({ example: 42 }),
    verdict: VerdictKind,
    adjusted_x_min: z.number().min(0).max(1).optional().openapi({ example: 0.14 }),
    adjusted_y_min: z.number().min(0).max(1).optional().openapi({ example: 0.22 }),
    adjusted_x_max: z.number().min(0).max(1).optional().openapi({ example: 0.48 }),
    adjusted_y_max: z.number().min(0).max(1).optional().openapi({ example: 0.61 }),
  })
  .superRefine((body, ctx) => {
    const corners = [
      body.adjusted_x_min,
      body.adjusted_y_min,
      body.adjusted_x_max,
      body.adjusted_y_max,
    ];
    const given = corners.filter((corner) => corner !== undefined).length;

    if (body.verdict === "adjust" && given !== 4) {
      ctx.addIssue({
        code: "custom",
        message: "an adjust verdict needs all four adjusted coordinates",
        path: ["adjusted_x_min"],
      });
      return;
    }

    if (body.verdict !== "adjust" && given > 0) {
      ctx.addIssue({
        code: "custom",
        message: `a ${body.verdict} verdict must not carry adjusted coordinates`,
        path: ["adjusted_x_min"],
      });
      return;
    }

    // Cross-field, so no bound on either coordinate alone can express it —
    // `PredictionBox` makes the same two checks for the same reason.
    if (body.adjusted_x_max !== undefined && body.adjusted_x_min !== undefined) {
      if (body.adjusted_x_max < body.adjusted_x_min) {
        ctx.addIssue({
          code: "custom",
          message: "adjusted_x_max must be >= adjusted_x_min",
          path: ["adjusted_x_max"],
        });
      }
    }
    if (body.adjusted_y_max !== undefined && body.adjusted_y_min !== undefined) {
      if (body.adjusted_y_max < body.adjusted_y_min) {
        ctx.addIssue({
          code: "custom",
          message: "adjusted_y_max must be >= adjusted_y_min",
          path: ["adjusted_y_max"],
        });
      }
    }
  })
  .openapi("StagedVerdict");

/**
 * The bound on one frame's rulings.
 *
 * A frame carries one box per detected object per active class, and
 * `MAX_ACTIVE_CLASSES` is 30 — a hundred is far past anything a real frame
 * produces while still refusing outright a client that has confused an image
 * id for something else. It is also comfortably inside D1's 100-parameter
 * ceiling per *statement*, which this endpoint does not approach anyway: it
 * writes one statement per verdict inside a single batch.
 */
export const MAX_VERDICTS_PER_IMAGE = 100;

/**
 * A whole frame's rulings, submitted together (M13.1's staging area).
 *
 * One call per frame rather than one per box, in the idiom `reportImages` and
 * `reportPredictions` already use — and here the reason is the operator rather
 * than the wire. A screen that wrote each ruling the moment it was clicked had
 * to remove the box it had just ruled on, which renumbered every box below it
 * while the cursor was still moving toward the next one. Rulings are staged in
 * the UI until submitted, so the frame holds still, and this endpoint is the
 * shape that staging needs.
 *
 * Written as one D1 batch: all of a frame's rulings land or none do. A partial
 * write would leave the frame in the pool with some boxes ruled and some not,
 * which is a legal state (that is exactly how a partly-ruled frame comes back)
 * and therefore one nothing downstream could distinguish from a deliberate
 * partial submit.
 *
 * `verdicts` may be empty — see `submitVerdictsRoute`, which answers 400 for
 * it. Bounded rather than open: a client that sent ten thousand rulings for
 * one frame has a bug, and finding out at the ceiling beats finding out at the
 * D1 timeout.
 */
export const CreateVerdictsRequest = z
  .object({
    verdicts: z.array(StagedVerdict).min(1).max(MAX_VERDICTS_PER_IMAGE),
  })
  .openapi("CreateVerdictsRequest");

/**
 * What a submission wrote (M13.1).
 *
 * A count rather than the rows. The rows would be evidence that an `adjust`
 * landed on the verdict and not on the prediction — the property CONTEXT.md
 * §12 turns on — but that is a claim about the *schema*, held down by
 * `verdicts.test.ts` reading `predictions` back after an adjust, not something
 * a response echoing its own request could establish. What the caller actually
 * needs is how many rows exist now, so a frame can leave the session.
 */
export const VerdictBatch = z
  .object({
    image_id: z.int().positive().openapi({ example: 1 }),
    verdicts: z.int().nonnegative().openapi({ example: 4 }),
  })
  .openapi("VerdictBatch");

/**
 * What reporting a missed object takes (M13.3).
 *
 * `class_id` is nullable rather than optional-and-absent, and both are
 * accepted: null is the real case migration 0003 describes — "something is
 * missing here" for a character that is not in `classes` at all — and a
 * reporter who does know which class it was names it. Nothing else is on the
 * body: the reporter comes from the Access assertion, the image from the path.
 */
export const CreateMissingReportRequest = z
  .object({
    class_id: z.int().positive().nullable().optional().openapi({ example: 3 }),
  })
  .openapi("CreateMissingReportRequest");

/** The `missing_reports` row as written (M13.3). */
export const MissingReport = z
  .object({
    id: z.int().positive().openapi({ example: 1 }),
    image_id: z.int().positive().openapi({ example: 7 }),
    class_id: z.int().positive().nullable().openapi({ example: 3 }),
    reporter: z.string().openapi({ example: "admin@example.com" }),
    created_at: z.int().openapi({ example: 1_754_099_000 }),
  })
  .openapi("MissingReport");

/**
 * How many frames one call of the labelling batch hands out (M13.4), and the
 * ceiling on what a caller may ask for.
 *
 * CONTEXT.md §Q25 sizes the session at "a couple of hundred images per
 * sitting" served as "N images and their signed URLs in one call" — about ten
 * batched calls. Twenty is that arithmetic. The ceiling is a hundred because
 * every image in a batch costs one HMAC chain to sign and one row of
 * predictions to join, and because a session that asked for a thousand would
 * be holding signed URLs that expire long before it reaches them.
 */
export const LABELLING_BATCH_SIZE = 20;
export const MAX_LABELLING_BATCH = 100;

/**
 * How long a batch's URLs stay good (M13.4).
 *
 * Short enough that a URL pasted elsewhere is worthless within the sitting,
 * long enough that an operator working through twenty frames does not hit an
 * expiry mid-batch. The UI treats an expiry as a re-request rather than an
 * error (M13.4), so being wrong in the short direction costs one extra call
 * and being wrong in the long direction weakens the bound §Q25 is built on.
 */
export const PRESIGN_TTL_SECONDS = 15 * 60;

export const LabellingBatchQuery = z.object({
  limit: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .refine((n) => n >= 1 && n <= MAX_LABELLING_BATCH)
    .optional()
    .openapi({ param: { name: "limit", in: "query" }, type: "integer", example: 20 }),
});

/**
 * One proposed box as the verification UI receives it (M13.4).
 *
 * Carries `id`, unlike `PredictionBox` — which is the same schema in the other
 * direction, a worker *writing* boxes by natural key. A verdict references
 * `predictions.id`, so the row id is precisely what this direction has to hand
 * out and the write direction cannot supply.
 *
 * `class_name` travels beside `class_id` rather than being looked up by the
 * client: the UI renders the name on the box and posts nothing keyed on it, so
 * fetching a roster to resolve ids would be a second request to render a
 * label.
 */
const ProposedBox = z
  .object({
    id: z.int().positive().openapi({ example: 42 }),
    class_id: z.int().positive().openapi({ example: 1 }),
    class_name: z.string().openapi({ example: "Paimon" }),
    x_min: z.number().openapi({ example: 0.12 }),
    y_min: z.number().openapi({ example: 0.2 }),
    x_max: z.number().openapi({ example: 0.5 }),
    y_max: z.number().openapi({ example: 0.6 }),
    confidence: z.number().openapi({ example: 0.87 }),
    prompt_version: z.string().openapi({ example: "2026-08-08-a" }),
    model_id: z.string().openapi({ example: "owlvit-base-patch32.onnx" }),
  })
  .openapi("ProposedBox");

/**
 * One frame in a labelling batch: where to fetch its bytes, and what the model
 * proposed on it.
 *
 * `predictions` carries only the boxes this annotator has not already ruled
 * on. A frame comes back into the pool while any of its boxes is unruled (see
 * `labellingBatchHandler`), so echoing the ruled ones too would show an
 * operator a box they just accepted with no way to tell it apart from one they
 * had not reached.
 *
 * `public_sample` travels with the frame (M14.1) so the verification screen
 * can render the flag's current state without a second request per frame —
 * the same reason `class_name` rides beside `class_id` on `ProposedBox`
 * rather than being looked up separately.
 */
const LabellingImage = z
  .object({
    id: z.int().positive().openapi({ example: 7 }),
    video_id: z.string().openapi({ example: "dQw4w9WgXcQ" }),
    r2_key: z.string().openapi({ example: "frames/dQw4w9WgXcQ/00042.000.jpg" }),
    timestamp_seconds: z.number().openapi({ example: 42 }),
    url: z.string().openapi({
      example:
        "https://account.r2.cloudflarestorage.com/crowdmon-frames/frames/…?X-Amz-Signature=…",
    }),
    predictions: z.array(ProposedBox),
    public_sample: z.boolean().openapi({ example: false }),
  })
  .openapi("LabellingImage");

/**
 * A labelling session's next N frames, their boxes and their URLs (M13.4).
 *
 * `url_mode` is on the wire because the two modes fail differently and the UI
 * has to know which it is holding. A `signed` URL goes straight to R2 and
 * answers 403 once it expires — that is the case M13.4 requires the UI to
 * treat as a re-request rather than an error. A `proxy` URL is this Worker's
 * own Access-gated `/api/admin/image` route, which does not expire on its own
 * and whose 403 means the operator's Access session is what ended. Guessing
 * between those two from a status code alone is exactly the ambiguity this
 * field removes.
 *
 * `expires_at` is populated in both modes so the UI has one refresh rule
 * rather than a branch: in `proxy` mode it is when the batch would have
 * expired had it been signed, which is a harmless early refresh.
 */
export const LabellingBatch = z
  .object({
    images: z.array(LabellingImage).max(MAX_LABELLING_BATCH),
    url_mode: z.enum(["signed", "proxy"]).openapi({ example: "signed" }),
    expires_at: z.int().openapi({ example: 1_754_099_900 }),
    /** How many frames are still waiting, this batch included — the session's own progress bar. */
    remaining: z.int().nonnegative().openapi({ example: 214 }),
  })
  .openapi("LabellingBatch");

/**
 * One class's labelling numbers (M13.3, M13.4).
 *
 * Counts rather than rates, and the denominator lives on `LabellingPool`
 * beside them. A rate computed in SQL would have to pick a rounding and a
 * zero-denominator convention here, in the contract, where a reader cannot see
 * either — and the two numbers a rate is built from are worth showing anyway:
 * "3 missing reports over 40 verified frames" says something "0.075" does not.
 *
 * Verdicts are counted per source (CONTEXT.md §Q10: rates are computed per
 * source, or an anonymous troll rejecting everything is indistinguishable from
 * a model that got worse). M13 writes only `admin` rows into `accepted` /
 * `adjusted` / `rejected`; M14.4 adds the matching `anon_*` triple rather than
 * a single lumped `anon_verdicts` count, because "per source" means the same
 * breakdown for both, not a headline number for one and three for the other.
 * `anon_adjusted` stays in the shape even though `submitPublicVerdictsHandler`
 * currently refuses the `adjust` kind at the schema layer — the `verdicts`
 * table itself has no CHECK tying `source` to which `verdict` values are
 * legal, so the column names the state honestly rather than by what today's
 * one caller happens to send.
 *
 * **Every count below is a count of boxes, not of verdict rows.** Several
 * verdicts on one prediction is a legal state (migration 0003), so counting
 * rows against a `predictions` denominator would render "1 box, 2 accepted".
 * A box ruled the same way twice counts once; a box accepted and later
 * rejected counts in both columns, because both are true of it.
 */
const ClassLabellingStats = z
  .object({
    class_id: z.int().positive().openapi({ example: 1 }),
    name: z.string().openapi({ example: "Paimon" }),
    active: z.boolean().openapi({ example: true }),
    predictions: z.int().nonnegative().openapi({ example: 128 }),
    accepted: z.int().nonnegative().openapi({ example: 90 }),
    adjusted: z.int().nonnegative().openapi({ example: 12 }),
    rejected: z.int().nonnegative().openapi({ example: 8 }),
    anon_accepted: z.int().nonnegative().openapi({ example: 0 }),
    anon_adjusted: z.int().nonnegative().openapi({ example: 0 }),
    anon_rejected: z.int().nonnegative().openapi({ example: 0 }),
    missing_reports: z.int().nonnegative().openapi({ example: 3 }),
  })
  .openapi("ClassLabellingStats");

/**
 * The pool a labelling session draws from (M13.4).
 *
 * Business data, and only business data — §7's "do not rebuild Grafana inside
 * /admin". How long a prelabel job took and how deep the queue is are already
 * on the dashboard; how many frames are left to rule on is not, and cannot be,
 * because it is a question about rows rather than about the system.
 */
const LabellingPool = z
  .object({
    images_with_predictions: z.int().nonnegative().openapi({ example: 254 }),
    images_verified: z.int().nonnegative().openapi({ example: 40 }),
    images_remaining: z.int().nonnegative().openapi({ example: 214 }),
    missing_reports: z.int().nonnegative().openapi({ example: 5 }),
  })
  .openapi("LabellingPool");

/** Named `LabellingStats`, not after the `labellingStats` operation. */
export const LabellingStats = z
  .object({
    pool: LabellingPool,
    classes: z.array(ClassLabellingStats),
  })
  .openapi("LabellingStats");

export type LabellingStatsRow = z.infer<typeof LabellingStats>;

/**
 * Curating the public pool (M14.1).
 *
 * One field, and it is the only one this route may set: `selection_reason`
 * (migration 0004) is written at selection time by a different actor and has
 * no business changing when an admin flags a frame for the public page.
 */
export const UpdatePublicSampleRequest = z
  .object({
    public_sample: z.boolean().openapi({ example: true }),
  })
  .openapi("UpdatePublicSampleRequest");

/** An image as the public-sample toggle reads and writes it (M14.1). */
export const AdminImage = z
  .object({
    id: z.int().positive().openapi({ example: 7 }),
    public_sample: z.boolean().openapi({ example: true }),
  })
  .openapi("AdminImage");

/**
 * The frame a visitor is currently looking at, so `/api/public/frame` can
 * avoid handing back the same one (M18, plan §C).
 *
 * A query parameter carrying an image id, not a session-scoped "last shown"
 * server-side — the route already has no session state (`publicFrameHandler`'s
 * own module comment: no adjust, no batching, nothing but a random draw), and
 * inventing one just to remember one integer would be a second source of
 * truth for what the client already knows: the frame on its own screen right
 * now. Optional, because the first load of a session has nothing to exclude.
 *
 * Carries no trust, the same as `session_id` on the anonymous verdict routes:
 * a caller naming an id that is not what they were actually shown gets a
 * frame that merely might repeat, never a frame it should not have been able
 * to reach — every row `publicFrameHandler` can return is already public.
 */
export const PublicFrameQuery = z.object({
  exclude: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .refine((id) => id > 0)
    .optional()
    .openapi({ param: { name: "exclude", in: "query" }, type: "integer", example: 7 }),
});

/**
 * One box on the public verification page (M14.2).
 *
 * A trimmed `ProposedBox`: no `prompt_version`, no `model_id`. Those name
 * this deployment's internal versioning to an operator debugging a labelling
 * session; a stranger trying the interface has no use for them, and CONTEXT.md
 * §12's verify-only gate already keeps everything about *how* the box was
 * proposed off this surface.
 */
const PublicProposedBox = z
  .object({
    id: z.int().positive().openapi({ example: 42 }),
    class_id: z.int().positive().openapi({ example: 1 }),
    class_name: z.string().openapi({ example: "Paimon" }),
    x_min: z.number().openapi({ example: 0.12 }),
    y_min: z.number().openapi({ example: 0.2 }),
    x_max: z.number().openapi({ example: 0.5 }),
    y_max: z.number().openapi({ example: 0.6 }),
    confidence: z.number().openapi({ example: 0.87 }),
  })
  .openapi("PublicProposedBox");

/**
 * One frame for an anonymous visitor (M14.2).
 *
 * One frame, not a batch: CONTEXT.md §Q25's public bound is "one short-lived
 * signed URL per request, no enumeration" — the batched form of
 * `LabellingBatch` stays on the authenticated path where throughput matters.
 * `url` is always a presigned R2 URL, never `frameUrls`' proxy fallback:
 * proxying goes through the Access-gated `/api/admin/image` route, which a
 * visitor with no Access session cannot reach, so a deployment with no R2
 * credential configured answers `503` on this route rather than serving a
 * broken image (see `publicFrameHandler`).
 */
export const PublicFrame = z
  .object({
    id: z.int().positive().openapi({ example: 7 }),
    r2_key: z.string().openapi({ example: "frames/dQw4w9WgXcQ/00042.000.jpg" }),
    url: z.string().openapi({
      example:
        "https://account.r2.cloudflarestorage.com/crowdmon-frames/frames/…?X-Amz-Signature=…",
    }),
    predictions: z.array(PublicProposedBox),
    expires_at: z.int().openapi({ example: 1_754_099_900 }),
  })
  .openapi("PublicFrame");

/**
 * A verdict-kind offered on the public page (M14.2's "adjust hidden on this
 * mount"). Enforced here rather than only in the UI: `VerificationCard`'s
 * `allowAdjust={false}` keeps the button off screen, but a caller that could
 * still POST `verdict: "adjust"` would have the same drawing surface as an
 * admin with none of the trust an admin's Access assertion establishes.
 */
export const PublicVerdictKind = z.enum(["accept", "reject"]).openapi("PublicVerdictKind");

/**
 * One anonymous ruling (M14.2, M14.4).
 *
 * No adjusted-coordinate fields at all, unlike `StagedVerdict` — there is no
 * `adjust` verdict on this surface for them to belong to.
 */
const PublicStagedVerdict = z
  .object({
    prediction_id: z.int().positive().openapi({ example: 42 }),
    verdict: PublicVerdictKind,
  })
  .openapi("PublicStagedVerdict");

/**
 * How long an opaque anonymous session id may be (CONTEXT.md §Q10, §12).
 *
 * There is no Access assertion on this surface to read an identity off, so
 * the caller supplies its own — generated client-side once and reused across
 * requests (`apps/web/src/api/anon-session.ts`). It carries no trust: nothing
 * downstream authenticates it, and `submitPublicVerdictsHandler` writes it
 * verbatim as `verdicts.annotator_id`. Its only job is letting one visitor's
 * contributions be told apart from another's later — "excluding one bad actor
 * does not mean discarding every anonymous contribution" (ROADMAP M14.4) — so
 * it is bounded in length and nothing else: a `crypto.randomUUID()` is 36
 * characters, and 128 leaves headroom without accepting an essay.
 */
export const MAX_SESSION_ID_LENGTH = 128;

/** The bound on one anonymous frame's rulings — same ceiling as `CreateVerdictsRequest`. */
export const CreatePublicVerdictsRequest = z
  .object({
    session_id: z.string().min(1).max(MAX_SESSION_ID_LENGTH).openapi({
      example: "b3f1c2a4-8e5d-4c6a-9b1a-2f3e4d5c6b7a",
    }),
    verdicts: z.array(PublicStagedVerdict).min(1).max(MAX_VERDICTS_PER_IMAGE),
  })
  .openapi("CreatePublicVerdictsRequest");

/**
 * What a gate screen needs before it can stop being one (M16, CONTEXT.md §Q19
 * amendment).
 *
 * Reaching the handler behind `requireAccess` already answers the only
 * question this route exists for — the 401/403 `requireAccess` itself
 * produces are the whole failure surface, and nothing here adds another.
 * `email` rather than an empty 204: `AdminLayout`'s sidebar names who is
 * signed in, and that value is already sitting in the assertion `session`
 * verified — a second request to re-derive it would be the round trip this
 * one exists to avoid.
 */
export const AdminSession = z
  .object({
    email: z.string().openapi({ example: "admin@example.com" }),
  })
  .openapi("AdminSession");

/**
 * `limit`/`offset` rather than a cursor, for both new list routes below
 * (M16). CONTEXT.md §Q19's amendment: the tables are small, the caller is one
 * operator, and D1's 100-bound-parameter ceiling (`d1-bound-param-limit`) is
 * nowhere near either query. Shared rather than declared twice — `verdicts`
 * and `videos/{id}/images` page the same way for the same reason, and two
 * copies of this pair is two ceilings that could quietly drift apart.
 */
const PAGE_LIMIT_DEFAULT = 50;
const PAGE_LIMIT_MAX = 200;

const limitParam = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .refine((n) => n >= 1 && n <= PAGE_LIMIT_MAX)
  .optional()
  .openapi({ param: { name: "limit", in: "query" }, type: "integer", example: PAGE_LIMIT_DEFAULT });

const offsetParam = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .optional()
  .openapi({ param: { name: "offset", in: "query" }, type: "integer", example: 0 });

/** The default `limitParam` falls back to when a caller omits it — both new routes'. */
export const ADMIN_PAGE_LIMIT_DEFAULT = PAGE_LIMIT_DEFAULT;

/**
 * How many distinct values `verdict` may carry in one request (M18, plan §A).
 *
 * Not an arbitrary cap — it is `VerdictKind`'s own cardinality. A caller
 * cannot usefully narrow to more than three verdict kinds because there are
 * only three, so this bounds the generated `IN (...)` placeholder count by
 * the schema itself rather than by a guess, the same way `MAX_ACTIVE_CLASSES`
 * bounds a different list elsewhere in this file.
 */
export const MAX_VERDICT_FILTER_VALUES = 3;

/**
 * A query parameter that accepts one value or several of the same enum,
 * repeated (`?verdict=accept&verdict=adjust`) rather than comma-joined into
 * one string. Hono's own query parser is why: `c.req.queries()` already
 * collapses a single occurrence to a bare string and multiple occurrences to
 * an array (`hono/validator`), so a caller who names the filter once needs no
 * special syntax and a caller who names it twice gets an array for free —
 * this only has to describe both shapes to zod, never parse either by hand.
 */
const multiValueParam = <T extends z.ZodEnum>(schema: T, max: number) =>
  z
    .union([schema, z.array(schema).min(1).max(max)])
    .optional()
    .transform((value) =>
      value === undefined ? undefined : Array.isArray(value) ? value : [value],
    );

export const AdminVerdictListQuery = z.object({
  limit: limitParam,
  offset: offsetParam,
  // Unfiltered by default: the page shows every verdict, admin and anon
  // alike, with `source` on each row already (CONTEXT.md §Q10's two tiers
  // stay visually distinct without narrowing the query). Filtering is a
  // convenience for "just what I ruled on", not the route's only mode.
  source: z
    .enum(["admin", "anon"])
    .optional()
    .openapi({ param: { name: "source", in: "query" } }),
  // Multi-select, unlike `source`: an operator reviewing "everything that
  // isn't a plain accept" wants `adjust` and `reject` together, and forcing
  // two separate page loads to get that (as `source`'s two-tab shape would)
  // is a worse UI for a three-valued enum than one checkbox group.
  verdict: multiValueParam(VerdictKind, MAX_VERDICT_FILTER_VALUES).openapi({
    param: { name: "verdict", in: "query" },
    example: "accept",
  }),
  class_id: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .refine((n) => n > 0)
    .optional()
    .openapi({ param: { name: "class_id", in: "query" }, type: "integer", example: 3 }),
  video_id: z
    .string()
    .min(1)
    .optional()
    .openapi({ param: { name: "video_id", in: "query" }, example: "dQw4w9WgXcQ" }),
  // Not narrowed to `AdminAnnotatorList`'s rows by this schema — a caller
  // could in principle name an annotator who has since been excluded
  // entirely (ROADMAP M14.4's "excluding one bad actor" case), and the
  // filter should still run rather than 400 on an id the dropdown no longer
  // offers.
  annotator_id: z
    .string()
    .min(1)
    .optional()
    .openapi({ param: { name: "annotator_id", in: "query" }, example: "admin@example.com" }),
  // Unix seconds, matching `verdicts.created_at`'s own storage format
  // (SQLite `unixepoch()`), so the bound is a plain integer comparison with
  // no timezone parsing on either side of the wire.
  from: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .optional()
    .openapi({ param: { name: "from", in: "query" }, type: "integer", example: 1_754_000_000 }),
  to: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .optional()
    .openapi({ param: { name: "to", in: "query" }, type: "integer", example: 1_754_099_000 }),
});

/**
 * One verdict, joined out to the prediction, image and class it belongs to
 * (M16's "reading back what was labelled"). Denormalized on purpose — the
 * annotations page renders one row per verdict, and every field it shows
 * (which frame, which class, whose ruling) lives here so the page needs no
 * second request per row the way five separate lookups would force.
 *
 * `verdict` reuses `VerdictKind` rather than a narrower type: the column
 * holds all three values regardless of `source` (migration 0003 puts no
 * `CHECK` tying the two together), so a public visitor's row is exactly as
 * capable of being `'accept'` as an admin's — the two-tier split (§Q10) is
 * `source`, never the verdict kind itself.
 *
 * `x_min`..`confidence` are the *prediction's* original box (M18, plan §B) —
 * `adjusted_*` above is the verdict's, which is null on anything that is not
 * an `adjust`. A preview that only had the adjusted box could not show what
 * the detector actually proposed, which is the one comparison worth drawing.
 * Both live on this one row rather than requiring a second request per
 * verdict, for the same reason the rest of this row is denormalized.
 */
export const AdminVerdict = z
  .object({
    id: z.int().positive().openapi({ example: 1 }),
    prediction_id: z.int().positive().openapi({ example: 42 }),
    verdict: VerdictKind,
    adjusted_x_min: z.number().min(0).max(1).nullable().openapi({ example: 0.14 }),
    adjusted_y_min: z.number().min(0).max(1).nullable().openapi({ example: 0.22 }),
    adjusted_x_max: z.number().min(0).max(1).nullable().openapi({ example: 0.48 }),
    adjusted_y_max: z.number().min(0).max(1).nullable().openapi({ example: 0.61 }),
    x_min: z.number().min(0).max(1).openapi({ example: 0.12 }),
    y_min: z.number().min(0).max(1).openapi({ example: 0.2 }),
    x_max: z.number().min(0).max(1).openapi({ example: 0.5 }),
    y_max: z.number().min(0).max(1).openapi({ example: 0.6 }),
    confidence: z.number().openapi({ example: 0.87 }),
    source: z.enum(["admin", "anon"]).openapi({ example: "admin" }),
    annotator_id: z.string().openapi({ example: "admin@example.com" }),
    created_at: z.int().openapi({ example: 1_754_099_000 }),
    image_id: z.int().positive().openapi({ example: 7 }),
    video_id: z.string().openapi({ example: "dQw4w9WgXcQ" }),
    r2_key: z.string().openapi({ example: "frames/dQw4w9WgXcQ/00042.000.jpg" }),
    timestamp_seconds: z.number().openapi({ example: 42 }),
    class_id: z.int().positive().openapi({ example: 3 }),
    class_name: z.string().openapi({ example: "Paimon" }),
  })
  .openapi("AdminVerdict");

/** One row of `AdminVerdictList.verdicts` — what `VerdictPreviewDialog` (web) renders. */
export type AdminVerdictRow = z.infer<typeof AdminVerdict>;

/**
 * Named `AdminVerdictList`, not after the `listVerdicts` operation, matching
 * every other list schema in this file.
 *
 * `total` is the count over the same filter conditions as `verdicts`,
 * unbounded by `limit` — `AdminVideoImages.total`'s own reasoning: with six
 * possible filters stacked together, an empty page is ambiguous between
 * "nothing was ever labelled" and "nothing matches this combination," and a
 * UI cannot tell those apart, or show how many pages exist, without a count
 * that was not itself cut off at `limit`.
 */
export const AdminVerdictList = z
  .object({
    verdicts: z.array(AdminVerdict),
    total: z.int().nonnegative().openapi({ example: 142 }),
  })
  .openapi("AdminVerdictList");

/**
 * One annotator's footprint in `verdicts`, for the filter dropdown (M18, plan
 * §A). Grouped by `(annotator_id, source)` rather than `annotator_id` alone:
 * an admin's Access email and an anonymous session id are drawn from
 * disjoint spaces in practice, but nothing enforces that at the schema level,
 * so the pair is what actually identifies one contributor's row here — the
 * same pairing `listVerdictsHandler`'s own filters keep separate.
 */
const AdminAnnotator = z
  .object({
    annotator_id: z.string().openapi({ example: "admin@example.com" }),
    source: z.enum(["admin", "anon"]).openapi({ example: "admin" }),
    verdicts: z.int().nonnegative().openapi({ example: 87 }),
  })
  .openapi("AdminAnnotator");

/** Named `AdminAnnotatorList`, not after the `listVerdictAnnotators` operation, matching this file's other lists. */
export const AdminAnnotatorList = z
  .object({ annotators: z.array(AdminAnnotator) })
  .openapi("AdminAnnotatorList");

/**
 * The `{id}` path parameter for `GET /api/admin/videos/{id}/images` (M16).
 *
 * Named `id` rather than `video_id` — unlike `VideoIdParam` above — because
 * that is the segment name the plan and the route path both use; the two
 * params are not interchangeable despite naming the same kind of value; this
 * one belongs to a browser-facing admin route with no worker-lease check
 * behind it, where `VideoIdParam` belongs to `listVideoImagesRoute`'s
 * worker-facing one.
 */
export const AdminVideoIdParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({ param: { name: "id", in: "path" }, example: "dQw4w9WgXcQ" }),
});

export const AdminVideoImagesQuery = z.object({
  limit: limitParam,
  offset: offsetParam,
});

/**
 * How a frame reads on the browsable per-video grid (M16, ROADMAP M16
 * "prelabel re-run" scope line). Not the same shape as `VideoImage` above —
 * that one is the worker's sampling pool (`r2_key` and a timestamp, nothing
 * else, because `ImageSampler` needs nothing else); this one is an operator
 * deciding what to look at next, so it carries a prediction count and a
 * verdict state a worker has no use for.
 *
 * `verdict_state` is computed rather than stored, from the same admin-tier
 * "unruled" definition `labellingStatsHandler` already uses (CONTEXT.md
 * §Q10): a frame with no predictions at all is not merely "unverified" —
 * there is nothing on it for an operator to rule on — so it gets its own
 * state rather than being lumped in with a frame still waiting on a ruling.
 */
const AdminVideoImage = z
  .object({
    id: z.int().positive().openapi({ example: 7 }),
    r2_key: z.string().openapi({ example: "frames/dQw4w9WgXcQ/00042.000.jpg" }),
    // Presigned where the deployment has an S3 credential, the Access-gated
    // proxy where it does not — `frameUrls`' two modes, exactly as
    // `LabellingBatch` carries them. M16 shipped this grid rendering a proxy
    // path built in the client instead, which meant one Worker invocation and
    // one Worker-egress copy of a full-resolution frame per tile, twenty-four
    // tiles to a page. §Q25 settled that question in the other direction for
    // any batch this size; the grid just never asked it.
    url: z.string().openapi({ example: "https://…r2.cloudflarestorage.com/…?X-Amz-Signature=…" }),
    timestamp_seconds: z.number().openapi({ example: 42 }),
    public_sample: z.boolean().openapi({ example: false }),
    predictions: z.int().nonnegative().openapi({ example: 3 }),
    verdict_state: z
      .enum(["no_predictions", "unverified", "verified"])
      .openapi({ example: "unverified" }),
  })
  .openapi("AdminVideoImage");

/**
 * Named `AdminVideoImages`, not after the `listAdminVideoImages` operation,
 * matching `VideoImages` above. `total` is the video's whole frame count —
 * unbounded by `limit` — so the grid can render "1–50 of 2,685" without a
 * second request; `images` is the one page `limit`/`offset` selected.
 */
export const AdminVideoImages = z
  .object({
    video_id: z.string().openapi({ example: "dQw4w9WgXcQ" }),
    total: z.int().nonnegative().openapi({ example: 2685 }),
    images: z.array(AdminVideoImage),
    // Both on the wire for `LabellingBatch`'s reasons, which apply here
    // unchanged: the two modes fail differently, and a UI that cannot tell a
    // 15-minute expiry from a lost Access session will offer the wrong
    // recovery for one of them. `expires_at` is populated in both modes so
    // there is one refresh rule rather than one per mode.
    url_mode: z.enum(["signed", "proxy"]).openapi({ example: "signed" }),
    expires_at: z.int().openapi({ example: 1_754_099_900 }),
  })
  .openapi("AdminVideoImages");

/**
 * `jobs` for one video, folded into a summary rather than handed back as rows
 * (M19, plan §A1) — the rows are `/admin/queue`'s (plan §C), and a second full
 * job list on this header would be a second place to keep "how far along is
 * this video" consistent with the one that page renders. What the summary
 * answers is exactly the question the header's progress line asks: is
 * extraction finished, which is `chunks_done` against `chunks_total`.
 *
 * `download` and `prelabel` are each at most one job — `idx_jobs_one_download_
 * per_video` (migration 0001) and `idx_jobs_one_prelabel_per_video`
 * (migration 0005) are unique indexes, so there is never a second row of
 * either kind to reconcile. `chunks_total`/`chunks_done`/`chunks_failed` are
 * not: fan-out (CONTEXT.md §Q13) creates one `chunk` job per 60-second
 * segment.
 */
const AdminVideoJobsSummary = z
  .object({
    download: JobStatus.nullable().openapi({ example: "done" }),
    chunks_total: z.int().nonnegative().openapi({ example: 20 }),
    chunks_done: z.int().nonnegative().openapi({ example: 20 }),
    chunks_failed: z.int().nonnegative().openapi({ example: 0 }),
    prelabel: JobStatus.nullable().openapi({ example: "done" }),
  })
  .openapi("AdminVideoJobsSummary");

/**
 * `GET /api/admin/videos/{id}` (M19, plan §A): the `videos` row's own
 * YouTube-derived metadata, plus the per-video aggregates, for the header
 * `/admin/videos/:id` grows above the frame grid `AdminVideoImages` already
 * carries.
 *
 * Not an extension of `AdminVideo`: that shape is computed once per row for
 * up to `VIDEO_PICKER_LIMIT` videos on every list-page mount, and every field
 * here beyond what `AdminVideo` already carries — `predictions` joined to
 * `images`, `verdicts`, a `jobs` scan — is per-video-only work no list of
 * fifty videos should pay for just to render a picker.
 *
 * `title`, `duration_seconds`, `width` and `height` are `.nullable()`, not
 * `.optional()`: the download job's fan-out report (`FanOutRequest`,
 * migration 0001) is what writes them, so a video still mid-download has none
 * of them yet, and that is a different fact from a duration of zero — the
 * page renders null as `—`, never `0`.
 *
 * `frames_verified` is not its own aggregate — it is `frames_with_predictions
 * - frames_unverified`, computed in the handler; see that handler's own
 * comment on the query it is computed from.
 */
export const AdminVideoDetail = z
  .object({
    id: z.string().openapi({ example: "dQw4w9WgXcQ" }),
    url: z.url().openapi({ example: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    title: z.string().nullable().openapi({ example: "Genshin Impact — Archon quest" }),
    duration_seconds: z.int().positive().nullable().openapi({ example: 1200 }),
    width: z.int().positive().nullable().openapi({ example: 1920 }),
    height: z.int().positive().nullable().openapi({ example: 1080 }),
    created_at: z.int().openapi({ example: 1_754_099_000 }),
    image_count: z.int().nonnegative().openapi({ example: 2685 }),
    frames_sampled: z.int().nonnegative().openapi({ example: 200 }),
    public_samples: z.int().nonnegative().openapi({ example: 3 }),
    predictions: z.int().nonnegative().openapi({ example: 340 }),
    frames_with_predictions: z.int().nonnegative().openapi({ example: 190 }),
    frames_verified: z.int().nonnegative().openapi({ example: 150 }),
    frames_unverified: z.int().nonnegative().openapi({ example: 40 }),
    // Null until at least one prediction exists for the video, the same
    // distinction `AdminVideo.model_id` draws (that field's own comment).
    model_id: z.string().nullable().openapi({ example: "owlvit-base-patch32.onnx" }),
    prelabelled_at: z.int().nullable().openapi({ example: 1_754_099_500 }),
    jobs: AdminVideoJobsSummary,
  })
  .openapi("AdminVideoDetail");

export type AdminVideoDetailRow = z.infer<typeof AdminVideoDetail>;
