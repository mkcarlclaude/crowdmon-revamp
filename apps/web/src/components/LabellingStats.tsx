import { useLabellingStats } from "../api/queries";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

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
 *
 * Restyled onto shadcn/ui's `Table` in M16 — it still renders a native
 * `<table>`/`<tr>`, so `LabellingStats.test.tsx`'s `.closest("tr")` queries
 * are untouched by the move.
 */
export function LabellingStats() {
  const stats = useLabellingStats();

  if (stats.isPending) return <p className="text-sm">Loading…</p>;

  if (stats.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
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
        <p className="text-sm text-muted-foreground">No classes yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Class</TableHead>
              <TableHead>Boxes</TableHead>
              <TableHead>Accepted</TableHead>
              <TableHead>Adjusted</TableHead>
              <TableHead>Rejected</TableHead>
              {/* Admin and anon rulings never pool into one number (CONTEXT.md
                  §Q10) — an anonymous troll rejecting everything would
                  otherwise read as a model that got worse. */}
              <TableHead>Anon accepted</TableHead>
              <TableHead>Anon adjusted</TableHead>
              <TableHead>Anon rejected</TableHead>
              <TableHead>Missed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {classes.map((klass) => (
              <TableRow key={klass.class_id}>
                <TableCell>
                  {klass.name}
                  {!klass.active && (
                    <span className="ml-1 text-xs text-muted-foreground">(retired)</span>
                  )}
                </TableCell>
                <TableCell className="font-mono">{klass.predictions}</TableCell>
                <TableCell className="font-mono">{klass.accepted}</TableCell>
                <TableCell className="font-mono">{klass.adjusted}</TableCell>
                <TableCell className="font-mono">{klass.rejected}</TableCell>
                <TableCell className="font-mono">{klass.anon_accepted}</TableCell>
                <TableCell className="font-mono">{klass.anon_adjusted}</TableCell>
                <TableCell className="font-mono">{klass.anon_rejected}</TableCell>
                {/* Over verified frames, not over this class's own boxes: a
                    prompt that proposes nothing has no boxes to divide by, and
                    that is precisely the prompt whose miss rate matters most. */}
                <TableCell className="font-mono">
                  {klass.missing_reports} / {pool.images_verified}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
