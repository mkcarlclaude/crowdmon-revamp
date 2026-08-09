import { useCreateSnapshot, useJobs, useSnapshots } from "../api/queries";

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
        <button
          type="button"
          disabled={create.isPending || running}
          onClick={() => create.mutate()}
          className="rounded border border-[var(--color-border)] px-3 py-1 text-sm disabled:opacity-50"
        >
          {create.isPending ? "Queueing…" : running ? "Building…" : "Build a snapshot"}
        </button>
        {create.isError && (
          <span role="alert" className="text-sm text-[var(--color-failed)]">
            {create.error.message}
          </span>
        )}
      </div>

      {snapshots.isPending && <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>}
      {snapshots.error && (
        <p role="alert" className="text-sm text-[var(--color-failed)]">
          {snapshots.error.message}
        </p>
      )}
      {snapshots.data && snapshots.data.snapshots.length === 0 && (
        <p className="text-sm text-[var(--color-text-muted)]">No snapshots built yet.</p>
      )}
      {snapshots.data && snapshots.data.snapshots.length > 0 && (
        <table className="text-sm">
          <thead>
            <tr className="text-left text-[var(--color-text-muted)]">
              <th className="pr-4 font-normal">R2 key</th>
              <th className="pr-4 font-normal">Images</th>
              <th className="pr-4 font-normal">Labels</th>
              <th className="pr-4 font-normal">Built</th>
            </tr>
          </thead>
          <tbody>
            {snapshots.data.snapshots.map((snapshot) => (
              <tr key={snapshot.id}>
                <td className="pr-4 font-mono">{snapshot.r2_key}</td>
                <td className="pr-4">{snapshot.image_count}</td>
                <td className="pr-4">{snapshot.label_count}</td>
                <td className="pr-4 text-[var(--color-text-muted)]">
                  {new Date(snapshot.created_at * 1000).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
