import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";
import { seedClass, seedImage, seedPool, seedPrediction, seedVerdict } from "./labelling-seed";

/**
 * The business numbers behind /admin (M13.3, M13.4, M14.4).
 *
 * Two claims are under test. **Verdict counts are per source, and split by
 * kind on both sides of that split** — `accepted`/`adjusted`/`rejected` for
 * `admin`, `anon_accepted`/`anon_adjusted`/`anon_rejected` for `anon` —
 * because an anonymous troll rejecting everything is otherwise
 * indistinguishable from a model that got worse (CONTEXT.md §Q10). And
 * **the missing-report rate has an honest denominator**: the numerator is
 * per class, the denominator is `pool.images_verified`, and a report with no
 * class is counted in the pool total and attributed to nobody.
 */

beforeAll(installAdminIdentity);
beforeEach(configureAccess);

interface Stats {
  pool: {
    images_with_predictions: number;
    images_verified: number;
    images_remaining: number;
    missing_reports: number;
  };
  classes: Array<{
    class_id: number;
    name: string;
    active: boolean;
    predictions: number;
    accepted: number;
    adjusted: number;
    rejected: number;
    anon_accepted: number;
    anon_adjusted: number;
    anon_rejected: number;
    missing_reports: number;
  }>;
}

async function getStats(headers?: Record<string, string>): Promise<Response> {
  return app.request(
    "/api/admin/labelling/stats",
    { headers: headers ?? (await adminHeaders()) },
    env,
  );
}

async function reportMissing(imageId: number, classId: number | null): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO missing_reports (image_id, class_id, reporter) VALUES (?, ?, 'admin@example.com')",
  )
    .bind(imageId, classId)
    .run();
}

describe("the labelling pool", () => {
  it("counts only frames that carry a prediction", async () => {
    const { videoId } = await seedPool();
    await seedImage(videoId, 2);

    const stats = (await (await getStats()).json()) as Stats;

    expect(stats.pool).toMatchObject({
      images_with_predictions: 1,
      images_verified: 0,
      images_remaining: 1,
    });
  });

  it("moves a frame from remaining to verified once its boxes are ruled on", async () => {
    const { predictionId } = await seedPool();
    await seedVerdict(predictionId);

    const stats = (await (await getStats()).json()) as Stats;

    expect(stats.pool).toMatchObject({
      images_with_predictions: 1,
      images_verified: 1,
      images_remaining: 0,
    });
  });

  it("is empty rather than absent when nothing has been labelled", async () => {
    const stats = (await (await getStats()).json()) as Stats;

    expect(stats.pool).toEqual({
      images_with_predictions: 0,
      images_verified: 0,
      images_remaining: 0,
      missing_reports: 0,
    });
    expect(stats.classes).toEqual([]);
  });
});

describe("per-class counts", () => {
  it("splits verdicts by kind and by source", async () => {
    const { imageId, classId, predictionId } = await seedPool();
    const adjusted = await seedPrediction(imageId, classId);
    const anonAccepted = await seedPrediction(imageId, classId);
    const anonRejected = await seedPrediction(imageId, classId);

    await seedVerdict(predictionId, { verdict: "accept" });
    await env.DB.prepare(
      `INSERT INTO verdicts
            (prediction_id, verdict, adjusted_x_min, adjusted_y_min, adjusted_x_max,
             adjusted_y_max, source, annotator_id)
            VALUES (?, 'adjust', 0.1, 0.1, 0.2, 0.2, 'admin', 'admin@example.com')`,
    )
      .bind(adjusted)
      .run();
    await seedVerdict(anonAccepted, {
      verdict: "accept",
      source: "anon",
      annotatorId: "session-abc",
    });
    await seedVerdict(anonRejected, {
      verdict: "reject",
      source: "anon",
      annotatorId: "session-abc",
    });

    const stats = (await (await getStats()).json()) as Stats;

    expect(stats.classes).toHaveLength(1);
    expect(stats.classes[0]).toMatchObject({
      class_id: classId,
      name: "Paimon",
      active: true,
      predictions: 4,
      accepted: 1,
      adjusted: 1,
      // Neither anonymous verdict is in `accepted`/`rejected`: pooling the
      // tiers is what makes a troll look like a worse model.
      rejected: 0,
      anon_accepted: 1,
      anon_adjusted: 0,
      anon_rejected: 1,
    });
  });

  it("counts boxes ruled on, not verdict rows", async () => {
    // Several verdicts on one prediction is a legal state (migration 0003
    // refuses a uniqueness constraint on `prediction_id` on purpose), so
    // counting verdict rows against a `predictions` denominator would render
    // "1 box, 2 accepted" — a panel claiming more accepted boxes than boxes.
    const { predictionId } = await seedPool();
    await seedVerdict(predictionId, { verdict: "accept" });
    await seedVerdict(predictionId, { verdict: "accept", annotatorId: "someone-else@example.com" });

    const stats = (await (await getStats()).json()) as Stats;

    expect(stats.classes[0]).toMatchObject({ predictions: 1, accepted: 1 });
  });

  it("counts a box ruled two different ways in both columns", async () => {
    // Both are true of it, and the alternative — picking the newest — would be
    // this endpoint quietly deciding which human ruling counts.
    const { predictionId } = await seedPool();
    await seedVerdict(predictionId, { verdict: "accept" });
    await seedVerdict(predictionId, { verdict: "reject" });

    const stats = (await (await getStats()).json()) as Stats;

    expect(stats.classes[0]).toMatchObject({ predictions: 1, accepted: 1, rejected: 1 });
  });

  it("lists a class the detector has never produced a box for", async () => {
    // The starved-prompt case, and the reason this is a LEFT JOIN: a class
    // with no predictions is exactly the one an operator needs to see.
    await seedClass("Nahida");

    const stats = (await (await getStats()).json()) as Stats;

    expect(stats.classes).toEqual([
      expect.objectContaining({ name: "Nahida", predictions: 0, accepted: 0 }),
    ]);
  });

  it("keeps a retired class in the roster", async () => {
    await seedClass("Retired", { active: 0 });

    const stats = (await (await getStats()).json()) as Stats;

    expect(stats.classes[0]).toMatchObject({ name: "Retired", active: false });
  });

  it("counts missing reports against the class they name", async () => {
    const { imageId, classId } = await seedPool();
    await reportMissing(imageId, classId);
    await reportMissing(imageId, classId);

    const stats = (await (await getStats()).json()) as Stats;

    expect(stats.classes[0]?.missing_reports).toBe(2);
    expect(stats.pool.missing_reports).toBe(2);
  });

  it("attributes an unclassed report to the pool and to no class", async () => {
    const { imageId } = await seedPool();
    await reportMissing(imageId, null);

    const stats = (await (await getStats()).json()) as Stats;

    expect(stats.pool.missing_reports).toBe(1);
    expect(stats.classes[0]?.missing_reports).toBe(0);
  });

  it("does not let one class's reports inflate its prediction count", async () => {
    // The reason `missing_reports` is its own statement: joined into the
    // grouped pass, three reports would multiply every other count by three.
    const { imageId, classId } = await seedPool();
    await reportMissing(imageId, classId);
    await reportMissing(imageId, classId);
    await reportMissing(imageId, classId);

    const stats = (await (await getStats()).json()) as Stats;

    expect(stats.classes[0]?.predictions).toBe(1);
  });
});

describe("the gate", () => {
  it("refuses a request with no assertion", async () => {
    expect((await getStats({})).status).toBe(401);
  });
});
