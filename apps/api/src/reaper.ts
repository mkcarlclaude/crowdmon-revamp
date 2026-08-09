/**
 * Crash recovery (M6.1, M6.2).
 *
 * A worker holds a job by renewing `heartbeat_at` every 30s (CONTEXT.md §Q14).
 * A worker that dies stops renewing and says nothing — there is no signal to
 * catch, which is the entire reason this runs on a schedule rather than in
 * response to something. Everything the queue promises about surviving a crash
 * is this function.
 *
 * Kept out of the routes so it can be tested by calling it, and so the
 * scheduled handler in index.ts stays the wiring it ought to be.
 */

/** A job the reaper moved, carried out so the caller can record it (M6.3). */
export interface ReapedJob {
  id: number;
  kind: "download" | "chunk" | "prelabel" | "dryrun" | "snapshot";
  // Null exactly for a stale `snapshot` job (migration 0008, M15.1) — it
  // names no video, so `recordReclaims` (reclaim-spans.ts) has to leave the
  // `crowdmon.video.id` attribute off its span rather than reading one.
  video_id: string | null;
  attempts: number;
}

export interface ReapResult {
  /** Leases that went stale and are available again. */
  requeued: ReapedJob[];
  /** Jobs that went stale with no attempts left, now terminally `failed`. */
  retired: ReapedJob[];
}

export interface ReapOptions {
  /**
   * How long a lease may go unrenewed before the job is taken back. A multiple
   * of the 30s heartbeat interval, not of the cron period: the cron decides how
   * *often* staleness is noticed, this decides what staleness is.
   */
  staleAfterSeconds: number;
  /**
   * How many claims a job gets before it is retired instead of re-queued.
   * `attempts` is incremented on claim, so this counts runs, including the ones
   * that ended in a crash.
   */
  maxAttempts: number;
}

const RETIRED_REASON = "exhausted its attempts without reporting an outcome";

/**
 * Reads the reaper's two thresholds from the environment.
 *
 * Throws rather than falling back to defaults. The values live in
 * `wrangler.toml`'s `[vars]` and are pinned by a test, so the only way to reach
 * a malformed one is to have edited the deployment's variables by hand — and a
 * hand edit that silently did nothing is worse than a cron invocation that
 * fails visibly. The same reasoning as the worker's `config.Load`: a
 * misconfigured process should say so, not run on values nobody chose.
 */
export function reapOptions(env: {
  LEASE_STALE_SECONDS: number;
  MAX_ATTEMPTS: number;
}): ReapOptions {
  return {
    staleAfterSeconds: positiveInteger(env.LEASE_STALE_SECONDS, "LEASE_STALE_SECONDS"),
    maxAttempts: positiveInteger(env.MAX_ATTEMPTS, "MAX_ATTEMPTS"),
  };
}

function positiveInteger(value: unknown, name: string): number {
  // `Number` rather than `parseInt`: a var set to "3 apples" should be an
  // error, and parseInt would read it as 3.
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }

  return parsed;
}

/**
 * Takes back every lease that has gone stale, retiring the ones with no
 * attempts left.
 *
 * The two statements are deliberately disjoint on `attempts` and run in one
 * `batch()`. Disjoint, because a row matched by both would be re-queued and
 * then retired within the same tick — `pending` in the table while Grafana
 * counted it as a failure. One batch, because D1 wraps a batch in a
 * transaction and this is one decision about one set of rows, not two.
 *
 * Neither statement touches `attempts`. The counter belongs to the claim
 * (`routes/jobs.ts`), and a reaper that also incremented it would spend two
 * attempts per crash, quietly halving the ceiling.
 */
export async function reapStaleJobs(
  db: D1Database,
  { staleAfterSeconds, maxAttempts }: ReapOptions,
): Promise<ReapResult> {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - staleAfterSeconds;

  // `heartbeat_at IS NULL` cannot happen through the API: the claim writes the
  // timestamp in the same statement that sets `status = 'claimed'`. It is
  // matched anyway because the reaper is the only thing that could ever move
  // such a row, so a predicate that skipped NULL would strand it as `claimed`
  // for good — and the partial index on `heartbeat_at WHERE status='claimed'`
  // covers NULL entries too.
  const STALE_LEASE = "status = 'claimed' AND (heartbeat_at IS NULL OR heartbeat_at < ?)";

  // Cleared together with the status. A row left naming a holder reads as
  // claimed to the admin list and to anything else that inspects it, and the
  // partial index goes on covering it.
  const RELEASE_LEASE = "claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL, updated_at = ?";

  const RETURNING_MOVED = "RETURNING id, kind, video_id, attempts";

  const results = await db.batch<ReapedJob>([
    db
      .prepare(
        `UPDATE jobs SET status = 'pending', ${RELEASE_LEASE}
          WHERE ${STALE_LEASE} AND attempts < ?
          ${RETURNING_MOVED}`,
      )
      .bind(now, cutoff, maxAttempts),
    // `>=` rather than `=`: lowering the ceiling leaves rows already past it,
    // and those must retire rather than cycle forever.
    db
      .prepare(
        `UPDATE jobs SET status = 'failed', failure_reason = ?, ${RELEASE_LEASE}
          WHERE ${STALE_LEASE} AND attempts >= ?
          ${RETURNING_MOVED}`,
      )
      .bind(RETIRED_REASON, now, cutoff, maxAttempts),
  ]);

  // Positional, because `batch` answers in statement order. Read defensively
  // rather than destructured: an empty array here would mean D1 returned
  // nothing for statements it ran, and silently reporting "reaped nothing"
  // would be indistinguishable from a healthy tick.
  const [requeued, retired] = results;
  if (!requeued || !retired) {
    throw new Error(`the reaper's batch returned ${results.length} results, expected 2`);
  }

  return { requeued: requeued.results, retired: retired.results };
}
