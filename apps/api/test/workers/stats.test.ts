import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { seedClaimedJob, seedDownloadJob, seedVideo } from "./seed";

async function stats() {
  return app.request("/api/jobs/stats", {}, env);
}

describe("GET /api/jobs/stats", () => {
  it("zero-fills every status and kind combination on an empty queue", async () => {
    const res = await stats();

    expect(res.status).toBe(200);
    // Every one of the twenty combinations is present at zero rather than
    // missing — this is the shape the Go worker's queue.depth gauge callback
    // depends on to tell a drained queue apart from a worker that stopped
    // reporting (schemas.ts's JobStats comment).
    expect(await res.json()).toEqual({
      pending: { download: 0, chunk: 0, prelabel: 0, dryrun: 0, snapshot: 0 },
      claimed: { download: 0, chunk: 0, prelabel: 0, dryrun: 0, snapshot: 0 },
      done: { download: 0, chunk: 0, prelabel: 0, dryrun: 0, snapshot: 0 },
      failed: { download: 0, chunk: 0, prelabel: 0, dryrun: 0, snapshot: 0 },
    });
  });

  it("counts jobs by status and kind", async () => {
    await seedVideo("aaaaaaaaaaa");
    await seedVideo("bbbbbbbbbbb");
    await seedVideo("ccccccccccc");
    // One download (and, since migration 0005, one prelabel) per video —
    // idx_jobs_one_download_per_video and idx_jobs_one_prelabel_per_video —
    // so each status below needs its own video row; chunk jobs carry no such
    // limit.
    await env.DB.prepare(
      `INSERT INTO jobs (kind, video_id, status) VALUES
        ('download', 'aaaaaaaaaaa', 'pending'),
        ('chunk',    'aaaaaaaaaaa', 'pending'),
        ('chunk',    'aaaaaaaaaaa', 'pending'),
        ('download', 'bbbbbbbbbbb', 'claimed'),
        ('chunk',    'bbbbbbbbbbb', 'done'),
        ('prelabel', 'bbbbbbbbbbb', 'pending'),
        ('download', 'ccccccccccc', 'failed')`,
    ).run();

    const res = await stats();

    expect(await res.json()).toEqual({
      pending: { download: 1, chunk: 2, prelabel: 1, dryrun: 0, snapshot: 0 },
      claimed: { download: 1, chunk: 0, prelabel: 0, dryrun: 0, snapshot: 0 },
      done: { download: 0, chunk: 1, prelabel: 0, dryrun: 0, snapshot: 0 },
      failed: { download: 1, chunk: 0, prelabel: 0, dryrun: 0, snapshot: 0 },
    });
  });

  it("carries no Access assertion, matching claim, heartbeat and complete", async () => {
    // This sits beside the other worker-facing /api/jobs/* routes, none of
    // which requireAccess gates (app.ts only gates /api/admin/*). No
    // Cf-Access-Jwt-Assertion header is sent, and the answer must still be
    // 200 rather than the 401/403 requireAccess would produce.
    await seedDownloadJob("ddddddddddd");

    const res = await stats();

    expect(res.status).toBe(200);
  });

  it("counts a claimed job", async () => {
    await seedClaimedJob("eeeeeeeeeee", { heartbeatAgo: 0, attempts: 1 });

    const res = await stats();

    expect(await res.json()).toMatchObject({ claimed: { download: 1, chunk: 0 } });
  });
});
