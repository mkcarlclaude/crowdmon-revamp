# A model that is measurably better than the one it replaces

**Status:** planned 2026-08-30 · **Milestone:** M27 (v5) · **Design record:**
`CONTEXT.md` §Q17 (the model registry and why promotion is manual), §Q21 and its "Where
the work runs" amendment (the one-method `Detector` interface, and the 940MX question
being closed rather than open), §Q16 (the frozen pool) · **Builds on**
`2026-08-28-eval-harness.md`, whose baseline is the number this milestone has to beat.

M26 built an instrument and read it: **mAP@0.5 = 0.055, recall ceiling 0.340**, on 236
images and 94 exhaustively-annotated ground-truth boxes. Two Paimons in three are invisible
to the zero-shot detector at any confidence threshold.

M27 produces the second number in that series, and the PRD's headline claim — *mAP improves
per model version* — is either true after this milestone or it is not a claim.

---

## The prerequisite nobody has done yet

**`snapshotSourceHandler` builds labels from `WINNING_VERDICT` for both splits**
(`routes/jobs.ts`), so a snapshot's eval-split entries carry verdict-derived labels: the
model-proposed subset M26 exists to replace. The honest labels live only behind
`GET /api/admin/eval-source`.

Nothing has read a manifest's eval half yet, so nothing is wrong today. M27 is the first
milestone that reads a snapshot in anger, and §Q21's own warning is about exactly this
shape — a training script that reads the directory instead of the manifest does not notice
the difference until it has trained on the wrong thing.

**Fix it before training, not after.** Eval-split entries source their labels from
`ground_truth`, and an eval image that is not marked exhaustive for every active class is
**omitted from the manifest entirely** rather than emitted with zero labels. A zero-label
eval entry is indistinguishable from "she is not in this frame", which is the original bug
in a new costume.

Train-split labels stay verdict-derived and unchanged. That asymmetry is deliberate and is
argued in the M26 plan: a missed instance in training is a weaker signal; in an evaluation
set it inverts the metric.

---

## A — The training set, and the honest thing to say about it

### A1. What exists

As of 2026-08-30, measured against production:

| split | images | labels |
|---|---|---|
| `diverse` (train) | 400 sampled, 23 labelled | **30** |
| `random` (eval) | 2,298 sampled | 402 verdict-labels, frozen out of training by §Q16 |

**Thirty boxes is not a training set.** Four more `diverse` prelabel passes are queued;
at the rates this project has actually measured — 0.78 proposals per diverse frame, and a
29% accept-or-adjust yield computed by scoring all 273 eval predictions against known
ground truth — 1,600 new frames give roughly 1,244 proposals and **~360 labels**, landing
near 450 with what the existing proposals yield.

Training should not start below **~300 labels**. Below that the model memorises and the
eval set is the only thing that would say so, which is a slow way to learn something the
label count already knows.

### A2. The bias that will shape the result, stated before the result exists

**Every training label is a box OWL-ViT proposed.** Verification cannot produce a label
where nothing was proposed, so the training set is drawn entirely from the 34% of instances
the zero-shot detector can already find. It systematically lacks the two thirds it cannot.

A model trained on that learns to be *more accurate about what OWL-ViT already sees*. The
expected shape of the improvement is therefore **precision and localisation up, recall
comparatively flat** — and recall is what the eval set measures most starkly.

This is a prediction, not a hedge, and it is falsifiable: if M27 comes back with precision
sharply improved and recall within noise of 0.340, that is this bias and not a training
failure. The fix in that case is not more verification — more verification buys more of the
same population — but drawing ground truth on a slice of *train* frames, which is a
different and more expensive sitting. **Do not pre-emptively do that work.** Measure first;
the whole point of having an instrument is to stop guessing which problem you have.

---

## B — The model

### B1. The choice, and the constraint that makes it

**`fasterrcnn_mobilenet_v3_large_fpn` from torchvision**, fine-tuned from its COCO
weights.

The hardware decides more than taste does. §Q21's amendment already closed the 940MX: it
is Maxwell, compute capability 5.0, dropped by CUDA 13, with 2GB of VRAM, and the box runs
detection CPU-only for that reason. Training only makes that worse, so M27 trains on four
CPU cores or it trains somewhere else. That rules out anything heavy before preference gets
a say.

Against the obvious alternative: **Ultralytics YOLO11n is AGPL-3.0 and this repository is
MIT and public.** Training with AGPL tooling and shipping the resulting weights is a
licensing question a portfolio project should not have. If throughput ever outweighs
convenience, **YOLOX-nano is Apache-2.0** and is the escape hatch; torch is already in the
detector image either way.

### B2. What does not change

**OWL-ViT stays.** It is the bootstrap engine — the thing that proposes candidates for a
class with no labels yet — and a closed-set model trained on one class cannot do that job.
M27 adds a model beside it, and §Q21's one-method `Detector` interface is what makes that a
configuration question rather than a rewrite.

---

## C — Training, and where it runs

