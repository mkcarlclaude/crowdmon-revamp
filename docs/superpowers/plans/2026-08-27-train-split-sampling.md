# A training set that exists

**Status:** planned 2026-08-27 · **Milestone:** M25 (v5) · **Design record:**
`CONTEXT.md` §Q16 (selection reasons and the 70/20/10 mix), §Q12 (pHash), §Q21 (where
training runs) · **Amends** `CONTEXT.md` §Q16 — the uncertainty band it specifies cannot
be built yet, and the reason is in the data

Training has no input. Not "a small input" — **zero**. This milestone produces one.

---

## The finding this exists to fix

Measured against a production export on 2026-08-27:

| | |
|---|---|
| Images extracted | 18,952 |
| Images sampled (carry predictions) | 1,013 |
| Predictions | 2,680 |
| Verdicts | 580 |
| Labels a snapshot would admit today | **125**, across 95 images |
| **Train-split images** | **0** |

Every one of the 1,013 sampled images carries `selection_reason = 'random'`. The split
rule in `splitFor()` (`worker/internal/snapshot/builder.go`) is *`random` → eval,
everything else → train*, so **a snapshot built today yields 125 eval labels and nothing
to train on.**

This is not a bug. v2's acceptance run recorded it as expected — *"every entry reads
`eval`, because every image an admin has verified so far was drawn by the sampler with
`selection_reason=random`; v2 has no other selector yet."* It is simply now the thing in
the way.

**It cannot be fixed by relabelling.** §Q16 is explicit that an image chosen by a biased
rule can never be retro-declared unbiased, and the 95 labelled images *are* the frozen
evaluation pool. Training on them destroys the only honest measurement instrument the
project has. The 125 labels are not wasted — they are exactly what M26's eval harness
needs — but they are not training data and never will be.

### The one existing escape hatch, and why it is not enough

M17's supplementary prelabel already writes a non-`random` reason: passing `image_ids`
stamps `manual`, which `splitFor()` routes to **train**. So training data is reachable
today with no new code.

It is not enough because the two modes split exactly wrong for this purpose:

- `image_ids` → `manual` → train, but **a human picks every id by hand**
- `{count}` → `random` → eval, which is the pool that is already full

Hand-picking is a bottleneck and biased by construction — which is precisely why M17
stamps it `manual` rather than pretending otherwise. It is a way to refill a drained
verification queue, not a way to build a training set.

---

## What §Q16 asks for, and what is actually buildable

§Q16 specifies `uncertain | random | diverse` at roughly **70 / 20 / 10**.

**The `uncertain` leg cannot be built yet, and the reason is in the data.** §Q16 defines
it as a confidence band of ~0.3–0.6, chosen to avoid the bottom of the range where an
open-vocabulary detector mostly finds empty frames. **This detector's confidences sit at
0.10–0.20.** A 0.3–0.6 band selects nothing at all. The band was specified before the
model existed and does not describe it.

§Q16 already anticipates this in its own v2 amendment: *"uncertainty sampling has no job
while a zero-shot model pre-labels uniformly and nothing is being measured."* That is
still true. It becomes false after M26 gives a measurement and M27 gives a model whose
confidence ranks informativeness.

So this milestone builds the leg that **works now and needs no model**:

- **`diverse`** — pHash distance from already-labelled images, reusing §Q12's existing
  work. It needs no confidence signal, no trained model, and no metric. It directly
  attacks the real problem, which is that 1,013 sampled frames out of 18,952 were drawn
  by one rule and may be highly redundant.
- **`random`** — unchanged, still the frozen eval pool, still non-negotiable.
- **`uncertain`** — **deferred to after M27**, with the band derived from the trained
  model's actual confidence distribution rather than a number written in advance.

The 70/20/10 ratio therefore does not land here. What lands is a `diverse`/`random`
split, and §Q16 gains an amendment saying why the third leg is waiting and what unblocks
it.

---

## A — The `diverse` selector

### A1. What it selects

From images in a video that have **no predictions yet** (`selection_reason IS NULL` —
16,673 of them today), choose the set that is most dissimilar from what is already
labelled, by pHash distance.

