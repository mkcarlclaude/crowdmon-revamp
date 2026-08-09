/**
 * The two things every multi-row query in this Worker has to know about D1.
 *
 * Extracted from `routes/jobs.ts`, where they were written for
 * `reportPredictions`, once `routes/admin-labelling.ts` needed the same
 * ceiling for the same reason. Two copies of a limit is two places to be wrong
 * about it the day it changes.
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
