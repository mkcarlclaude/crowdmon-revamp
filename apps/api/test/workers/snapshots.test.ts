import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { DEFAULT_INCLUSION_POLICY } from "../../src/schemas";
import { adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";
import { seedUser } from "./contributor-seed";

/**
 * Dataset snapshots (M15.1, M15.3): an admin-triggered job that packages
 * every image and label the current inclusion policy admits into one R2
 * artifact, and the default policy that decides what qualifies.
 *
 * The property most of these tests exist to hold down is M15.3's own
 * sentence, reordered by M20 plan §C1: the default inclusion policy admits
 * the latest `admin` verdict outright; absent one, the latest verdict from a
 * *trusted* user; `anon` verdicts and an untrusted user's verdicts never
 * qualify; and an `adjust` resolves to its adjusted coordinates rather than
 * the model's original box.
 */

beforeAll(installAdminIdentity);
beforeEach(configureAccess);

const VIDEO = "dQw4w9WgXcQ";

async function seedVideo() {
  await env.DB.prepare("INSERT INTO videos (id, url) VALUES (?, ?)")
    .bind(VIDEO, `https://www.youtube.com/watch?v=${VIDEO}`)
    .run();
}

// "diverse" by default, not "random": most of this suite's images exist to
// exercise WINNING_VERDICT's ordering, which as of M26.7 only ever governs
// the *train* half — a "random" image's labels now come from `ground_truth`
// instead (plan §B), and none of these verdict-focused tests seed that
// table. Tests that specifically exercise the eval half pass "random"
// explicitly.
async function seedImage(
  key: string,
  timestamp: number,
  selectionReason: string | null = "diverse",
) {
  const row = await env.DB.prepare(
    `INSERT INTO images (r2_key, video_id, timestamp_seconds, phash, dedup_threshold, selection_reason)
          VALUES (?, ?, ?, 'af3c9e1b2d4f7a80', 10, ?) RETURNING id`,
  )
    .bind(key, VIDEO, timestamp, selectionReason)
    .first<{ id: number }>();
  if (!row) throw new Error("seeding an image returned no row");
  return row.id;
}

async function seedClass(name = "Paimon") {
  const row = await env.DB.prepare(
    `INSERT INTO classes (name, appearance_prompt, prompt_version, active)
          VALUES (?, 'a small floating companion', '2026-08-08-a', 1) RETURNING id`,
  )
    .bind(name)
    .first<{ id: number }>();
  if (!row) throw new Error("seeding a class returned no row");
  return row.id;
}

async function seedPrediction(imageId: number, classId: number) {
  const row = await env.DB.prepare(
    `INSERT INTO predictions (image_id, class_id, x_min, y_min, x_max, y_max, confidence, prompt_version, model_id)
          VALUES (?, ?, 0.1, 0.1, 0.4, 0.5, 0.9, '2026-08-08-a', 'owlvit-base-patch32.onnx')
          RETURNING id`,
  )
    .bind(imageId, classId)
    .first<{ id: number }>();
  if (!row) throw new Error("seeding a prediction returned no row");
  return row.id;
}

async function seedVerdict(
  predictionId: number,
  verdict: "accept" | "adjust" | "reject",
  opts: {
    source?: "admin" | "anon" | "user";
    annotator?: string;
    adjusted?: [number, number, number, number];
  } = {},
) {
  const source = opts.source ?? "admin";
  const annotator = opts.annotator ?? "admin@example.com";
  const adjusted = opts.adjusted;
  await env.DB.prepare(
    `INSERT INTO verdicts
          (prediction_id, verdict, source, annotator_id, adjusted_x_min, adjusted_y_min, adjusted_x_max, adjusted_y_max)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      predictionId,
      verdict,
      source,
      annotator,
      adjusted ? adjusted[0] : null,
      adjusted ? adjusted[1] : null,
      adjusted ? adjusted[2] : null,
      adjusted ? adjusted[3] : null,
    )
    .run();
}

async function createSnapshot() {
  return app.request(
    "/api/admin/snapshots",
    { method: "POST", headers: await adminHeaders() },
    env,
  );
}

async function claim(workerId = "test-worker") {
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

function snapshotSource(jobId: number, workerId = "test-worker") {
  return app.request(`/api/jobs/${jobId}/snapshot-source?worker_id=${workerId}`, {}, env);
}

function reportSnapshot(jobId: number, body: unknown) {
  return app.request(
    `/api/jobs/${jobId}/snapshot`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

// The eval half's own fixtures (M26.7 plan §B): a ground-truth box and an
// exhaustive mark, the two things `resolveScoredEvalPool`
// (`admin-eval.ts`) and the eval query in `snapshotSourceHandler` read
// instead of a verdict. Mirrors `admin-eval.test.ts`'s own helpers of the
// same name rather than importing them — this file already keeps its own
// local `seedImage`/`seedClass`/`seedPrediction`, distinct in shape from
// `labelling-seed.ts`'s versions, for the same reason: the pool this suite
// wants is closer to `snapshotSourceHandler`'s own SQL than to a
// verification screen's.
async function drawGroundTruth(imageId: number, classId: number, box = [0.1, 0.1, 0.4, 0.4]) {
  const [x_min, y_min, x_max, y_max] = box;
  await app.request(
    `/api/admin/images/${imageId}/ground-truth`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(await adminHeaders()) },
      body: JSON.stringify({ class_id: classId, x_min, y_min, x_max, y_max }),
    },
    env,
  );
}

async function markExhaustive(imageId: number, classId: number) {
  await app.request(
    `/api/admin/images/${imageId}/ground-truth/exhaustive`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(await adminHeaders()) },
      body: JSON.stringify({ class_id: classId, exhaustive: true }),
    },
    env,
  );
}

describe("POST /api/admin/snapshots", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await app.request("/api/admin/snapshots", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });

  it("enqueues a snapshot job with no video", async () => {
    const res = await createSnapshot();

    expect(res.status).toBe(201);
    const body = (await res.json()) as { job_id: number; status: string };
    expect(body.status).toBe("pending");

    const job = await env.DB.prepare("SELECT kind, video_id, status FROM jobs WHERE id = ?")
      .bind(body.job_id)
      .first<{ kind: string; video_id: string | null; status: string }>();
    expect(job).toEqual({ kind: "snapshot", video_id: null, status: "pending" });
  });

  it("allows more than one — a second snapshot while the first is still running is not an error", async () => {
    expect((await createSnapshot()).status).toBe(201);
    expect((await createSnapshot()).status).toBe(201);
  });
});

describe("GET /api/admin/snapshots", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await app.request("/api/admin/snapshots", {}, env);
    expect(res.status).toBe(401);
  });

  it("lists snapshots newest first, with counts and dates", async () => {
    await env.DB.prepare(
      `INSERT INTO snapshots (r2_key, image_count, label_count, inclusion_policy)
            VALUES ('snapshots/job-1', 10, 15, 'policy a')`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO snapshots (r2_key, image_count, label_count, inclusion_policy)
            VALUES ('snapshots/job-2', 20, 30, 'policy a')`,
    ).run();

    const res = await app.request("/api/admin/snapshots", { headers: await adminHeaders() }, env);
    const body = (await res.json()) as {
      snapshots: Array<{ r2_key: string; image_count: number }>;
    };

    expect(res.status).toBe(200);
    expect(body.snapshots).toHaveLength(2);
    // Newest first: job-2 was inserted second.
    expect(body.snapshots[0]).toMatchObject({ r2_key: "snapshots/job-2", image_count: 20 });
    expect(body.snapshots[1]).toMatchObject({ r2_key: "snapshots/job-1", image_count: 10 });
  });

  it("answers an empty list before anything has been built", async () => {
    const res = await app.request("/api/admin/snapshots", { headers: await adminHeaders() }, env);
    await expect(res.json()).resolves.toEqual({ snapshots: [] });
  });
});

