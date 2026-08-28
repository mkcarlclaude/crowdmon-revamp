/**
 * The things every multi-row query in this Worker has to know about D1.
 *
 * Extracted from `routes/jobs.ts`, where they were written for
 * `reportPredictions`, once `routes/admin-labelling.ts` needed the same
 * ceiling for the same reason. Two copies of a limit is two places to be wrong
 * about it the day it changes. `SHUFFLE_KEY_MASK` and `randomShuffleKey`
 * (M25.1, plan §A) joined for the same reason, once `routes/contribute.ts`
 * needed a second writer to agree with `routes/jobs.ts`'s on the same bound.
 */

/**
 * Builds `?, ?, ?` for an `IN (...)`, so a set of handles resolves in one
 * query rather than one `SELECT` per handle.
 */
export const placeholders = (values: unknown[]) => values.map(() => "?").join(",");

/**
 * D1 rejects a query carrying more than 100 bound parameters, and that limit
 * is per *statement* — batching does not pool it.
 *
 * This is a real bound, not a theoretical one. M11.3 samples 200 images per
 * video by default, so a report naming a distinct `r2_key` for each would put
 * 200 of them into one `IN (...)` and be rejected by D1 before a single row
 * was read. The tests that exercise a handful of keys cannot see it, which is
 * exactly why the chunking is stated here rather than left to whatever size
 * the first caller happens to be.
 */
export const D1_MAX_BOUND_PARAMS = 100;

/** Splits `values` into runs no query built from one of them can exceed D1's limit. */
export function chunkForBinding<T>(values: T[], reservedParams = 0): T[][] {
  const size = D1_MAX_BOUND_PARAMS - reservedParams;
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

/**
 * The bound `images.shuffle_key` (migration 0013, M25.1 plan §A) is generated
 * within, on both sides of it: the migration's SQL backfill and
 * `randomShuffleKey` below.
 *
 * The plan calls this a random 64-bit integer, which is what SQLite's own
 * `random()` returns and what the column's storage class can hold. It is not
 * what this Worker can carry safely, and that gap is a correctness bound, not
 * a style preference — measured directly against this project's own D1
 * rather than assumed from general JavaScript-precision folklore:
 *
 * - Binding a `bigint` is not an escape hatch. D1 rejects it outright —
 *   `D1_TYPE_ERROR: Type 'bigint' not supported for value '9223372036854775807'`
 *   — so there is no way to hand a full 64-bit value to a prepared statement
 *   that is not already a `number`.
 * - A `number` is a float64, exact only up to `Number.MAX_SAFE_INTEGER`
 *   (2^53 - 1). A column holding more comes back already rounded: an inserted
 *   `9223372036854775807` reads back as `9223372036854776000` — a different
 *   value, with nothing at any layer raising an error about it.
 *
 * `shuffle_key` has to survive exactly this round trip *twice* — out to a
 * batch response and back in as the next request's cursor (plan §A3) — so a
 * value that silently changed under rounding would not just misreport
 * itself, it would corrupt the keyset walk: `shuffle_key > ?` compares
 * against a number that is no longer the one actually stored, which skips or
 * repeats rows depending on which way the rounding went, with no error and no
 * NULL to catch it the way §A2's hazard at least fails loudly-ish.
 *
 * So the value is masked to the low 53 bits rather than left at SQLite's
 * native 64 — bitwise `&`, not `%`: a modulo of a signed dividend folds two
 * differently-sized halves of the range together at the boundary, where a
 * mask just keeps the low bits of a uniformly random word, which are
 * themselves uniform regardless of the high bits truncated away. 2^53
 * distinct values against a corpus of 19,352 images is nowhere near where
 * collision odds would matter (rough birthday-bound arithmetic: on the order
 * of 2 × 10⁻⁸). The alternative considered and rejected was carrying the
 * cursor as a string end to end (D1 can store and compare text losslessly at
 * any width) — masking wins because it keeps `shuffle_key > ?` an ordinary
 * numeric comparison the query planner already knows how to use an index
 * for, rather than a text comparison that would have to special-case
 * negative values and left-padding to sort the same as the numbers they
 * represent.
 */
export const SHUFFLE_KEY_MASK = Number.MAX_SAFE_INTEGER; // 2^53 - 1, low 53 bits

/**
 * `crypto.getRandomValues`, matching `routes/auth.ts`'s own session-token
 * idiom — assembled from two 32-bit words rather than one call against a
 * wider buffer, because there is no fixed-width typed array between 32 and 64
 * bits and this needs exactly 53: 21 bits from the first word (masked down
 * from 32) placed above all 32 bits of the second, both known-uniform because
 * `getRandomValues` is, so the low 53 bits of the result never favour any
 * value over another the way a modulo of a non-power-of-two range could.
 */
export function randomShuffleKey(): number {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  // `?? 0` rather than a non-null assertion: `Uint32Array`'s index signature
  // types every element as possibly `undefined` even though a length-2 array
  // always has both, and the fallback is never actually reached.
  const [high, low] = words;
  return ((high ?? 0) & 0x1f_ffff) * 2 ** 32 + (low ?? 0);
}
