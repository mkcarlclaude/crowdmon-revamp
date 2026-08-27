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
 * on the self-duplication failure). It is also the one part with a cost worth
 * measuring rather than asserting: the first version of this module was
 * correct and 100x too slow, and no test in the suite could tell, because a
 * unit test's pool is a dozen frames and a real one is thousands
 * (`PackedHash`).
 */

/**
 * How many hashes a single call will read on either side of the draw — the
 * `LIMIT` on both of `createPrelabelHandler`'s two `diverse` queries.
 *
 * `selectDiverse` is O(candidates × (reference + budget)): one linear pass to
 * seed each candidate's distance to the reference set, and one linear pass
 * per pick. That is the plan's own instruction not to buy clustering it
 * cannot show it needs, and it is genuinely fast — but only because the
 * distance is measured on hashes parsed once (see `packHash`), and only up to
 * a size worth stating rather than discovering as a CPU-limit error in
 * production.
 *
 * 25,000 is the honest per-video ceiling rather than a round number:
 * extraction runs at 1fps (`worker/internal/frames`' `FPS`, not
 * configurable) and `MAX_VIDEO_SECONDS` is 21,600, so no video can yield more
 * than 21,600 frames before dedup and rather fewer after it. A limit above
 * that cannot truncate a real video's pool, which matters because a
 * truncation here would silently bias the draw toward the earliest frames.
 * Measured at the worst case this permits — 8,000 candidates against 1,000
 * already-sampled frames, budget 400 — the selection takes ~35ms.
 */
export const MAX_DIVERSE_CANDIDATES = 25000;

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
 * A phash split into its two 32-bit halves, parsed exactly once.
 *
 * **JavaScript has no 64-bit integer that bitwise operators understand**, and
 * both of the obvious ways around that are traps:
 *
 * - A plain `Number` looks like it works. JavaScript's bitwise operators
 *   truncate their operands to 32 bits, so `popcount(a ^ b)` over `Number`
 *   silently compares the *low half* of a 64-bit hash and reports 0 for two
 *   frames differing only in the high word — a deduplicator that looks like
 *   it works right up until it returns a screen full of the same frame.
 * - A `BigInt` is correct and unusably slow at this scale. Measured on the
 *   worst per-video case `MAX_DIVERSE_CANDIDATES` permits (8,000 candidates,
 *   1,000 reference, budget 400 — about 5 million distance computations), a
 *   `BigInt` implementation that re-parsed both hex strings on every call
 *   took **5.6 seconds**, which on a Worker is a request that dies rather
 *   than a request that is slow. The same selection over this struct takes
 *   ~35ms. The parse, not the arithmetic, was most of it: the hot loops below
 *   compare each hash against thousands of others, so parsing per comparison
 *   does the same work thousands of times over.
 *
 * Two halves it is. `hi` and `lo` are both non-negative 32-bit values held in
 * a `Number`, which is exact well past 2^32.
 */
interface PackedHash {
  hi: number;
  lo: number;
}

const HEX_HASH = /^[0-9a-f]{16}$/;

/** Parses what `frames.Hash.Hex()` wrote, rejecting anything it could not have. */
function packHash(hash: string): PackedHash {
  if (!HEX_HASH.test(hash)) throw new Error(`${hash} is not a 16-character hex hash`);
  return {
    hi: Number.parseInt(hash.slice(0, 8), 16),
    lo: Number.parseInt(hash.slice(8), 16),
  };
}

/**
 * Hamming distance between two parsed hashes, and the only place bits are
 * actually counted.
 *
 * SWAR rather than `frames.go`'s Kernighan loop (`for v != 0 { v &= v - 1 }`)
 * — the Go version runs once per *differing* bit, which is the right trade
 * when most comparisons are near-duplicates, but this selector's whole job is
 * to find frames that are far apart, so its comparisons average ~32 set bits
 * and the branchless fixed-cost version wins. Same answer either way; the
 * exported `hammingDistance` is what the tests pin it against.
 *
 * `Math.imul` for the final multiply, not `*`: the operand can exceed 2^32
 * and plain multiplication would produce a float whose low bits are the ones
 * being shifted out.
 */
function popcount32(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return Math.imul(v, 0x01010101) >>> 24;
}

function packedDistance(a: PackedHash, b: PackedHash): number {
  return popcount32(a.hi ^ b.hi) + popcount32(a.lo ^ b.lo);
}

/**
 * Hamming distance between two hex phashes: the number of differing bits,
 * 0 for identical frames and around 32 for unrelated ones — `frames.Hash.
 * Distance`'s definition, restated in TypeScript because selection happens
 * in the API at enqueue time (`createPrelabelHandler`) rather than in the Go
 * worker.
 *
 * The convenient form, parsing on every call. `selectDiverse` deliberately
 * does *not* use it (see `PackedHash` for the 100x that costs); it is the
 * definition the tests pin, and the one a caller comparing two hashes once
 * should reach for.
 */
export function hammingDistance(a: string, b: string): number {
  return packedDistance(packHash(a), packHash(b));
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
export function selectDiverse({
  candidates,
  reference,
  budget,
}: DiverseSelection): DiverseCandidate[] {
  if (budget <= 0 || candidates.length === 0) return [];
  if (candidates.length <= budget) return [...candidates];

  // Parsed once, here, and never again — the whole of `PackedHash`'s
  // argument. Every hash below is compared against thousands of others, so
  // parsing inside the loops would repeat this work once per comparison
  // rather than once per hash.
  const packed = candidates.map((candidate) => packHash(candidate.phash));
  const packedReference = reference.map(packHash);

  // Distance from each candidate to the nearest thing already in the chosen
  // set, where "already chosen" starts as the reference frames. `Infinity`
  // for an empty reference set means the first pick is candidate 0 — the
  // arbitrary choice a first-ever pass over a video has to make, and the only
  // place in this function anything is arbitrary.
  //
  // A `Float64Array` rather than a plain array because `Infinity` has to be
  // representable: an integer-typed array would clamp the empty-reference
  // case to a finite maximum, and every candidate would then tie at that
  // value rather than falling through to the pool-order tiebreak below.
  const minDistance = new Float64Array(candidates.length);
  for (let i = 0; i < packed.length; i++) {
    let nearest = Number.POSITIVE_INFINITY;
    const hash = packed[i] as PackedHash;
    for (let r = 0; r < packedReference.length; r++) {
      const distance = packedDistance(hash, packedReference[r] as PackedHash);
      if (distance < nearest) nearest = distance;
    }
    minDistance[i] = nearest;
  }

  const picked: DiverseCandidate[] = [];
  const taken = new Uint8Array(candidates.length);

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

    taken[best] = 1;
    picked.push(candidates[best] as DiverseCandidate);
    const chosen = packed[best] as PackedHash;

    for (let i = 0; i < candidates.length; i++) {
      if (taken[i]) continue;
      const distance = packedDistance(packed[i] as PackedHash, chosen);
      if (distance < (minDistance[i] as number)) minDistance[i] = distance;
    }
  }

  return picked;
}
