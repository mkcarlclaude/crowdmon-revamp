import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../../src/app";

function submit(url: string) {
  return app.request(
    "/api/admin/videos",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
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
