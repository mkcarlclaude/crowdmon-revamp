# On-demand prelabel + single-frame dry-run

**Status:** planned 2026-08-12 · **Milestone:** M17 (v3) · **Design record:** `CONTEXT.md`
§Q16, §12, §16 · **Supersedes the scope line in** `docs/superpowers/plans/2026-08-11-m16-admin-dashboard.md`

Two independent changes that push the same way: **selection moves out of the Go worker
and into the admin UI + API.** The worker stops deciding which frames to look at and
becomes a pure executor of an explicit list.

- **A — single-frame dry-run.** Iterate a candidate prompt against one fixed image
  instead of fifty random ones. Small, one additive migration, no provenance hazard.
- **B — on-demand prelabel.** Let an admin queue a supplementary prelabel pass over a
  chosen or randomised set of not-yet-sampled frames, to refill the verification pool
  when it drains. Larger, and it lands on top of a *verified acceptance claim* that has
  to be preserved.

Do A first. It is independently useful, it exercises the "selection moves server-side"
shape on the easier of the two, and nothing in B depends on it.

---

## Contradictions with the existing record

The instruction was to check the docs before planning. Three findings change the design;
the rest are amendments to write.

### 1. HARD — removing the automatic prelabel pass falsifies v2's done-claim

v2's completion test is a single sentence with no criteria list, and `PRD.md` §9 says so
explicitly: *"Falsifiable, and it is the whole of the completion test."* Its first clause:

> A submitted video becomes pre-labelled frames **with no human trigger**

`PRD.md` §9's falsification table names the exact observation that kills it:

| Clause | Proven false by |
|---|---|
| *with no human trigger* | A submitted video whose frames are extracted but **not pre-labelled until something is run by hand** |

This is not a stale aspiration. It has been **demonstrated and recorded** — `README.md:138`
carries the evidence from the v2 acceptance run (M15.4): *"Job 146 (`kind=prelabel`) was
enqueued by `completeJobHandler`'s own last-chunk check, timestamped seconds after the
video's last `chunk` job finished — no admin action between them."* The same claim appears
at `PRD.md:157`, `ROADMAP.md:774`, and `README.md:13`.

**Resolution: keep the automatic first pass. Add on-demand passes as supplementary.**

The clause stays literally true — a submitted video still becomes pre-labelled frames with
no human trigger — and the README evidence stays valid, because the mechanism that produced
it is untouched. The admin button queues *additional* work over frames the first pass did
not sample.

This also matches the actual need. The stated problem was "prelabelled images run out
during extensive labelling sessions, spawn more" — that is a refill, not a replacement.
Deleting the auto-enqueue would buy nothing and cost a closed acceptance claim.

> If the automatic pass is genuinely unwanted, that is a decision to amend `PRD.md` §9's
> done-claim, its falsification table, `ROADMAP.md`'s v2 header, and both README
> references — including retracting recorded acceptance evidence. Out of scope here; this
> plan assumes the first pass stays.

### 2. HARD — hand-picked frames must never be stamped `selection_reason = 'random'`

`CONTEXT.md` §Q16 defines the vocabulary as `uncertain | random | diverse`, amended in v2
to *"the column ships, the weighting does not"* — v2 selects randomly only. And on
`random`:

> `random` images form a **permanent evaluation pool, excluded from training forever**.
>
> **Why the random slice is non-negotiable:** … If every labelled image was chosen because
> the model found it hard, each version is measured against its own different hard set and
> the improvement chart becomes unreadable. The random slice is the measurement
> instrument, not a nicety.

A hand-picked set is the definition of a biased sample. Stamping it `random` pollutes the
frozen evaluation pool and destroys the property §Q16 calls non-negotiable — silently, and
irrecoverably, since §Q16 also notes an image *"can never be retro-declared an unbiased
sample."*

So the two entry paths need different reasons:

| Path | `selection_reason` | Snapshot split (via `splitFor`) |
|---|---|---|
| Automatic first pass (unchanged) | `random` | eval |
| "Randomise 50 un-sampled frames" button | `random` — still an unbiased draw over the remaining pool | eval |
| Admin hand-picks specific frames | **`manual`** (new value) | train |

