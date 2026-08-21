-- Contributor accounts (M20, plan §B1): Google-authenticated users, their
-- sessions, and a third `verdicts.source` value, 'user' — CONTEXT.md §7's v4
-- amendment to the two-tier rule migration 0003 and its Q10 amendment
-- established. This is a *third tier*, not a merge into 'admin' and not a
-- replacement of 'anon': the ordering that later reads this column (plan §C)
-- stays a total, static one precisely because 'user' is its own value in the
-- per-source split, the same way 'anon' already is.
--
-- Four statements, matching the plan: `users`, `sessions`, `sessions`' index,
-- and a rebuild of `verdicts` to widen its CHECK.

-- The OIDC subject (`sub`) is the identity, not `email`. A Google account's
-- email can change and — inside a Google Workspace domain — be reassigned to
-- a different person entirely; `sub` cannot. Matching on email is the
-- standard way to hand one person's contributions to another, which is
-- exactly the failure `google_sub UNIQUE` and the upsert in
-- `googleCallbackHandler` (routes/auth.ts) key off instead.
--
-- `trusted` defaults to 0. Anyone can sign up, verify immediately, and watch
-- their own count rise on `/api/contribute/me` (plan §B5) — their verdicts
-- are recorded and counted from the first one, but do not enter a snapshot's
-- labels (plan §C1) until an admin flips this one boolean. That is the whole
-- bad-actor answer: one column an admin sets on a *person*, not the four
-- subsystems (consensus resolution, agreement scoring, trust weighting,
-- inter-rater reliability) CONTEXT.md §7 refuses building for a table with a
-- median contributor who is now a stranger.
CREATE TABLE users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub   TEXT NOT NULL UNIQUE,
  email        TEXT NOT NULL,
  display_name TEXT,
  trusted      INTEGER NOT NULL DEFAULT 0 CHECK (trusted IN (0, 1)),
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Opaque, random session ids rather than a self-verifying JWT — plan §B2's
-- own reasoning: logout has to actually revoke a session, and a token that
-- verifies itself cannot be revoked without the row lookup a session table
-- already is. `expires_at` is enforced by `requireUser` on every request, not
-- by this table refusing to hold an expired row; the row is left in place
-- until the reaper cron sweeps it (see the index comment below and
-- `session-reaper.ts`), the same "lease is a claim, cleanup is separate"
-- shape `jobs.heartbeat_at` already uses for crash recovery.
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- What makes sweeping expired sessions a cheap scan rather than a full-table
-- one — `session-reaper.ts`'s own comment on why this piggybacks on the
-- existing reaper cron instead of a schedule of its own.
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

-- Widening `verdicts.source` to admit 'user' is a table rebuild — SQLite has
-- no `ALTER TABLE ... ALTER COLUMN` and no way to change a CHECK constraint
-- in place. Migrations 0005 and 0008 already established the recipe this one
-- follows: build the table you actually want, copy every row across, drop
-- the old one, rename the new one into its place, recreate every index that
-- pointed at it.
--
-- Unlike those two, this rebuild has no second table to move out of the way
-- first. `jobs` had `chunks` and `dryruns` cascading into it, and D1 ignores
-- `PRAGMA foreign_keys=OFF` (verified directly against this engine —
-- migration 0005's own header has the detail), so dropping `jobs` before its
-- children were rebuilt would have cascade-deleted every row they held.
-- `verdicts` has no children: migration 0003's own header states it plainly
-- — "nothing in this schema issues an UPDATE or DELETE against this table,"
-- and no later migration before this one added a foreign key pointing *at*
-- `verdicts.id`. So `DROP TABLE verdicts` below cascades into nothing, and
-- the safety here comes from that fact, not from the pragma — exactly the
-- distinction CLAUDE.md's own note on this hazard asks a migration like this
-- one to get right rather than merely repeat.
--
-- Every column, both CHECK constraints and both indexes are carried over
-- verbatim from migration 0003 except the one CHECK this migration exists to
-- widen. The migration test (`contributor-accounts.test.ts`) asserts the row
-- count and every distinct `source` value survive intact, not merely that
-- 'user' is now accepted.
CREATE TABLE verdicts_new (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  prediction_id      INTEGER NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
  verdict            TEXT NOT NULL CHECK (verdict IN ('accept', 'adjust', 'reject')),
  adjusted_x_min     REAL CHECK (adjusted_x_min IS NULL OR (adjusted_x_min >= 0 AND adjusted_x_min <= 1)),
  adjusted_y_min     REAL CHECK (adjusted_y_min IS NULL OR (adjusted_y_min >= 0 AND adjusted_y_min <= 1)),
  adjusted_x_max     REAL CHECK (adjusted_x_max IS NULL OR (adjusted_x_max >= adjusted_x_min AND adjusted_x_max <= 1)),
  adjusted_y_max     REAL CHECK (adjusted_y_max IS NULL OR (adjusted_y_max >= adjusted_y_min AND adjusted_y_max <= 1)),

  -- The only line that changed from migration 0003: a third admitted value.
  source             TEXT NOT NULL CHECK (source IN ('admin', 'anon', 'user')),

  -- The admin's Access email, an anonymous visitor's opaque session id, or
  -- (new) a contributor's `users.id` as text — never their email. Storing the
  -- numeric id rather than the email here is deliberate and is not the same
  -- choice `google_sub` above makes for a different reason: this column is
  -- read back by `contribute.ts`'s pool query to decide whether a *trusted*
  -- user has already ruled on a box, joined against `users.id`. Had this
  -- stored email instead, a trusted contributor changing their Google
  -- account's email would silently stop matching their own past verdicts —
  -- the exact "email is not the identity" failure this file's `users` table
  -- exists to avoid, reintroduced one column over.
  annotator_id       TEXT NOT NULL,

  created_at         INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),

  CHECK (
    (verdict = 'adjust'
      AND adjusted_x_min IS NOT NULL AND adjusted_y_min IS NOT NULL
      AND adjusted_x_max IS NOT NULL AND adjusted_y_max IS NOT NULL)
    OR
    (verdict != 'adjust'
      AND adjusted_x_min IS NULL AND adjusted_y_min IS NULL
      AND adjusted_x_max IS NULL AND adjusted_y_max IS NULL)
  )
);

INSERT INTO verdicts_new
  (id, prediction_id, verdict, adjusted_x_min, adjusted_y_min, adjusted_x_max, adjusted_y_max,
   source, annotator_id, created_at)
  SELECT id, prediction_id, verdict, adjusted_x_min, adjusted_y_min, adjusted_x_max, adjusted_y_max,
         source, annotator_id, created_at
    FROM verdicts;

-- Safe precisely because nothing references `verdicts.id` — see the header
-- above. Nothing to rebuild ahead of this drop, unlike `jobs`.
DROP TABLE verdicts;

ALTER TABLE verdicts_new RENAME TO verdicts;

-- Both indexes migration 0003 declared, recreated verbatim — DROP TABLE took
-- them with it, and nothing about what either one covers changed.
CREATE INDEX idx_verdicts_prediction ON verdicts (prediction_id);
CREATE INDEX idx_verdicts_source ON verdicts (source);
