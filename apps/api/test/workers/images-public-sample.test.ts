import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedVideo } from "./seed";

/**
 * Migration 0004 (M10.2, issue #99): `images` gains `public_sample` and
 * `selection_reason`.
 *
 * Neither column has a writer yet — `public_sample` is set from `/admin`
 * (M14.1) and `selection_reason` is written at selection time (M11) — so
 * there is no endpoint to exercise here. What this pins down is the schema
 * contract everything downstream relies on: a v1-era insert that names
 * neither column must still succeed and read back null (the "2,685 rows
 * stay valid" claim from ROADMAP M10.2), and both columns must round-trip
 * once something does set them.
 */

async function insertImage(videoId: string, overrides: Record<string, unknown> = {}) {
  await seedVideo(videoId);

  const columns = ["r2_key", "video_id", "timestamp_seconds", "phash", "dedup_threshold"];
  const values: Record<string, unknown> = {
    r2_key: `${videoId}/0000000.jpg`,
    video_id: videoId,
    timestamp_seconds: 1,
    phash: "af3c9e1b2d4f7a80",
    dedup_threshold: 8,
    ...overrides,
  };
  for (const key of Object.keys(overrides)) {
    if (!columns.includes(key)) columns.push(key);
  }

  const placeholders = columns.map(() => "?").join(", ");
  await env.DB.prepare(`INSERT INTO images (${columns.join(", ")}) VALUES (${placeholders})`)
    .bind(...columns.map((c) => values[c]))
    .run();
}

function imageRow(videoId: string) {
  return env.DB.prepare("SELECT public_sample, selection_reason FROM images WHERE video_id = ?")
    .bind(videoId)
    .first<{ public_sample: number | null; selection_reason: string | null }>();
}

describe("images.public_sample / images.selection_reason (migration 0004)", () => {
  it("lets an insert that names neither column succeed and read back null", async () => {
    await insertImage("aaaaaaaaaaa");

    const row = await imageRow("aaaaaaaaaaa");
    expect(row).toEqual({ public_sample: null, selection_reason: null });
  });

  it("round-trips public_sample once an admin sets it", async () => {
    await insertImage("bbbbbbbbbbb", { public_sample: 1 });

    const row = await imageRow("bbbbbbbbbbb");
    expect(row?.public_sample).toBe(1);
  });

  it("round-trips selection_reason once it is written at selection time", async () => {
    await insertImage("ccccccccccc", { selection_reason: "random" });

    const row = await imageRow("ccccccccccc");
    expect(row?.selection_reason).toBe("random");
  });

  it("rejects a public_sample value outside 0/1", async () => {
    await seedVideo("ddddddddddd");

    await expect(
      env.DB.prepare(
        `INSERT INTO images (r2_key, video_id, timestamp_seconds, phash, dedup_threshold, public_sample)
              VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind("ddddddddddd/0000000.jpg", "ddddddddddd", 1, "af3c9e1b2d4f7a80", 8, 2)
        .run(),
    ).rejects.toThrow();
  });
});