A script on the home box, beside `worker/cmd/eval` in spirit if not in language: §Q21 puts
training there, §Q17 makes promotion manual, and M26 §B1 already argued why a `jobs.kind`
is the wrong shape for something a person runs deliberately a few times a year.

It reads the snapshot manifest — never the directory (§Q21) — takes only `split == "train"`
entries, and must **fail loudly if it sees an eval-split entry**, rather than filtering it
out quietly. A filter that silently drops the wrong thing is indistinguishable from one
that silently keeps it.

Fix the seed and record it, along with epochs, learning rate, image size and the snapshot
id, in the run's output. A training run nobody can repeat is an anecdote.

---

## D — Export, and the trap this repo has already fallen into

The trained model reaches production the way every model does here: exported to ONNX and
served by the Python sidecar behind the `Detector` interface.

`CLAUDE.md` has a section about this and it cost a milestone the first time. `torch.onnx
.export` in torch 2.13 defaults to the dynamo exporter, which honours `dynamic_axes` for
inputs, silently drops it for outputs, and overrides `opset_version`. The build passed and
the artifact would have failed every request. **Exit code 0 is not verification when the
artifact has a shape:** load the exported graph and run inference at more than one input
shape and more than one batch size, and be suspicious of any fix whose entire effect is to
make an error message go away.

Build the image locally before pushing, per the same section.

---

## E — `model_versions`, finally

M26 §B3 deferred this table here deliberately, because a registry with one row is a schema
guessing at a consumer. §Q17 already names the fields: version, eval mAP on the frozen
pool, training-set size at that point, accept/adjust/reject counts, snapshot reference,
timestamp.

Two things §Q17 settles that this plan does not reopen:

- **Promotion is manual.** Nothing here promotes a model automatically, and the plan that
  proposes otherwise is the plan that mixes the eval pool into training and replaces the
  honest metric with a flattering one.
- **The registry records; it does not decide.** Writing a row is not deploying a model.

The table absorbs M26's report file as its first row, and `worker/cmd/eval` gains a flag to
write a row rather than only a file.

---

## F — The second number, and what makes it comparable

**M27's model must be scored against the same `scored_image_ids` M26 recorded** —
`eval/2026-08-29/report.json` in `crowdmon-frames` names all 286 of them, beside the
`eval-source.json` it was computed from.

The scored set is defined by what has been annotated, and annotation continues, so the set
will have grown by the time M27 runs. Scoring the new, larger set is fine and is probably
what you want going forward — but the *comparison* to 0.055 holds only over the intersection.
Report both: the new model on the M26 set, which is the honest before-and-after, and the new
model on whatever the set is that day, which is the number the next milestone compares to.

A chart of two numbers measured on different populations is not a chart of improvement, and
nothing in the data would say so.

---

## Deliberately not in this plan

- **Re-annotating the train split exhaustively.** §A2 — the expensive fix for a problem that
  may not be the one you have. It waits for the measurement.
- **A second class.** Only Paimon is active; the roster question M25 left open is still open
  and is not this milestone's to settle.
- **Automatic promotion.** §Q17, and §E above.
- **A `jobs.kind` for training or evaluation.** §C.
- **Growing or re-drawing the eval pool.** §Q16.
- **Uncertainty sampling.** Deferred past M27 since M25, and for a reason that still holds:
  the band was specified before the model existed. A trained model is what makes it
  answerable, which makes it M28's at the earliest.

---

## Verification

1. `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `cd worker && go generate ./... &&
   go vet ./... && go test ./...`.
2. **The manifest's eval half carries `ground_truth` labels**, and an eval image not marked
   exhaustive does not appear in it at all. This is the prerequisite above and the one that
   silently poisons everything downstream if it is wrong.
3. **The training script refuses an eval-split entry** rather than skipping it.
4. **The exported ONNX graph runs at more than one input shape and batch size**, asserted on
   the artifact, not on the exit code (§D).
5. **The new model scored against M26's exact `scored_image_ids`**, reported beside its score
   on the current set (§F).
6. **A `model_versions` row that matches the report file it came from** — the two must not be
   able to disagree.

---

## Context for whoever picks this up cold

- Baseline to beat: **mAP@0.5 0.055, mAP@[.5:.95] 0.0325, recall ceiling 0.340**, on 236
  images / 94 boxes, excluding the 50 frames of `F1snt1pXqQc` that predate #180's shuffle
  and over-represent one easy video. ROADMAP records why that exclusion is the honest one.
- The home box is 4 cores, 11GB RAM, no usable GPU. `ssh carl@carls-ubuntu`, key auth,
  non-interactive.
- Production reads need `CLOUDFLARE_API_TOKEN` from `infra/.env` (`set -a && . ./infra/.env
  && set +a`); production writes are Carl's to run with a `! ` prefix.
- Verdicts are append-only and re-rulable: the latest admin verdict wins, so a
  fast-clicked mistake is corrected by ruling again, not by deleting anything.
- Only Paimon is an active class.
