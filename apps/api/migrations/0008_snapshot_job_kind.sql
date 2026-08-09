-- Widens `jobs.kind` to accept 'snapshot', the fifth job kind (M15.1, issue
-- #116): an admin-triggered job that builds a dataset snapshot rather than
-- running inside a request, so building one does not depend on a browser tab
-- staying open.
--
-- Why `video_id` has to become nullable
-- --------------------------------------
-- Every job kind so far is about one video: a download job, a chunk of one
-- video, one video's pre-labelling, one candidate wording tried against one
-- video. `jobs.video_id TEXT NOT NULL REFERENCES videos(id)` (migration 0001)
-- says exactly that. A snapshot job is the first job kind that is not about
-- any one video — it packages whatever the whole dataset currently qualifies
-- under the inclusion policy, across every video at once — so there is no
-- `videos.id` a snapshot job's row could truthfully name. Leaving the column
-- `NOT NULL` and inventing a sentinel `videos` row for it to point at would
-- misrepresent a fact this schema otherwise records honestly everywhere else;
-- making the column nullable, and constraining exactly when it may be null,
-- says the true thing instead.
--
-- The CHECK at the bottom of `jobs_new` below ties the two together in both
-- directions: `kind = 'snapshot'` if and only if `video_id IS NULL`. Without
-- it, `video_id` merely being nullable would let a `download` row silently
-- carry a NULL video_id too — a state nothing in this application ever means
-- to produce, and one the four existing job kinds' entire read path (the
-- claim handler's video lookup, `admin-jobs.ts`'s join, every span that tags
-- `crowdmon.video.id`) was written assuming can never happen for them.
--
-- Why this is a table-rebuild, not a two-line ALTER
-- ----------------------------------------------------
-- SQLite has no `ALTER TABLE ... ALTER COLUMN` and no way to add or change a
-- CHECK constraint in place — migrations 0005 and 0007 already establish the
-- rebuild recipe this one repeats: build the table you actually want, copy
-- the rows across, drop the old one, rename the new one into its place, and
-- recreate every index that pointed at it.
--
-- `chunks` and `dryruns` both carry `job_id ... REFERENCES jobs(id) ON DELETE
-- CASCADE`, and D1 does not honour `PRAGMA foreign_keys=OFF` (verified
-- directly against this engine — migration 0005's header has the detail), so
-- `DROP TABLE jobs` while either child still pointed at the old table would
-- cascade-delete every row in it. Migration 0007's own header flagged this in
-- advance: "the next `jobs` rebuild has *two* children to move ahead of the
-- drop, not one." This is that migration. Both children are rebuilt first,
-- against `jobs_new`, then dropped; only once neither old child exists is the
-- old `jobs` itself safe to drop.
CREATE TABLE jobs_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL
                 CHECK (kind IN ('download', 'chunk', 'prelabel', 'dryrun', 'snapshot')),

  -- Nullable now, and only for 'snapshot' — see the file header. Every other
  -- kind keeps exactly the guarantee migration 0001 gave it: a row that names
  -- no video is a schema bug, not a state a reader has to plan for.
  video_id       TEXT REFERENCES videos(id),

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

  traceparent    TEXT,

  CHECK ((kind = 'snapshot') = (video_id IS NULL))
);

INSERT INTO jobs_new
  (id, kind, video_id, status, attempts, claimed_by, claimed_at, heartbeat_at,
   failure_reason, config_version, created_at, updated_at, traceparent)
  SELECT id, kind, video_id, status, attempts, claimed_by, claimed_at, heartbeat_at,
         failure_reason, config_version, created_at, updated_at, traceparent
    FROM jobs;

-- Unchanged from migration 0001 except which `jobs` it points at during the
-- transition.
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

-- Unchanged from migration 0007 except which `jobs` it points at.
CREATE TABLE dryruns_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id            INTEGER NOT NULL UNIQUE REFERENCES jobs_new(id) ON DELETE CASCADE,
  class_id          INTEGER NOT NULL REFERENCES classes(id),
  appearance_prompt TEXT NOT NULL,
  sample_size       INTEGER NOT NULL,
  model_id          TEXT,
  boxes             TEXT,
  sampled_keys      TEXT,
  requested_by      TEXT NOT NULL,
  created_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  reported_at       INTEGER
);

INSERT INTO dryruns_new
  (id, job_id, class_id, appearance_prompt, sample_size, model_id, boxes, sampled_keys,
   requested_by, created_at, reported_at)
  SELECT id, job_id, class_id, appearance_prompt, sample_size, model_id, boxes, sampled_keys,
         requested_by, created_at, reported_at
    FROM dryruns;

-- Children before parent — see the file header for why the order is
-- load-bearing: only once both `chunks` and `dryruns` (the only tables with a
-- cascading foreign key into `jobs`) are gone can the old `jobs` be dropped
-- without that drop cascading into either of them.
DROP TABLE chunks;
DROP TABLE dryruns;
DROP TABLE jobs;

ALTER TABLE jobs_new RENAME TO jobs;
ALTER TABLE chunks_new RENAME TO chunks;
ALTER TABLE dryruns_new RENAME TO dryruns;

-- Every index migrations 0001, 0005 and 0007 declared on these three tables,
-- recreated verbatim — DROP TABLE took them with it, and nothing about the
-- claim query, the reaper's scan, one-download-per-video, one-prelabel-per-
-- video, chunk identity or a class's dry-run history changed.
CREATE INDEX idx_jobs_claimable ON jobs (status, kind, id);
CREATE INDEX idx_jobs_stale ON jobs (heartbeat_at) WHERE status = 'claimed';
CREATE UNIQUE INDEX idx_jobs_one_download_per_video
  ON jobs (video_id) WHERE kind = 'download';
CREATE UNIQUE INDEX idx_jobs_one_prelabel_per_video
  ON jobs (video_id) WHERE kind = 'prelabel';
CREATE UNIQUE INDEX idx_chunks_identity ON chunks (video_id, segment_index);
CREATE INDEX idx_dryruns_class ON dryruns (class_id, id DESC);
