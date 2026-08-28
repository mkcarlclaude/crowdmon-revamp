import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { SEGMENT_SECONDS } from "../../src/schemas";
import { seedVideo } from "./seed";

/**
 * Image reporting (M8.4): a chunk worker's write on its lease, recording the
 * frames it extracted, deduplicated and uploaded, and stamping the threshold
 * and config version that produced them.
 *
 * The provenance assertion below is the point of the milestone: every row
 * `reportImages` writes must carry the `dedup_threshold` the request named,
 * because nothing else in the schema records which regime produced a given
 * row once the threshold changes for a later run.
 */

/** A chunk job already held by `workerId`, with its `chunks` row in place. */
async function seedHeldChunkJob(
  videoId: string,
  segment: { start: number; end: number } = { start: 0, end: 60 },
  workerId = "w1",
): Promise<number> {
  await seedVideo(videoId);
  const at = Math.floor(Date.now() / 1000);

  const row = await env.DB.prepare(
    `INSERT INTO jobs (kind, video_id, status, attempts, claimed_by, claimed_at, heartbeat_at)
          VALUES ('chunk', ?, 'claimed', 1, ?, ?, ?)
       RETURNING id`,
  )
    .bind(videoId, workerId, at, at)
    .first<{ id: number }>();
  if (!row) throw new Error("seedHeldChunkJob inserted nothing");

  await env.DB.prepare(
    `INSERT INTO chunks (job_id, video_id, segment_index, start_seconds, end_seconds)
          VALUES (?, ?, 0, ?, ?)`,
  )
    .bind(row.id, videoId, segment.start, segment.end)
    .run();

  return row.id;
}

