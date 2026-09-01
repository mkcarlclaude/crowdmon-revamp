# The manifest's eval half stops being a list of boxes a model proposed

**Status:** planned 2026-08-31 · **Milestone:** M26.7 (v5) · **Design record:**
`CONTEXT.md` §Q16 (the frozen pool), §Q21 (read the manifest, never the directory) ·
**Discharges** the "prerequisite nobody has done yet" section of
`2026-08-30-first-trained-model.md`, so M27 starts on a manifest it can trust.

---

## The finding

`snapshotSourceHandler` (`routes/jobs.ts`) builds labels from `WINNING_VERDICT` for
**both** splits. So a snapshot's eval-split entries carry verdict-derived labels: boxes a
model proposed and a human accepted. That is precisely the population M26 built
`ground_truth` (migration 0014) to replace, and the inverted metric M26 opens with —
a model that finds a Paimon the zero-shot detector missed scores it as a false positive.

The honest labels exist and are already being annotated: 286 images marked exhaustive,
117 ground-truth boxes, feeding `GET /api/admin/eval-source` and `worker/cmd/eval`. They
have simply never reached the manifest. `admin-eval.ts`'s module comment says why that
was right at the time — widening the snapshot route to refuse on incomplete eval
annotation would block an unrelated training rebuild on a labelling sitting. That
reasoning still holds, and this plan does not reverse it: **nothing here adds a refusal.**

Nothing is broken today because nothing has read a manifest's eval half. M27 is the first
milestone that reads a snapshot in anger, which is exactly the shape of §Q21's warning:
the difference is invisible until something has already trained on it.

### What actually changes, measured against production 2026-08-31

| | today (verdict-derived) | after (ground truth) |
|---|---|---|
| eval images in the manifest | 433 | **286** |
| of those, zero-label true negatives | 0 | **171** |
| exhaustive images absent from the manifest today | 233 | 0 |

This is not a relabelling of the same set. Only ~53 images are in both. **171 of the 286 —
sixty per cent of the scored set — carry no ground-truth box at all**, because the honest
answer for that frame is "she is not in it." Those are the entries a verdict-derived
manifest can never contain, since a frame with nothing accepted on it produces no labels
and is dropped, and they are the ones that make a false positive cost something.

---

## A — Where the split decision lives, which this change forces

`SnapshotSourceImage`'s comment states the current arrangement: the API returns
`selection_reason` raw and the worker's `splitFor()` decides the split, because the mapping
is "a property of the *builder*, not of the contract."

**That stops being true here, and the plan must not pretend otherwise.** The moment the
API chooses which *table* an image's labels come from, it has already decided that image's
split. Returning `selection_reason` and letting the worker re-derive the same rule
independently leaves two decisions that can disagree, with the manifest recording the
worker's answer and the labels reflecting the API's.

So the response carries `split` explicitly, resolved once, by the side that already had to
know. `selection_reason` stays alongside it as provenance — it is a fact about the image,
not a derived field, and `manual` vs `diverse` is worth keeping in the record.

`splitFor()` does not get deleted. It becomes the **check**: the builder computes the split
from `selection_reason` and fails loudly if it disagrees with the `split` the API sent.
That is M27 plan §C's own posture — a filter that silently drops the wrong thing is
indistinguishable from one that silently keeps it — applied one layer earlier, and it is
what stops the two copies of the rule (three, counting `CONTRIBUTOR_TRAIN_SPLIT`) from
drifting in silence.

---

## B — The eval half

**Labels come from `ground_truth`**, joined through `classes` for `class_name`, in the same
normalised-float shape `SnapshotLabel` already describes. No confidence, no model id —
a ground-truth box is not a model's output and the schema already reflects that.

**Membership is exhaustiveness, not labels.** An eval image is in the manifest once it is
marked exhaustive for **every active class** (`ground_truth_exhaustive`), and is absent
until then — never emitted with zero labels as a stand-in. Reuse `getEvalSourceHandler`'s
covered-pairs construction rather than writing a second one: it already chunks image ids
against `MAX_ACTIVE_CLASSES` reserved slots for the D1 hundred-parameter ceiling
(`memory/d1-bound-param-limit`), and a second implementation of "exhaustive for every
active class" is a second thing to keep true.

