import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";
import { seedSession, seedUser } from "./contributor-seed";
import { seedImage, seedPool, seedPrediction, seedVerdict } from "./labelling-seed";

/**
 * `/api/contribute/*` (M20, plan §B3, §B4, §B5, §B6).
 *
 * `requireUser` is under test as much as the three routes are — plan §B6
 * asks specifically that a caller with no cookie is refused, and that an
 * *admin's* Access assertion with no session cookie is refused identically,
 * because the two middlewares answer different questions (`middleware/
 * session.ts`'s own module comment) and neither route tree should ever
 * accept the other's proof of identity.
 */

beforeAll(installAdminIdentity);
beforeEach(configureAccess);

async function asContributor(
  path: string,
  init: RequestInit = {},
  overrides: { userId?: number; trusted?: 0 | 1 } = {},
): Promise<Response> {
  const userId = overrides.userId ?? (await seedUser({ trusted: overrides.trusted ?? 0 }));
  const { cookieHeader } = await seedSession(userId);

  return app.request(path, { ...init, headers: { ...init.headers, cookie: cookieHeader } }, env);
}

describe("requireUser gates /api/contribute/*", () => {
  it("refuses a request with no session cookie", async () => {
    const res = await app.request("/api/contribute/me", {}, env);
    expect(res.status).toBe(401);
  });

  it("refuses a valid admin Access assertion with no session cookie — the two gates are different questions", async () => {
    const res = await app.request("/api/contribute/me", { headers: await adminHeaders() }, env);
    expect(res.status).toBe(401);
  });

  it("refuses an expired session", async () => {
    const userId = await seedUser();
    const { cookieHeader } = await seedSession(userId, { expiresIn: -60 });

    const res = await app.request("/api/contribute/me", { headers: { cookie: cookieHeader } }, env);
    expect(res.status).toBe(401);
  });

  it("refuses an unknown session id", async () => {
    const res = await app.request(
      "/api/contribute/me",
      { headers: { cookie: "cm_session=not-a-real-session" } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("admits a valid, unexpired session", async () => {
    const res = await asContributor("/api/contribute/me");
    expect(res.status).toBe(200);
  });
});

describe("GET /api/contribute/batch", () => {
  it("returns a frame with an unruled box", async () => {
    const { imageId, predictionId } = await seedPool();

    const res = await asContributor("/api/contribute/batch");
    const body = (await res.json()) as {
      images: Array<{ id: number; predictions: Array<{ id: number }> }>;
    };

    expect(res.status).toBe(200);
    expect(body.images).toHaveLength(1);
    expect(body.images[0]).toMatchObject({ id: imageId });
    expect(body.images[0]?.predictions.map((box) => box.id)).toEqual([predictionId]);
  });

  it("drops a box an admin has already ruled on — contributors must not redo the admin's work", async () => {
    const { predictionId } = await seedPool();
    await seedVerdict(predictionId, { source: "admin" });

    const res = await asContributor("/api/contribute/batch");
    const body = (await res.json()) as { images: unknown[] };

    expect(body.images).toEqual([]);
  });

  it("drops a box a trusted user has already ruled on", async () => {
    const { predictionId } = await seedPool();
    const trustedUserId = await seedUser({ trusted: 1 });
    await seedVerdict(predictionId, { source: "user", annotatorId: String(trustedUserId) });

    const res = await asContributor("/api/contribute/batch");
    const body = (await res.json()) as { images: unknown[] };

    expect(body.images).toEqual([]);
  });

  it("keeps a box an untrusted user has already ruled on — an unpromoted account cannot single-handedly exhaust the pool", async () => {
    const { predictionId, imageId } = await seedPool();
    const untrustedUserId = await seedUser({ trusted: 0 });
    await seedVerdict(predictionId, { source: "user", annotatorId: String(untrustedUserId) });

    const res = await asContributor("/api/contribute/batch");
    const body = (await res.json()) as { images: Array<{ id: number }> };

    expect(body.images.map((image) => image.id)).toEqual([imageId]);
  });

  it("ignores an anonymous verdict, matching the admin pool's own rule", async () => {
    const { predictionId, imageId } = await seedPool();
    await seedVerdict(predictionId, { source: "anon", annotatorId: "anon-session-1" });

    const res = await asContributor("/api/contribute/batch");
    const body = (await res.json()) as { images: Array<{ id: number }> };

    expect(body.images.map((image) => image.id)).toEqual([imageId]);
  });

  it("is gated: no cookie, no batch", async () => {
    await seedPool();
    const res = await app.request("/api/contribute/batch", {}, env);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/contribute/images/{id}/verdicts", () => {
  it("writes source = 'user' with the contributor's numeric user id, allowing adjust", async () => {
    const { imageId, predictionId } = await seedPool();
    const userId = await seedUser({ trusted: 0 });
    const { cookieHeader } = await seedSession(userId);

    const res = await app.request(
      `/api/contribute/images/${imageId}/verdicts`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookieHeader },
        body: JSON.stringify({
          verdicts: [
            {
              prediction_id: predictionId,
              verdict: "adjust",
              adjusted_x_min: 0.1,
              adjusted_y_min: 0.1,
              adjusted_x_max: 0.4,
              adjusted_y_max: 0.4,
            },
          ],
        }),
      },
      env,
    );

    expect(res.status).toBe(201);

    const row = await env.DB.prepare(
      "SELECT source, annotator_id, verdict FROM verdicts WHERE prediction_id = ?",
    )
      .bind(predictionId)
      .first<{ source: string; annotator_id: string; verdict: string }>();

    expect(row).toEqual({ source: "user", annotator_id: String(userId), verdict: "adjust" });
  });

  it("404s a prediction that is not on the named frame", async () => {
    const { imageId, classId, videoId } = await seedPool();
    const otherImageId = await seedImage(videoId, 2);
    const otherPredictionId = await seedPrediction(otherImageId, classId);

    const res = await asContributor(`/api/contribute/images/${imageId}/verdicts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdicts: [{ prediction_id: otherPredictionId, verdict: "accept" }] }),
    });

    expect(res.status).toBe(404);
  });

  it("is gated: no cookie, no write", async () => {
    const { imageId, predictionId } = await seedPool();

    const res = await app.request(
      `/api/contribute/images/${imageId}/verdicts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verdicts: [{ prediction_id: predictionId, verdict: "accept" }] }),
      },
      env,
    );

    expect(res.status).toBe(401);
  });
});

describe("GET /api/contribute/me", () => {
  it("counts only this contributor's own verdicts, by kind, and distinct frames touched", async () => {
    const { imageId: image1, classId, videoId } = await seedPool();
    const image2 = await seedImage(videoId, 2);
    const prediction2 = await seedPrediction(image2, classId);
    const prediction3 = await seedPrediction(image2, classId);

    const userId = await seedUser({ email: "me@example.com", displayName: "Me", trusted: 1 });
    const { cookieHeader } = await seedSession(userId);

    // Two verdicts on the same frame (image2) plus one on image1 — three
    // verdicts, two distinct frames.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO verdicts (prediction_id, verdict, source, annotator_id) VALUES (?, 'accept', 'user', ?)`,
      ).bind(prediction2, String(userId)),
      env.DB.prepare(
        `INSERT INTO verdicts (prediction_id, verdict, source, annotator_id) VALUES (?, 'reject', 'user', ?)`,
      ).bind(prediction3, String(userId)),
    ]);

    // A different contributor's verdict on image1 — must not be counted.
    const otherUserId = await seedUser({ email: "other@example.com" });
    const pool = await env.DB.prepare("SELECT id FROM predictions WHERE image_id = ?")
      .bind(image1)
      .first<{ id: number }>();
    if (pool) {
      await env.DB.prepare(
        `INSERT INTO verdicts (prediction_id, verdict, source, annotator_id) VALUES (?, 'accept', 'user', ?)`,
      )
        .bind(pool.id, String(otherUserId))
        .run();
    }

    const res = await app.request("/api/contribute/me", { headers: { cookie: cookieHeader } }, env);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      email: "me@example.com",
      display_name: "Me",
      trusted: true,
      frames_touched: 1,
      verdicts: { accept: 1, adjust: 0, reject: 1 },
    });
  });

  it("is honest that trusted defaults to false for a brand-new account", async () => {
    const res = await asContributor("/api/contribute/me", {}, { trusted: 0 });
    const body = await res.json();
    expect(body).toMatchObject({ trusted: false });
  });
});