describe("claiming a snapshot job", () => {
  it("hands the worker a job with no video", async () => {
    await createSnapshot();

    const res = await claim();

    expect(res.status).toBe(200);
    const job = (await res.json()) as Record<string, unknown>;
    expect(job).toMatchObject({ kind: "snapshot", video_id: null, video_url: null });
    expect(job.chunk).toBeUndefined();
    expect(job.dryrun).toBeUndefined();
  });

  it("does not retire a snapshot job as 'video row missing' the way every other kind would", async () => {
    await createSnapshot();

    const res = await claim();
    expect(res.status).toBe(200);

    const job = await env.DB.prepare("SELECT status FROM jobs WHERE kind = 'snapshot'").first<{
      status: string;
    }>();
    expect(job?.status).toBe("claimed");
  });
});

describe("GET /api/jobs/{id}/snapshot-source", () => {
  beforeEach(seedVideo);

  async function queueAndClaim(): Promise<number> {
    await createSnapshot();
    const claimed = (await (await claim()).json()) as { id: number };
    return claimed.id;
  }

  it("refuses a caller that does not hold the lease", async () => {
    const jobId = await queueAndClaim();

    const res = await snapshotSource(jobId, "some-other-worker");
    expect(res.status).toBe(404);
  });

  it("admits an image with an admin accept, using the prediction's own box", async () => {
    const jobId = await queueAndClaim();
    const imageId = await seedImage(`frames/${VIDEO}/00000.000.jpg`, 0);
    const classId = await seedClass();
    const predictionId = await seedPrediction(imageId, classId);
    await seedVerdict(predictionId, "accept");

    const res = await snapshotSource(jobId);
    const body = (await res.json()) as {
      images: Array<{
        r2_key: string;
        video_id: string;
        selection_reason: string | null;
        split: "train" | "eval";
        labels: Array<{
          class_name: string;
          x_min: number;
          y_min: number;
          x_max: number;
          y_max: number;
        }>;
      }>;
    };

    expect(res.status).toBe(200);
    expect(body.images).toEqual([
      {
        r2_key: `frames/${VIDEO}/00000.000.jpg`,
        video_id: VIDEO,
        timestamp_seconds: 0,
        selection_reason: "diverse",
        split: "train",
        labels: [{ class_name: "Paimon", x_min: 0.1, y_min: 0.1, x_max: 0.4, y_max: 0.5 }],
      },
    ]);
  });

  it("resolves an admin adjust to the adjusted coordinates, not the prediction's own box", async () => {
    const jobId = await queueAndClaim();
    const imageId = await seedImage(`frames/${VIDEO}/00001.000.jpg`, 1);
    const classId = await seedClass();
    const predictionId = await seedPrediction(imageId, classId);
    await seedVerdict(predictionId, "adjust", { adjusted: [0.2, 0.2, 0.6, 0.6] });

    const res = await snapshotSource(jobId);
    const body = (await res.json()) as {
      images: Array<{
        labels: Array<{ x_min: number; y_min: number; x_max: number; y_max: number }>;
      }>;
    };

    expect(body.images[0]?.labels).toEqual([
      { class_name: "Paimon", x_min: 0.2, y_min: 0.2, x_max: 0.6, y_max: 0.6 },
    ]);
  });

  it("excludes a prediction with no admin verdict at all", async () => {
    const jobId = await queueAndClaim();
    const imageId = await seedImage(`frames/${VIDEO}/00002.000.jpg`, 2);
    const classId = await seedClass();
    await seedPrediction(imageId, classId);

    const res = await snapshotSource(jobId);
    const body = (await res.json()) as { images: unknown[] };
    expect(body.images).toEqual([]);
  });

  it("excludes a prediction an anonymous visitor accepted — the default policy's whole point (M15.3)", async () => {
    const jobId = await queueAndClaim();
    const imageId = await seedImage(`frames/${VIDEO}/00003.000.jpg`, 3);
    const classId = await seedClass();
    const predictionId = await seedPrediction(imageId, classId);
    await seedVerdict(predictionId, "accept", { source: "anon", annotator: "anon-session-1" });

    const res = await snapshotSource(jobId);
    const body = (await res.json()) as { images: unknown[] };
    expect(body.images).toEqual([]);
  });

  it("excludes a prediction whose latest admin verdict is a reject, even after an earlier accept", async () => {
    const jobId = await queueAndClaim();
    const imageId = await seedImage(`frames/${VIDEO}/00004.000.jpg`, 4);
    const classId = await seedClass();
    const predictionId = await seedPrediction(imageId, classId);
    await seedVerdict(predictionId, "accept");
    await seedVerdict(predictionId, "reject");

    const res = await snapshotSource(jobId);
    const body = (await res.json()) as { images: unknown[] };
    expect(body.images).toEqual([]);
  });

  it("uses the latest admin verdict when an admin re-rules after an anonymous one", async () => {
    const jobId = await queueAndClaim();
    const imageId = await seedImage(`frames/${VIDEO}/00005.000.jpg`, 5);
    const classId = await seedClass();
    const predictionId = await seedPrediction(imageId, classId);
    await seedVerdict(predictionId, "reject", { source: "anon", annotator: "anon-session-2" });
    await seedVerdict(predictionId, "accept");

    const res = await snapshotSource(jobId);
    const body = (await res.json()) as { images: Array<{ labels: unknown[] }> };
    expect(body.images).toHaveLength(1);
    expect(body.images[0]?.labels).toHaveLength(1);
  });

  it("groups more than one qualifying label onto the same image", async () => {
    const jobId = await queueAndClaim();
    const imageId = await seedImage(`frames/${VIDEO}/00006.000.jpg`, 6);
    const paimon = await seedClass("Paimon");
    const klee = await seedClass("Klee");
    await seedVerdict(await seedPrediction(imageId, paimon), "accept");
    await seedVerdict(await seedPrediction(imageId, klee), "accept");

    const res = await snapshotSource(jobId);
    const body = (await res.json()) as { images: Array<{ labels: unknown[] }> };

    expect(body.images).toHaveLength(1);
    expect(body.images[0]?.labels).toHaveLength(2);
  });

  // M20 plan §C1 — the ordering that fills a gap no admin has ruled on with
  // a *trusted* user's verdict, and only a trusted one.

  it("admits a trusted user's verdict when no admin has ruled on the prediction", async () => {
    const jobId = await queueAndClaim();
    const imageId = await seedImage(`frames/${VIDEO}/00007.000.jpg`, 7);
    const classId = await seedClass();
    const predictionId = await seedPrediction(imageId, classId);
    const trustedUserId = await seedUser({ trusted: 1 });
    await seedVerdict(predictionId, "accept", { source: "user", annotator: String(trustedUserId) });

    const res = await snapshotSource(jobId);
    const body = (await res.json()) as { images: Array<{ labels: unknown[] }> };
    expect(body.images).toHaveLength(1);
    expect(body.images[0]?.labels).toHaveLength(1);
  });

  it("excludes an untrusted user's verdict even though the source is 'user'", async () => {
    const jobId = await queueAndClaim();
    const imageId = await seedImage(`frames/${VIDEO}/00008.000.jpg`, 8);
    const classId = await seedClass();
    const predictionId = await seedPrediction(imageId, classId);
    const untrustedUserId = await seedUser({ trusted: 0 });
    await seedVerdict(predictionId, "accept", {
      source: "user",
      annotator: String(untrustedUserId),
    });

    const res = await snapshotSource(jobId);
    const body = (await res.json()) as { images: unknown[] };
    expect(body.images).toEqual([]);
  });

  it("prefers the latest admin verdict over a trusted user's verdict on the same prediction", async () => {
    const jobId = await queueAndClaim();
    const imageId = await seedImage(`frames/${VIDEO}/00009.000.jpg`, 9);
    const classId = await seedClass();
    const predictionId = await seedPrediction(imageId, classId);
    const trustedUserId = await seedUser({ trusted: 1 });
    // The trusted user's verdict is written first and would win on recency
    // alone; the admin's later reject must still be authoritative, because
    // rank (admin before trusted user) outranks recency, not the reverse.
    await seedVerdict(predictionId, "accept", { source: "user", annotator: String(trustedUserId) });
    await seedVerdict(predictionId, "reject");

    const res = await snapshotSource(jobId);
    const body = (await res.json()) as { images: unknown[] };
    expect(body.images).toEqual([]);
  });

  it("prefers an admin accept over a trusted user's verdict, even when the user ruled last", async () => {
    const jobId = await queueAndClaim();
    const imageId = await seedImage(`frames/${VIDEO}/00010.000.jpg`, 10);
    const classId = await seedClass();
    const predictionId = await seedPrediction(imageId, classId);
    const trustedUserId = await seedUser({ trusted: 1 });
    await seedVerdict(predictionId, "adjust", { adjusted: [0.15, 0.15, 0.45, 0.45] });
    // Written after the admin's adjust, and would win by recency alone.
    await seedVerdict(predictionId, "accept", { source: "user", annotator: String(trustedUserId) });

    const res = await snapshotSource(jobId);
    const body = (await res.json()) as {
      images: Array<{ labels: Array<{ x_min: number; y_min: number }> }>;
    };
    expect(body.images).toHaveLength(1);
    // The admin's adjusted coordinates, not the prediction's own box and not
    // whatever the trusted user's own verdict carried.
    expect(body.images[0]?.labels).toEqual([expect.objectContaining({ x_min: 0.15, y_min: 0.15 })]);
  });

  it("a mixed pool: admin, trusted user, untrusted user and anon each rule a different prediction — exactly the first two become labels", async () => {
    const jobId = await queueAndClaim();
    const classId = await seedClass();
    const trustedUserId = await seedUser({ trusted: 1, email: "trusted@example.com" });
    const untrustedUserId = await seedUser({ trusted: 0, email: "untrusted@example.com" });

    const adminImageId = await seedImage(`frames/${VIDEO}/00011.000.jpg`, 11);
    const adminPredictionId = await seedPrediction(adminImageId, classId);
    await seedVerdict(adminPredictionId, "accept");

    const trustedImageId = await seedImage(`frames/${VIDEO}/00012.000.jpg`, 12);
    const trustedPredictionId = await seedPrediction(trustedImageId, classId);
    await seedVerdict(trustedPredictionId, "accept", {
      source: "user",
      annotator: String(trustedUserId),
    });

    const untrustedImageId = await seedImage(`frames/${VIDEO}/00013.000.jpg`, 13);
    const untrustedPredictionId = await seedPrediction(untrustedImageId, classId);
    await seedVerdict(untrustedPredictionId, "accept", {
      source: "user",
      annotator: String(untrustedUserId),
    });

    const anonImageId = await seedImage(`frames/${VIDEO}/00014.000.jpg`, 14);
    const anonPredictionId = await seedPrediction(anonImageId, classId);
    await seedVerdict(anonPredictionId, "accept", { source: "anon", annotator: "anon-session-3" });

    const res = await snapshotSource(jobId);
    const body = (await res.json()) as { images: Array<{ r2_key: string }> };

    expect(body.images).toHaveLength(2);
    expect(body.images.map((image) => image.r2_key).sort()).toEqual(
      [`frames/${VIDEO}/00011.000.jpg`, `frames/${VIDEO}/00012.000.jpg`].sort(),
    );
  });

  /**
   * The eval half (M26.7, plan §B). Every test here turns on the one
   * distinction the milestone exists to draw: a `random` image's labels are
   * what an annotator drew (`ground_truth`), never what a model proposed and
   * a human accepted (`WINNING_VERDICT`) — those two agreeing by accident is
   * exactly what a fixture has to rule out, so the ones below make them
   * disagree on purpose.
   */
  describe("the eval half reads ground truth, not verdicts", () => {
    it("labels an eval image from ground_truth even when its accepted prediction says otherwise", async () => {
      const jobId = await queueAndClaim();
      const imageId = await seedImage(`frames/${VIDEO}/00020.000.jpg`, 20, "random");
      const classId = await seedClass();

      // The two sources deliberately disagree: an accepted prediction at one
      // box, a hand-drawn ground-truth box somewhere else entirely. A
      // handler still reading verdicts would return the prediction's
      // coordinates and pass every assertion that only counted labels, which
      // is why this fixture separates them in space rather than in count.
      const predictionId = await seedPrediction(imageId, classId);
      await seedVerdict(predictionId, "accept");
      await drawGroundTruth(imageId, classId, [0.7, 0.7, 0.9, 0.9]);
      await markExhaustive(imageId, classId);

      const res = await snapshotSource(jobId);
      const body = (await res.json()) as {
        images: Array<{
          r2_key: string;
          selection_reason: string | null;
          split: "train" | "eval";
          labels: Array<{ class_name: string; x_min: number; y_min: number }>;
        }>;
      };

      expect(res.status).toBe(200);
      expect(body.images).toHaveLength(1);
      const [image] = body.images;
      expect(image?.split).toBe("eval");
      expect(image?.selection_reason).toBe("random");
      // The drawn box, not the accepted prediction's 0.1/0.1.
      expect(image?.labels).toEqual([
        { class_name: "Paimon", x_min: 0.7, y_min: 0.7, x_max: 0.9, y_max: 0.9 },
      ]);
    });

    it("admits an exhaustive eval image with no ground-truth box at all, carrying zero labels", async () => {
      const jobId = await queueAndClaim();
      const imageId = await seedImage(`frames/${VIDEO}/00021.000.jpg`, 21, "random");
      const classId = await seedClass();

      // Marked exhaustive, nothing drawn: an annotator looked at this frame
      // and recorded that the character is not in it. Read against
      // production, 171 of the 286 exhaustively-annotated frames are this
      // case — the majority of the scored set, and the entries that make a
      // false positive cost something. A handler that kept M15.3's
      // "emit an image only once it carries a label" rule for this half
      // would silently drop every one of them.
      await markExhaustive(imageId, classId);

      const res = await snapshotSource(jobId);
      const body = (await res.json()) as {
        images: Array<{ r2_key: string; split: string; labels: unknown[] }>;
      };

      expect(body.images).toHaveLength(1);
      expect(body.images[0]?.split).toBe("eval");
      expect(body.images[0]?.labels).toEqual([]);
    });

    it("omits an eval image nobody has finished annotating, even when it carries an accepted verdict", async () => {
      const jobId = await queueAndClaim();
      const classId = await seedClass();

      // Not marked exhaustive. Under M15.3 this image was in the manifest —
      // it has an accepted verdict — and it is the case the whole milestone
      // turns on: absent, not present-with-zero-labels. Emitting it empty
      // would make it indistinguishable from the true negative above, which
      // is the distinction `ground_truth_exhaustive` exists to record
      // (migration 0014's own comment).
      const unfinished = await seedImage(`frames/${VIDEO}/00022.000.jpg`, 22, "random");
      const predictionId = await seedPrediction(unfinished, classId);
      await seedVerdict(predictionId, "accept");
      await drawGroundTruth(unfinished, classId);

      const res = await snapshotSource(jobId);
      const body = (await res.json()) as { images: Array<{ r2_key: string }> };

      expect(body.images).toEqual([]);
    });

    it("answers 200 with an empty eval half and a populated train half when nothing is marked exhaustive", async () => {
      const jobId = await queueAndClaim();
      const classId = await seedClass();

      // `getEvalSourceHandler` refuses this state with a 409; this route must
      // not. A training rebuild has no business waiting on an eval
      // annotation sitting (`admin-eval.ts`'s own module comment), so a
      // deployment mid-annotation gets both halves under one 200 — the train
      // half whole, the eval half simply empty.
      const evalImage = await seedImage(`frames/${VIDEO}/00023.000.jpg`, 23, "random");
      await drawGroundTruth(evalImage, classId);

      const trainImage = await seedImage(`frames/${VIDEO}/00024.000.jpg`, 24);
      const predictionId = await seedPrediction(trainImage, classId);
      await seedVerdict(predictionId, "accept");

      const res = await snapshotSource(jobId);
      const body = (await res.json()) as {
        images: Array<{ r2_key: string; split: string }>;
      };

      expect(res.status).toBe(200);
      expect(body.images).toHaveLength(1);
      expect(body.images[0]?.split).toBe("train");
      expect(body.images[0]?.r2_key).toBe(`frames/${VIDEO}/00024.000.jpg`);
    });

    it("keeps the two halves apart: a train image is verdict-derived in the same response", async () => {
      const jobId = await queueAndClaim();
      const classId = await seedClass();

      const evalImage = await seedImage(`frames/${VIDEO}/00025.000.jpg`, 25, "random");
      await drawGroundTruth(evalImage, classId, [0.7, 0.7, 0.9, 0.9]);
      await markExhaustive(evalImage, classId);

      const trainImage = await seedImage(`frames/${VIDEO}/00026.000.jpg`, 26);
      const predictionId = await seedPrediction(trainImage, classId);
      await seedVerdict(predictionId, "accept");

      const res = await snapshotSource(jobId);
      const body = (await res.json()) as {
        images: Array<{
          r2_key: string;
          split: string;
          labels: Array<{ x_min: number }>;
        }>;
      };

      const byKey = new Map(body.images.map((image) => [image.r2_key, image]));
      expect(byKey.get(`frames/${VIDEO}/00025.000.jpg`)?.split).toBe("eval");
      expect(byKey.get(`frames/${VIDEO}/00025.000.jpg`)?.labels[0]?.x_min).toBe(0.7);
      expect(byKey.get(`frames/${VIDEO}/00026.000.jpg`)?.split).toBe("train");
      expect(byKey.get(`frames/${VIDEO}/00026.000.jpg`)?.labels[0]?.x_min).toBe(0.1);
    });
  });
});