function reportImages(jobId: number, body: Record<string, unknown>) {
  return app.request(
    `/api/jobs/${jobId}/images`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

const image = (overrides: Record<string, unknown> = {}) => ({
  r2_key: "aaaaaaaaaaa/0000000.jpg",
  timestamp_seconds: 1,
  phash: "af3c9e1b2d4f7a80",
  ...overrides,
});

const reported = (overrides: Record<string, unknown> = {}) => ({
  worker_id: "w1",
  frames_extracted: 2,
  frames_kept: 1,
  dedup_threshold: 8,
  config_version: "2026-08-01-a",
  images: [image()],
  ...overrides,
});

function imageRows(videoId: string) {
  return env.DB.prepare(
    "SELECT r2_key, timestamp_seconds, phash, dedup_threshold FROM images WHERE video_id = ? ORDER BY timestamp_seconds",
  )
    .bind(videoId)
    .all<{ r2_key: string; timestamp_seconds: number; phash: string; dedup_threshold: number }>();
}

describe("POST /api/jobs/{id}/images", () => {
  it("writes the rows, updates chunks counts, and stamps jobs.config_version", async () => {
    const jobId = await seedHeldChunkJob("aaaaaaaaaaa");

    const res = await reportImages(
      jobId,
      reported({
        frames_extracted: 3,
        frames_kept: 2,
        images: [
          image({ r2_key: "aaaaaaaaaaa/0000001.jpg", timestamp_seconds: 1 }),
          image({ r2_key: "aaaaaaaaaaa/0000002.jpg", timestamp_seconds: 2 }),
        ],
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ video_id: "aaaaaaaaaaa", images: 2 });

    const { results } = await imageRows("aaaaaaaaaaa");
    expect(results).toEqual([
      {
        r2_key: "aaaaaaaaaaa/0000001.jpg",
        timestamp_seconds: 1,
        phash: "af3c9e1b2d4f7a80",
        dedup_threshold: 8,
      },
      {
        r2_key: "aaaaaaaaaaa/0000002.jpg",
        timestamp_seconds: 2,
        phash: "af3c9e1b2d4f7a80",
        dedup_threshold: 8,
      },
    ]);

    const chunk = await env.DB.prepare(
      "SELECT frames_extracted, frames_kept FROM chunks WHERE job_id = ?",
    )
      .bind(jobId)
      .first();
    expect(chunk).toEqual({ frames_extracted: 3, frames_kept: 2 });

    const job = await env.DB.prepare("SELECT config_version FROM jobs WHERE id = ?")
      .bind(jobId)
      .first();
    expect(job).toEqual({ config_version: "2026-08-01-a" });
  });

  it("stamps every written row with the threshold in force for this run", async () => {
    const jobId = await seedHeldChunkJob("bbbbbbbbbbb");

    await reportImages(jobId, reported({ dedup_threshold: 42, images: [image()] }));

    const { results } = await imageRows("bbbbbbbbbbb");
    for (const row of results) {
      expect(row.dedup_threshold).toBe(42);
    }
  });

  it("is idempotent — re-running the same report does not inflate the dataset", async () => {
    const jobId = await seedHeldChunkJob("ccccccccccc");
    const body = reported();

    await reportImages(jobId, body);
    const again = await reportImages(jobId, body);

    expect(again.status).toBe(200);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM images WHERE video_id = ?")
      .bind("ccccccccccc")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("updates the existing row rather than duplicating it when the threshold changes", async () => {
    const jobId = await seedHeldChunkJob("ddddddddddd");

    await reportImages(jobId, reported({ dedup_threshold: 8 }));
    await reportImages(jobId, reported({ dedup_threshold: 16 }));

    const { results } = await imageRows("ddddddddddd");
    expect(results).toHaveLength(1);
    expect(results[0]?.dedup_threshold).toBe(16);
  });

  /**
   * M25.1's own worst-case hazard (plan §A2): `shuffle_key > ?` is NULL, not
   * true, for a NULL key, so a row that never got one silently leaves the
   * labelling queue forever with nothing failing. This is the one of the
   * plan's three named defences that lives on the write path rather than in
   * the migration's own backfill.
   */
  it("stamps every written row with a non-NULL shuffle_key", async () => {
    const jobId = await seedHeldChunkJob("lllllllllll");

    await reportImages(
      jobId,
      reported({
        frames_extracted: 2,
        frames_kept: 2,
        images: [
          image({ r2_key: "lllllllllll/0000001.jpg", timestamp_seconds: 1 }),
          image({ r2_key: "lllllllllll/0000002.jpg", timestamp_seconds: 2 }),
        ],
      }),
    );

    const { results } = await env.DB.prepare("SELECT shuffle_key FROM images WHERE video_id = ?")
      .bind("lllllllllll")
      .all<{ shuffle_key: number | null }>();

    expect(results).toHaveLength(2);
    for (const row of results) {
      expect(row.shuffle_key).not.toBeNull();
      // Masked to the low 53 bits (`d1.ts`'s `SHUFFLE_KEY_MASK`), so every
      // value is representable as an exact JS `number` — never negative,
      // never past `Number.MAX_SAFE_INTEGER`.
      expect(row.shuffle_key).toBeGreaterThanOrEqual(0);
      expect(row.shuffle_key).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    }
  });

  it("never regenerates shuffle_key on a re-run", async () => {
    // A reaped chunk re-reports the same frames (CONTEXT.md §Q14) — this must
    // not reshuffle an already-served frame's position, which is the
    // "ordering isn't stable across a session" bug the keyset cursor exists
    // to avoid.
    const jobId = await seedHeldChunkJob("mmmmmmmmmmm");
    const body = reported();

    await reportImages(jobId, body);
    const before = await env.DB.prepare("SELECT shuffle_key FROM images WHERE video_id = ?")
      .bind("mmmmmmmmmmm")
      .first<{ shuffle_key: number }>();

    await reportImages(jobId, reported({ dedup_threshold: 99 }));
    const after = await env.DB.prepare("SELECT shuffle_key FROM images WHERE video_id = ?")
      .bind("mmmmmmmmmmm")
      .first<{ shuffle_key: number }>();

    expect(after?.shuffle_key).toBe(before?.shuffle_key);
  });

  it("rejects a worker that does not hold the lease, and writes nothing", async () => {
    const jobId = await seedHeldChunkJob("eeeeeeeeeee", undefined, "somebody-else");

    const res = await reportImages(jobId, reported({ worker_id: "w1" }));

    expect(res.status).toBe(404);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM images WHERE video_id = ?")
      .bind("eeeeeeeeeee")
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("rejects a report against a download job", async () => {
    await seedVideo("fffffffffff");
    const at = Math.floor(Date.now() / 1000);
    const row = await env.DB.prepare(
      `INSERT INTO jobs (kind, video_id, status, claimed_by, claimed_at, heartbeat_at)
            VALUES ('download', ?, 'claimed', 'w1', ?, ?)
         RETURNING id`,
    )
      .bind("fffffffffff", at, at)
      .first<{ id: number }>();

    const res = await reportImages(row?.id ?? 0, reported());

    expect(res.status).toBe(400);
  });

  it("rejects frames_kept disagreeing with images.length", async () => {
    const jobId = await seedHeldChunkJob("ggggggggggg");

    const res = await reportImages(jobId, reported({ frames_kept: 5, images: [image()] }));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/frames_kept/);

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM images WHERE video_id = ?")
      .bind("ggggggggggg")
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("rejects a malformed phash", async () => {
    const jobId = await seedHeldChunkJob("hhhhhhhhhhh");

    const res = await reportImages(jobId, reported({ images: [image({ phash: "not-a-hash" })] }));

    expect(res.status).toBe(400);
  });

  it("rejects an images array past the per-chunk bound, naming the limit", async () => {
    const jobId = await seedHeldChunkJob("iiiiiiiiiii");
    const tooMany = Array.from({ length: SEGMENT_SECONDS * 2 + 1 }, (_, i) =>
      image({ r2_key: `iiiiiiiiiii/${i}.jpg`, timestamp_seconds: i }),
    );

    const res = await reportImages(
      jobId,
      reported({ frames_kept: tooMany.length, images: tooMany }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues?: { path: string }[] };
    expect(body.issues?.map((i) => i.path)).toEqual(["images"]);
  });

  it("rejects a timestamp outside the chunk's window", async () => {
    const jobId = await seedHeldChunkJob("jjjjjjjjjjj", { start: 0, end: 60 });

    const res = await reportImages(jobId, reported({ images: [image({ timestamp_seconds: 90 })] }));

    expect(res.status).toBe(400);
  });
});
