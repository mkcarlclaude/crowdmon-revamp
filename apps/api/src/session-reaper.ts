/**
 * Sweeps expired contributor sessions (M20, plan §B2: "expired sessions are
 * deleted by the existing reaper cron, not by a new schedule").
 *
 * `requireUser` already refuses an expired session on read — this exists only
 * to keep `sessions` from growing forever, the same "the lease already means
 * nothing, cleanup is a separate later concern" split `reaper.ts` draws for
 * stale job leases. Piggybacked onto `scheduled.ts`'s existing cron invocation
 * rather than a second Cron Trigger of its own: Terraform owns that schedule
 * (CONTEXT.md §Q14), and a table this small growing until the next tick is not
 * worth a second trigger, a second Terraform resource and a second thing to
 * remember exists.
 *
 * `idx_sessions_expires` (migration 0012) is what makes this a cheap scan
 * rather than a full-table one.
 */
export async function reapExpiredSessions(db: D1Database): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  return result.meta.changes ?? 0;
}
