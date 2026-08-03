import type { Bindings } from "./bindings";
import { reapOptions, reapStaleJobs } from "./reaper";
import { recordReclaims } from "./reclaim-spans";

/**
 * The Cron Trigger's handler (M6.2).
 *
 * Wiring only, and deliberately so: the SQL is in reaper.ts where it can be
 * tested inside workerd against a real D1, and the telemetry is in
 * reclaim-spans.ts where it can be tested on Node. What is left here is the
 * one thing neither can cover — that the two are called, in that order, with
 * the deployment's own configuration.
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
};
