-- v2 labelling schema: classes, predictions, verdicts, missing reports and
-- dataset snapshots (M10.1, CONTEXT.md §12 "Data model").
--
-- One property runs through all five tables: nothing is overwritten. A
-- prediction is the model's original output and is never mutated after
-- insert; an `adjust` verdict writes its corrected box onto the *verdict*
-- row instead. That is what keeps "every annotation is a human verdict on a
-- model prediction" checkable rather than asserted, and it is what any later
-- exclusion of an annotator (CONTEXT.md §Q10) falls back to — a schema that
-- let `adjust` mutate the prediction would make that exclusion an
-- unrecoverable loss instead of a `WHERE` clause.
--
-- Box coordinates throughout are normalized floats in [0, 1], not pixel
-- ints. `images` carries no width/height of its own, so a pixel box would
-- need a join to `videos.width`/`height` to mean anything, and that column
-- describes the source video, not necessarily the extracted frame after any
-- future resize. Normalized coordinates need nothing to interpret them and
-- are the native output shape of the ONNX detection models CONTEXT.md §12
-- describes the prelabel worker running behind a one-method interface.

-- Open-vocabulary detectors match described appearance, not proper nouns
-- (CONTEXT.md §12 "the classes are data"), so which characters exist is an
-- empirical question answered by running a prompt and looking — hence a
-- table, not an enum baked into application code.
CREATE TABLE classes (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Unique: two rows for the same character would split every prediction
  -- and verdict for it across two class_ids with nothing at insert time to
  -- catch the duplicate.
  name               TEXT NOT NULL UNIQUE,

  -- What is actually sent to the detector, e.g. "a small white-haired flying
  -- companion with pointed ears". Distinct from `name` because the display
  -- name and the wording that makes the model find her drift independently
  -- — renaming the row in the admin UI must not change what any existing
  -- prediction was produced by.
  appearance_prompt  TEXT NOT NULL,

  -- Free-text tag for the appearance_prompt in force, e.g. "2026-08-08-a".
  -- Same idiom as `jobs.config_version` (migration 0001): stamped onto every
  -- prediction this class produces (see `predictions.prompt_version` below)
  -- so that editing the wording later does not silently create two regimes
  -- inside one class (CONTEXT.md §12). Not a foreign key into a prompt-
  -- history table — no such table exists in v2, and a free-text tag is
  -- enough to tell two regimes apart without one.
  prompt_version     TEXT NOT NULL,

  -- Soft delete. An inactive class is skipped by pre-labelling but its id
  -- must survive, because existing predictions and verdicts reference it —
  -- a hard delete would either cascade into destroying label history or
  -- leave it referencing nothing.
  active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),

  created_at         INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at         INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- A model's proposed box on one image for one class. Immutable after
