import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedVideo } from "./seed";

/**
 * Migration 0005 (M11.1, issue #101): `jobs.kind` widens to admit 'prelabel'.
 *
 * This is schema-only coverage, the same idiom `v2-labelling-schema.test.ts`
 * uses for migration 0003 — talking to `env.DB` directly rather than through
 * `app.request`, because what is under test is the rebuilt table's
 * constraints, not an endpoint. `completeJobHandler`'s own enqueue-on-last-
 * chunk logic has its coverage where that handler lives.
 *
 * The migration's own comment explains why this could not be a one-line
 * ALTER: D1 does not honour `PRAGMA foreign_keys=OFF`, so the rebuild had to
 * drop `chunks` (the one table with a cascading foreign key into `jobs`)
 * before dropping the old `jobs`, rather than disabling enforcement around
 * the drop the way the textbook recipe does. That ordering is what these
 * tests are really pinned against: get it wrong and the symptom is not a
 * migration error, it is `chunks` quietly losing every row it had — which
 * `idx_chunks_identity` surviving, below, is the check for.
 */

describe("migration 0005: jobs.kind admits 'prelabel'", () => {
  it("inserts a prelabel job", async () => {
    await seedVideo("aaaaaaaaaaa");

    const row = await env.DB.prepare(
      "INSERT INTO jobs (kind, video_id) VALUES ('prelabel', ?) RETURNING id, kind, status",
    )
      .bind("aaaaaaaaaaa")
      .first();

    expect(row).toEqual({ id: expect.any(Number), kind: "prelabel", status: "pending" });
  });

  it("still rejects a kind outside download/chunk/prelabel", async () => {
    await seedVideo("bbbbbbbbbbb");

    await expect(
      env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('transcribe', ?)")
        .bind("bbbbbbbbbbb")
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE video_id = ?")
      .bind("bbbbbbbbbbb")
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("still collides a second download job for the same video — idx_jobs_one_download_per_video survived the rebuild", async () => {
    await seedVideo("ccccccccccc");

    await env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('download', ?)")
      .bind("ccccccccccc")
      .run();

    await expect(
      env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('download', ?)")
        .bind("ccccccccccc")
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  // Migration 0005 added `idx_jobs_one_prelabel_per_video` here, and this
  // test once pinned the collision it enforced — reproduced verbatim in
  // migration 0011's own commit history. M17 (plan §B) is the reason it no
  // longer applies: an admin queuing a supplementary prelabel pass over a
  // video that already has one is the *feature*, not a bug the schema should
  // still be preventing, so migration 0011 drops that index outright (see
  // its own comment for why the auto-enqueue's exactly-once guarantee does
  // not depend on it). This test now pins the opposite: a second prelabel
  // job for the same video is an ordinary insert, not a constraint failure.
  it("allows a second prelabel job for the same video — idx_jobs_one_prelabel_per_video was dropped in migration 0011", async () => {
    await seedVideo("ddddddddddd");

    await env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('prelabel', ?)")
      .bind("ddddddddddd")
      .run();

    await expect(
      env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('prelabel', ?)")
        .bind("ddddddddddd")
        .run(),
    ).resolves.toMatchObject({ success: true });

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE video_id = ? AND kind = 'prelabel'",
    )
      .bind("ddddddddddd")
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it("keeps chunks intact through the rebuild, still cascading on delete and still unique per (video, segment)", async () => {
    await seedVideo("eeeeeeeeeee");

    const job = await env.DB.prepare(
      "INSERT INTO jobs (kind, video_id) VALUES ('chunk', ?) RETURNING id",
    )
      .bind("eeeeeeeeeee")
      .first<{ id: number }>();
    if (!job) throw new Error("job insert returned nothing");

    await env.DB.prepare(
      `INSERT INTO chunks (job_id, video_id, segment_index, start_seconds, end_seconds)
            VALUES (?, ?, 0, 0, 60)`,
    )
      .bind(job.id, "eeeeeeeeeee")
      .run();

    // idx_chunks_identity: a second chunk row at the same (video, segment)
    // still collides.
    await expect(
      env.DB.prepare(
        `INSERT INTO chunks (job_id, video_id, segment_index, start_seconds, end_seconds)
              SELECT id, ?, 0, 0, 60 FROM jobs WHERE video_id = ? AND kind = 'chunk'`,
      )
        .bind("eeeeeeeeeee", "eeeeeeeeeee")
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);

    // job_id NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE: deleting
    // the job still takes its chunk row with it — the exact behaviour a
    // rebuild that lost the foreign key, or lost CASCADE specifically, would
    // silently fail to reproduce.
    await env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(job.id).run();
    const remaining = await env.DB.prepare("SELECT COUNT(*) AS n FROM chunks WHERE job_id = ?")
      .bind(job.id)
      .first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });
});
