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
 * Mirrors the `kind` CHECK constraint, widened by migration 0005 (M11.1) and
 * again by 0007 (M12.2's `dryrun`).
 */
export const JobKind = z.enum(["download", "chunk", "prelabel", "dryrun"]).openapi("JobKind");

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
    video_id: z.string().openapi({ example: "dQw4w9WgXcQ" }),
    video_url: z.url().openapi({ example: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
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
    video_id: z.string().openapi({ example: "dQw4w9WgXcQ" }),
    video_url: z.url().openapi({ example: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
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
 * Fixed shape — sixteen named fields, four statuses times four kinds (M11.1
 * added `prelabel`, M12.2 `dryrun`, alongside `download` and `chunk`) — rather than the array
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
 * How many frames one dry-run runs the candidate wording over (M12.2's
 * "~50 frames").
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
 * One class, `DRYRUN_SAMPLE_SIZE` frames, so 20 boxes on a single frame is
 * already far past anything a usable prompt produces — this is sized to reject
 * a detector that has started emitting garbage rather than to accommodate a
 * plausible run, the same posture `MAX_PREDICTIONS_PER_JOB` takes.
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
 * What starting a dry-run takes (M12.2).
 *
 * `video_id` is the caller's, not the server's pick. Which footage a prompt is
 * tried against is the judgement being made — a character who appears in one
 * video and not another is the difference between a prompt that looks broken
 * and one that looks fine — so choosing it silently would hide the variable
 * that matters most in reading the result.
 *
 * No `sample_size`: see `DRYRUN_SAMPLE_SIZE`.
 */
export const CreateDryRunRequest = z
  .object({
    video_id: z.string().min(1).openapi({ example: "dQw4w9WgXcQ" }),
    appearance_prompt: z
      .string()
      .min(1)
      .max(MAX_APPEARANCE_PROMPT)
      .openapi({ example: "a tiny white-haired floating companion with a dark crown" }),
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
 */
export const DryRun = z
  .object({
    id: z.int().positive().openapi({ example: 1 }),
    job_id: z.int().positive().openapi({ example: 42 }),
    class_id: z.int().positive().openapi({ example: 1 }),
    class_name: z.string().openapi({ example: "Paimon" }),
    video_id: z.string().openapi({ example: "dQw4w9WgXcQ" }),
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
 * One video as the dry-run form needs to see it: what to call it, and whether
 * it has any frames to sample.
 *
 * `image_count` rather than a boolean: a video whose extraction is still
 * running has some frames and will have more, and an admin choosing between
 * "12 frames so far" and "2,685" is making a real choice about how meaningful
 * a 50-frame sample off it will be.
 */
const AdminVideo = z
  .object({
    id: z.string().openapi({ example: "dQw4w9WgXcQ" }),
    title: z.string().nullable().openapi({ example: "Genshin Impact — Archon quest" }),
    image_count: z.int().nonnegative().openapi({ example: 2685 }),
    created_at: z.int().openapi({ example: 1_754_099_000 }),
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
