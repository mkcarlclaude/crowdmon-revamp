/**
 * The `diverse` leg of `CONTEXT.md` §Q16's weighted mix (M25, plan §A).
 *
 * §Q16 names three selectors — `uncertain | random | diverse` at roughly
 * 70/20/10 — and until M25 the codebase shipped exactly one of them. That was
 * not an oversight: `random` images are the permanently frozen evaluation
 * pool, `splitFor()` (`worker/internal/snapshot/builder.go`) routes them to
 * `eval` and everything else to `train`, and so a snapshot built from a
 * `random`-only dataset yields an evaluation set and **nothing to train on**.
 * Measured against production on 2026-08-27: 1,013 sampled images, every one
 * of them `random`, and zero train-split images.
 *
 * This module is the selector that fixes that, and it is deliberately the
 * *only* one of §Q16's two missing legs that lands here. `uncertain` draws
 * from a confidence band §Q16 fixes at ~0.3–0.6; this detector's confidences
 * sit at 0.10–0.20, so that band selects nothing at all. The number was
 * written before the model existed and describes a different model. It waits
 * for M27, when a trained model's own confidence distribution can say where
 * the band actually is. `diverse` has no such dependency: pHash is already
 * stored on every image (§Q12, M7), so this leg needs no model, no metric and
 * no schema change.
 *
 * Pure functions over hex strings, in a module of their own rather than
 * inline in `routes/admin-prelabel.ts`, because selection quality is the one
 * part of M25 that is genuinely unit-testable — the handler around it is D1
 * plumbing, and the greedy rule below is the thing that can be subtly wrong
 * in a way no integration test would notice (see `selectDiverse`'s own note
 * on the self-duplication failure).
 */

/**
 * How many candidate hashes a single call will scan.
 *
 * `selectDiverse` is O(candidates × (reference + budget)) — one linear pass
 * per pick, which is the plan's own instruction not to buy clustering it
 * cannot show it needs. That is comfortable at the sizes this endpoint sees
 * (a few thousand frames in one video, a few hundred already sampled, a few
 * hundred picked) and it is not free at ten times those, so the ceiling is
 * stated here rather than discovered as a Worker CPU-limit error in
 * production. The caller reads it into its `LIMIT`; nothing here enforces it,
 * because a caller that legitimately hands over more should get a correct
 * answer slowly rather than a wrong one quickly.
 */
export const MAX_DIVERSE_CANDIDATES = 20000;

/**
 * A candidate frame: its `images.id` and the `images.phash` written by
 * `frames.Hash.Hex()` — 16 lowercase hex characters, zero-padded, exactly
 * what `VideoImage.phash` in `schemas.ts` already constrains on the wire.
 */
export interface DiverseCandidate {
  id: number;
  phash: string;
}

/**
 * Hamming distance between two hex phashes: the number of differing bits,
 * 0 for identical frames and around 32 for unrelated ones — `frames.Hash.
 * Distance`'s definition, restated in TypeScript because selection happens
 * in the API at enqueue time (`createPrelabelHandler`) rather than in the Go
 * worker.
 *
 * `BigInt` rather than a pair of 32-bit `Number` halves. JavaScript's bitwise
 * operators truncate their operands to 32 bits, so the obvious
 * `popcount(a ^ b)` written over `Number` silently compares the low half of a
 * 64-bit hash and reports 0 for two frames differing only in the high word —
 * a bug that looks like a working deduplicator right up until it returns a
 * screen full of the same frame. The `BigInt` cost is real and irrelevant
 * here: the whole point of `MAX_DIVERSE_CANDIDATES` is that this runs a few
 * million times per request, not a few billion.
 */
export function hammingDistance(a: string, b: string): number {
  let diff = parseHash(a) ^ parseHash(b);
  let bits = 0;
  // Kernighan's loop, `popcount` in worker/internal/frames/frames.go: each
  // iteration clears the lowest set bit, so it runs once per differing bit
  // rather than 64 times regardless.
  while (diff !== 0n) {
    diff &= diff - 1n;
    bits++;
  }
  return bits;
}

