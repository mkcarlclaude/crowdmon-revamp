import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

/**
 * Applies `migrations/` to the test D1 before any test runs.
 *
 * The same files production runs, in the same order, rather than a schema
 * written for tests: the queue's guarantees are largely constraints — the
 * partial unique index that makes a second download job impossible, the CHECK
 * on `status` — and a test schema that omitted one would prove nothing.
 */
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

/**
 * Empties the tables between tests.
 *
 * The pool isolates storage between *files*, not between tests within one, and
 * the queue is full of uniqueness constraints — one download job per video,
 * one chunk per (video, segment). Without this, the second test to submit the
 * same URL gets a 409 it did not ask for and passes or fails for the wrong
 * reason.
 *
 * Children first: `chunks` and `images` carry foreign keys into `jobs` and
 * `videos`.
 */
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM images"),
    env.DB.prepare("DELETE FROM chunks"),
    env.DB.prepare("DELETE FROM jobs"),
    env.DB.prepare("DELETE FROM videos"),
  ]);
});