describe("POST /api/jobs/{id}/snapshot", () => {
  it("records the snapshot with the default inclusion policy", async () => {
    await createSnapshot();
    const claimed = (await (await claim()).json()) as { id: number };

    const res = await reportSnapshot(claimed.id, {
      worker_id: "test-worker",
      r2_key: `snapshots/job-${claimed.id}`,
      image_count: 12,
      label_count: 20,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { snapshot_id: number };

    const row = await env.DB.prepare("SELECT * FROM snapshots WHERE id = ?")
      .bind(body.snapshot_id)
      .first<{
        r2_key: string;
        image_count: number;
        label_count: number;
        inclusion_policy: string;
      }>();
    expect(row).toMatchObject({
      r2_key: `snapshots/job-${claimed.id}`,
      image_count: 12,
      label_count: 20,
      inclusion_policy: DEFAULT_INCLUSION_POLICY,
    });
  });

  it("stamps a policy that names both label sources, not just the verdict one (M26.7 §C)", async () => {
    // The assertion above only says the row matches the constant; it would
    // stay green if the constant still described one policy for both halves.
    // This one says the constant describes what the handler actually does.
    // A snapshot's dataset has to be reconstructible from its own row
    // (migration 0003's comment on `snapshots.inclusion_policy`), and after
    // M26.7 that is two policies — verdicts for train, `ground_truth` gated
    // on exhaustiveness for eval — so a policy string naming only the first
    // is a row that lies about how its own snapshot was built.
    expect(DEFAULT_INCLUSION_POLICY).toContain("ground_truth_exhaustive");
    expect(DEFAULT_INCLUSION_POLICY).toContain("accept or adjust");
    expect(DEFAULT_INCLUSION_POLICY).toContain("selection_reason='random' -> eval");
  });

  it("refuses a worker that does not hold the lease", async () => {
    await createSnapshot();
    const claimed = (await (await claim()).json()) as { id: number };

    const res = await reportSnapshot(claimed.id, {
      worker_id: "some-other-worker",
      r2_key: "snapshots/job-x",
      image_count: 0,
      label_count: 0,
    });

    expect(res.status).toBe(404);
  });

  it("refuses a job of the wrong kind with a 400, not a 404", async () => {
    await seedVideo();
    await env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('download', ?)")
      .bind(VIDEO)
      .run();
    const claimed = (await (await claim()).json()) as { id: number };

    const res = await reportSnapshot(claimed.id, {
      worker_id: "test-worker",
      r2_key: "snapshots/job-x",
      image_count: 0,
      label_count: 0,
    });

    expect(res.status).toBe(400);
  });
});