`phash` is already stored per image and `dedupThreshold` already exists (§Q12, M7). The
distance function is the same Hamming comparison the dedup pass uses; what is new is the
target — dedup asks *"is this near the previous frame"*, this asks *"is this far from
everything already labelled"*.

Greedy farthest-point selection is enough. Do not reach for clustering; with a 64-bit
hash and a few thousand candidates a linear scan per pick is fast, and the plan should
not buy an algorithm it cannot show it needs.

### A2. What it stamps

`selection_reason = 'diverse'`. That value is in §Q16's stated vocabulary and needs no
schema change — `selection_reason` is free text on `images` (migration 0004), and
`splitFor()` routes everything that is not `random` to train, so `diverse` lands in the
training split with no change to the builder. Confirm that with a test rather than
assuming it, because it is the whole point of the milestone.

### A3. Where it runs

The `prelabel` job already samples. This extends that path rather than adding a job kind:
the enqueue carries a selection mode, and the worker samples accordingly.

**Do not** reuse `idx_jobs_one_prelabel_per_video` in a way that blocks a second pass —
M17 already solved re-running prelabel for a video, and this rides that mechanism.

### A4. The budget

Per-video, bounded, in the spirit of M11.3's 200-frame cap. The governor stays
verification throughput, not extraction rate: an enormous unlabelled training pool is not
progress, it is a queue nobody will ever work through.

Pick a number that makes the *next* milestone possible rather than a round one. M26 needs
the eval pool it already has; M27 needs enough train labels to be worth a run at all.

---

## B — The class problem, which is separate and cheaper

Labels today:

```
Paimon         118
Raiden Shogun    7
Hu Tao, Keqing, Aether, Kazuha    0
```

And the roster disagrees with the data:

```
name           active  predictions
Paimon         1       2104
Keqing         0        260
Raiden Shogun  0        233
Hu Tao         1         55
Aether         0         23
Kazuha         0          5
```

**Only Paimon and Hu Tao are active, yet the labels are Paimon and Raiden Shogun.** Raiden
has 233 candidate predictions and is switched off; Hu Tao is active with 55.

This is a data decision, not code — classes are a table and prompts are rows (§Q12, M12).
Someone has to decide which characters v5 actually trains on, and switch the roster to
match. A five-class detector trained on 118 Paimons and 7 Raidens is a Paimon detector
with noise.

Worth resolving **before** A's budget is chosen, because it changes what the sampler
should be reaching for.

---

## Deliberately not in this plan

- **The `uncertain` leg and the 70/20/10 weighting.** Needs a model whose confidence
  means something. After M27, with the band measured rather than assumed.
- **Training itself.** M27.
- **The eval harness.** M26, and it is unblocked today — 95 images and 125 labels are
  enough to score the zero-shot detector and get the baseline every later claim is
  measured against.
- **Long-job survival** (§Q21's trap: the deploy timer restarts the container under a
  multi-day run). Real, and needed before M27, not before this.
- **Retro-labelling the eval pool as training data.** §Q16. Permanent, and it would
  destroy the measurement instrument.

---

## Verification

1. `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `cd worker && go generate ./... &&
   go vet ./... && go test ./...` — the Go client regenerates from `openapi.json` and CI
   diffs it, which has broken two pushes in this repo already.
2. **A test that a `diverse` image lands in the train split of a built snapshot.** That
   is the milestone's whole claim, and it is one `splitFor()` call away from being
   provable.
3. A test that `random` still lands in eval, and that no existing `random` row is ever
   rewritten. The frozen pool must stay frozen.
4. Selection quality is not unit-testable in any meaningful way. After a real run, export
   the database and check by hand that the `diverse` set is not visibly near-duplicate
   frames — the failure mode is a sampler that "works" and returns 200 shots of the same
   loading screen.

---

## Context for whoever picks this up cold

- Production reads: `npx wrangler d1 execute --remote` is **blocked** by the permission
  classifier, for reads as well as writes. `npx wrangler d1 export crowdmon --remote
  --output <file>` works and is how the numbers above were obtained — load the dump into
  local sqlite and query it there.
- Production writes must be run by Carl with a `! ` prefix.
- `.d1-backups/` is gitignored; dumps contain every annotator email.
- The home box is `ssh carl@carls-ubuntu`, key auth, non-interactive. `~/monitoring-stack`
  is read-only and not this repo's to change.
