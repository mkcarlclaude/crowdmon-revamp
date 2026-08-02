-- Initial schema: videos, the job queue, chunks and extracted images.
--
-- Timestamps are unix epoch seconds via strftime rather than ISO strings. The
-- reaper compares heartbeat_at against now on every cron tick, and integer
-- comparison needs no parsing and indexes cleanly.

CREATE TABLE videos (
  -- The YouTube id, not a surrogate key. It is stable, externally meaningful,
  -- and makes re-submitting the same URL a primary key conflict rather than a
  -- duplicate row nobody notices.
  id               TEXT PRIMARY KEY,
  url              TEXT NOT NULL,
  title            TEXT,
  duration_seconds INTEGER,
  width            INTEGER,
  height           INTEGER,
  created_at       INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at       INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- One queue for both job kinds.
--
-- CONTEXT.md §Q14 commits to a single heartbeat-lease mechanism rather than a
-- visibility timeout for one kind and a heartbeat for the other. Two tables
-- would mean the claim endpoint querying both, the reaper scanning both, and
-- the Go worker carrying two claim paths — which is that split arriving by the
-- back door. Chunk-specific columns live in `chunks`, not here.
CREATE TABLE jobs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL CHECK (kind IN ('download', 'chunk')),
  video_id       TEXT NOT NULL REFERENCES videos(id),

  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'claimed', 'done', 'failed')),

  -- Incremented on claim, not on failure: a worker that dies without ever
  -- reporting back still has to count against the ceiling, or a job that
  -- crashes the worker before it can report is retried forever.
  attempts       INTEGER NOT NULL DEFAULT 0,

  claimed_by     TEXT,
  claimed_at     INTEGER,
  heartbeat_at   INTEGER,

  -- Why a job reached the terminal 'failed' state. Deleted video, geo-blocked,
  -- malformed — the cases M6.1 exists to stop retrying.
  failure_reason TEXT,

  -- Which extraction settings produced this job's output. Without it, changing
  -- a threshold later leaves the dataset an unrecorded mixture of regimes
  -- (M8.4).
  config_version TEXT,

  created_at     INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at     INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Supports the claim query's WHERE status = 'pending' ... ORDER BY id.
CREATE INDEX idx_jobs_claimable ON jobs (status, kind, id);

-- Supports the reaper. Partial, because it only ever scans held jobs and the
-- overwhelming majority of rows will be 'done'.
CREATE INDEX idx_jobs_stale ON jobs (heartbeat_at) WHERE status = 'claimed';

-- A video is downloaded once. Re-submitting the same URL must not enqueue a
-- second download job, and enforcing that here means the API cannot get it
-- wrong under concurrency.
CREATE UNIQUE INDEX idx_jobs_one_download_per_video
  ON jobs (video_id) WHERE kind = 'download';

-- The work definition and results for a chunk job. Split from `jobs` so the
-- queue table does not carry columns that are null for every download job.
CREATE TABLE chunks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id           INTEGER NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  video_id         TEXT NOT NULL REFERENCES videos(id),

  segment_index    INTEGER NOT NULL,
  start_seconds    INTEGER NOT NULL,
  end_seconds      INTEGER NOT NULL,

  frames_extracted INTEGER,
  frames_kept      INTEGER,

  created_at       INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Deterministic chunk identity (M7.3). Fan-out is not transactional — it can
-- be reaped and re-run halfway through — so re-enqueueing must collide rather
-- than duplicate.
CREATE UNIQUE INDEX idx_chunks_identity ON chunks (video_id, segment_index);

CREATE TABLE images (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Deterministic from (video_id, timestamp): a re-run of the same chunk
  -- overwrites the same object rather than inflating the dataset (M8.3).
  r2_key            TEXT NOT NULL UNIQUE,
  video_id          TEXT NOT NULL REFERENCES videos(id),
  timestamp_seconds REAL NOT NULL,
  phash             TEXT NOT NULL,

  -- The dedup threshold in force when this row was produced (M8.4). Changing
  -- the threshold later does not re-deduplicate old videos, so without this
  -- stamped per row the dataset silently becomes a mixture of regimes and no
  -- reported dedup ratio means anything.
  dedup_threshold   INTEGER NOT NULL,

  created_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE UNIQUE INDEX idx_images_identity ON images (video_id, timestamp_seconds);
CREATE INDEX idx_images_phash ON images (phash);
