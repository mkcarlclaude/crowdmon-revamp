import { useLabellingStats } from "../api/queries";

/**
 * What the pool looks like from above (M13.3, M13.4).
 *
 * **Business data here, system data in Grafana** — CONTEXT.md §7's "do not
 * rebuild Grafana inside /admin". Nothing on this panel is about the system:
 * no durations, no queue depth, no failure rates. How many frames are left to
 * rule on and how often a prompt misses are questions about rows, and Grafana
 * has no way to answer them.
 *
 * The missing-report rate is the number M13.3 calls "the number that says
 * whether a prompt is good enough", and it is rendered as a fraction rather
 * than a percentage on purpose: "3 / 40" carries how much evidence is behind
 * it, and "7.5%" over four verified frames does not.
 */
export function LabellingStats() {
  const stats = useLabellingStats();

  if (stats.isPending) return <p className="text-sm">Loading…</p>;

  if (stats.isError) {
    return (
      <p role="alert" className="text-sm text-[var(--color-failed)]">
        {stats.error.message}
      </p>
    );
  }

  const { pool, classes } = stats.data;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        <span className="font-mono">{pool.images_verified}</span> of{" "}
        <span className="font-mono">{pool.images_with_predictions}</span> pre-labelled frames
        verified · <span className="font-mono">{pool.images_remaining}</span> waiting ·{" "}
        <span className="font-mono">{pool.missing_reports}</span> missing-object reports
      </p>

      {classes.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">No classes yet.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
            <tr>
              <th className="py-1">Class</th>
              <th className="py-1">Boxes</th>
              <th className="py-1">Accepted</th>
              <th className="py-1">Adjusted</th>
              <th className="py-1">Rejected</th>
              <th className="py-1">Missed</th>
            </tr>
          </thead>
          <tbody>
            {classes.map((klass) => (
              <tr key={klass.class_id} className="border-t border-[var(--color-border)]">
                <td className="py-1">
                  {klass.name}
                  {!klass.active && (
                    <span className="ml-1 text-xs text-[var(--color-text-muted)]">(retired)</span>
                  )}
                </td>
                <td className="py-1 font-mono">{klass.predictions}</td>
                <td className="py-1 font-mono">{klass.accepted}</td>
                <td className="py-1 font-mono">{klass.adjusted}</td>
                <td className="py-1 font-mono">{klass.rejected}</td>
                {/* Over verified frames, not over this class's own boxes: a
                    prompt that proposes nothing has no boxes to divide by, and
                    that is precisely the prompt whose miss rate matters most. */}
                <td className="py-1 font-mono">
                  {klass.missing_reports} / {pool.images_verified}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
