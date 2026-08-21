import type { Bindings } from "./bindings";
import { reapOptions, reapStaleJobs } from "./reaper";
import { recordReclaims } from "./reclaim-spans";
import { reapExpiredSessions } from "./session-reaper";

/**
 * The Cron Trigger's handler (M6.2; M20 plan §B2 adds the session sweep).
 *
 * Wiring only, and deliberately so: the SQL is in reaper.ts and
 * session-reaper.ts where it can be tested inside workerd against a real D1,
 * and the telemetry is in reclaim-spans.ts where it can be tested on Node.
 * What is left here is the one thing none of those can cover — that they are
 * called, in this order, with the deployment's own configuration.
 *
 * The schedule itself is not in wrangler.toml — Terraform owns it. See
 * CONTEXT.md §Q14 for why that is safe and what would break it.
 */
export const scheduled: ExportedHandlerScheduledHandler<Bindings> = async (_controller, env) => {
  // Not wrapped in a try/catch. A throw here fails the invocation, which is
  // visible in the dashboard and on the trace; swallowing it would leave a
  // reaper that has silently stopped recovering crashed jobs, and nothing in
  // the system would report that.
  recordReclaims(await reapStaleJobs(env.DB, reapOptions(env)));

  // Independent of the job reaper above — a session sweep failing has no
  // bearing on whether a stale lease got taken back, and the reverse. Run
  // after rather than before for no reason stronger than reading top to
  // bottom as "jobs, then sessions"; nothing about correctness depends on the
  // order.
  await reapExpiredSessions(env.DB);
};
