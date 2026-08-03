import { trace } from "@opentelemetry/api";
import type { ReapedJob, ReapResult } from "./reaper";

/**
 * Reclaim visibility (M6.3).
 *
 * Spans rather than metrics, because there is no metrics pipeline to use:
 * @microlabs/otel-cf-workers exports traces only, so a counter would have
 * nowhere to go. Tempo's metrics-generator turns span rate into a series, which
 * is what makes "reclaim rate" a Grafana panel — but only if the *number of
 * spans* is the number of events. That is why this emits one span per job
 * rather than one span per tick with a count attribute: a count inside an
 * attribute is not a rate and cannot be made into one here.
 *
 * Two span names for the same reason. The metrics-generator's default
 * dimensions are service, span name, kind and status; an `outcome` attribute is
 * not among them, so splitting re-queues from retirements by attribute would
 * produce two things that are indistinguishable in Grafana.
 *
 * Kept apart from reaper.ts so the SQL can be tested inside workerd and this
 * can be tested on Node — @opentelemetry/api's ESM build does not resolve under
 * workerd's module loader.
 */

/** A lease that went stale and whose job is available again. */
export const RECLAIMED_SPAN = "job.reclaimed";

/** A job that went stale with no attempts left and is now terminally failed. */
export const RETIRED_SPAN = "job.retired";

const TRACER = "crowdmon.reaper";

/**
 * Records one span per job the reaper moved.
 *
 * Started and ended immediately: these are events, and their duration is
 * meaningless — the interesting quantity is how many there are. The active
 * context at call time is the scheduled handler's span, so each one lands as a
 * child of the tick that produced it and an operator can go from a rate spike
 * to the exact jobs behind it.
 */
export function recordReclaims({ requeued, retired }: ReapResult): void {
  const tracer = trace.getTracer(TRACER);

  // Totals on the tick's own span as well as one span per job. The per-job
  // spans are what a rate is built from; these are what makes a single tick
  // readable in Tempo without expanding it — including the healthy case,
  // where both are zero and there are no children at all.
  trace.getActiveSpan()?.setAttributes({
    "crowdmon.reaper.requeued": requeued.length,
    "crowdmon.reaper.retired": retired.length,
  });

  const emit = (name: string, job: ReapedJob) => {
    tracer
      .startSpan(name, {
        attributes: {
          "crowdmon.job.id": job.id,
          "crowdmon.job.kind": job.kind,
          "crowdmon.video.id": job.video_id,
          // How many claims the job had spent when it was taken back. A
          // reclaim at attempt 1 is a crash; a run of them climbing toward the
          // ceiling is a poison job on its way to being retired.
          "crowdmon.job.attempts": job.attempts,
        },
      })
      .end();
  };

  for (const job of requeued) emit(RECLAIMED_SPAN, job);
  for (const job of retired) emit(RETIRED_SPAN, job);
}
