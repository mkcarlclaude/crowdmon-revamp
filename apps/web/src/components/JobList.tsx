import type { AdminJobRow } from "@crowdmon/api/schemas";
import { useJobs } from "../api/queries";
import { RelativeAge } from "./RelativeAge";

const STATUS_COLOR: Record<AdminJobRow["status"], string> = {
  pending: "var(--color-pending)",
  claimed: "var(--color-claimed)",
  done: "var(--color-done)",
  failed: "var(--color-failed)",
};

/**
 * Grouped by video, not by arrival order.
 *
 * A chunk job can carry a lower id than the download job it belongs to once a
 * reap has re-run fan-out (M7.3), so ordering is not a grouping key. Videos are
 * ordered by their newest job so a fresh submission appears at the top.
 */
function groupByVideo(jobs: AdminJobRow[]) {
  const groups = new Map<
    string,
    { download?: AdminJobRow; chunks: AdminJobRow[]; newest: number }
  >();

  for (const job of jobs) {
    const group = groups.get(job.video_id) ?? { chunks: [], newest: 0 };
    if (job.kind === "download") group.download = job;
    else group.chunks.push(job);
    group.newest = Math.max(group.newest, job.id);
    groups.set(job.video_id, group);
  }

  return [...groups.entries()].sort(([, a], [, b]) => b.newest - a.newest);
}

export function JobList() {
  const { data, isPending, error } = useJobs();

  if (isPending) return <p className="text-[var(--color-text-muted)]">Loading…</p>;
  if (error)
    return (
      <p role="alert" className="text-[var(--color-failed)]">
        {error.message}
      </p>
    );
  if (data.jobs.length === 0) return <p className="text-[var(--color-text-muted)]">No jobs yet.</p>;

  return (
    <div className="flex flex-col gap-4">
      {groupByVideo(data.jobs).map(([videoId, group]) => (
        <section
          key={videoId}
          aria-label={videoId}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4"
        >
          <h3 className="font-mono text-sm">{videoId}</h3>
          {group.download && <JobRow job={group.download} now={data.now} />}
          {group.chunks.length > 0 && (
            <ul className="mt-2 border-l border-[var(--color-border)] pl-4">
              {group.chunks
                .sort((a, b) => (a.chunk?.segment_index ?? 0) - (b.chunk?.segment_index ?? 0))
                .map((chunk) => (
                  <li key={chunk.id}>
                    <JobRow job={chunk} now={data.now} />
                  </li>
                ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function JobRow({ job, now }: { job: AdminJobRow; now: number }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-1 text-sm">
      <span style={{ color: STATUS_COLOR[job.status] }}>{job.status}</span>
      <span className="font-mono text-[var(--color-text-muted)]">#{job.id}</span>
      {job.chunk && <span>segment {job.chunk.segment_index}</span>}
      {/* Attempts are shown always, not only when non-zero: the number
          approaching M6.1's ceiling is the signal, and a field that appears
          only sometimes is a field nobody learns to read. */}
      <span className="text-[var(--color-text-muted)]">attempts {job.attempts}</span>
      {job.claimed_by && <span className="font-mono">{job.claimed_by}</span>}
      <span className="text-[var(--color-text-muted)]">
        heartbeat <RelativeAge at={job.heartbeat_at} now={now} />
      </span>
      <span className="text-[var(--color-text-muted)]">
        created <RelativeAge at={job.created_at} now={now} />
      </span>
      {job.failure_reason && (
        <span className="text-[var(--color-failed)]">{job.failure_reason}</span>
      )}
    </div>
  );
}
