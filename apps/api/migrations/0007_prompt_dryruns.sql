-- Prompt dry-runs (M12.2, issue #110): running a candidate prompt against a
-- sample of frames and looking at the boxes, before that prompt is allowed to
-- pre-label anything.
--
-- Why this is a job kind and not a synchronous endpoint
-- ------------------------------------------------------
-- The detector lives on the home box behind a pull topology (CONTEXT.md §Q4):
-- there is no inbound port, so nothing on Cloudflare's side can call it and
-- wait. A dry-run is therefore work that has to be queued, claimed, leased,
-- heartbeated and reaped exactly like every other kind — which is the same
-- argument CONTEXT.md §12 makes for pre-labelling being "a fourth job kind,
-- not a subsystem", and it buys the same things for free here: the attempt
-- ceiling, the reaper, `queue_depth`, the trace.
--
-- `dryrun` is the fourth kind, so `jobs.kind`'s CHECK has to be widened, and
-- SQLite has no way to alter a CHECK in place. Migration 0005 explains the
-- table-rebuild recipe and — more importantly — why the *ordering* is
-- load-bearing rather than tidy: D1 does not honour `PRAGMA foreign_keys=OFF`,
-- and `DROP TABLE` still fires `ON DELETE CASCADE`, so `chunks` (the only
-- table with a cascading foreign key into `jobs`) must be rebuilt and dropped
-- before the old `jobs` is dropped, or production's chunk rows go with it.
-- That reasoning is unchanged here and is not repeated; read 0005's header.
--
-- No unique index for `dryrun`
-- ------------------------------
-- `download` and `prelabel` each get one job per video, enforced by a partial
-- unique index. A dry-run is the opposite: trying a second wording against the
-- same video, minutes after the first, is the entire activity. Nothing here
-- constrains how many a video may have.
CREATE TABLE jobs_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL CHECK (kind IN ('download', 'chunk', 'prelabel', 'dryrun')),
  video_id       TEXT NOT NULL REFERENCES videos(id),

  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'claimed', 'done', 'failed')),

  attempts       INTEGER NOT NULL DEFAULT 0,

  claimed_by     TEXT,
  claimed_at     INTEGER,
  heartbeat_at   INTEGER,

  failure_reason TEXT,

  config_version TEXT,

  created_at     INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at     INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),

  traceparent    TEXT
);

INSERT INTO jobs_new
  (id, kind, video_id, status, attempts, claimed_by, claimed_at, heartbeat_at,
   failure_reason, config_version, created_at, updated_at, traceparent)
  SELECT id, kind, video_id, status, attempts, claimed_by, claimed_at, heartbeat_at,
         failure_reason, config_version, created_at, updated_at, traceparent
    FROM jobs;

CREATE TABLE chunks_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id           INTEGER NOT NULL UNIQUE REFERENCES jobs_new(id) ON DELETE CASCADE,
  video_id         TEXT NOT NULL REFERENCES videos(id),

  segment_index    INTEGER NOT NULL,
  start_seconds    INTEGER NOT NULL,
  end_seconds      INTEGER NOT NULL,

  frames_extracted INTEGER,
  frames_kept      INTEGER,

  created_at       INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

INSERT INTO chunks_new
  (id, job_id, video_id, segment_index, start_seconds, end_seconds, frames_extracted,
   frames_kept, created_at)
  SELECT id, job_id, video_id, segment_index, start_seconds, end_seconds, frames_extracted,
         frames_kept, created_at
    FROM chunks;

-- Child before parent — migration 0005's header for why this order is the
-- whole safety argument and not a preference.
DROP TABLE chunks;
DROP TABLE jobs;

ALTER TABLE jobs_new RENAME TO jobs;
ALTER TABLE chunks_new RENAME TO chunks;

CREATE INDEX idx_jobs_claimable ON jobs (status, kind, id);
CREATE INDEX idx_jobs_stale ON jobs (heartbeat_at) WHERE status = 'claimed';
CREATE UNIQUE INDEX idx_jobs_one_download_per_video
  ON jobs (video_id) WHERE kind = 'download';
CREATE UNIQUE INDEX idx_jobs_one_prelabel_per_video
  ON jobs (video_id) WHERE kind = 'prelabel';
CREATE UNIQUE INDEX idx_chunks_identity ON chunks (video_id, segment_index);

-- The work definition and the result of one dry-run, split from `jobs` for the
-- reason `chunks` is: the queue table must not carry columns that are null for
-- every other kind of job.
CREATE TABLE dryruns (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,

  -- 1:1 with its job, cascading, exactly as `chunks.job_id` is.
  job_id            INTEGER NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,

  -- Which class this wording is a candidate *for*. Not cascaded and not
  -- nullable: a dry-run is always run against a class that exists (created
  -- deactivated by M12.1, or an active one somebody is rewording), and a class
  -- is soft-deleted rather than dropped, so there is no case where this
  -- reference stops resolving.
  class_id          INTEGER NOT NULL REFERENCES classes(id),

  -- The candidate wording — deliberately a copy, not a join to
  -- `classes.appearance_prompt`. The whole point of a dry-run is to look at
  -- text that is *not* what the class currently says; joining live would show
  -- the result of a run against wording it never ran against the moment
  -- anybody saved an edit.
  appearance_prompt TEXT NOT NULL,

  -- How many frames the sampler was asked for, stamped in the same idiom as
  -- `images.dedup_threshold` and `jobs.config_version`: a budget raised later
  -- must not make an old dry-run's box count look like a different result than
  -- it was.
  sample_size       INTEGER NOT NULL,

  -- Everything below is written once, by the worker's report, and is NULL
  -- until then — which is also how "has this finished" is answered without a
  -- second status column duplicating `jobs.status`.
  model_id          TEXT,

  -- The boxes, as JSON, and this is the one place in the schema where that is
  -- the right shape. A dry-run's result is written once, read whole by one
  -- screen, never joined, never aggregated, and never referenced by another
  -- row — every property that makes `predictions` a table is absent here. It
  -- is also, emphatically, not label data: nothing downstream may treat these
  -- boxes as annotations, and keeping them out of `predictions` is what makes
  -- "a dry-run writes nothing" (ROADMAP.md M12.2) literally true of the
  -- dataset rather than a claim about intent.
  boxes             TEXT,

  -- The R2 keys the sampler drew, also JSON, for the reason
  -- `ReportPredictionsRequest.sampled_images` exists: a detector finding
  -- nothing is a real outcome, and `boxes` alone can never say which frames
  -- were even looked at. Without this a prompt that matched nothing would be
  -- indistinguishable on screen from a job that sampled nothing.
  sampled_keys      TEXT,

  -- Who asked, from the Access assertion. `verdicts.annotator_id`'s idiom, and
  -- useful for the same reason: a dry-run is cheap but not free (minutes of
  -- the box's two cores), so the row that started one says who to ask about it.
  requested_by      TEXT NOT NULL,

  created_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  reported_at       INTEGER
);

-- The admin screen's only query: this class's dry-runs, newest first.
CREATE INDEX idx_dryruns_class ON dryruns (class_id, id DESC);