`splitFor()` (`worker/internal/snapshot/builder.go:101`) already maps non-`random` → train,
so this needs **no Go change** and `DEFAULT_INCLUSION_POLICY` stays accurate as written —
the rule it states (`selection_reason='random' -> eval, else train`) is unchanged. What
changes is that the rule stops being a tautology: today every admitted image is `random`,
and the builder's own comment admits *"every admitted image is 'eval' in practice today."*
Hand-picked frames become the first rows ever to land in train. That is the feature, but it
must be deliberate.

`manual` is a fourth value outside §Q16's stated vocabulary, so §Q16 needs an amendment
note rather than being silently exceeded.

### 3. SEVERE — `selection_reason` is written unconditionally and must become write-once

`apps/api/src/routes/jobs.ts:882`:

```sql
UPDATE images SET selection_reason = 'random' …
```

Unconditional. Today that is safe because `idx_jobs_one_prelabel_per_video` guarantees an
image can only ever be sampled once. **Dropping that index removes the only thing making
this safe.**

The failure: pass one stamps an image `random`, putting it in the permanent evaluation
pool. A later hand-picked pass includes the same image and rewrites the reason to `manual`.
The image silently moves from the eval split into the train split — which is precisely the
observation `PRD.md` §9 lists as falsifying the *last* clause of the done-claim:

| *with a split manifest* | A manifest missing, or **a frozen-evaluation-pool image appearing in the train split** |

So one UI button, with no migration and no Go change, can falsify two clauses of a closed
acceptance claim. This is `CONTEXT.md` §Q19's provenance rule stated in general form —
*"Thresholds are dataset provenance, not just settings … or the dataset becomes an
unrecorded mixture of regimes"* — and it is exactly the trap `CONTEXT.md` §16 flagged as
the fourth prerequisite for this feature.

**Fix:** make the stamp write-once, in SQL, not in a guard the caller has to remember:

```sql
UPDATE images SET selection_reason = ? WHERE r2_key IN (…) AND selection_reason IS NULL
```

Add a test that a second pass over an already-sampled image leaves the original reason
intact. Also worth deciding deliberately: the API should refuse to include an
already-sampled image in a hand-picked set at all, so the write-once guard is a backstop
rather than the mechanism.

### 4. Deviation from §16's anticipated approach, stated on purpose

`CONTEXT.md` §16 (and the M16 plan) already scoped this feature out and enumerated four
prerequisites: a migration, an admin enqueue route, *"a Go worker change so `ImageSampler`
draws only frames not already sampled"*, and an answer to the provenance rule.

This plan satisfies all four but **inverts the third**. Rather than teaching
`ImageSampler` to exclude sampled frames, selection moves to the API and the worker
consumes an explicit list. Reasons:

- The hand-pick UI requires server-side selection anyway. Two selection mechanisms — one
  in Go for the random case, one in the API for the manual case — is the thing to avoid.
- "Frames not already sampled" is a `WHERE selection_reason IS NULL` predicate. It belongs
  next to the data.
- `ImageSampler` and `BoundedImageSampler` both largely dissolve. `BoundedImageSampler`'s
  doc comment argues at length that it exists so a dry-run's budget comes from its row
  rather than worker config; change A removes that argument entirely.

§16's text should be amended to record the inversion, not left implying the worker-side
version is still the plan.

### 5. Amendments to write (no design change)

- **`CONTEXT.md` §9.4 — sampling posture.** The argument for never ratio-sampling
  `image.detect` spans rests on prelabel being low-rate: *"one prelabel job per video,
  bounded to M11.3's budget."* On-demand passes raise that rate by an amount an operator
  controls, and §9.4 already flags Tempo's 7-day retention on a shared box. The posture
  need not change, but its premise no longer holds by construction and should say so.
- **`CONTEXT.md` §Q25 amendment.** *"the admin dry-run grid is proxied, not signed. Fifty
  frames…"* — change A shrinks the subject to one frame. The amendment's conclusion holds
  more strongly than before; only the number is stale.
- **`apps/api/src/routes/videos.ts:135`** computes `frames_sampled` as
  `selection_reason IS NOT NULL`. Still correct, but it now means "sampled by any pass,
  automatic or manual." Check the videos list still reads honestly.
- **`docs/FLOWS.md`** §1.2 (job-kind table), §3.3 (auto-enqueue), §3.4 (prelabel
  sequence), §3.5 (dry-run sequence), §6 (ERD), §6.1 (index table) all describe the
  current behaviour and need updating with each change.

