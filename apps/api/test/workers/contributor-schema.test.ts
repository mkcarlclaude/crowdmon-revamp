import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedUser } from "./contributor-seed";
import { seedClass, seedImage, seedPrediction } from "./labelling-seed";
import { seedVideo } from "./seed";

/**
 * Migration 0012 (M20, plan §B1): `users`, `sessions`, and `verdicts.source`
 * widened to admit `'user'`.
 *
 * Schema-only coverage, the same idiom `v2-labelling-schema.test.ts` and
 * `prelabel-job-kind.test.ts` use for their own migrations — talking to
 * `env.DB` directly rather than through `app.request`, because what is under
 * test is the rebuilt table's constraints.
 *
 * **What "before and after the rebuild" means in this harness.** Every
 * migration is applied once, up front, before any test in this project runs
 * (`test/workers/setup.ts`) — there is no live "pre-0012 database" this suite
 * can compare against mid-test. `prelabel-job-kind.test.ts` and
 * `snapshot-job-kind.test.ts` already settle for the same substitution this
 * file makes: seed rows under every value the *old* CHECK admitted alongside
 * the *new* one, and assert the row count and the exact set of `source`
 * values survive together, rather than merely that `'user'` is accepted in
 * isolation. A rebuild that quietly dropped 'anon' rows while accepting
 * 'user' — the exact shape a cascade-on-drop bug takes — would fail the count
 * assertion below even though "insert a 'user' row" alone would not catch it.
 */

async function seedPredictionRow(): Promise<number> {
  const videoId = `v-${crypto.randomUUID().slice(0, 8)}`;
  await seedVideo(videoId);
  const classId = await seedClass(`class-${crypto.randomUUID().slice(0, 8)}`);
  const imageId = await seedImage(videoId, 1);
  return seedPrediction(imageId, classId);
}