const HEX_HASH = /^[0-9a-f]{16}$/;

function parseHash(hash: string): bigint {
  if (!HEX_HASH.test(hash)) throw new Error(`${hash} is not a 16-character hex hash`);
  return BigInt(`0x${hash}`);
}

export interface DiverseSelection {
  /** The pool to draw from — frames with no `selection_reason` yet. */
  candidates: DiverseCandidate[];
  /**
   * The phashes this draw should be *unlike*: the frames of this video that
   * an earlier pass already sampled. Empty on a video nothing has sampled,
   * which is a legitimate input rather than a misconfiguration.
   */
  reference: string[];
  /** How many frames to pick. */
  budget: number;
}

/**
 * Greedy farthest-point selection: repeatedly take the candidate whose
 * *nearest* already-chosen neighbour is farthest away.
 *
 * **Every pick joins the set the next pick is measured against, and that is
 * the whole algorithm.** A selector that only maximised distance from the
 * reference set would score every near-duplicate of the farthest frame
 * identically well and return the budget filled with copies of one shot — the
 * exact failure the plan warns about ("200 shots of the same loading
 * screen"), and one that looks like success from the outside because the job
 * completes, the rows are stamped, and the frames really are far from what
 * was already labelled. Seeding `minDistance` from the reference set and then
 * folding each pick into it is what makes the result diverse *internally* as
 * well as *relative to* what exists.
 *
 * Deterministic, for `worker/internal/sample`'s reason restated one layer up:
 * the same pool, reference and budget always yield the same ids in the same
 * order. Ties break toward the lower index, so a degenerate pool where every
 * frame is the identical hash still returns `budget` distinct rows in pool
 * order rather than one row repeated — the `>` in the scan below, not `>=`,
 * is what does that, and it is also why a candidate can never be picked
 * twice (its own distance to itself is 0, which no later pick can beat).
 *
 * Order matters to the caller only in that a short pool returns *everything*:
 * when there are no more candidates than budget the greedy work is skipped
 * entirely, because selecting all of them in a different order selects the
 * same set.
 */
export function selectDiverse({ candidates, reference, budget }: DiverseSelection) {
  if (budget <= 0 || candidates.length === 0) return [];
  if (candidates.length <= budget) return [...candidates];

  // Distance from each candidate to the nearest thing already in the chosen
  // set, where "already chosen" starts as the reference frames. `Infinity`
  // for an empty reference set means the first pick is candidate 0 — the
  // arbitrary choice a first-ever pass over a video has to make, and the only
  // place in this function anything is arbitrary.
  const minDistance = candidates.map((candidate) =>
    reference.reduce(
      (nearest, hash) => Math.min(nearest, hammingDistance(candidate.phash, hash)),
      Number.POSITIVE_INFINITY,
    ),
  );

  const picked: DiverseCandidate[] = [];
  const taken = new Array<boolean>(candidates.length).fill(false);

  while (picked.length < budget) {
    let best = -1;
    let bestDistance = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < candidates.length; i++) {
      if (taken[i]) continue;
      const distance = minDistance[i] as number;
      if (distance > bestDistance) {
        best = i;
        bestDistance = distance;
      }
    }

    // Unreachable while `picked.length < budget < candidates.length`, since
    // some candidate is always untaken — but a `-1` index would silently
    // append `undefined`, so it is a guard rather than a comment.
    if (best === -1) break;

    const chosen = candidates[best] as DiverseCandidate;
    taken[best] = true;
    picked.push(chosen);

    for (let i = 0; i < candidates.length; i++) {
      if (taken[i]) continue;
      const distance = hammingDistance((candidates[i] as DiverseCandidate).phash, chosen.phash);
      if (distance < (minDistance[i] as number)) minDistance[i] = distance;
    }
  }

  return picked;
}
