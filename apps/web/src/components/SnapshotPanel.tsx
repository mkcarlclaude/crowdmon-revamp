import { useCreateSnapshot, useJobs, useSnapshots } from "../api/queries";
import { Button } from "./ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

/**
 * Building and browsing dataset snapshots (M15.1).
 *
 * Building itself is a queued job on the home box, not this button's own
 * work (ROADMAP.md M15.1: "building one must not depend on a browser tab
 * staying open") — the button only ever enqueues a `jobs` row, and the list
 * below is `snapshots` rows that already finished. `useJobs` (already
 * polled for the queue section above) is read again here rather than a
 * second endpoint, purely to say "a build is running" without inventing a
 * new poll.
 *
 * Restyled onto shadcn/ui's `Button` and `Table` in M16.
 */
export function SnapshotPanel() {
  const create = useCreateSnapshot();
  const snapshots = useSnapshots();
  const jobs = useJobs();

  const running = jobs.data?.jobs.some(
    (job) => job.kind === "snapshot" && (job.status === "pending" || job.status === "claimed"),
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          disabled={create.isPending || running}
          onClick={() => create.mutate()}
        >
          {create.isPending ? "Queueing…" : running ? "Building…" : "Build a snapshot"}
        </Button>
        {create.isError && (
          <span role="alert" className="text-sm text-destructive">
            {create.error.message}
          </span>
        )}
      </div>

      {snapshots.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {snapshots.error && (
        <p role="alert" className="text-sm text-destructive">
          {snapshots.error.message}
        </p>
      )}
      {snapshots.data && snapshots.data.snapshots.length === 0 && (
        <p className="text-sm text-muted-foreground">No snapshots built yet.</p>
      )}
      {snapshots.data && snapshots.data.snapshots.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>R2 key</TableHead>
              <TableHead>Images</TableHead>
              <TableHead>Labels</TableHead>
              <TableHead>Built</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {snapshots.data.snapshots.map((snapshot) => (
              <TableRow key={snapshot.id}>
                <TableCell className="font-mono">{snapshot.r2_key}</TableCell>
                <TableCell>{snapshot.image_count}</TableCell>
                <TableCell>{snapshot.label_count}</TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(snapshot.created_at * 1000).toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
