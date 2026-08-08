import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { MAX_PREDICTIONS_PER_JOB } from "../../src/schemas";
import { seedVideo } from "./seed";

/**
 * Prediction reporting (M10.3): the endpoint a prelabel worker posts its
 * detector's boxes to, in the shape `/api/jobs/{id}/images` established for
 * chunk workers — one call per job, not one per box.
 *
 * `predictions` has no submit endpoint of its own to seed through — nothing
 * enqueues a `prelabel` job on its own timeline the way `submitVideo` does
 * for a download — so every test here writes a claimed `prelabel` job by
 * hand, the same way `seed.ts`'s `seedClaimedJob` stands in for a claim
 * nothing here calls.
 */

/** A prelabel job already held by `workerId`, needing no `chunks` row (unlike `reportImages`'s target). */
async function seedHeldJob(videoId: string, workerId = "w1"): Promise<number> {
  await seedVideo(videoId);
  const at = Math.floor(Date.now() / 1000);

  const row = await env.DB.prepare(
    `INSERT INTO jobs (kind, video_id, status, attempts, claimed_by, claimed_at, heartbeat_at)
          VALUES ('prelabel', ?, 'claimed', 1, ?, ?, ?)
       RETURNING id`,
  )
    .bind(videoId, workerId, at, at)
    .first<{ id: number }>();
  if (!row) throw new Error("seedHeldJob inserted nothing");

  return row.id;
}

/**
 * `timestamp_seconds` defaults to 1 and only needs overriding when a test
 * seeds more than one image for the same video — `idx_images_identity`
 * (migration 0001) is unique on `(video_id, timestamp_seconds)`, not on
 * `r2_key` alone.
 */
async function seedImage(videoId: string, r2Key: string, timestampSeconds = 1): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO images (r2_key, video_id, timestamp_seconds, phash, dedup_threshold)
          VALUES (?, ?, ?, 'af3c9e1b2d4f7a80', 8)`,
  )
    .bind(r2Key, videoId, timestampSeconds)
    .run();
}

async function seedClass(name: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO classes (name, appearance_prompt, prompt_version)
          VALUES (?, 'a small white-haired flying companion with pointed ears', '2026-08-08-a')`,
  )
    .bind(name)
    .run();
}

