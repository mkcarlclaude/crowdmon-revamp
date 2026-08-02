import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";

// /api/admin/* is gated (M3.5); these tests are about what the handler does
// once past the gate, so they carry a valid assertion throughout.
beforeAll(installAdminIdentity);
beforeEach(configureAccess);

describe("GET /api/admin/jobs", () => {
  beforeEach(async () => {
    await env.DB.prepare("INSERT INTO videos (id, url) VALUES (?, ?)")
      .bind("dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
      .run();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await app.request("/api/admin/jobs", {}, env);
    expect(res.status).toBe(401);
  });

  it("returns the server clock alongside the jobs", async () => {
    const res = await app.request("/api/admin/jobs", { headers: await adminHeaders() }, env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { now: number; jobs: unknown[] };
    // Seconds, matching migration 0001 — not milliseconds. A UI subtracting
    // seconds from milliseconds shows every worker as decades stale.
    expect(body.now).toBeGreaterThan(1_700_000_000);
    expect(body.now).toBeLessThan(4_000_000_000);
  });

  it("reports lease state for a claimed job", async () => {
    await env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('download', ?)")
      .bind("dQw4w9WgXcQ")
      .run();
    await app.request(
      "/api/jobs/claim",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worker_id: "test-worker" }),
      },
      env,
    );

    const res = await app.request("/api/admin/jobs", { headers: await adminHeaders() }, env);
    const body = (await res.json()) as { jobs: Array<Record<string, unknown>> };

    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]).toMatchObject({
      kind: "download",
      video_id: "dQw4w9WgXcQ",
      status: "claimed",
      attempts: 1,
      claimed_by: "test-worker",
    });
    expect(body.jobs[0]?.heartbeat_at).toBeTypeOf("number");
  });

  it("returns nulls rather than omitting unset lease columns", async () => {
    await env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('download', ?)")
      .bind("dQw4w9WgXcQ")
      .run();

    const res = await app.request("/api/admin/jobs", { headers: await adminHeaders() }, env);
    const body = (await res.json()) as { jobs: Array<Record<string, unknown>> };

    // Explicit null, not absent: the UI distinguishes "never claimed" from
    // "the API did not say", and an optional field collapses the two.
    expect(body.jobs[0]).toHaveProperty("claimed_by", null);
    expect(body.jobs[0]).toHaveProperty("failure_reason", null);
  });

  it("includes chunk work definition on chunk jobs", async () => {
    const job = await env.DB.prepare(
      "INSERT INTO jobs (kind, video_id) VALUES ('chunk', ?) RETURNING id",
    )
      .bind("dQw4w9WgXcQ")
      .first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO chunks (job_id, video_id, segment_index, start_seconds, end_seconds) VALUES (?, ?, 0, 0, 60)",
    )
      .bind(job?.id, "dQw4w9WgXcQ")
      .run();

    const res = await app.request("/api/admin/jobs", { headers: await adminHeaders() }, env);
    const body = (await res.json()) as { jobs: Array<{ chunk?: { end_seconds: number } }> };

    expect(body.jobs[0]?.chunk).toMatchObject({ segment_index: 0, end_seconds: 60 });
  });

  it("does not include a chunk field on a download job", async () => {
    await env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('download', ?)")
      .bind("dQw4w9WgXcQ")
      .run();

    const res = await app.request("/api/admin/jobs", { headers: await adminHeaders() }, env);
    const body = (await res.json()) as { jobs: Array<Record<string, unknown>> };

    expect(body.jobs[0]).not.toHaveProperty("chunk");
  });

  it("orders newest first and honours the limit", async () => {
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('chunk', ?)")
        .bind("dQw4w9WgXcQ")
        .run();
    }

    const res = await app.request(
      "/api/admin/jobs?limit=2",
      { headers: await adminHeaders() },
      env,
    );
    const body = (await res.json()) as { jobs: Array<{ id: number }> };

    expect(body.jobs).toHaveLength(2);
    expect(body.jobs[0]?.id ?? 0).toBeGreaterThan(body.jobs[1]?.id ?? 0);
  });

  it("rejects a limit outside the accepted range", async () => {
    const res = await app.request(
      "/api/admin/jobs?limit=99999",
      { headers: await adminHeaders() },
      env,
    );
    expect(res.status).toBe(400);
  });
});
