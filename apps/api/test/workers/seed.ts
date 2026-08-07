import { env } from "cloudflare:test";

/**
 * Rows written straight to D1 rather than through the API.
 *
 * Chunk jobs have no submit endpoint — M7.2's fan-out creates them — so a test
 * that wants one has to write it. Download jobs go through SQL here too, so
 * the queue tests are not also testing the submit handler.
 */

export async function seedVideo(id: string) {
  await env.DB.prepare("INSERT INTO videos (id, url) VALUES (?, ?)")
    .bind(id, `https://www.youtube.com/watch?v=${id}`)
    .run();
}

/**
 * `traceparent` defaults to null, matching every row from before migration
 * 0002 and every submit that ran with no active span (M9.2) — the common
 * case for the tests that do not care about it at all.
 */
export async function seedDownloadJob(videoId: string, traceparent: string | null = null) {
  await seedVideo(videoId);
  await env.DB.prepare("INSERT INTO jobs (kind, video_id, traceparent) VALUES ('download', ?, ?)")
    .bind(videoId, traceparent)
    .run();
}

/**
 * A job already held by a worker, with its lease aged on purpose.
 *
 * The reaper's whole input is a row someone stopped renewing, and there is no
 * API call that produces one — a worker that crashes simply stops. Written as
 * SQL rather than claim-then-rewind so a test can state the lease age and the
 * attempt count it means to exercise, instead of deriving them.
 *
 * `heartbeatAgo` is seconds before now; `null` writes no heartbeat at all,
 * which the claim endpoint cannot produce but the reaper still has to handle.
 */
export async function seedClaimedJob(
  videoId: string,
  { heartbeatAgo, attempts }: { heartbeatAgo: number | null; attempts: number },
): Promise<number> {
  await seedVideo(videoId);

  const claimedAt = Math.floor(Date.now() / 1000) - (heartbeatAgo ?? 0);

  const row = await env.DB.prepare(
    `INSERT INTO jobs (kind, video_id, status, attempts, claimed_by, claimed_at, heartbeat_at)
          VALUES ('download', ?, 'claimed', ?, 'test-worker', ?, ?)
       RETURNING id`,
  )
    .bind(videoId, attempts, claimedAt, heartbeatAgo === null ? null : claimedAt)
    .first<{ id: number }>();

  if (!row) throw new Error("seedClaimedJob inserted nothing");
  return row.id;
}
