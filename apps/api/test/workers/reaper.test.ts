import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { reapOptions, reapStaleJobs } from "../../src/reaper";
import { seedClaimedJob, seedDownloadJob } from "./seed";

/**
 * The reaper (M6.2), tested against a real D1 rather than a stand-in.
 *
 * Every guarantee here is a property of the SQL: the two `UPDATE`s must be
 * disjoint so no row is both re-queued and retired, and the rows `RETURNING`
 * hands back are what the caller counts and reports on. A fake `D1Database`
 * would be testing the fake.
 */

const OPTIONS = { staleAfterSeconds: 120, maxAttempts: 3 };

function jobRow(id: number) {
  return env.DB.prepare(
    `SELECT status, attempts, claimed_by, claimed_at, heartbeat_at, failure_reason
       FROM jobs WHERE id = ?`,
  )
    .bind(id)
    .first<{
      status: string;
      attempts: number;
      claimed_by: string | null;
      claimed_at: number | null;
      heartbeat_at: number | null;
      failure_reason: string | null;
    }>();
}

describe("reapStaleJobs", () => {
  it("returns a stale lease to pending and clears the holder", async () => {
    const id = await seedClaimedJob("aaaaaaaaaaa", { heartbeatAgo: 300, attempts: 1 });

    const result = await reapStaleJobs(env.DB, OPTIONS);

    expect(result.requeued).toHaveLength(1);
    expect(result.retired).toHaveLength(0);
    expect(await jobRow(id)).toMatchObject({
      status: "pending",
      // All three cleared together. A pending row still naming a holder reads
      // as claimed to anything that inspects it, and `claimed_at` left behind
      // makes the admin list show a lease that no longer exists.
      claimed_by: null,
      claimed_at: null,
      heartbeat_at: null,
    });
  });

  it("does not touch a lease that is still being renewed", async () => {
    const id = await seedClaimedJob("bbbbbbbbbbb", { heartbeatAgo: 30, attempts: 1 });

    const result = await reapStaleJobs(env.DB, OPTIONS);

    expect(result.requeued).toHaveLength(0);
    expect((await jobRow(id))?.status).toBe("claimed");
  });

  it("leaves the boundary alone rather than reaping it", async () => {
    // Exactly at the threshold is a lease that has not yet gone stale. The
    // comparison is strict for that reason, and this pins which side of the
    // boundary the reaper sits on.
    const id = await seedClaimedJob("ccccccccccc", { heartbeatAgo: 120, attempts: 1 });

    await reapStaleJobs(env.DB, OPTIONS);

    expect((await jobRow(id))?.status).toBe("claimed");
  });

  it("does not increment attempts", async () => {
    // `attempts` counts claims, not reaps (schema comment on the column). If
    // the reaper counted too, one crash would spend two attempts and the
    // ceiling would mean half what it says.
    const id = await seedClaimedJob("ddddddddddd", { heartbeatAgo: 300, attempts: 1 });

    await reapStaleJobs(env.DB, OPTIONS);

    expect((await jobRow(id))?.attempts).toBe(1);
  });

  it("retires a job that has exhausted its attempts instead of re-queueing it", async () => {
    const id = await seedClaimedJob("eeeeeeeeeee", { heartbeatAgo: 300, attempts: 3 });

    const result = await reapStaleJobs(env.DB, OPTIONS);

    expect(result.requeued).toHaveLength(0);
    expect(result.retired).toHaveLength(1);

    const row = await jobRow(id);
    expect(row).toMatchObject({ status: "failed", claimed_by: null, heartbeat_at: null });
    // The reason has to say the job ran out of attempts, not merely that it
    // failed: an operator reading the admin list needs to tell a poison job
    // apart from a worker that reported a real error.
    expect(row?.failure_reason).toMatch(/attempt/i);
  });

  it("retires rather than re-queues above the ceiling too", async () => {
    // A ceiling lowered after the fact leaves rows already past it. `>=`
    // rather than `=` is what stops those from being re-queued forever.
    const id = await seedClaimedJob("fffffffffff", { heartbeatAgo: 300, attempts: 9 });

    await reapStaleJobs(env.DB, OPTIONS);

    expect((await jobRow(id))?.status).toBe("failed");
  });

  it("reaps a claimed row whose heartbeat was never written", async () => {
    // Unreachable through the API — the claim writes `heartbeat_at` in the
    // same statement that sets `status = 'claimed'`. Covered because the
    // reaper is the only thing that could ever clear such a row, so a
    // predicate that skipped NULL would strand it permanently.
    const id = await seedClaimedJob("ggggggggggg", { heartbeatAgo: null, attempts: 1 });

    const result = await reapStaleJobs(env.DB, OPTIONS);

    expect(result.requeued).toHaveLength(1);
    expect((await jobRow(id))?.status).toBe("pending");
  });

  it("ignores jobs that are not held", async () => {
    const pending = await seedClaimedJob("hhhhhhhhhhh", { heartbeatAgo: 300, attempts: 1 });
    const done = await seedClaimedJob("iiiiiiiiiii", { heartbeatAgo: 300, attempts: 1 });
    const failed = await seedClaimedJob("jjjjjjjjjjj", { heartbeatAgo: 300, attempts: 1 });
    await env.DB.batch([
      env.DB.prepare("UPDATE jobs SET status = 'pending' WHERE id = ?").bind(pending),
      env.DB.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").bind(done),
      env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").bind(failed),
    ]);

    const result = await reapStaleJobs(env.DB, OPTIONS);

    expect(result.requeued).toHaveLength(0);
    expect(result.retired).toHaveLength(0);
  });

  it("reports each reaped job so the caller can record it", async () => {
    const id = await seedClaimedJob("kkkkkkkkkkk", { heartbeatAgo: 300, attempts: 2 });

    const result = await reapStaleJobs(env.DB, OPTIONS);

    // Ids and kinds, not just a count: M6.3 emits one span per event, and a
    // count alone cannot say which job moved.
    expect(result.requeued[0]).toMatchObject({
      id,
      kind: "download",
      video_id: "kkkkkkkkkkk",
      attempts: 2,
    });
  });

  it("splits a mixed batch between re-queued and retired", async () => {
    // The two statements run against one database in one batch. If their
    // predicates overlapped, a row could be re-queued and then retired in the
    // same tick — pending in the table but counted as a failure in Grafana.
    const retryable = await seedClaimedJob("lllllllllll", { heartbeatAgo: 300, attempts: 1 });
    const exhausted = await seedClaimedJob("mmmmmmmmmmm", { heartbeatAgo: 300, attempts: 3 });

    const result = await reapStaleJobs(env.DB, OPTIONS);

    expect(result.requeued.map((j) => j.id)).toEqual([retryable]);
    expect(result.retired.map((j) => j.id)).toEqual([exhausted]);
    expect((await jobRow(retryable))?.status).toBe("pending");
    expect((await jobRow(exhausted))?.status).toBe("failed");
  });

  it("is a no-op on an empty queue", async () => {
    const result = await reapStaleJobs(env.DB, OPTIONS);

    expect(result).toEqual({ requeued: [], retired: [] });
  });
});

