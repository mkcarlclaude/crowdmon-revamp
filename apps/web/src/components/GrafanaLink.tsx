/**
 * Links out to the dashboard in infra/grafana/crowdmon-v1.json rather than
 * rendering any panel here.
 *
 * CONTEXT.md §7 draws the line deliberately: D1 holds business data
 * (annotations, dataset counts, model versions), OTel holds system data
 * (latency, throughput, queue depth, error rates), and "/admin shows the
 * first and links out for the second. Two dashboards that disagree will
 * disagree at the worst moment." Embedding a Grafana panel here — even one —
 * would be a second, drifting copy of a query this repo does not own the
 * datasource for; a plain anchor has nothing to drift.
 *
 * The href is a fixed public hostname, not a secret: `grafana.mkcarl.com` is
 * already documented in CONTEXT.md §2 and gated by its own Grafana auth, not
 * by anything this Worker controls.
 */
export function GrafanaLink() {
  return (
    <a
      href="https://grafana.mkcarl.com/d/crowdmon-v1/"
      target="_blank"
      rel="noreferrer"
      className="text-sm text-[var(--color-text-muted)] underline underline-offset-2 hover:text-[var(--color-text)]"
    >
      System health (Grafana) ↗
    </a>
  );
}
