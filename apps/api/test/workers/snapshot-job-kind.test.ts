import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedVideo } from "./seed";

/**
 * Migration 0008 (M15.1, issue #116): `jobs.kind` widens to admit 'snapshot',
 * and `jobs.video_id` becomes nullable — exactly for that kind.
 *
 * Schema-only coverage, `prelabel-job-kind.test.ts`'s own idiom: talking to
 * `env.DB` directly rather than through `app.request`, because what is under
 * test is the rebuilt table's constraints, not an endpoint.
 *
 * The migration's own header explains why this could not be a one-line
 * ALTER, and why the rebuild had to move *two* children — `chunks` and
 * `dryruns` — ahead of the drop this time, not one: D1 does not honour
 * `PRAGMA foreign_keys=OFF`, so dropping the old `jobs` while either still
 * pointed at it would have cascade-deleted every row in both. That ordering
 * is what `keeps chunks and dryruns intact through the rebuild` below is
 * really pinned against.
 */

describe("migration 0008: jobs.kind admits 'snapshot', video_id becomes nullable", () => {
  it("inserts a snapshot job with a null video_id", async () => {
    const row = await env.DB.prepare(
      "INSERT INTO jobs (kind, video_id) VALUES ('snapshot', NULL) RETURNING id, kind, video_id, status",
    ).first();

    expect(row).toEqual({
      id: expect.any(Number),
      kind: "snapshot",
      video_id: null,
      status: "pending",
    });
  });

  it("still rejects a kind outside download/chunk/prelabel/dryrun/snapshot", async () => {
    await seedVideo("aaaaaaaaaaa");

    await expect(
      env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('transcribe', ?)")
        .bind("aaaaaaaaaaa")
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("refuses a snapshot job with a non-null video_id", async () => {
    await seedVideo("bbbbbbbbbbb");

    await expect(
      env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('snapshot', ?)")
        .bind("bbbbbbbbbbb")
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("refuses a download job with a null video_id — the CHECK ties both directions", async () => {
    await expect(
      env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('download', NULL)").run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("allows more than one snapshot job — nothing here is one-per-anything, unlike download and prelabel", async () => {
    await env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('snapshot', NULL)").run();
    await env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('snapshot', NULL)").run();

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE kind = 'snapshot'",
    ).first<{
      n: number;
    }>();
    expect(count?.n).toBe(2);
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

  it("keeps chunks intact through the rebuild, still cascading on delete and still unique per (video, segment)", async () => {
    await seedVideo("ddddddddddd");

    const job = await env.DB.prepare(
      "INSERT INTO jobs (kind, video_id) VALUES ('chunk', ?) RETURNING id",
    )
      .bind("ddddddddddd")
      .first<{ id: number }>();
    if (!job) throw new Error("job insert returned nothing");

    await env.DB.prepare(
      `INSERT INTO chunks (job_id, video_id, segment_index, start_seconds, end_seconds)
            VALUES (?, ?, 0, 0, 60)`,
    )
      .bind(job.id, "ddddddddddd")
      .run();

    await env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(job.id).run();
    const remaining = await env.DB.prepare("SELECT COUNT(*) AS n FROM chunks WHERE job_id = ?")
      .bind(job.id)
      .first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });

  it("keeps dryruns intact through the rebuild, still cascading on delete", async () => {
    await seedVideo("eeeeeeeeeee");
    const klass = await env.DB.prepare(
      `INSERT INTO classes (name, appearance_prompt, prompt_version, active)
            VALUES ('Paimon', 'a small floating companion', '2026-08-08-a', 0) RETURNING id`,
    ).first<{ id: number }>();
    if (!klass) throw new Error("class insert returned nothing");

    const job = await env.DB.prepare(
      "INSERT INTO jobs (kind, video_id) VALUES ('dryrun', ?) RETURNING id",
    )
      .bind("eeeeeeeeeee")
      .first<{ id: number }>();
    if (!job) throw new Error("job insert returned nothing");

    await env.DB.prepare(
      `INSERT INTO dryruns (job_id, class_id, appearance_prompt, sample_size, requested_by)
            VALUES (?, ?, 'a candidate wording', 50, 'admin@example.com')`,
    )
      .bind(job.id, klass.id)
      .run();

    await env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(job.id).run();
    const remaining = await env.DB.prepare("SELECT COUNT(*) AS n FROM dryruns WHERE job_id = ?")
      .bind(job.id)
      .first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });
});