function reportPredictions(jobId: number, body: Record<string, unknown>) {
  return app.request(
    `/api/jobs/${jobId}/predictions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

const box = (overrides: Record<string, unknown> = {}) => ({
  r2_key: "aaaaaaaaaaa/0000000.jpg",
  class_name: "Paimon",
  x_min: 0.1,
  y_min: 0.2,
  x_max: 0.5,
  y_max: 0.6,
  confidence: 0.87,
  prompt_version: "2026-08-08-a",
  ...overrides,
});

const reported = (overrides: Record<string, unknown> = {}) => ({
  worker_id: "w1",
  model_id: "owlvit-base-patch32.onnx",
  predictions: [box()],
  ...overrides,
});

function predictionRows(videoId: string) {
  return env.DB.prepare(
    `SELECT p.x_min, p.y_min, p.x_max, p.y_max, p.confidence, p.prompt_version, p.model_id,
            i.r2_key AS r2_key, c.name AS class_name
       FROM predictions p
       JOIN images i ON i.id = p.image_id
       JOIN classes c ON c.id = p.class_id
      WHERE i.video_id = ?
      ORDER BY p.id`,
  )
    .bind(videoId)
    .all();
}

describe("POST /api/jobs/{id}/predictions", () => {
  it("writes N predictions in one call, resolving r2_key and class_name to their ids", async () => {
    const jobId = await seedHeldJob("aaaaaaaaaaa");
    await seedImage("aaaaaaaaaaa", "aaaaaaaaaaa/0000000.jpg", 1);
    await seedImage("aaaaaaaaaaa", "aaaaaaaaaaa/0000001.jpg", 2);
    await seedClass("Paimon");
    await seedClass("Klee");

    const res = await reportPredictions(
      jobId,
      reported({
        predictions: [
          box({ r2_key: "aaaaaaaaaaa/0000000.jpg", class_name: "Paimon" }),
          box({ r2_key: "aaaaaaaaaaa/0000001.jpg", class_name: "Klee", confidence: 0.42 }),
        ],
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ video_id: "aaaaaaaaaaa", predictions: 2 });

    const { results } = await predictionRows("aaaaaaaaaaa");
    expect(results).toEqual([
      {
        r2_key: "aaaaaaaaaaa/0000000.jpg",
        class_name: "Paimon",
        x_min: 0.1,
        y_min: 0.2,
        x_max: 0.5,
        y_max: 0.6,
        confidence: 0.87,
        prompt_version: "2026-08-08-a",
        model_id: "owlvit-base-patch32.onnx",
      },
      {
        r2_key: "aaaaaaaaaaa/0000001.jpg",
        class_name: "Klee",
        x_min: 0.1,
        y_min: 0.2,
        x_max: 0.5,
        y_max: 0.6,
        confidence: 0.42,
        prompt_version: "2026-08-08-a",
        model_id: "owlvit-base-patch32.onnx",
      },
    ]);
  });

  it("resolves a report naming more distinct r2_keys than one query may bind", async () => {
    // D1 rejects a query carrying more than 100 bound parameters, so the
    // handler chunks its `IN (...)` lookups. 150 distinct keys is past that
    // boundary and well inside M11.3's 200-image sample, which is the size a
    // real prelabel report will be — every earlier test here names two or
    // three keys and so exercises exactly one chunk.
    //
    // Local D1 is SQLite and does not enforce the parameter cap, so what this
    // pins down is that the chunked results are reassembled correctly: a key
    // in the second chunk must still resolve, and none may go missing at the
    // seam.
    const jobId = await seedHeldJob("eeeeeeeeeee");
    await seedClass("Paimon");

    const keys = Array.from(
      { length: 150 },
      (_, i) => `eeeeeeeeeee/${String(i).padStart(7, "0")}.jpg`,
    );
    for (const [i, key] of keys.entries()) await seedImage("eeeeeeeeeee", key, i + 1);

    const res = await reportPredictions(
      jobId,
      reported({ predictions: keys.map((r2_key) => box({ r2_key })) }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ video_id: "eeeeeeeeeee", predictions: 150 });

    const { results } = await predictionRows("eeeeeeeeeee");
    expect(results).toHaveLength(150);
    expect(results.map((row) => (row as { r2_key: string }).r2_key)).toEqual(keys);
  });

  it("accepts an empty report without writing anything", async () => {
    const jobId = await seedHeldJob("bbbbbbbbbbb");

    const res = await reportPredictions(jobId, reported({ predictions: [] }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ video_id: "bbbbbbbbbbb", predictions: 0 });
  });

  it("rejects a worker that does not hold the lease, and writes nothing", async () => {
    const jobId = await seedHeldJob("ccccccccccc", "somebody-else");
    await seedImage("ccccccccccc", "aaaaaaaaaaa/0000000.jpg");
    await seedClass("Paimon");

    const res = await reportPredictions(jobId, reported({ worker_id: "w1" }));

    expect(res.status).toBe(404);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM predictions").first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });

  it("rejects reporting predictions against a non-prelabel job, and writes nothing", async () => {
    // M11.1 (migration 0005): before `prelabel` existed there was nothing to
    // check a job's kind against here, and any held lease qualified. A
    // download job's lease must not double as permission to write prediction
    // rows now that there is a real kind to hold it to.
    await seedVideo("kkkkkkkkkkk");
    const at = Math.floor(Date.now() / 1000);
    const row = await env.DB.prepare(
      `INSERT INTO jobs (kind, video_id, status, attempts, claimed_by, claimed_at, heartbeat_at)
            VALUES ('download', ?, 'claimed', 1, 'w1', ?, ?)
         RETURNING id`,
    )
      .bind("kkkkkkkkkkk", at, at)
      .first<{ id: number }>();
    await seedClass("Paimon");

    const res = await reportPredictions(row?.id ?? 0, reported());

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/only a prelabel job/);

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM predictions").first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });

  it("rejects an r2_key that does not exist, and writes nothing", async () => {
    const jobId = await seedHeldJob("ddddddddddd");
    await seedClass("Paimon");

    const res = await reportPredictions(
      jobId,
      reported({ predictions: [box({ r2_key: "ddddddddddd/does-not-exist.jpg" })] }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown r2_key/);
    expect(body.error).toMatch(/does-not-exist\.jpg/);

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM predictions").first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });

  it("rejects an r2_key that exists but belongs to a different video", async () => {
    const jobId = await seedHeldJob("eeeeeeeeeee");
    await seedVideo("other-video11");
    await seedImage("other-video11", "other-video11/0000000.jpg");
    await seedClass("Paimon");

    const res = await reportPredictions(
      jobId,
      reported({ predictions: [box({ r2_key: "other-video11/0000000.jpg" })] }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown r2_key/);
  });

  it("rejects a class_name that does not exist, and writes nothing", async () => {
    const jobId = await seedHeldJob("fffffffffff");
    await seedImage("fffffffffff", "fffffffffff/0000000.jpg");

    const res = await reportPredictions(
      jobId,
      reported({
        predictions: [box({ r2_key: "fffffffffff/0000000.jpg", class_name: "Nobody" })],
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown class_name/);
    expect(body.error).toMatch(/Nobody/);

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM predictions").first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });

  it("rejects a predictions array past the per-job bound, naming the limit", async () => {
    const jobId = await seedHeldJob("ggggggggggg");
    const tooMany = Array.from({ length: MAX_PREDICTIONS_PER_JOB + 1 }, () => box());

    const res = await reportPredictions(jobId, reported({ predictions: tooMany }));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues?: { path: string }[] };
    expect(body.issues?.map((i) => i.path)).toEqual(["predictions"]);
  });

  it.each([
    ["x_min below 0", { x_min: -0.1 }],
    ["x_max above 1", { x_max: 1.1 }],
    ["confidence below 0", { confidence: -0.01 }],
    ["confidence above 1", { confidence: 1.01 }],
  ])("rejects an out-of-range %s", async (_name, overrides) => {
    const jobId = await seedHeldJob("hhhhhhhhhhh");

    const res = await reportPredictions(jobId, reported({ predictions: [box(overrides)] }));

    expect(res.status).toBe(400);
  });

  it("rejects a box whose x_max is less than its x_min", async () => {
    const jobId = await seedHeldJob("iiiiiiiiiii");

    const res = await reportPredictions(
      jobId,
      reported({ predictions: [box({ x_min: 0.6, x_max: 0.4 })] }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues?: { path: string }[] };
    expect(body.issues?.map((i) => i.path)).toEqual(["predictions.0.x_max"]);
  });

  it("rejects a box whose y_max is less than its y_min", async () => {
    const jobId = await seedHeldJob("jjjjjjjjjjj");

    const res = await reportPredictions(
      jobId,
      reported({ predictions: [box({ y_min: 0.6, y_max: 0.4 })] }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues?: { path: string }[] };
    expect(body.issues?.map((i) => i.path)).toEqual(["predictions.0.y_max"]);
  });
});
