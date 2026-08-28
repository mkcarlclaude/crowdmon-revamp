# An evaluation set that can be wrong about the model

**Status:** planned 2026-08-28 · **Milestone:** M26 (v5) · **Design record:**
`CONTEXT.md` §Q16 (the frozen pool and why it is non-negotiable), §Q17 (model registry,
`eval mAP on the frozen pool`), §Q21 (where this runs) · **Amends** the M25 plan, which
said the eval harness was "unblocked today". It is not, and the reason is structural.

The headline artifact this whole project builds toward is one sentence: **mAP improves
per model version.** M26 is supposed to produce the first number in that series — the
zero-shot baseline every later claim is measured against.

It cannot, yet. Not because the pool is too small, but because of where the labels came
from.

---

## The finding

**Every ground-truth box in this dataset is a box the detector proposed.**

`INSERT INTO predictions` appears exactly once in the codebase (`routes/jobs.ts:1025`) —
`reportPredictionsHandler`, the worker reporting detector output. A `verdicts` row always
references a `predictions` row (`prediction_id NOT NULL REFERENCES predictions(id)`), and
`adjust` only moves an existing box's coordinates; there is no `adjusted_*` path that
creates geometry where no prediction existed. A snapshot label is a prediction with a
winning accept/adjust verdict.

So the label set is a **subset of the detector's own output**, filtered by a human. It
contains nothing the detector failed to find.

### Why that inverts the metric rather than merely limiting it

The obvious reading is "recall is unmeasurable, so we can only report precision." That
would be a limitation. The real consequence is worse:

Take an eval image where the zero-shot detector missed a Paimon. Nothing was proposed
there, so nothing was shown to an admin, so the ground truth for that image has no box in
that region. Now M27's trained model — a *better* model — finds her. That detection
matches no ground-truth box, so it scores as a **false positive**, and precision drops.

**A model is penalised precisely for the improvement it was trained to make.** The mAP
series would trend *down* as the model gets better, and the chart PRD §5 promises would
be not just noisy but backwards. This is a measurement instrument that reads in reverse,
which is worse than having none, because it looks like it works.

### It cannot be fixed after the fact

§Q16 is explicit that the frozen pool's value is that it was drawn unbiased and left
alone. Its 95 images are still fine as a *sample* — the bias is not in which images were
chosen, it is in which boxes inside them exist. So the images stay; what has to change is
that somebody looks at each one and records **every** instance of each active class,
including the ones no model has ever proposed.

That is a labelling task, not a code change, and it is the actual gate on M26.

---

## A — Exhaustive annotation of the eval pool

### A1. What it is

For each of the 95 frozen images, for each active class, record every instance visible —
whether or not a prediction exists there. The output is a ground-truth set that is
independent of any model, which is the only kind a fair comparison can use.

**95 images and one class (Paimon) is a tractable sitting.** That is the whole reason to
do it now rather than after the pool grows: the roster was cut to Paimon alone on
2026-08-27, and the eval pool is small precisely because it has been drained slowly.

### A2. The schema question, which is the real decision

Ground-truth boxes need somewhere to live, and there are two shapes:

**A synthetic `predictions` row plus an `accept` verdict.** Zero new tables, and every
existing reader — `snapshotSourceHandler`, the split manifest, the stats — works
untouched. But it makes `predictions` mean two different things, and `model_id` /
`confidence` / `prompt_version` become lies on those rows (what model? what confidence?).
`predictions` is currently a truthful record of *what a model said*, and that property is
worth more than the saved table.

**A `ground_truth` table**, keyed by `(image_id, class_id)` with coordinates and an
annotator. Honest about what it is, and it forces every reader to decide explicitly
whether it wants model output or truth — which is exactly the decision that must not be
made by accident.

**Recommendation: the second.** The first is cheaper today and buys a permanent ambiguity
in the one table whose meaning the metric depends on.

### A3. The drawing surface, and the trap already documented

Adding a box means drawing one, and `CLAUDE.md` has a section about exactly this:

> `/admin/verify`'s adjust tool was driven end to end against production and passed —
> 201, coordinates stored to the last decimal, prediction row untouched — and was still
> unusable by hand. An `<img>` is natively draggable, so a real press-and-move tore the
> frame loose as a drag ghost and fired `pointercancel`.

Neither jsdom nor CDP can reproduce the gestures a browser owns. So the drawing surface's
tests must assert on the *attributes that keep the browser out of the way* —
`draggable={false}`, `touch-action`, `user-select` — and the gesture itself has to be
tried by hand before this is called done. A synthetic pass is not evidence here, and
saying so is part of the deliverable.