---

## Change A — single-frame dry-run

**Problem.** A dry-run samples `DRYRUN_SAMPLE_SIZE = 50` frames at random per run, so a
reworded prompt is evaluated against a *different* set of frames. Two variables move at
once and no comparison is attributable to the wording. Fifty detect calls on a two-core
box also make the loop too slow to iterate.

**Shape.** The request names an image. The worker runs one detect call on it. The UI shows
every wording tried against that frame, side by side.

### Migration `0009_dryrun_image.sql`

```sql
ALTER TABLE dryruns ADD COLUMN image_id INTEGER REFERENCES images(id);
```

One additive column, **no table rebuild** — so none of the child-row cascade hazard that
0005/0007/0008 had to work around applies. Nullable, so existing rows stay valid and read
as "video-sampled, pre-M17."

Note the `REFERENCES` clause is documentation only: D1 ignores the `foreign_keys` pragma,
so it is not enforced. `sample_size` stays `NOT NULL` and a single-frame run writes `1` —
no schema change needed for it.

### API

- `POST /api/admin/classes/{id}/dryrun` — request becomes `{image_id, appearance_prompt}`,
  replacing `{video_id, …}`. Derive `jobs.video_id` from the image
  (`SELECT video_id FROM images WHERE id = ?`), because migration 0008's
  `CHECK ((kind = 'snapshot') = (video_id IS NULL))` requires a non-null value for a
  `dryrun` job. 404 on an unknown image.
- Claim hydration (`jobs.ts`, the `kind === "dryrun"` branch) joins `images` and returns
  the `r2_key` alongside `class_name` and `appearance_prompt`. The worker never needs to
  resolve an id.
- `POST /api/jobs/{id}/dryrun` — `sampled_images` shrinks to a one-element array;
  `MAX_DRYRUN_BOXES` drops from `DRYRUN_SAMPLE_SIZE * 20` to `20`, since the "20 boxes on
  a single frame is generous" reasoning in `schemas.ts:881` now applies to the whole
  payload.
- `GET /api/admin/classes/{id}/dryruns` — accept an optional `image_id` filter.
  `idx_dryruns_class (class_id, id DESC)` already serves the ordering.

### Go worker

`Pipeline.dryrun` loses `sampleN` and the `dryrun.select` span; it detects on the key the
claim handed it. `BoundedImageSampler` and `Pipeline.SampleN` can be deleted — nothing else
implements or calls them. Keep the `dryrun.report` span name (its comment's argument for
not being `predictions.report` is unaffected).

### Web