**`labels` must be allowed to be empty on the eval side.** `SnapshotSourceImage.labels`
is `.min(1)` today, and `snapshotSourceHandler` only emits an image once it carries at
least one label. Both have to relax for eval, or the 171 true negatives — the majority of
the scored set — are silently dropped and this whole milestone delivers a smaller version
of the bug it set out to fix.

**The invariant that makes an empty eval entry readable, stated once and loudly:** a
zero-label eval entry means *this frame was examined and contains nothing*. It can only
mean that because non-exhaustive images are absent entirely. The two rules are one rule;
neither is safe alone, and anything that later relaxes the omission rule silently converts
every true negative into "nobody looked yet."

**The train half does not change.** Verdict-derived, `accept` or `adjust`, at least one
label required. The asymmetry is argued in the M26 plan and restated in M27 §A2: a missed
instance in training is a weaker signal; in an evaluation set it inverts the metric.

**No refusal, at all.** `eval-source` answers 409 when nothing is marked exhaustive; this
route must not. An empty eval half is a correct answer for a deployment mid-annotation, and
blocking a training rebuild on an eval sitting is the exact coupling `admin-eval.ts`
rejected.

---

## C — `DEFAULT_INCLUSION_POLICY`

The string is stamped verbatim onto every `snapshots` row so a snapshot's dataset is
reconstructible from its own row. It currently describes one policy for both splits and
will be a lie the moment this ships. It has to name the asymmetry — train from verdicts,
eval from ground truth gated on exhaustiveness.

Existing rows are **not** backfilled, per that constant's own comment: a change here
describes snapshots built after it and must never rewrite what an existing row says about
how it was built. The one snapshot in production (job-329, 2026-08-09) keeps its string and
becomes, correctly, a record of a snapshot built the old way.

---

## Deliberately not in this plan

- **Any refusal or gate on incomplete eval annotation** (§B).
- **Growing or re-annotating the frozen pool** — §Q16, and M26's own "the estimate has
  converged" argument.
- **Deleting the eval-split verdicts** already recorded. They stop being read by the
  manifest; they are harmless where they sit.
- **`worker/cmd/eval` or `GET /api/admin/eval-source`.** The scorer is already correct and
  is not what this touches. The two routes stay separate for `admin-eval.ts`'s own reason.
- **Training anything.** That is M27.

---

## Verification

1. `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `cd worker && go generate ./... &&
   go vet ./... && go test ./...`.
2. **An eval image's labels are its `ground_truth` rows**, not its accepted predictions —
   on a fixture where the two differ, which is the only fixture that can tell.
3. **An exhaustive eval image with zero ground-truth boxes appears, with `labels: []`.**
   This is the 171-image case and the one most likely to be lost.
4. **An eval image not marked exhaustive for every active class is absent**, even when it
   carries accepted verdicts — today's manifest would have included it.
5. **A train image is unchanged**: verdict-derived, `adjust` geometry preferred, and still
   requires at least one label.
6. **The builder fails loudly when `split` disagrees with `splitFor(selection_reason)`**
   (§A), rather than trusting either side.
7. **No 409 and no refusal** when nothing is marked exhaustive — an empty eval half, a
   populated train half, and a 200.
8. `DEFAULT_INCLUSION_POLICY` names both sources, and no existing `snapshots` row changed.

---

## Context for whoever picks this up cold

- The split rule now lives in three places: `splitFor()`
  (`worker/internal/snapshot/builder.go`), `CONTRIBUTOR_TRAIN_SPLIT`
  (`routes/contribute.ts`, M26.6), and whatever §A adds to `snapshotSourceHandler`. Each
  points at the others; keep it that way.
- `ground_truth` is not append-only (migration 0014's header): a wrong box is deleted and
  redrawn. A manifest is a point-in-time read and does not need to care, but a re-run can
  legitimately differ from an earlier one.
- Production reads need `CLOUDFLARE_API_TOKEN` from `infra/.env` (`set -a && . ./infra/.env
  && set +a`); production writes are Carl's to run with a `! ` prefix.
- Only Paimon is active, so "every active class" is one class today. The code must not
  assume that — `MAX_ACTIVE_CLASSES` is 30.
