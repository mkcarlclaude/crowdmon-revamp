import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { DEFAULT_INCLUSION_POLICY } from "../../src/schemas";
import { adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";

/**
 * Dataset snapshots (M15.1, M15.3): an admin-triggered job that packages
 * every image and label the current inclusion policy admits into one R2
 * artifact, and the default policy that decides what qualifies.
 *
 * The property most of these tests exist to hold down is M15.3's own
 * sentence: the default inclusion policy excludes anonymous verdicts, uses
 * the *latest* admin verdict per prediction, and resolves an `adjust` to its
 * adjusted coordinates rather than the model's original box.
 */

beforeAll(installAdminIdentity);
beforeEach(configureAccess);

const VIDEO = "dQw4w9WgXcQ";

async function seedVideo() {
  await env.DB.prepare("INSERT INTO videos (id, url) VALUES (?, ?)")
    .bind(VIDEO, `https://www.youtube.com/watch?v=${VIDEO}`)
    .run();
}

async function seedImage(
  key: string,
  timestamp: number,
  selectionReason: string | null = "random",
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
    source?: "admin" | "anon";
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
        selection_reason: "random",
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
