import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";
import { seedSession, seedUser } from "./contributor-seed";
import { seedClass, seedImage, seedPool, seedPrediction, seedVerdict } from "./labelling-seed";
import { seedVideo } from "./seed";

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

  /**
   * The same shuffle_key keyset cursor `labellingBatchHandler` uses (M25.1,
   * plan §A3), exercised through this pool instead — `CONTRIBUTOR_UNRULED_BOX`
   * rather than `UNRULED_BOX`, and no `idx_images_admin_pool` to lean on
   * (plan §C), but the same forward-then-wrap mechanism.
   */
  it("pages forward through disjoint frames, then wraps once the cursor passes the top", async () => {
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    const classId = await seedClass("Paimon");

    const keys = [10, 20, 30];
    const idByKey = new Map<number, number>();
    for (const [i, shuffleKey] of keys.entries()) {
      const imageId = await seedImage(videoId, i + 1, { shuffleKey });
      await seedPrediction(imageId, classId);
      idByKey.set(shuffleKey, imageId);
    }

    interface ContributeBatchBody {
      images: Array<{ id: number }>;
      remaining: number;
      remaining_capped: boolean;
      next_cursor: number | null;
    }

    const first = (await (
      await asContributor("/api/contribute/batch?limit=2")
    ).json()) as ContributeBatchBody;
    expect(first.images.map((image) => image.id)).toEqual([idByKey.get(10), idByKey.get(20)]);
    expect(first.next_cursor).toBe(20);

    // Only one key (30) sits above cursor 20 — a short page that wraps back
    // to the bottom of the key space to fill out the rest, re-serving frame
    // 10 rather than stopping with an unruled frame left behind.
    const second = (await (
      await asContributor(`/api/contribute/batch?limit=2&cursor=${first.next_cursor}`)
    ).json()) as ContributeBatchBody;
    expect(second.images.map((image) => image.id)).toEqual([idByKey.get(30), idByKey.get(10)]);
    expect(second.remaining).toBe(3);
    // Below the cap, the count is exact and says so.
    expect(second.remaining_capped).toBe(false);
  });

  /**
   * The bounded count (M25.1, plan §C): this route is public and
   * unauthenticated, so its `remaining` is capped at `CONTRIBUTOR_REMAINING_CAP`
   * rather than an exact `COUNT(*)` — the admin pool's exact figure relies on
   * `unruled_admin`, which this pool has no denormalised column for.
   */
  it("caps remaining at 500 rather than scanning for the exact count past it", async () => {
    const videoId = "dQw4w9WgXcQ";
    await seedVideo(videoId);
    const classId = await seedClass("Paimon");

    const TOTAL = 505;
    for (let i = 0; i < TOTAL; i++) {
      const imageId = await seedImage(videoId, i + 1, { shuffleKey: i });
      await seedPrediction(imageId, classId);
    }

    const body = (await (await asContributor("/api/contribute/batch?limit=1")).json()) as {
      remaining: number;
      remaining_capped: boolean;
    };

    expect(body.remaining).toBe(500);
    // The bit `Math.min` would otherwise destroy. Without it, "exactly 500
    // left" and "at least 500 left" are the same number on the wire and the
    // client cannot render the cap as a cap.
    expect(body.remaining_capped).toBe(true);
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

/**
 * `CONTRIBUTE_BATCH_RATE_LIMITER` (M20, coordinator review of #158): the pool
 * endpoint mints presigned R2 URLs across the whole unruled pool, and an
 * account is the thing being bounded here, not an IP — `wrangler.toml`'s own
 * comment on this binding is why. Two contributors sharing no IP (this test
 * harness sends no `cf-connecting-ip` at all, so an IP-keyed limiter would
 * conflate every caller into the one `"unknown"` bucket the same way
 * `public-rate-limit.test.ts` relies on) still get independent budgets,
 * which is the property a user-id key buys over an IP one and the thing this
 * suite exists to prove.
 */
describe("the contribute batch rate limit", () => {
  it("admits the first 10 requests and refuses the 11th, for one contributor", async () => {
    const userId = await seedUser();
    const { cookieHeader } = await seedSession(userId);

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await app.request(
        "/api/contribute/batch",
        { headers: { cookie: cookieHeader } },
        env,
      );
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
  });

  it("gives a second contributor their own budget rather than sharing the first one's", async () => {
    const exhaustedUserId = await seedUser();
    const { cookieHeader: exhaustedCookie } = await seedSession(exhaustedUserId);
    for (let i = 0; i < 10; i++) {
      await app.request("/api/contribute/batch", { headers: { cookie: exhaustedCookie } }, env);
    }
    const exhausted = await app.request(
      "/api/contribute/batch",
      { headers: { cookie: exhaustedCookie } },
      env,
    );
    expect(exhausted.status).toBe(429);

    const freshUserId = await seedUser();
    const { cookieHeader: freshCookie } = await seedSession(freshUserId);
    const fresh = await app.request(
      "/api/contribute/batch",
      { headers: { cookie: freshCookie } },
      env,
    );

    expect(fresh.status).toBe(200);
  });
});