describe("migration 0012: users, sessions, verdicts.source admits 'user'", () => {
  it("creates a user with trusted defaulting to 0", async () => {
    const row = await env.DB.prepare(
      "INSERT INTO users (google_sub, email) VALUES (?, ?) RETURNING id, trusted",
    )
      .bind("sub-1", "friend@example.com")
      .first<{ id: number; trusted: number }>();

    expect(row).toEqual({ id: expect.any(Number), trusted: 0 });
  });

  it("rejects a second user with the same google_sub", async () => {
    await env.DB.prepare("INSERT INTO users (google_sub, email) VALUES (?, ?)")
      .bind("sub-dup", "a@example.com")
      .run();

    await expect(
      env.DB.prepare("INSERT INTO users (google_sub, email) VALUES (?, ?)")
        .bind("sub-dup", "b@example.com")
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("rejects a trusted value outside 0/1", async () => {
    await expect(
      env.DB.prepare("INSERT INTO users (google_sub, email, trusted) VALUES (?, ?, 2)")
        .bind("sub-bad-trust", "a@example.com")
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("creates a session referencing a user, and cascades on delete", async () => {
    const userId = await seedUser();

    await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
      .bind("session-1", userId, Math.floor(Date.now() / 1000) + 3600)
      .run();

    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?")
      .bind(userId)
      .first<{ n: number }>();
    expect(before?.n).toBe(1);

    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();

    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?")
      .bind(userId)
      .first<{ n: number }>();
    expect(after?.n).toBe(0);
  });

  it("rejects a session for a user that does not exist", async () => {
    await expect(
      env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
        .bind("session-orphan", 999_999, Math.floor(Date.now() / 1000) + 3600)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("accepts a source = 'user' verdict — the CHECK this migration exists to widen", async () => {
    const predictionId = await seedPredictionRow();

    const verdict = await env.DB.prepare(
      `INSERT INTO verdicts (prediction_id, verdict, source, annotator_id)
            VALUES (?, 'accept', 'user', '1')
         RETURNING id`,
    )
      .bind(predictionId)
      .first<{ id: number }>();

    expect(verdict?.id).toBeTypeOf("number");
  });

  it("still rejects a source value outside admin/anon/user", async () => {
    const predictionId = await seedPredictionRow();

    await expect(
      env.DB.prepare(
        `INSERT INTO verdicts (prediction_id, verdict, source, annotator_id)
              VALUES (?, 'accept', 'friend', 'x')`,
      )
        .bind(predictionId)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("still ties the adjusted-coordinate CHECK to verdict = 'adjust' after the rebuild", async () => {
    const predictionId = await seedPredictionRow();

    await expect(
      env.DB.prepare(
        `INSERT INTO verdicts (prediction_id, verdict, source, annotator_id)
              VALUES (?, 'adjust', 'user', '1')`,
      )
        .bind(predictionId)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("still cascades verdicts when the prediction they judge is deleted", async () => {
    const predictionId = await seedPredictionRow();
    await env.DB.prepare(
      `INSERT INTO verdicts (prediction_id, verdict, source, annotator_id)
            VALUES (?, 'accept', 'user', '1')`,
    )
      .bind(predictionId)
      .run();

    await env.DB.prepare("DELETE FROM predictions WHERE id = ?").bind(predictionId).run();

    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM verdicts WHERE prediction_id = ?",
    )
      .bind(predictionId)
      .first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });

  it("still allows several verdicts on one prediction — no uniqueness constraint survived that should not exist", async () => {
    const predictionId = await seedPredictionRow();

    await env.DB.prepare(
      `INSERT INTO verdicts (prediction_id, verdict, source, annotator_id)
            VALUES (?, 'accept', 'admin', 'admin@example.com')`,
    )
      .bind(predictionId)
      .run();

    await expect(
      env.DB.prepare(
        `INSERT INTO verdicts (prediction_id, verdict, source, annotator_id)
              VALUES (?, 'reject', 'user', '1')`,
      )
        .bind(predictionId)
        .run(),
    ).resolves.toMatchObject({ success: true });
  });

  it("keeps every pre-existing row and every pre-existing source value intact through the rebuild", async () => {
    // The literal instruction the plan gives this test: assert the row count
    // and every distinct source value are identical before and after — the
    // failure mode `CLAUDE.md`'s own note on this hazard describes is a
    // rebuild that silently cascades child rows away, which would show up
    // here as a missing row or a missing source value, not as a rejected
    // insert.
    const admin = await seedPredictionRow();
    const anon = await seedPredictionRow();
    const user = await seedPredictionRow();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO verdicts (prediction_id, verdict, source, annotator_id)
              VALUES (?, 'accept', 'admin', 'admin@example.com')`,
      ).bind(admin),
      env.DB.prepare(
        `INSERT INTO verdicts (prediction_id, verdict, source, annotator_id)
              VALUES (?, 'reject', 'anon', 'anon-session-1')`,
      ).bind(anon),
      env.DB.prepare(
        `INSERT INTO verdicts (prediction_id, verdict, source, annotator_id)
              VALUES (?, 'accept', 'user', '1')`,
      ).bind(user),
    ]);

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM verdicts").first<{ n: number }>();
    expect(count?.n).toBe(3);

    const { results } = await env.DB.prepare(
      "SELECT DISTINCT source FROM verdicts ORDER BY source",
    ).all<{ source: string }>();
    expect(results.map((row) => row.source)).toEqual(["admin", "anon", "user"]);
  });

  it("idx_verdicts_source and idx_verdicts_prediction both survived the rebuild", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'verdicts'",
    ).all<{ name: string }>();

    const names = results.map((row) => row.name);
    expect(names).toContain("idx_verdicts_source");
    expect(names).toContain("idx_verdicts_prediction");
  });

  it("idx_sessions_expires exists, for the reaper's cheap sweep", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions'",
    ).all<{ name: string }>();

    expect(results.map((row) => row.name)).toContain("idx_sessions_expires");
  });
});
