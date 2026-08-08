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
 * `videos`, and migration 0003's labelling tables carry them into `images`
 * and `classes`.
 *
 * The v2 tables are listed here rather than left to whichever file first
 * touches them. `classes.name` is UNIQUE, so the second test in a file to
 * seed the same class fails a constraint it never meant to exercise — the
 * same trap this hook already exists to close for one download job per
 * video. A per-file `beforeEach` would work only for the file that
 * remembered to write one.
 */
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM missing_reports"),
    env.DB.prepare("DELETE FROM verdicts"),
    env.DB.prepare("DELETE FROM predictions"),
    env.DB.prepare("DELETE FROM images"),
    env.DB.prepare("DELETE FROM chunks"),
    // Before `jobs` and `classes`, both of which it references (migration
    // 0007). Its `job_id` cascade would handle the first on its own; the
    // second would not.
    env.DB.prepare("DELETE FROM dryruns"),
    env.DB.prepare("DELETE FROM jobs"),
    env.DB.prepare("DELETE FROM videos"),
    env.DB.prepare("DELETE FROM classes"),
    env.DB.prepare("DELETE FROM snapshots"),
  ]);
});
