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

/** Mirrors the `kind` CHECK constraint in migration 0001. */
export const JobKind = z.enum(["download", "chunk"]).openapi("JobKind");

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
