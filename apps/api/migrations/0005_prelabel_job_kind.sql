-- Widens `jobs.kind` to accept 'prelabel', the third job kind (M11.1, issue
-- #101): one job per video, enqueued once its chunks are all done, that runs
-- the detector across the video's sampled frames.
--
-- Why this migration is not a one-line ALTER
-- --------------------------------------------
-- SQLite has no `ALTER TABLE ... ALTER COLUMN` and no `DROP CONSTRAINT`: a
-- CHECK constraint is baked into the column definition at CREATE TABLE time,
-- and the only way to change one is the table-rebuild dance SQLite's own docs
-- describe — create the table you actually want, copy the rows across, drop
-- the old one, rename the new one into its place, and recreate every index
-- that pointed at it. `jobs.kind CHECK (kind IN ('download', 'chunk'))`
-- (migration 0001) is exactly such a constraint, so widening it to admit
-- 'prelabel' means rebuilding the whole table.
--
-- Why `chunks` has to be rebuilt too, and rebuilt *first*
-- --------------------------------------------------------
-- `chunks.job_id REFERENCES jobs(id) ON DELETE CASCADE` (migration 0001) is
-- the only foreign key that points at `jobs`. The textbook version of this
-- recipe says to run `PRAGMA foreign_keys=OFF` before dropping the old table,
-- so the drop does not cascade into every row that referenced it — but D1
-- does not honour that pragma. (Verified directly against the same D1 engine
-- these migrations run on: querying `PRAGMA foreign_keys` immediately after
-- setting it to `OFF` still reports `1`. D1 keeps foreign-key enforcement on,
-- unconditionally, for every session — there is no opt-out.) `DROP TABLE`
-- still triggers `ON DELETE CASCADE` in SQLite (also verified directly: it is
-- not exempt the way some other engines' drop paths are), so dropping the old
-- `jobs` table while `chunks` still held real rows referencing it would have
-- silently deleted every one of them — production's `chunks` table has real
-- data behind it, unlike this migration's own test fixtures, which start
-- empty and would never have caught that.
--
-- The fix is ordering, not a pragma: rebuild `chunks` into `chunks_new`
-- first, referencing `jobs_new` (already populated with every row `jobs`
-- has, under the same ids — copied explicitly rather than left to
-- AUTOINCREMENT, so `chunks`' `job_id` values still resolve). Drop the old
-- `chunks` next — nothing references `chunks`, so that drop cascades into
-- nothing. Only then is it safe to drop the old `jobs`: the one table whose
-- foreign key could have cascaded into real rows no longer exists. Renaming
-- `jobs_new` to `jobs` was also confirmed to rewrite `chunks_new`'s foreign
-- key definition from `REFERENCES jobs_new(id)` to `REFERENCES jobs(id)`
-- automatically — SQLite updates a `REFERENCES` clause elsewhere in the
-- schema when the table it names is renamed, so `chunks_new` does not need a
-- second rebuild after the rename to point at the right name.
CREATE TABLE jobs_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL CHECK (kind IN ('download', 'chunk', 'prelabel')),
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

  -- Migration 0002. Appended here, at the end, matching the physical column
  -- order `ALTER TABLE ... ADD COLUMN` actually produced on the table being
  -- replaced — cosmetic for a rebuild that names every column explicitly
  -- below, but there is no reason for the two tables' declared order to
  -- disagree while both exist side by side.
  traceparent    TEXT
);

INSERT INTO jobs_new
  (id, kind, video_id, status, attempts, claimed_by, claimed_at, heartbeat_at,
   failure_reason, config_version, created_at, updated_at, traceparent)
  SELECT id, kind, video_id, status, attempts, claimed_by, claimed_at, heartbeat_at,
         failure_reason, config_version, created_at, updated_at, traceparent
    FROM jobs;

-- Unchanged from migration 0001 except which `jobs` it points at during the
-- transition (see the file header: `jobs_new` for now, `jobs` again the
-- instant it is renamed).
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

-- Child before parent — see the file header for why the order is load-bearing
-- and not just tidy: only once `chunks` (the sole table with a cascading
-- foreign key into `jobs`) is gone can the old `jobs` be dropped without that
-- drop cascading into it.
DROP TABLE chunks;
DROP TABLE jobs;

ALTER TABLE jobs_new RENAME TO jobs;
ALTER TABLE chunks_new RENAME TO chunks;

-- Every index migration 0001 declared on `jobs`, recreated verbatim — DROP
-- TABLE took them with it, and nothing about the claim query, the reaper's
-- scan or one-download-per-video changed.
CREATE INDEX idx_jobs_claimable ON jobs (status, kind, id);
CREATE INDEX idx_jobs_stale ON jobs (heartbeat_at) WHERE status = 'claimed';
CREATE UNIQUE INDEX idx_jobs_one_download_per_video
  ON jobs (video_id) WHERE kind = 'download';

-- The new one this migration exists to add. Exactly one prelabel job per
-- video, enforced the same way one download job per video already is
-- (migration 0001's own comment on `idx_jobs_one_download_per_video`): fan-out
-- is not transactional and a chunk can be reaped and re-run, so more than one
-- chunk-completion request can conclude "every chunk for this video is now
-- done" before any of them has written a row — the API deciding that with a
-- read-then-write in `completeJobHandler` could not be made race-proof on its
-- own no matter how careful the SQL, because "check, then insert" is
-- inherently two steps for two concurrent callers to interleave. A partial
-- unique index turns the loser of that race into a constraint failure D1
-- reports, rather than a silent second prelabel job.
CREATE UNIQUE INDEX idx_jobs_one_prelabel_per_video
  ON jobs (video_id) WHERE kind = 'prelabel';

-- `chunks`' own index, recreated for the same reason as `jobs`'.
CREATE UNIQUE INDEX idx_chunks_identity ON chunks (video_id, segment_index);
