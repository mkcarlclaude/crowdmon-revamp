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
 * and `classes`. Migration 0011 (M17, plan §B) added `prelabel_images`,
 * whose two foreign keys both carry `ON DELETE CASCADE` — unlike
 * `dryruns.image_id`, deleting `jobs` or `images` while a `prelabel_images`
 * row still pointed at either would not fail here, it would just quietly
 * take the row with it. Deleted explicitly anyway, before both of its
 * parents, rather than left to that cascade: a `beforeEach` that depends on
 * *which* cascade direction happens to be declared on a table is a `beforeEach`
 * that breaks the day somebody changes the schema for an unrelated reason,
 * the same argument that already applies to every other table listed here.
 *
 * The v2 tables are listed here rather than left to whichever file first
 * touches them. `classes.name` is UNIQUE, so the second test in a file to
 * seed the same class fails a constraint it never meant to exercise — the
 * same trap this hook already exists to close for one download job per
 * video. A per-file `beforeEach` would work only for the file that
 * remembered to write one.
 *
 * `sessions` before `users`: migration 0012's `sessions.user_id ...
 * ON DELETE CASCADE` would take a leftover session with it either way, but
 * this hook does not lean on that any more than it leans on any other
 * table's cascade — see the `prelabel_images` paragraph above for why.
 * `users.google_sub` is UNIQUE, the same trap `classes.name` sets for a test
 * that seeds the same account twice across two tests in one file.
 */
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM missing_reports"),
    env.DB.prepare("DELETE FROM verdicts"),
    env.DB.prepare("DELETE FROM predictions"),
    // Before `images`, and before `jobs` and `classes` for `dryruns.job_id`'s
    // and `dryruns.class_id`'s own reasons below — migration 0010 (M17, plan
    // §A) added `dryruns.image_id REFERENCES images(id)` with no `ON DELETE
    // CASCADE`. That reference is real, not advisory: migration 0005's own
    // finding is that D1 enforces foreign keys unconditionally, with no
    // pragma that turns it off, so `DELETE FROM images` while a `dryruns` row
    // still pointed at one would fail a constraint no test here meant to
    // exercise.
    env.DB.prepare("DELETE FROM dryruns"),
    env.DB.prepare("DELETE FROM prelabel_images"),
    env.DB.prepare("DELETE FROM images"),
    env.DB.prepare("DELETE FROM chunks"),
    env.DB.prepare("DELETE FROM jobs"),
    env.DB.prepare("DELETE FROM videos"),
    env.DB.prepare("DELETE FROM classes"),
    env.DB.prepare("DELETE FROM snapshots"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM users"),
  ]);
});
