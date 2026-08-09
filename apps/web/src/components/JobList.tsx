import type { AdminJobRow } from "@crowdmon/api/schemas";
import { useJobs } from "../api/queries";
import { RelativeAge } from "./RelativeAge";

const STATUS_COLOR: Record<AdminJobRow["status"], string> = {
  pending: "var(--color-pending)",
  claimed: "var(--color-claimed)",
  done: "var(--color-done)",
  failed: "var(--color-failed)",
};

/** A job with a real video, as every kind but `snapshot` (M15.1) carries. */
type VideoJobRow = AdminJobRow & { video_id: string };

/**
 * Grouped by video, not by arrival order.
 *
 * A chunk job can carry a lower id than the download job it belongs to once a
 * reap has re-run fan-out (M7.3), so ordering is not a grouping key. Videos are
 * ordered by their newest job so a fresh submission appears at the top.
 *
 * `jobs` is pre-filtered to rows that carry one: a `snapshot` job's own
 * `video_id` is null (it packages the whole dataset, not one video), and has
 * nowhere in this per-video view to be grouped under — `SnapshotPanel` is
 * where that kind's status renders instead.
 */
function groupByVideo(jobs: VideoJobRow[]) {
  const groups = new Map<
    string,
    { download?: VideoJobRow; chunks: VideoJobRow[]; newest: number }
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
  // Excludes `snapshot` jobs (M15.1): they carry no video to group under,
  // and `SnapshotPanel` renders their status instead — see groupByVideo's
  // own comment.
  const videoJobs = data.jobs.filter((job): job is VideoJobRow => job.video_id !== null);

  if (videoJobs.length === 0) {
    return <p className="text-[var(--color-text-muted)]">No jobs yet.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {groupByVideo(videoJobs).map(([videoId, group]) => (
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
