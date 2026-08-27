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

/**
 * A 16-character hex phash with the low `bits` bits set, so a test can state
 * a Hamming distance ("32 bits apart") instead of picking two literals and
 * hoping. `lowBits(0)` is the all-zero hash; `lowBits(64)` is 64 bits away
 * from it. The `diverse` draw is the only mode that reads this column.
 */
function lowBits(bits: number): string {
  return ((1n << BigInt(bits)) - 1n).toString(16).padStart(16, "0");
}

async function seedImage(
  timestamp: number,
  { videoId = VIDEO, selectionReason = null as string | null, phash = "af3c9e1b2d4f7a80" } = {},
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO images (r2_key, video_id, timestamp_seconds, phash, dedup_threshold, selection_reason)
          VALUES (?, ?, ?, ?, 8, ?) RETURNING id`,
  )
    .bind(
      `frames/${videoId}/${String(timestamp).padStart(5, "0")}.000.jpg`,
      videoId,
      timestamp,
      phash,
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

  /**
   * M25, plan §A. The reason this mode exists is `splitFor()` — `random`
   * routes to the frozen eval pool and everything else to train, so before
   * `diverse` the only way to get a train-split row was for a human to name
   * every id by hand. `snapshot-source-diverse.test.ts` follows the stamp all
   * the way to the split; these tests cover the draw itself.
   */
  describe("diverse draw mode (count, strategy: 'diverse')", () => {
    it("stamps diverse on the job, not random", async () => {
      await seedImage(1, { phash: lowBits(0) });
      await seedImage(2, { phash: lowBits(40) });

      const res = await authedCreatePrelabel(VIDEO, { count: 1, strategy: "diverse" });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { job_id: number; selection_reason: string };
      expect(body.selection_reason).toBe("diverse");
      expect((await jobRow(body.job_id))?.selection_reason).toBe("diverse");
    });

    it("draws the frame farthest from what an earlier pass already sampled", async () => {
      // Already sampled, so it is the reference set rather than a candidate.
      await seedImage(1, { phash: lowBits(0), selectionReason: "random" });
      const near = await seedImage(2, { phash: lowBits(3) });
      const far = await seedImage(3, { phash: lowBits(44) });

      const res = await authedCreatePrelabel(VIDEO, { count: 1, strategy: "diverse" });

      expect(res.status).toBe(201);
      const { job_id } = (await res.json()) as { job_id: number };
      const { results } = await prelabelImageIds(job_id);
      expect(results.map((r) => r.image_id)).toEqual([far]);
      expect(results.map((r) => r.image_id)).not.toContain(near);
    });

    // The plan's own named failure mode: "a sampler that works and returns
    // 200 shots of the same loading screen". Every candidate here is far from
    // the reference set, but three of them are within a bit of each other, so
    // a selector that only maximised reference distance would return the pair
    // 2/3 rather than reaching for the frame that is unlike everything.
    it("does not fill the budget with near-duplicates of its own first pick", async () => {
      await seedImage(1, { phash: lowBits(0), selectionReason: "random" });
      const farthest = await seedImage(2, { phash: lowBits(44) });
      await seedImage(3, { phash: lowBits(43) });
      await seedImage(4, { phash: lowBits(42) });
      const unlikeEverything = await seedImage(5, { phash: lowBits(22) });

      const res = await authedCreatePrelabel(VIDEO, { count: 2, strategy: "diverse" });

      expect(res.status).toBe(201);
      const { job_id } = (await res.json()) as { job_id: number };
      const { results } = await prelabelImageIds(job_id);
      expect(results.map((r) => r.image_id).sort((a, b) => a - b)).toEqual(
        [farthest, unlikeEverything].sort((a, b) => a - b),
      );
    });

    it("never draws an image an earlier pass already sampled", async () => {
      const alreadySampled = await seedImage(1, { phash: lowBits(60), selectionReason: "random" });
      const unsampled = await seedImage(2, { phash: lowBits(1) });

      const res = await authedCreatePrelabel(VIDEO, { count: 10, strategy: "diverse" });

      expect(res.status).toBe(201);
      const { job_id } = (await res.json()) as { job_id: number };
      const { results } = await prelabelImageIds(job_id);
      expect(results.map((r) => r.image_id)).toEqual([unsampled]);
      expect(results.map((r) => r.image_id)).not.toContain(alreadySampled);
    });

    it("ignores another video's frames on both sides of the draw", async () => {
      await seedVideo("other-video11");
      const otherUnsampled = await seedImage(1, {
        videoId: "other-video11",
        phash: lowBits(64),
      });
      const mine = await seedImage(1, { phash: lowBits(2) });

      const res = await authedCreatePrelabel(VIDEO, { count: 10, strategy: "diverse" });

      expect(res.status).toBe(201);
      const { job_id } = (await res.json()) as { job_id: number };
      const { results } = await prelabelImageIds(job_id);
      expect(results.map((r) => r.image_id)).toEqual([mine]);
      expect(results.map((r) => r.image_id)).not.toContain(otherUnsampled);
    });

    it("draws fewer than count when the un-sampled pool is smaller, rather than erroring", async () => {
      await seedImage(1, { phash: lowBits(4) });

      const res = await authedCreatePrelabel(VIDEO, { count: 5, strategy: "diverse" });

      expect(res.status).toBe(201);
      expect(((await res.json()) as { images: number }).images).toBe(1);
    });

    it("refuses a diverse draw with nothing left to sample", async () => {
      await seedImage(1, { selectionReason: "random" });

      const res = await authedCreatePrelabel(VIDEO, { count: 5, strategy: "diverse" });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/no un-sampled frames/);
      expect((await countPrelabelJobs())?.n).toBe(0);
    });

    // A first-ever pass over a video: nothing sampled, so there is no
    // reference set at all. The draw must still work — `selectDiverse` falls
    // back to spreading across the pool itself — rather than 400ing or
    // returning the head of the pool.
    it("draws on a video nothing has sampled yet", async () => {
      const first = await seedImage(1, { phash: lowBits(0) });
      await seedImage(2, { phash: lowBits(1) });
      const opposite = await seedImage(3, { phash: lowBits(64) });

      const res = await authedCreatePrelabel(VIDEO, { count: 2, strategy: "diverse" });

      expect(res.status).toBe(201);
      const { job_id } = (await res.json()) as { job_id: number };
      const { results } = await prelabelImageIds(job_id);
      expect(results.map((r) => r.image_id).sort((a, b) => a - b)).toEqual(
        [first, opposite].sort((a, b) => a - b),
      );
    });

    it("inserts a draw larger than one query may bind", async () => {
      for (let i = 0; i < 120; i++) {
        await seedImage(i, { phash: lowBits(i % 64) });
      }

      const res = await authedCreatePrelabel(VIDEO, { count: 120, strategy: "diverse" });

      expect(res.status).toBe(201);
      const { job_id, images } = (await res.json()) as { job_id: number; images: number };
      expect(images).toBe(120);
      const { results } = await prelabelImageIds(job_id);
      expect(new Set(results.map((r) => r.image_id)).size).toBe(120);
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

/**
 * M25, plan §A and its verification items 2 and 3. The Go half
 * (`TestBuildRoutesDiverseSelectionToTrain`) proves `splitFor` routes the
 * string `diverse` to `train`; this is the half that proves the string
 * actually gets written, by the real route and the real report handler,
 * and reaches `snapshot-source` — the endpoint the Go builder reads.
 *
 * The second test here is the one that matters most and is easiest to skip:
 * adding a selector that writes to the train split must not give any path,
 * anywhere, to rewriting a row that already reads `random`. That row is in
 * the frozen evaluation pool, and §Q16 is explicit that the move is
 * permanent and unrecoverable.
 */
describe("a diverse pass's selection_reason, followed through to snapshot-source", () => {
  beforeEach(() => seedVideo(VIDEO));

  async function claimAndReport(jobId: number, keys?: string[]) {
    const claimed = await claim();
    const job = (await claimed.json()) as {
      id: number;
      prelabel?: { images: Array<{ r2_key: string }> };
    };
    expect(job.id).toBe(jobId);
    const res = await reportPredictions(jobId, {
      worker_id: "test-worker",
      model_id: "owlvit-base-patch32.onnx",
      predictions: [],
      sampled_images: keys ?? job.prelabel?.images.map((i) => i.r2_key) ?? [],
    });
    expect(res.status).toBe(200);
  }

  async function snapshotSource() {
    const row = await env.DB.prepare(
      "INSERT INTO jobs (kind, video_id) VALUES ('snapshot', NULL) RETURNING id",
    ).first<{ id: number }>();
    if (!row) throw new Error("seeding the snapshot job returned no row");
    await env.DB.prepare(
      "UPDATE jobs SET status = 'claimed', claimed_by = 'test-worker' WHERE id = ?",
    )
      .bind(row.id)
      .run();
    const res = await app.request(
      `/api/jobs/${row.id}/snapshot-source?worker_id=test-worker`,
      {},
      env,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as {
      images: Array<{ r2_key: string; selection_reason: string | null }>;
    };
  }

  async function seedAcceptedPrediction(imageId: number, classId: number) {
    const predictionId = await seedPrediction(imageId, classId);
    await env.DB.prepare(
      "INSERT INTO verdicts (prediction_id, verdict, source, annotator_id) VALUES (?, 'accept', 'admin', 'admin@example.com')",
    )
      .bind(predictionId)
      .run();
  }

  it("reads 'diverse' at snapshot-source for a diversely-drawn image", async () => {
    const classId = await seedClass("Paimon");
    const drawn = await seedImage(7, { phash: lowBits(48) });
    await seedAcceptedPrediction(drawn, classId);

    const created = await authedCreatePrelabel(VIDEO, { count: 1, strategy: "diverse" });
    expect(created.status).toBe(201);
    const { job_id } = (await created.json()) as { job_id: number };
    await claimAndReport(job_id);

    const body = await snapshotSource();
    const row = body.images.find((i) => i.r2_key.includes("00007.000"));
    expect(row?.selection_reason).toBe("diverse");
  });

  // The frozen pool, defended at the layer that would actually break it. The
  // route already refuses to *draw* an already-sampled image (the tests
  // above), so this drives the report handler directly with a key it would
  // never have been handed — the bypass a future caller, or a bug, could
  // produce. `AND selection_reason IS NULL` in `reportPredictionsHandler` is
  // what has to hold, and if it did not, an eval-pool image would silently
  // become a train-split one with no way back (CONTEXT.md §Q16).
  it("never rewrites an existing random row to diverse", async () => {
    const frozen = await seedImage(1, { phash: lowBits(0), selectionReason: "random" });
    const fresh = await seedImage(2, { phash: lowBits(50) });

    const created = await authedCreatePrelabel(VIDEO, { count: 1, strategy: "diverse" });
    const { job_id } = (await created.json()) as { job_id: number };

    // Both keys reported, including the one this job was never given.
    await claimAndReport(job_id, [
      `frames/${VIDEO}/00001.000.jpg`,
      `frames/${VIDEO}/00002.000.jpg`,
    ]);

    const reasons = await env.DB.prepare(
      "SELECT id, selection_reason FROM images WHERE id IN (?, ?)",
    )
      .bind(frozen, fresh)
      .all<{ id: number; selection_reason: string | null }>();
    const byId = new Map(reasons.results.map((r) => [r.id, r.selection_reason]));

    expect(byId.get(frozen)).toBe("random");
    expect(byId.get(fresh)).toBe("diverse");
  });
});
