import type { AdminJobRow } from "@crowdmon/api/schemas";
import { useState } from "react";
import { Link } from "react-router";
import { useJobs } from "../api/queries";
import { RelativeAge } from "./RelativeAge";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

const STATUS_COLOR: Record<AdminJobRow["status"], string> = {
  pending: "var(--color-pending)",
  claimed: "var(--color-claimed)",
  done: "var(--color-done)",
  failed: "var(--color-failed)",
};

/**
 * `undefined` is "all" on the wire (`useJobs`'s own `?status=` omission) —
 * kept as a distinct chip here rather than folded into the status union so
 * clearing the filter and picking a status are the same kind of click.
 */
const STATUS_CHIPS: Array<{ value: AdminJobRow["status"] | undefined; label: string }> = [
  { value: undefined, label: "All" },
  { value: "pending", label: "Pending" },
  { value: "claimed", label: "Claimed" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
];

/** `dryrun` reads as "dry-run" here; every other kind renders its own name (M19, plan §C1). */
function kindLabel(kind: AdminJobRow["kind"]): string {
  return kind === "dryrun" ? "dry-run" : kind;
}

/**
 * `/admin/queue` (M19, plan §C): every job of every kind, flat, newest first
 * — replacing `JobList`'s grouped-by-video tree, which answered "how far
 * along is this video" (now `/admin/videos/:id`'s own extraction-progress
 * line, plan §A) at the cost of two things this table exists to fix.
 *
 * **`snapshot` jobs stop being invisible.** They carry no `video_id`
 * (migration 0008, M15.1 — a snapshot packages the whole dataset, not one
 * video), so `JobList` filtered them out of its per-video grouping entirely;
 * the one job kind with no video was the one an operator could never see
 * running. `SnapshotPanel` on `/admin/snapshots` still owns the *artifacts* a
 * snapshot build produces — this table shows the job that builds them.
 *
 * **`kind` is finally on screen.** `JobList` inferred download-vs-chunk from
 * its own grouping and never rendered `kind` at all, so a `prelabel` or
 * `dryrun` job rendered as a nameless row under whichever video it belonged
 * to. `kind` gets a neutral badge, not a fifth colour: `status` already owns
 * the palette (`--color-pending`/`claimed`/`done`/`failed`), and two colour
 * scales in one row is a row nobody reads at a glance.
 *
 * **No summary counts.** A "12 pending / 3 claimed" strip computed off this
 * table's own 50-row page would be a count of the page, not of the queue,
 * and would silently lie the moment the real queue is longer than the
 * limit. Honest totals need a `GROUP BY status` route this plan declines to
 * add.
 *
 * Owns its own status-chip state and its own `useJobs(status)` call, in
 * `JobList`'s own self-contained idiom, rather than taking `jobs` as a prop —
 * that is what lets a click on a chip be observable as a changed fetch URL
 * (`JobTable.test.tsx`), the thing `JobList.test.tsx` could never assert
 * because that component took no filter at all.
 */
export function JobTable() {
  const [status, setStatus] = useState<AdminJobRow["status"] | undefined>(undefined);
  const { data, isPending, error } = useJobs(status);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {STATUS_CHIPS.map((chip) => (
          <Button
            key={chip.label}
            type="button"
            size="sm"
            variant={status === chip.value ? "default" : "outline"}
            onClick={() => setStatus(chip.value)}
          >
            {chip.label}
          </Button>
        ))}
      </div>

      {isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      )}
      {data && data.jobs.length === 0 && <p className="text-sm text-muted-foreground">No jobs.</p>}

      {data && data.jobs.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>#</TableHead>
              <TableHead>Video</TableHead>
              <TableHead>Segment</TableHead>
              <TableHead>Attempts</TableHead>
              <TableHead>Claimed by</TableHead>
              <TableHead>Heartbeat</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Failure</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.jobs.map((job) => (
              <TableRow key={job.id}>
                <TableCell>
                  <Badge
                    variant="outline"
                    style={{
                      borderColor: STATUS_COLOR[job.status],
                      color: STATUS_COLOR[job.status],
                    }}
                  >
                    {job.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{kindLabel(job.kind)}</Badge>
                </TableCell>
                <TableCell className="font-mono text-muted-foreground">#{job.id}</TableCell>
                <TableCell>
                  {job.video_id ? (
                    <Link
                      to={`/admin/videos/${job.video_id}`}
                      className="font-mono text-sm underline underline-offset-2 hover:text-foreground"
                    >
                      {job.video_id}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {job.chunk ? job.chunk.segment_index : "—"}
                </TableCell>
                <TableCell className="text-muted-foreground">{job.attempts}</TableCell>
                <TableCell className="font-mono text-muted-foreground">
                  {job.claimed_by ?? "—"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <RelativeAge at={job.heartbeat_at} now={data.now} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <RelativeAge at={job.created_at} now={data.now} />
                </TableCell>
                <TableCell className="text-destructive">{job.failure_reason ?? ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
