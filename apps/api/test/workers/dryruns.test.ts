import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { DRYRUN_HISTORY, DRYRUN_SAMPLE_SIZE } from "../../src/schemas";
import { ADMIN_EMAIL, adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";

/**
 * Prompt dry-runs (M12.2): trying a candidate wording against ~50 frames and
 * looking at the boxes, before that wording is allowed to pre-label anything.
 *
 * The property most of these tests exist to hold down is the one the milestone
 * words as "writing nothing": a dry-run must not put a row in `predictions` or
 * stamp `images.selection_reason`, or its boxes become indistinguishable from
 * an approved class's.
 */

beforeAll(installAdminIdentity);
beforeEach(configureAccess);

const VIDEO = "dQw4w9WgXcQ";
const CANDIDATE = "a tiny white-haired floating companion with a dark crown";

async function seedVideo(withImages = 3) {
  await env.DB.prepare("INSERT INTO videos (id, url) VALUES (?, ?)")
    .bind(VIDEO, `https://www.youtube.com/watch?v=${VIDEO}`)
    .run();

  for (let i = 0; i < withImages; i++) {
    await env.DB.prepare(
      `INSERT INTO images (r2_key, video_id, timestamp_seconds, phash, dedup_threshold)
            VALUES (?, ?, ?, ?, 10)`,
    )
      .bind(`frames/${VIDEO}/0000${i}.000.jpg`, VIDEO, i, "af3c9e1b2d4f7a80")
      .run();
  }
}

async function seedClass(name = "Paimon"): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO classes (name, appearance_prompt, prompt_version, active)
          VALUES (?, 'a small white-haired floating fairy companion', '2026-08-08-a', 0)
       RETURNING id`,
  )
    .bind(name)
    .first<{ id: number }>();

  if (!row) throw new Error("seeding a class returned no row");
  return row.id;
}

async function createDryRun(
  classId: number,
  body: unknown = { video_id: VIDEO, appearance_prompt: CANDIDATE },
) {
  return app.request(
    `/api/admin/classes/${classId}/dryrun`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(await adminHeaders()) },
      body: JSON.stringify(body),
    },
    env,
  );
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

function report(jobId: number, body: unknown) {
  return app.request(
    `/api/jobs/${jobId}/dryrun`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

const box = (r2_key: string, confidence = 0.4) => ({
  r2_key,
  x_min: 0.1,
  y_min: 0.1,
  x_max: 0.4,
  y_max: 0.5,
  confidence,
});

describe("POST /api/admin/classes/{id}/dryrun", () => {
  beforeEach(() => seedVideo());

  it("rejects an unauthenticated request", async () => {
    const classId = await seedClass();
    const res = await app.request(
      `/api/admin/classes/${classId}/dryrun`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ video_id: VIDEO, appearance_prompt: CANDIDATE }),
      },
      env,
    );

    expect(res.status).toBe(401);
  });

  it("queues a dryrun job carrying the candidate wording", async () => {
    const classId = await seedClass();

    const res = await createDryRun(classId);

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      class_id: classId,
      class_name: "Paimon",
      video_id: VIDEO,
      appearance_prompt: CANDIDATE,
      sample_size: DRYRUN_SAMPLE_SIZE,
      status: "pending",
      // Null, not empty: nothing has run, which is a different fact from a
      // prompt that matched nothing.
      boxes: null,
      sampled_keys: null,
      model_id: null,
      requested_by: ADMIN_EMAIL,
    });

    const job = await env.DB.prepare("SELECT kind, status FROM jobs WHERE id = ?")
      .bind(body.job_id)
      .first<{ kind: string; status: string }>();
    expect(job).toMatchObject({ kind: "dryrun", status: "pending" });
  });

  it("leaves the class's own prompt untouched", async () => {
    // The whole point is trying text that is *not* saved yet. A dry-run that
    // wrote the candidate onto the class would have activated it by the back
    // door, and would have bumped nothing.
    const classId = await seedClass();

    await createDryRun(classId);

    const klass = await env.DB.prepare(
      "SELECT appearance_prompt, prompt_version, active FROM classes WHERE id = ?",
    )
      .bind(classId)
      .first<{ appearance_prompt: string; prompt_version: string; active: number }>();

    expect(klass).toEqual({
      appearance_prompt: "a small white-haired floating fairy companion",
      prompt_version: "2026-08-08-a",
      active: 0,
    });
  });

  it("runs against a retired class, because that is when it is most useful", async () => {
    // M12.1 creates every class deactivated so this can happen first. A
    // dry-run that required an active class would invert the ordering the two
    // milestones exist to establish.
    const classId = await seedClass();

    expect((await createDryRun(classId)).status).toBe(201);
  });

  it("refuses a video with no extracted frames yet", async () => {
    // Sampling nothing reports nothing, which on screen is indistinguishable
    // from a prompt that matched nothing.
    await env.DB.prepare("DELETE FROM images").run();
    const classId = await seedClass();

    const res = await createDryRun(classId);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("no extracted frames"),
    });
  });

  it("answers 404 for an unknown class or an unknown video", async () => {
    const classId = await seedClass();

    expect((await createDryRun(9_999)).status).toBe(404);
    expect(
      (await createDryRun(classId, { video_id: "nope", appearance_prompt: CANDIDATE })).status,
    ).toBe(404);
  });

  it("allows a second dry-run against the same video — trying two wordings is the activity", async () => {
    const classId = await seedClass();

    expect((await createDryRun(classId)).status).toBe(201);
    expect(
      (await createDryRun(classId, { video_id: VIDEO, appearance_prompt: "a different wording" }))
        .status,
    ).toBe(201);
  });
});

describe("claiming a dryrun job", () => {
  beforeEach(() => seedVideo());

  it("hands the worker the candidate wording, not the class's current prompt", async () => {
    const classId = await seedClass();
    await createDryRun(classId);

    const res = await claim();

    expect(res.status).toBe(200);
    const job = (await res.json()) as Record<string, unknown>;
    expect(job).toMatchObject({
      kind: "dryrun",
      video_id: VIDEO,
      dryrun: {
        class_name: "Paimon",
        appearance_prompt: CANDIDATE,
        sample_size: DRYRUN_SAMPLE_SIZE,
      },
    });
    // The chunk work definition belongs to a different kind and must not
    // appear here.
    expect(job.chunk).toBeUndefined();
  });

  it("retires a dryrun job whose work definition is missing", async () => {
    // Reachable: `createDryRun` writes the job and its `dryruns` row in two
    // statements, so a failure between them leaves exactly this.
    await seedClass();
    await env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('dryrun', ?)")
      .bind(VIDEO)
      .run();

    const res = await claim();

    expect(res.status).toBe(204);
    const job = await env.DB.prepare("SELECT status, failure_reason FROM jobs").first<{
      status: string;
      failure_reason: string;
    }>();
    expect(job).toMatchObject({ status: "failed", failure_reason: "dryrun row missing" });
  });
});

describe("POST /api/jobs/{id}/dryrun", () => {
  beforeEach(() => seedVideo());

  async function queueAndClaim(): Promise<number> {
    const classId = await seedClass();
    await createDryRun(classId);
    const claimed = (await (await claim()).json()) as { id: number };
    return claimed.id;
  }

  it("records the boxes and what was sampled", async () => {
    const jobId = await queueAndClaim();

    const res = await report(jobId, {
      worker_id: "test-worker",
      model_id: "owlvit-base-patch32.onnx",
      boxes: [box(`frames/${VIDEO}/00000.000.jpg`, 0.41)],
      sampled_images: [`frames/${VIDEO}/00000.000.jpg`, `frames/${VIDEO}/00001.000.jpg`],
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ boxes: 1 });

    const row = await env.DB.prepare("SELECT * FROM dryruns WHERE job_id = ?")
      .bind(jobId)
      .first<{ model_id: string; boxes: string; sampled_keys: string; reported_at: number }>();
    expect(row?.model_id).toBe("owlvit-base-patch32.onnx");
    expect(JSON.parse(row?.boxes ?? "null")).toHaveLength(1);
    expect(JSON.parse(row?.sampled_keys ?? "null")).toHaveLength(2);
    expect(row?.reported_at).toBeGreaterThan(1_700_000_000);
  });

  it("writes nothing to predictions, and stamps no selection_reason", async () => {
    // The milestone's own words. A dry-run's boxes are not label data, and the
    // guarantee is that they never enter the table where label data lives.
    const jobId = await queueAndClaim();

    await report(jobId, {
      worker_id: "test-worker",
      model_id: "owlvit-base-patch32.onnx",
      boxes: [box(`frames/${VIDEO}/00000.000.jpg`)],
      sampled_images: [`frames/${VIDEO}/00000.000.jpg`],
    });

    const predictions = await env.DB.prepare("SELECT COUNT(*) AS count FROM predictions").first<{
      count: number;
    }>();
    expect(predictions?.count).toBe(0);

    const stamped = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM images WHERE selection_reason IS NOT NULL",
    ).first<{ count: number }>();
    expect(stamped?.count).toBe(0);
  });

  it("accepts an empty result — a prompt that matched nothing is a real answer", async () => {
    const jobId = await queueAndClaim();

    const res = await report(jobId, {
      worker_id: "test-worker",
      model_id: "owlvit-base-patch32.onnx",
      boxes: [],
      sampled_images: [`frames/${VIDEO}/00000.000.jpg`],
    });

    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT boxes, sampled_keys FROM dryruns WHERE job_id = ?")
      .bind(jobId)
      .first<{ boxes: string; sampled_keys: string }>();
    // `[]` over a non-empty sample, not null: the run happened and found
    // nothing, which is what the screen has to be able to say.
    expect(row?.boxes).toBe("[]");
    expect(JSON.parse(row?.sampled_keys ?? "null")).toHaveLength(1);
  });

  it("overwrites on a re-run rather than appending", async () => {
    // Nothing references a dry-run's boxes, so the latest attempt is simply
    // the answer — the opposite of `reportPredictions`, which appends because
    // its rows are referenced.
    const jobId = await queueAndClaim();

    await report(jobId, {
      worker_id: "test-worker",
      model_id: "owlvit-base-patch32.onnx",
      boxes: [box(`frames/${VIDEO}/00000.000.jpg`), box(`frames/${VIDEO}/00001.000.jpg`)],
      sampled_images: [`frames/${VIDEO}/00000.000.jpg`],
    });
    await report(jobId, {
      worker_id: "test-worker",
      model_id: "owlvit-base-patch32.onnx",
      boxes: [box(`frames/${VIDEO}/00000.000.jpg`)],
      sampled_images: [`frames/${VIDEO}/00000.000.jpg`],
    });

    const rows = await env.DB.prepare("SELECT boxes FROM dryruns WHERE job_id = ?")
      .bind(jobId)
      .all<{ boxes: string }>();
    expect(rows.results).toHaveLength(1);
    expect(JSON.parse(rows.results[0]?.boxes ?? "null")).toHaveLength(1);
  });

  it("refuses a worker that does not hold the lease", async () => {
    const jobId = await queueAndClaim();

    const res = await report(jobId, {
      worker_id: "some-other-worker",
      model_id: "owlvit-base-patch32.onnx",
      boxes: [],
      sampled_images: [],
    });

    expect(res.status).toBe(404);
  });

  it("refuses a job of the wrong kind with a 400, not a 404", async () => {
    // The lease is genuine; what is wrong is the request. A 404 would send the
    // worker hunting for a lease it still holds.
    await env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('download', ?)")
      .bind(VIDEO)
      .run();
    const claimed = (await (await claim()).json()) as { id: number };

    const res = await report(claimed.id, {
      worker_id: "test-worker",
      model_id: "owlvit-base-patch32.onnx",
      boxes: [],
      sampled_images: [],
    });

    expect(res.status).toBe(400);
  });

  it("rejects a box outside [0, 1] or with x_max below x_min", async () => {
    const jobId = await queueAndClaim();

    const outside = await report(jobId, {
      worker_id: "test-worker",
      model_id: "m",
      boxes: [{ ...box("k"), x_max: 1.4 }],
      sampled_images: [],
    });
    const inverted = await report(jobId, {
      worker_id: "test-worker",
      model_id: "m",
      boxes: [{ ...box("k"), x_min: 0.9, x_max: 0.2 }],
      sampled_images: [],
    });

    expect(outside.status).toBe(400);
    expect(inverted.status).toBe(400);
  });
});

describe("GET /api/admin/classes/{id}/dryruns", () => {
  beforeEach(() => seedVideo());

  async function listDryRuns(classId: number) {
    return app.request(
      `/api/admin/classes/${classId}/dryruns`,
      { headers: await adminHeaders() },
      env,
    );
  }

  it("rejects an unauthenticated request", async () => {
    const classId = await seedClass();

    const res = await app.request(`/api/admin/classes/${classId}/dryruns`, {}, env);

    expect(res.status).toBe(401);
  });

  it("returns the newest first, capped at the history bound", async () => {
    const classId = await seedClass();
    for (let i = 0; i < DRYRUN_HISTORY + 2; i++) {
      await createDryRun(classId, { video_id: VIDEO, appearance_prompt: `wording ${i}` });
    }

    const res = await listDryRuns(classId);
    const body = (await res.json()) as { dryruns: Array<{ appearance_prompt: string }> };

    expect(body.dryruns).toHaveLength(DRYRUN_HISTORY);
    expect(body.dryruns[0]?.appearance_prompt).toBe(`wording ${DRYRUN_HISTORY + 1}`);
  });

  it("joins the job's status rather than duplicating it", async () => {
    const classId = await seedClass();
    await createDryRun(classId);
    await claim();

    const res = await listDryRuns(classId);
    const body = (await res.json()) as { dryruns: Array<{ status: string }> };

    expect(body.dryruns[0]?.status).toBe("claimed");
  });

  it("carries the failure reason of a dry-run that failed", async () => {
    const classId = await seedClass();
    const created = (await (await createDryRun(classId)).json()) as { job_id: number };
    await env.DB.prepare("UPDATE jobs SET status = 'failed', failure_reason = ? WHERE id = ?")
      .bind("the detector sidecar is down", created.job_id)
      .run();

    const res = await listDryRuns(classId);
    const body = (await res.json()) as { dryruns: Array<{ failure_reason: string }> };

    expect(body.dryruns[0]?.failure_reason).toBe("the detector sidecar is down");
  });

  it("parses the stored boxes into the shape the contract declares", async () => {
    const classId = await seedClass();
    const created = (await (await createDryRun(classId)).json()) as { job_id: number };
    await claim();
    await report(created.job_id, {
      worker_id: "test-worker",
      model_id: "owlvit-base-patch32.onnx",
      boxes: [box(`frames/${VIDEO}/00000.000.jpg`, 0.41)],
      sampled_images: [`frames/${VIDEO}/00000.000.jpg`],
    });

    const res = await listDryRuns(classId);
    const body = (await res.json()) as {
      dryruns: Array<{ boxes: Array<{ r2_key: string; confidence: number }> }>;
    };

    // Objects, not the JSON string D1 stores — a client that had to parse a
    // string would be a client the OpenAPI document lies to.
    expect(body.dryruns[0]?.boxes).toEqual([
      {
        r2_key: `frames/${VIDEO}/00000.000.jpg`,
        x_min: 0.1,
        y_min: 0.1,
        x_max: 0.4,
        y_max: 0.5,
        confidence: 0.41,
      },
    ]);
  });

  it("answers an empty list for a class nobody has tried anything against", async () => {
    const classId = await seedClass();

    const res = await listDryRuns(classId);

    await expect(res.json()).resolves.toEqual({ dryruns: [] });
  });
});

describe("GET /api/admin/videos", () => {
  it("reports how many frames each video has, including none", async () => {
    await seedVideo(2);
    await env.DB.prepare("INSERT INTO videos (id, url, title) VALUES (?, ?, ?)")
      .bind("noframes123", "https://youtu.be/noframes123", "Not extracted yet")
      .run();

    const res = await app.request("/api/admin/videos", { headers: await adminHeaders() }, env);
    const body = (await res.json()) as {
      videos: Array<{ id: string; title: string | null; image_count: number }>;
    };

    expect(res.status).toBe(200);
    // A video with no frames is listed at zero rather than omitted: the form
    // has to be able to say why it cannot be dry-run against.
    expect(body.videos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: VIDEO, image_count: 2 }),
        expect.objectContaining({ id: "noframes123", image_count: 0 }),
      ]),
    );
  });

  it("rejects an unauthenticated request", async () => {
    const res = await app.request("/api/admin/videos", {}, env);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/admin/image", () => {
  it("streams an object out of the private bucket", async () => {
    await env.FRAMES.put("frames/dQw4w9WgXcQ/00000.000.jpg", "not-really-a-jpeg");

    const res = await app.request(
      "/api/admin/image?key=frames/dQw4w9WgXcQ/00000.000.jpg",
      { headers: await adminHeaders() },
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/jpeg");
    await expect(res.text()).resolves.toBe("not-really-a-jpeg");
  });

  it("answers 404 for a key with no object, rather than failing the page", async () => {
    const res = await app.request(
      "/api/admin/image?key=frames/dQw4w9WgXcQ/99999.000.jpg",
      { headers: await adminHeaders() },
      env,
    );

    expect(res.status).toBe(404);
  });

  it("rejects an unauthenticated request — the bucket stays private", async () => {
    await env.FRAMES.put("frames/dQw4w9WgXcQ/00000.000.jpg", "not-really-a-jpeg");

    const res = await app.request("/api/admin/image?key=frames/dQw4w9WgXcQ/00000.000.jpg", {}, env);

    expect(res.status).toBe(401);
  });
});