There is an existing implementation to read rather than reinvent: M20's adjust tool
already solved press-drag-release on a frame, and M24 removed it from `/contribute` while
leaving it on the admin side.

---

## B — The harness

### B1. Where it runs

**A script on the home box, not a new job kind.** §Q21 puts training there and §Q17 makes
promotion manual; evaluation belongs on the same side of that line. A `jobs.kind` value
would need a migration, a `CHECK` widening, and the claim-endpoint rollout ordering that
has bitten this repo before — all to schedule something a person runs deliberately, a few
times a year, and reads the output of.

The counter-argument is real and worth stating: a job kind gets the reaper, the traces and
the queue UI for free. If evaluation ever runs unattended, that is the moment to move it.
It does not run unattended in v5.

### B2. What it computes

Standard detection mAP, and the parts worth pinning down rather than leaving to a library
default:

- **IoU threshold.** Report mAP@0.5 as the headline, and mAP@[.5:.95] beside it. The
  first is what a reader understands; the second is what catches a model that finds the
  right things and boxes them sloppily. Reporting only the first hides localisation drift.
- **Confidence sweep.** Precision and recall at each threshold, not a single operating
  point, because this detector's confidences sit at 0.10–0.20 and any fixed cutoff
  inherited from a tutorial discards everything.
- **Per class**, even at one class today. A single-class mean is the same number, and the
  shape stops being a rewrite the day a second class returns.

### B3. What it writes

One row per evaluation. §Q17 already specifies the fields — version, eval mAP, training
set size, accept/adjust/reject counts, snapshot reference, timestamp — and `model_versions`
does not exist yet. **Creating it belongs to M27**, which is what has a model version to
register. M26 writes its output as a file beside the snapshot in R2 and prints it, and
the table absorbs it when there is a second number to compare against.

Building an empty registry now would be a schema guessing at a consumer that does not
exist.

---

## The baseline this produces, and what it is worth

The zero-shot detector scored against an exhaustively-annotated pool will look **much
worse** than the current accept rate suggests, and that is the point. Today's numbers —
2,680 predictions, 580 verdicts, 125 accepted labels — describe agreement with the
detector's own proposals. A true recall number has never been measured, and the first
honest one is very likely low.

A baseline that flatters the starting point makes every subsequent improvement look
smaller. This is the cheapest moment in the project's life to get that number right.

---

## Deliberately not in this plan

- **`model_versions`.** M27's, when there is a version to register (§B3).
- **Training.** M27.
- **Re-annotating the train split.** Training data does not need exhaustive labels the way
  an evaluation set does — a missed instance in training is a weaker signal, not an
  inverted metric. It would also be a far larger job.
- **Growing the eval pool.** Tempting while annotating, and a separate decision: the pool
  is frozen, and adding images to it mid-stream means two regimes inside one instrument.
- **Automatic promotion.** §Q17 rules it out and nothing here changes that.

---

## Verification

1. `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `cd worker && go generate ./... &&
   go vet ./... && go test ./...`.
2. **The scorer against a hand-computed fixture.** A handful of boxes whose AP can be
   worked out on paper, asserted exactly — a metric implementation that is quietly wrong
   is indistinguishable from a model that is quietly bad, and this is the only place that
   distinction can be caught.
3. **A test that a ground-truth box with no matching prediction lowers the score**, which
   is the entire failure this milestone exists to fix. It must be impossible to pass by
   scoring only where predictions already exist.
4. **A test that an unmatched *prediction* is a false positive**, its mirror image.
5. **The drawing surface's attributes**, per §A3 — and a hand test on a real mouse before
   this is called done, reported as such rather than as a synthetic pass.

---

## Context for whoever picks this up cold

- Production reads: `npx wrangler d1 execute --remote` and `d1 export --remote` both need
  `CLOUDFLARE_API_TOKEN` from `infra/.env` (`set -a && . ./infra/.env && set +a`) — the
  OAuth token from `wrangler login` returns 7403 on D1 as of 2026-08-28.
- Production writes must be run by Carl with a `! ` prefix.
- `.d1-backups/` is gitignored; dumps contain every annotator email.
- The frozen pool is 95 images and 125 labels, all `selection_reason = 'random'`. The 400
  `diverse` frames drawn on 2026-08-27 are **train** and are not part of this.
- Only Paimon is an active class as of 2026-08-27.