-- insert — nothing in this schema issues an UPDATE against this table, and
-- no later milestone should either; see the file header.
CREATE TABLE predictions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Cascaded: a prediction is a claim about pixels in one specific image,
  -- and has no meaning once that image is gone. Nothing in this application
  -- deletes an `images` row today, so the cascade is dormant in production —
  -- it exists for the day that changes (an admin purging a video) and for
  -- test cleanup, which does delete `images` between runs.
  image_id        INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,

  -- Not cascaded either — a class is soft-deleted via `active`, never
  -- dropped, so a prediction never needs to survive its class disappearing.
  class_id        INTEGER NOT NULL REFERENCES classes(id),

  x_min           REAL NOT NULL CHECK (x_min >= 0 AND x_min <= 1),
  y_min           REAL NOT NULL CHECK (y_min >= 0 AND y_min <= 1),
  x_max           REAL NOT NULL CHECK (x_max >= x_min AND x_max <= 1),
  y_max           REAL NOT NULL CHECK (y_max >= y_min AND y_max <= 1),

  -- CONTEXT.md §Q16: a later uncertainty-band selector draws directly on
  -- confidence and cannot reconstruct it from the box alone, so it is
  -- persisted from the first prediction row even though v2 does not yet
  -- select on it ("the column ships, the weighting does not").
  confidence      REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),

  -- Copied from `classes.prompt_version` at insert time rather than joined
  -- live: `classes.prompt_version` can change after this row exists, and
  -- the whole point of stamping it here is to record which wording produced
  -- this exact box (CONTEXT.md §12, "provenance is stamped, not inferred").
  prompt_version  TEXT NOT NULL,

  -- Which detector produced this box (e.g. an ONNX weights file name or
  -- hash). Free text rather than a foreign key into a model registry: v2
  -- explicitly excludes the model registry (CONTEXT.md §12 "What v2
  -- excludes"), and CONTEXT.md §12 describes the model itself as a one-file
  -- swap, so there is exactly one running model and no table worth having
  -- yet.
  model_id        TEXT NOT NULL,

  created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Verification UI: every prediction on one image.
CREATE INDEX idx_predictions_image ON predictions (image_id);
-- Per-class accept/adjust/reject rollups (CONTEXT.md §12: "accept / adjust /
-- reject rates per model version fall out of the schema for free").
CREATE INDEX idx_predictions_class ON predictions (class_id);

-- A human's ruling on one prediction. Append-only: nothing in this schema
-- issues an UPDATE or DELETE against this table.
--
-- Deliberately NOT unique on prediction_id, and none should ever be added.
-- Several verdicts on one prediction is a legal state (CONTEXT.md §12 and
-- §Q10): a public verification page can show the same prediction to more
-- than one anonymous visitor, and an admin re-verifying a prediction an
-- anonymous visitor already ruled on must not collide with that earlier
-- row. A UNIQUE index or constraint on prediction_id would silently forbid
-- both, and the absence of one is not visible from the schema without this
-- comment.
CREATE TABLE verdicts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Cascaded, unlike the two `REFERENCES images` above: a verdict has no
  -- meaning independent of the prediction it rules on, the same relationship
  -- `chunks.job_id` has to `jobs` in migration 0001.
  prediction_id      INTEGER NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,

  verdict            TEXT NOT NULL CHECK (verdict IN ('accept', 'adjust', 'reject')),

  -- Populated only when verdict = 'adjust'. Nullable rather than a sentinel
  -- box, because 'accept' and 'reject' rows have no adjusted coordinates at
  -- all, and a sentinel like (0,0,0,0) would be indistinguishable from a
  -- real degenerate box. The CHECK below ties presence to `verdict` so the
  -- two cannot drift apart.
  adjusted_x_min     REAL CHECK (adjusted_x_min IS NULL OR (adjusted_x_min >= 0 AND adjusted_x_min <= 1)),
  adjusted_y_min     REAL CHECK (adjusted_y_min IS NULL OR (adjusted_y_min >= 0 AND adjusted_y_min <= 1)),
  adjusted_x_max     REAL CHECK (adjusted_x_max IS NULL OR (adjusted_x_max >= adjusted_x_min AND adjusted_x_max <= 1)),
  adjusted_y_max     REAL CHECK (adjusted_y_max IS NULL OR (adjusted_y_max >= adjusted_y_min AND adjusted_y_max <= 1)),

  -- CONTEXT.md §Q10 amendment: two tiers, admin and anonymous, nothing in
  -- between. Accept/adjust/reject rates are computed per source rather than
  -- pooled, because an anonymous troll rejecting everything would otherwise
  -- be indistinguishable from a model that got worse — the one metric a
  -- later flywheel claim depends on.
  source             TEXT NOT NULL CHECK (source IN ('admin', 'anon')),

  -- The admin's identity for source='admin' (the Access-verified email), or
  -- an opaque per-visitor session id for source='anon' (CONTEXT.md §Q10:
  -- "an anonymous verdict is recorded with source = 'anon' and an opaque
  -- session id"). One NOT NULL column rather than two nullable ones: every
  -- verdict has exactly one or the other by construction, and nothing in v2
  -- needs to represent "no annotator recorded" as a distinct state. Named
  -- `annotator_id` to match CONTEXT.md §Q10's "annotator_id on every
  -- annotation".
  annotator_id       TEXT NOT NULL,

  created_at         INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),

  -- Ties the adjusted-coordinate columns to verdict='adjust' so the two
  -- cannot disagree: an 'adjust' row without coordinates would have nowhere
  -- to record what changed, and an 'accept'/'reject' row carrying
  -- coordinates would imply a correction nobody asked for.
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

-- Verification UI history for one prediction, and the accept/adjust/reject
-- rollups computed over it.
CREATE INDEX idx_verdicts_prediction ON verdicts (prediction_id);
-- Per-source rates (CONTEXT.md §Q10): admin and anonymous verdicts must
-- stay distinguishable in every rollup that reads this table.
CREATE INDEX idx_verdicts_source ON verdicts (source);

-- The verify-only gate (CONTEXT.md §12) means a character the detector
-- misses is never proposed, never corrected, and indistinguishable in the
-- data from a character that was truly absent. This is the escape hatch:
-- its own row type rather than a verdict on a prediction that does not
-- exist, because there is no prediction row to attach a verdict to.
CREATE TABLE missing_reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Cascaded, matching `predictions.image_id` above: a report about what is
  -- missing from an image has no meaning once that image is gone.
  image_id     INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,

  -- Nullable: a report can be "something is missing here" with no known
  -- class yet — e.g. a character not in `classes` at all — as well as "this
  -- specific class is missing". NULL is that first case, not a foreign-key
  -- violation waiting to happen.
  class_id     INTEGER REFERENCES classes(id),

  -- Admin-only in v2 (CONTEXT.md §12). Free text rather than a foreign key
  -- into a user table, for the same reason `verdicts.annotator_id` is: v2
  -- has no user table (§Q7's OAuth is not built), and the Access-verified
  -- identity behind `/api/admin` is already a string.
  reporter     TEXT NOT NULL,

  created_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Per-image report lookup, and the per-class missing rate CONTEXT.md §12
-- names as "the number that says whether a prompt is good enough".
CREATE INDEX idx_missing_reports_image ON missing_reports (image_id);
CREATE INDEX idx_missing_reports_class ON missing_reports (class_id);

-- A frozen dataset export (CONTEXT.md §Q21, amended for the home box rather
-- than Kaggle in §12): images, labels and a split manifest, written to R2
-- as one artifact. Nothing in this schema deletes or updates a snapshot row
-- — a stable, reconstructible identifier is the entire point, since a later
-- `model_versions` row (not part of v2; see CONTEXT.md §Q17) will reference
-- one and must be able to point at a dataset that still means what it meant
-- when training ran.
CREATE TABLE snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Where the artifact (images, labels, split manifest) lives in R2. Not
  -- UNIQUE: unlike `images.r2_key` (migration 0001), which is deterministic
  -- specifically so a re-run overwrites rather than duplicates, a snapshot
  -- key is expected to embed this row's own id or a timestamp, so a
  -- collision is not a real possibility a constraint needs to guard against.
  r2_key            TEXT NOT NULL,

  -- Two counts rather than one aggregate: an image can carry more than one
  -- label (multiple classes, or multiple verdicts), so "how many images"
  -- and "how many labels" can disagree and both are worth having on the row
  -- rather than one implying the other.
  image_count       INTEGER NOT NULL,
  label_count       INTEGER NOT NULL,

  -- Free text describing which rows the snapshot admitted — which sources
  -- and verdict states counted as a label, whether the public/eval pool was
  -- included. Stored as the policy itself rather than a foreign key into a
  -- versioned policy table (no such table exists), so a snapshot's dataset
  -- is reconstructible from this row alone rather than asserted
  -- (CONTEXT.md §Q17: "referencing a dataset that can be reconstructed
  -- rather than asserted").
  inclusion_policy  TEXT NOT NULL,

  created_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
