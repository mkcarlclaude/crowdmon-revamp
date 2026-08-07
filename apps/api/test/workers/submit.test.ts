import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";

// /api/admin/* is gated (M3.5); these tests are about what the handler does
// once past the gate, so they carry a valid assertion throughout.
beforeAll(installAdminIdentity);
beforeEach(configureAccess);

async function submit(url: string) {
  return app.request(
    "/api/admin/videos",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(await adminHeaders()) },
      body: JSON.stringify({ url }),
    },
    env,
  );
}

const WATCH_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

describe("POST /api/admin/videos", () => {
  it("creates the video and its download job", async () => {
    const res = await submit(WATCH_URL);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { video_id: string; job_id: number };
    expect(body.video_id).toBe("dQw4w9WgXcQ");
    expect(body.job_id).toBeGreaterThan(0);

    // Read back through SQL rather than the API: there is no endpoint that
    // reports a job before it is claimed, and the columns that matter here
    // (kind, status) are exactly the ones a claim would consume.
    const job = await env.DB.prepare(
      "SELECT kind, video_id, status, attempts FROM jobs WHERE id = ?",
    )
      .bind(body.job_id)
      .first();
    expect(job).toEqual({
      kind: "download",
      video_id: "dQw4w9WgXcQ",
      status: "pending",
      attempts: 0,
    });

    const video = await env.DB.prepare("SELECT id, url FROM videos WHERE id = ?")
      .bind(body.video_id)
      .first();
    expect(video).toEqual({ id: "dQw4w9WgXcQ", url: WATCH_URL });
  });

  // app.request() here carries no active span — that only exists once
  // index.ts's instrument() wraps the fetch handler, which this test
  // deliberately bypasses (app.ts's own module comment explains why). The
  // W3C serialisation itself is proven on real spans in
  // test/node/traceparent.test.ts; what this pins down is the fallback: a
  // download job created with no active span must still be claimable, the
  // same as one from before migration 0002.
  it("stamps no traceparent when nothing is tracing the request (M9.2)", async () => {
    const res = await submit(WATCH_URL);
    const body = (await res.json()) as { job_id: number };

    const job = await env.DB.prepare("SELECT traceparent FROM jobs WHERE id = ?")
      .bind(body.job_id)
      .first<{ traceparent: string | null }>();

    expect(job?.traceparent).toBeNull();
  });

  it("rejects the same video a second time", async () => {
    await submit(WATCH_URL);
    const res = await submit(WATCH_URL);

    // Migration 0001 makes this certain, not incidental: the partial unique
    // index on (video_id) WHERE kind='download' means the API cannot get this
    // wrong under concurrency even if the handler forgot to look.
    expect(res.status).toBe(409);

    const { count } = (await env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE video_id = ?")
      .bind("dQw4w9WgXcQ")
      .first()) as { count: number };
    expect(count).toBe(1);
  });

  it.each([
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/abcdefghijk", "abcdefghijk"],
  ])("takes the id out of %s", async (url, expected) => {
    const res = await submit(url);

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ video_id: expected });
  });

  it.each([
    "https://example.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=tooshort",
    "https://www.youtube.com/",
  ])("refuses %s", async (url) => {
    const res = await submit(url);

    // A URL that passes `z.url()` but names no video would otherwise become a
    // videos row with a nonsense primary key, and a download job that can only
    // ever fail on the worker.
    expect(res.status).toBe(400);
  });
});
