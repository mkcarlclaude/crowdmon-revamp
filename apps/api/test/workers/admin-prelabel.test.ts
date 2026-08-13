import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";
import { seedClass, seedPrediction } from "./labelling-seed";
import { seedVideo } from "./seed";

/**
 * On-demand supplementary prelabel (M17, plan §B):
 * `POST /api/admin/videos/{id}/prelabel`.
 *
 * The property most of these tests exist to hold down is the plan's
 * "Contradictions" §§2-3: a hand-picked pass must stamp `manual`, a random
 * draw must stamp `random`, and neither pass may ever silently rewrite an
 * image another pass already claimed. `predictions.test.ts` covers the
 * write-once guard's own SQL layer directly; this file covers the route that
 * is supposed to make that guard unnecessary in the first place.
 */

beforeAll(installAdminIdentity);
beforeEach(configureAccess);

const VIDEO = "dQw4w9WgXcQ";

async function seedImage(
  timestamp: number,
  { videoId = VIDEO, selectionReason = null as string | null } = {},
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO images (r2_key, video_id, timestamp_seconds, phash, dedup_threshold, selection_reason)
          VALUES (?, ?, ?, 'af3c9e1b2d4f7a80', 8, ?) RETURNING id`,
  )
    .bind(
      `frames/${videoId}/${String(timestamp).padStart(5, "0")}.000.jpg`,
      videoId,
      timestamp,
      selectionReason,
    )
    .first<{ id: number }>();
  if (!row) throw new Error("seeding an image returned no row");
  return row.id;
}

function createPrelabel(videoId: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(
    `/api/admin/videos/${videoId}/prelabel`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function authedCreatePrelabel(videoId: string, body: unknown) {
  return createPrelabel(videoId, body, await adminHeaders());
}

function claim(workerId = "test-worker") {
  return app.request(
    "/api/jobs/claim",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker_id: workerId }),
    },
    env,
  );
}

function reportPredictions(jobId: number, body: unknown) {
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

function jobRow(jobId: number) {
  return env.DB.prepare("SELECT kind, video_id, selection_reason FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<{ kind: string; video_id: string; selection_reason: string | null }>();
}

function prelabelImageIds(jobId: number) {
  return env.DB.prepare("SELECT image_id FROM prelabel_images WHERE job_id = ? ORDER BY image_id")
    .bind(jobId)
    .all<{ image_id: number }>();
}

function countPrelabelJobs() {
  return env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'prelabel'").first<{
    n: number;
  }>();
}

describe("POST /api/admin/videos/{id}/prelabel", () => {
  beforeEach(() => seedVideo(VIDEO));

  it("rejects an unauthenticated request", async () => {
    const res = await createPrelabel(VIDEO, { count: 1, strategy: "random" });
    expect(res.status).toBe(401);
  });

  it("404s for a video that does not exist", async () => {
    const res = await authedCreatePrelabel("no-such-video", { count: 1, strategy: "random" });
    expect(res.status).toBe(404);
  });

  describe("request shape", () => {
    it("rejects a body giving neither mode", async () => {
      const res = await authedCreatePrelabel(VIDEO, {});
      expect(res.status).toBe(400);
    });

    it("rejects a body giving both modes at once", async () => {
      const res = await authedCreatePrelabel(VIDEO, {
        image_ids: [1],
        count: 1,
        strategy: "random",
      });
      expect(res.status).toBe(400);
    });

    it("rejects count without strategy", async () => {
      const res = await authedCreatePrelabel(VIDEO, { count: 5 });
      expect(res.status).toBe(400);
    });

    it("rejects strategy without count", async () => {
      const res = await authedCreatePrelabel(VIDEO, { strategy: "random" });
      expect(res.status).toBe(400);
    });
  });

  describe("hand-picked mode (image_ids)", () => {
    it("queues a job over the named images, stamped manual", async () => {
      const img1 = await seedImage(5);
      const img2 = await seedImage(2);

      const res = await authedCreatePrelabel(VIDEO, { image_ids: [img1, img2] });

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        job_id: number;
        video_id: string;
        selection_reason: string;
        images: number;
      };
      expect(body).toMatchObject({ video_id: VIDEO, selection_reason: "manual", images: 2 });

      const job = await jobRow(body.job_id);
      expect(job).toMatchObject({ kind: "prelabel", video_id: VIDEO, selection_reason: "manual" });

      const { results } = await prelabelImageIds(body.job_id);
      expect(results.map((r) => r.image_id).sort((a, b) => a - b)).toEqual(
        [img1, img2].sort((a, b) => a - b),
      );
    });

    it("404s naming a hand-picked id this video does not have, and writes nothing", async () => {
      const img1 = await seedImage(1);

      const res = await authedCreatePrelabel(VIDEO, { image_ids: [img1, 999999] });

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/999999/);
      expect((await countPrelabelJobs())?.n).toBe(0);
    });

    it("treats an image id belonging to a different video as unknown", async () => {
      await seedVideo("other-video11");
      const otherImg = await seedImage(1, { videoId: "other-video11" });

      const res = await authedCreatePrelabel(VIDEO, { image_ids: [otherImg] });

      expect(res.status).toBe(404);
      expect((await countPrelabelJobs())?.n).toBe(0);
    });

    // Plan §"Contradictions" §3's whole hazard, caught before it can ever
    // reach the write-once SQL guard (`predictions.test.ts` tests that guard
    // directly): a hand-picked set naming an image an earlier pass already
    // sampled must be refused outright, not silently accepted and later
    // no-op'd.
    it("refuses to include an already-sampled image, naming it, and writes nothing", async () => {
      const img1 = await seedImage(1);
      const img2 = await seedImage(2, { selectionReason: "random" });

      const res = await authedCreatePrelabel(VIDEO, { image_ids: [img1, img2] });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/already sampled/);
      expect(body.error).toMatch(String(img2));
      expect((await countPrelabelJobs())?.n).toBe(0);

      // The already-sampled image's own row is untouched, not just the job.
      const image = await env.DB.prepare("SELECT selection_reason FROM images WHERE id = ?")
        .bind(img2)
        .first<{ selection_reason: string | null }>();
      expect(image?.selection_reason).toBe("random");
    });

    it("de-duplicates a repeated id rather than colliding on prelabel_images' own primary key", async () => {
      const img1 = await seedImage(1);

      const res = await authedCreatePrelabel(VIDEO, { image_ids: [img1, img1] });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { job_id: number; images: number };
      expect(body.images).toBe(1);
    });

    // D1 rejects a query carrying more than 100 bound parameters, per
    // statement (`D1_MAX_BOUND_PARAMS`, `d1.ts`) — this exercises the
    // existence/already-sampled lookup and the insert past that boundary.
    // Local D1 is SQLite and does not enforce the cap, so what this pins
    // down is that results from more than one lookup chunk are reassembled
    // correctly, the same property `predictions.test.ts`'s own 150-key test
    // pins for `reportPredictionsHandler`.
    it("resolves and inserts a hand-picked set naming more images than one query may bind", async () => {
      const ids: number[] = [];
      for (let t = 0; t < 150; t++) ids.push(await seedImage(t));

      const res = await authedCreatePrelabel(VIDEO, { image_ids: ids });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { job_id: number; images: number };
      expect(body.images).toBe(150);

      const { results } = await prelabelImageIds(body.job_id);
      expect(results).toHaveLength(150);
    });
  });

  describe("random draw mode (count, strategy: 'random')", () => {
    it("draws count un-sampled images at random, stamped random", async () => {
      const img1 = await seedImage(1);
      const img2 = await seedImage(2);
      // Already sampled — must never be drawn.
      await seedImage(3, { selectionReason: "random" });

      const res = await authedCreatePrelabel(VIDEO, { count: 2, strategy: "random" });

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        job_id: number;
        images: number;
        selection_reason: string;
      };
      expect(body).toMatchObject({ images: 2, selection_reason: "random" });

      const { results } = await prelabelImageIds(body.job_id);
      expect(results.map((r) => r.image_id).sort((a, b) => a - b)).toEqual(
        [img1, img2].sort((a, b) => a - b),
      );
    });

    it("draws fewer than count when the un-sampled pool is smaller, rather than erroring", async () => {
      await seedImage(1);

      const res = await authedCreatePrelabel(VIDEO, { count: 5, strategy: "random" });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { images: number };
      expect(body.images).toBe(1);
    });

    it("refuses a random draw with nothing left to sample", async () => {
      await seedImage(1, { selectionReason: "random" });

      const res = await authedCreatePrelabel(VIDEO, { count: 5, strategy: "random" });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/no un-sampled frames/);
      expect((await countPrelabelJobs())?.n).toBe(0);
    });
  });
});

describe("claim hydration for a supplementary prelabel job", () => {
  beforeEach(() => seedVideo(VIDEO));

  it("returns the job's explicit image list, ordered by timestamp", async () => {
    const img1 = await seedImage(5);
    const img2 = await seedImage(2);

    const created = await authedCreatePrelabel(VIDEO, { image_ids: [img1, img2] });
    const { job_id } = (await created.json()) as { job_id: number };

    const claimed = await claim();
    expect(claimed.status).toBe(200);
    const job = (await claimed.json()) as {
      id: number;
      kind: string;
      prelabel?: { images: Array<{ r2_key: string; timestamp_seconds: number }> };
    };

    expect(job.id).toBe(job_id);
    expect(job.kind).toBe("prelabel");
    expect(job.prelabel?.images.map((i) => i.timestamp_seconds)).toEqual([2, 5]);
  });

  // The automatic first pass (M11.1) writes no `prelabel_images` rows at
  // all, so its claim must carry no `prelabel` field — the signal
  // `Job.prelabel`'s own contract comment documents as "fall back to
  // Sampler". A job seeded the way `completeJobHandler`'s auto-enqueue
  // would, directly, since this suite is testing the claim response rather
  // than that handler.
  it("omits prelabel from the claim response for the automatic first pass", async () => {
    await env.DB.prepare(
      "INSERT INTO jobs (kind, video_id, selection_reason) VALUES ('prelabel', ?, 'random')",
    )
      .bind(VIDEO)
      .run();

    const claimed = await claim();
    const job = (await claimed.json()) as { kind: string; prelabel?: unknown };

    expect(job.kind).toBe("prelabel");
    expect(job.prelabel).toBeUndefined();
  });
});

/**
 * The plan's required end-to-end test, TypeScript half: "A hand-picked pass
 * writes manual, and a snapshot built afterwards puts those images in the
 * train split while random images stay in eval — end to end through
 * splitFor." `splitFor` itself is a Go function
 * (worker/internal/snapshot/builder.go) with its own direct test
 * (`TestBuildRoutesManualSelectionToTrainAndRandomToEval`); what this test
 * proves is the half on this side of the language boundary — that a
 * hand-picked pass, run through the real `createPrelabelHandler` and
 * `reportPredictionsHandler`, produces exactly the `selection_reason` value
 * `GET /api/jobs/{id}/snapshot-source` hands the Go worker, which is the one
 * fact `splitFor`'s own test has to assume rather than prove.
 */
describe("a hand-picked pass's selection_reason, followed through to snapshot-source", () => {
  beforeEach(() => seedVideo(VIDEO));

  it("reads 'manual' for a hand-picked image and 'random' for a randomly-drawn one", async () => {
    const manualImage = await seedImage(1);
    const randomImage = await seedImage(2);
    const classId = await seedClass("Paimon");
    // A prediction on each, so both images qualify for `snapshot-source`
    // (M15.3: at least one prediction with a latest-admin accept/adjust).
    const manualPredictionId = await seedPrediction(manualImage, classId);
    const randomPredictionId = await seedPrediction(randomImage, classId);
    await env.DB.prepare(
      "INSERT INTO verdicts (prediction_id, verdict, source, annotator_id) VALUES (?, 'accept', 'admin', 'admin@example.com')",
    )
      .bind(manualPredictionId)
      .run();
    await env.DB.prepare(
      "INSERT INTO verdicts (prediction_id, verdict, source, annotator_id) VALUES (?, 'accept', 'admin', 'admin@example.com')",
    )
      .bind(randomPredictionId)
      .run();

    // Claims and reports one job for real — `reportPredictionsHandler`'s own
    // stamp, not a test shortcut, is what writes `selection_reason`.
    async function claimAndReport(jobId: number) {
      const claimed = await claim();
      const job = (await claimed.json()) as {
        id: number;
        prelabel?: { images: Array<{ r2_key: string }> };
      };
      expect(job.id).toBe(jobId);
      const keys = job.prelabel?.images.map((i) => i.r2_key) ?? [];
      const res = await reportPredictions(jobId, {
        worker_id: "test-worker",
        model_id: "owlvit-base-patch32.onnx",
        predictions: [],
        sampled_images: keys,
      });
      expect(res.status).toBe(200);
    }

    // The hand-picked pass, through the actual route — claimed and reported
    // *before* the random draw is even queued. `createPrelabelHandler`'s own
    // "already sampled" check reads `images.selection_reason`, which only
    // becomes non-null once a report actually lands (M11.3's own ordering,
    // unchanged by this milestone) — not the instant `prelabel_images` rows
    // are written. Drawing the random job first would leave `manualImage`
    // still `selection_reason IS NULL` and eligible for that draw too,
    // making which image gets picked a race this test cannot pin.
    const handPicked = await authedCreatePrelabel(VIDEO, { image_ids: [manualImage] });
    const { job_id: manualJobId } = (await handPicked.json()) as { job_id: number };
    await claimAndReport(manualJobId);

    // Now the only un-sampled image left is `randomImage`, so the draw is
    // deterministic despite `ORDER BY RANDOM()`.
    const randomDrawn = await authedCreatePrelabel(VIDEO, { count: 1, strategy: "random" });
    const { job_id: randomJobId } = (await randomDrawn.json()) as { job_id: number };
    await claimAndReport(randomJobId);

    // Build a snapshot and read its source the way the Go worker does.
    const snapshotJobRow = await env.DB.prepare(
      "INSERT INTO jobs (kind, video_id) VALUES ('snapshot', NULL) RETURNING id",
    ).first<{ id: number }>();
    if (!snapshotJobRow) throw new Error("seeding the snapshot job returned no row");
    await env.DB.prepare(
      "UPDATE jobs SET status = 'claimed', claimed_by = 'test-worker' WHERE id = ?",
    )
      .bind(snapshotJobRow.id)
      .run();

    const source = await app.request(
      `/api/jobs/${snapshotJobRow.id}/snapshot-source?worker_id=test-worker`,
      {},
      env,
    );
    expect(source.status).toBe(200);
    const body = (await source.json()) as {
      images: Array<{ r2_key: string; selection_reason: string | null }>;
    };

    const manualRow = body.images.find((i) => i.r2_key.includes("00001.000"));
    const randomRow = body.images.find((i) => i.r2_key.includes("00002.000"));

    expect(manualRow?.selection_reason).toBe("manual");
    expect(randomRow?.selection_reason).toBe("random");
  });
});