`/admin/detection` → `DryRunPanel`: pick a frame (from the video's grid, or paste an id),
then run wordings against it repeatedly. Render iterations as a comparison strip — same
frame, one box overlay per run, newest first, each labelled with its wording. Proxied image
fetch via `GET /api/admin/image?key=…` stays exactly as §Q25's amendment describes.

### Two things worth building while the shape is open

- **Keep a wide confirm pass.** One frame overfits — a wording tuned to one pose and one
  lighting condition can be worse across the video. Don't delete the 50-frame path; demote
  it to a confirmation step before `PATCH /api/admin/classes/{id}` accepts a wording.
  Iterate narrow, confirm wide.
- **Dry-run against a frame that already has admin verdicts,** and the UI can show
  candidate boxes against accepted ground truth and compute IoU. That turns "does this look
  better" into a number, which is the thing currently missing. Cheap once the dry-run names
  its image; the accepted box is reachable via `predictions` → latest admin `verdicts`
  (reuse `LATEST_ADMIN_VERDICT` from `jobs.ts`).

---

## Change B — on-demand supplementary prelabel

**Problem.** The verification pool is `WHERE EXISTS (UNRULED_BOX)`
(`admin-labelling.ts:18`) — images holding a prediction with no admin verdict. It drains
monotonically as an admin works, and nothing can refill it: prelabel runs exactly once per
video, automatically, forever.

**Shape.** Keep the automatic first pass (see contradiction 1). Add a route that queues a
supplementary `prelabel` job over an explicit set of not-yet-sampled frames, chosen either
by hand or by a "randomise N" button, plus the UI to drive it.

### Scope decision: keep prelabel video-scoped

A supplementary job could span videos ("50 random un-sampled frames anywhere"), which
would want `jobs.video_id IS NULL` like `snapshot` — but that means relaxing migration
0008's `CHECK` and therefore a **full `jobs` table rebuild**, with the child-ordering
hazard 0005/0007/0008 each had to handle (D1 ignores the `foreign_keys` pragma, so the
standard rebuild recipe cascades child rows away unless ordered deliberately).

Keep prelabel scoped to one video. `video_id` stays non-null, the CHECK is untouched, and
the migration reduces to a dropped index plus a new side table. The UI presents a video
picker; a cross-video refill is N jobs behind one button. Revisit only if per-video
selection proves genuinely insufficient.

### Migration `0010_prelabel_selection.sql`

```sql
DROP INDEX idx_jobs_one_prelabel_per_video;

CREATE TABLE prelabel_images (
  job_id   INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, image_id)
);
```

No table rebuild. Note what the dropped index was silently protecting — see contradiction
3 — and land the write-once `selection_reason` fix **in the same migration's PR**, not a
follow-up. The window between the two is the window where the dataset can be corrupted
invisibly.

### API

- `POST /api/admin/videos/{id}/prelabel` — body `{image_ids[]}` for a hand-pick, or
  `{count, strategy: "random"}` to have the server draw from
  `WHERE video_id = ? AND selection_reason IS NULL`. One batch: `INSERT INTO jobs` +
  `INSERT INTO prelabel_images`, atomic for `chunks`' reason — the claim handler must never
  observe a prelabel job whose selection is half-written. Respect the D1 100-bound-param
  limit per statement (chunk the inserts; batching does not pool the limit).
- Reject any image already carrying `selection_reason`, with the offending ids named. The
  write-once SQL guard stays as a backstop.
- Claim hydration: a `prelabel` job returns its image list (`r2_key` + `timestamp_seconds`)
  from `prelabel_images`, exactly as `chunk` returns its window. Bound by
  `MAX_SAMPLED_IMAGES_PER_JOB`.
- `POST /api/jobs/{id}/predictions` — `selection_reason` becomes a value the *job* carries
  (`random` | `manual`) rather than the literal `'random'` in the handler. Simplest home for
  it is a column on `jobs` or a single-valued field on the selection; either way the API
  decides it at enqueue time, never the worker.
- `GET /api/admin/labelling/stats` already returns `remaining`. Surface it.

### Go worker

`Pipeline.prelabel` drops the `GET /api/videos/{id}/images` fetch, the `Sampler` call and
the `sample.select` span; it iterates the list the claim gave it. `ImageSampler` and the
`sample` package's use from this branch go away. `sampled_keys` is still reported —
unchanged in meaning and still collected before the first `Detect` call, so a job that dies
partway still stamps nothing.

**Rollout order matters and is not optional.** The claim endpoint is kind-agnostic, and a
job queued before the box updates fails *terminally* rather than waiting. Ship the worker
release that reads `prelabel_images` **before** the API route that can create such a job.
A supplementary job claimed by an old worker would ignore its list and re-sample the video
— which, with the write-once guard in place, silently does nothing useful and burns
attempts.

### Web

`/admin/videos/:id` already lists a video's frames with prediction counts and verdict
state — that grid is the selection surface. Add multi-select plus two actions: "prelabel
selected" (→ `manual`) and "randomise N un-sampled" (→ `random`). Show pool `remaining`
from labelling stats next to it, and make the two buttons visibly distinct, because the
split consequence differs and is invisible afterwards. Label them with it.

---

## Test coverage this needs

Beyond the per-route tests each change implies:

- A second prelabel pass over an already-sampled image leaves `selection_reason`
  unchanged. This is the guard for contradiction 3; without this test the hazard returns
  the first time somebody refactors the stamp.
- A hand-picked pass writes `manual`, and a snapshot built afterwards puts those images in
  the **train** split while `random` images stay in **eval**. Asserts contradictions 2 and
  3 together, end to end, through `splitFor`.
- An automatic first pass still happens with no admin action after the last chunk
  completes — the regression test for v2's done-claim. It should have existed already.
- Dry-run: two runs with different wordings against the same `image_id` both resolve to the
  same `r2_key`, and both appear in the class's dry-run list filtered by that image.
