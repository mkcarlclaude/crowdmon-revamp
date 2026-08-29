-- Model-independent ground truth for the frozen evaluation pool (M26,
-- migration 0014). Plan: docs/superpowers/plans/2026-08-28-eval-harness.md
-- §A2. Design record: CONTEXT.md §Q16.
--
-- Why this is not a synthetic `predictions` row
-- ----------------------------------------------
-- A ground-truth box exists precisely because a model did *not* propose it
-- — that is the whole finding the plan opens with: every existing label is
-- a box the detector found, so a model that later finds what the zero-shot
-- detector missed scores that detection as a false positive, and the mAP
-- series would trend backwards as the model improves. Writing a ground-truth
-- box as a `predictions` row plus an `accept` verdict was considered and
-- rejected: it costs no migration, but `predictions.model_id`,
-- `.confidence` and `.prompt_version` (migration 0003) would become lies on
-- those rows, and `predictions` being a truthful record of *what a model
-- said* is worth more than the table it would save. `ground_truth` is its
-- own table so a reader has to choose explicitly between model output and
-- truth, rather than that choice being made by accident.
--
-- `ground_truth` is deliberately not append-only the way `predictions` and
-- `verdicts` are (migration 0003's file header). A model's prediction is
-- what the model said, immutable because rewriting it would rewrite
-- history; a hand-drawn box is one person's attempt to record what is
-- actually in the frame, and undoing a mis-drawn one is correcting a
-- mistake, not rewriting a fact. `routes/admin-ground-truth.ts` deletes
-- rows for exactly that reason. Still no UPDATE: a wrong box is deleted and
-- redrawn, not nudged, which keeps "this row is exactly what an annotator
-- drew" true without a second code path that edits geometry in place.
CREATE TABLE ground_truth (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Cascaded, matching `predictions.image_id`: a ground-truth box is a claim
  -- about pixels in one image and has no meaning once that image is gone.
  image_id      INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,

  -- Not cascaded, matching `predictions.class_id`: a class is soft-deleted
  -- via `active`, never dropped, so a box never needs to survive its class
  -- disappearing.
  class_id      INTEGER NOT NULL REFERENCES classes(id),

  -- Same normalized-float shape and the same CHECKs as `predictions`
  -- (migration 0003's own reasoning: `images` carries no width/height, so a
  -- pixel box would need a join to mean anything).
  x_min         REAL NOT NULL CHECK (x_min >= 0 AND x_min <= 1),
  y_min         REAL NOT NULL CHECK (y_min >= 0 AND y_min <= 1),
  x_max         REAL NOT NULL CHECK (x_max >= x_min AND x_max <= 1),
  y_max         REAL NOT NULL CHECK (y_max >= y_min AND y_max <= 1),

  -- The Access-verified identity that drew this box. Free text rather than
  -- a foreign key, matching `verdicts.annotator_id`'s own reasoning
  -- (migration 0003): there is no user table for an admin identity to
  -- reference.
  annotator_id  TEXT NOT NULL,

  created_at    INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- The annotation surface's per-image read (#176): every ground-truth box on
-- one frame, alongside what the detector proposed there.
CREATE INDEX idx_ground_truth_image ON ground_truth (image_id);
-- The scorer's per-class read (#177): every ground-truth box for one class,
-- across the whole eval pool.
CREATE INDEX idx_ground_truth_class ON ground_truth (class_id);

-- Exhaustiveness is a property of an (image, class) pair, not of a box, and
-- it cannot be read off `ground_truth` alone: zero rows for an image/class
-- means either "nobody has looked yet" or "somebody looked and there is
-- genuinely nothing here," and those two states must score differently —
-- the first is not a safe input to the scorer, the second is a legitimate
-- zero. This table records which one, explicitly, the moment an annotator
-- finishes a pass over one image for one class.
--
-- A second table rather than a column on `images`: exhaustiveness varies
-- per class (today only Paimon has ever been looked at this way; a second
-- active class starts at "nobody has looked," independently of Paimon's own
-- state), and `images` names one row per frame with no class dimension to
-- hang that on. A column would also mean an `ALTER TABLE` rebuild of
-- `images` to add it — D1 ignores the `foreign_keys` pragma during exactly
-- that kind of rebuild and silently cascades away every child row that
-- referenced it (`memory/d1-ignores-foreign-keys-pragma`), a risk this
-- table avoids entirely by never touching `images`.
--
-- `(image_id, class_id)` as the primary key, not a surrogate id, matching
-- `prelabel_images` (migration 0011): the pair *is* the fact, and marking a
-- class exhaustively annotated twice is a re-affirmation, not a second row —
-- `routes/admin-ground-truth.ts` upserts on this key rather than appending.
CREATE TABLE ground_truth_exhaustive (
  image_id      INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  class_id      INTEGER NOT NULL REFERENCES classes(id),
  annotator_id  TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),

  PRIMARY KEY (image_id, class_id)
);

-- The scorer's safe set (#177): every class an image has been exhaustively
-- annotated for, read without a join back through `ground_truth` (which may
-- legitimately have zero rows for a pair that is nonetheless exhaustive).
CREATE INDEX idx_ground_truth_exhaustive_class ON ground_truth_exhaustive (class_id);