describe("a job that crashes its worker every time", () => {
  it("stops being handed out once it has spent its attempts", async () => {
    // M6.1's actual claim, run rather than asserted a piece at a time: the
    // loop is claim -> crash -> reap -> claim, and nothing in a single
    // statement's test shows that it terminates. Driven through the real
    // claim endpoint so `attempts` is incremented by the code that owns it.
    await seedDownloadJob("nnnnnnnnnnn");

    const claim = () =>
      app.request(
        "/api/jobs/claim",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ worker_id: "doomed" }),
        },
        env,
      );

    // Crashing means the worker never reports anything, so the only way the
    // job moves is the reaper. Winding the heartbeat back is what a dead
    // worker looks like from the API's side.
    const crash = async () => {
      await env.DB.prepare("UPDATE jobs SET heartbeat_at = heartbeat_at - 600").run();
      return reapStaleJobs(env.DB, OPTIONS);
    };

    for (let attempt = 1; attempt < OPTIONS.maxAttempts; attempt++) {
      expect((await claim()).status, `claim ${attempt}`).toBe(200);
      const result = await crash();
      expect(result.requeued, `reap ${attempt}`).toHaveLength(1);
    }

    // The last one it gets.
    expect((await claim()).status).toBe(200);
    expect((await crash()).retired).toHaveLength(1);

    // And now the queue is empty rather than holding a job that would be
    // claimed, crash a worker, and come back forever.
    expect((await claim()).status).toBe(204);

    const row = await env.DB.prepare("SELECT status, attempts FROM jobs").first<{
      status: string;
      attempts: number;
    }>();
    expect(row).toMatchObject({ status: "failed", attempts: OPTIONS.maxAttempts });
  });
});

describe("reapOptions", () => {
  it("reads both thresholds from the environment", () => {
    expect(reapOptions({ LEASE_STALE_SECONDS: 120, MAX_ATTEMPTS: 3 })).toEqual({
      staleAfterSeconds: 120,
      maxAttempts: 3,
    });
  });

  it("reads the values the deployment is actually configured with", () => {
    // Against the real bindings, so a var deleted from wrangler.toml fails
    // here rather than at 00:05 in production.
    expect(() => reapOptions(env)).not.toThrow();
  });

  const BAD_VALUES: [string, unknown][] = [
    ["a missing value", undefined],
    ["a non-numeric string", "soon"],
    ["a trailing-unit string", "3 attempts"],
    ["zero", 0],
    ["a negative value", -1],
    ["a fraction", 1.5],
  ];

  it.each(BAD_VALUES)("refuses %s for LEASE_STALE_SECONDS", (_label, value) => {
    // Loudly, rather than falling back to a default. These live in
    // wrangler.toml and are pinned by a test, so a bad one means somebody
    // edited the deployment by hand — and a hand edit that silently did
    // nothing is the failure worth preventing.
    expect(() =>
      reapOptions({ LEASE_STALE_SECONDS: value as number, MAX_ATTEMPTS: 3 }),
    ).toThrowError(/LEASE_STALE_SECONDS/);
  });

  it.each(BAD_VALUES)("refuses %s for MAX_ATTEMPTS", (_label, value) => {
    // Asserted separately rather than assumed from the case above: the two
    // read different variables, and a copy-paste that validated
    // LEASE_STALE_SECONDS twice would leave a ceiling of NaN — under which
    // `attempts >= maxAttempts` is false for every row and nothing is ever
    // retired. A poison job would cycle forever with the ceiling in place.
    expect(() =>
      reapOptions({ LEASE_STALE_SECONDS: 120, MAX_ATTEMPTS: value as number }),
    ).toThrowError(/MAX_ATTEMPTS/);
  });
});
