import { useJobs } from "../api/queries";
import { AddClassForm } from "../components/AddClassForm";
import { ClassRoster } from "../components/ClassRoster";
import { GrafanaLink } from "../components/GrafanaLink";
import { JobList } from "../components/JobList";
import { LabellingSession } from "../components/LabellingSession";
import { LabellingStats } from "../components/LabellingStats";
import { SessionExpiredBanner } from "../components/SessionExpiredBanner";
import { SnapshotPanel } from "../components/SnapshotPanel";
import { SubmitForm } from "../components/SubmitForm";

export function Admin() {
  // Reads the same cached query the list renders — TanStack Query dedupes it,
  // so this is the existing poll's error, not a second request.
  const { error } = useJobs();

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 p-8">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <GrafanaLink />
      </div>
      <SessionExpiredBanner error={error} />
      <section>
        <h2 className="mb-2 text-sm uppercase tracking-wide text-[var(--color-text-muted)]">
          Submit a video
        </h2>
        <SubmitForm />
      </section>
      <section>
        <h2 className="mb-2 text-sm uppercase tracking-wide text-[var(--color-text-muted)]">
          Queue
        </h2>
        <JobList />
      </section>
      {/* M13. Above the classes and below the queue, by the same rule: this is
          the screen's daily work once a video has been submitted, and the
          class roster is the occasional edit. */}
      <section>
        <h2 className="mb-2 text-sm uppercase tracking-wide text-[var(--color-text-muted)]">
          Verify
        </h2>
        <LabellingSession />
      </section>
      <section>
        <h2 className="mb-2 text-sm uppercase tracking-wide text-[var(--color-text-muted)]">
          Labelling pool
        </h2>
        <LabellingStats />
      </section>
      {/* M12.1. Below the queue rather than above it: submitting a video is the
          daily act and editing a prompt is the occasional one, and the page
          orders by how often a thing is used rather than by how much was
          written about it. */}
      <section>
        <h2 className="mb-2 text-sm uppercase tracking-wide text-[var(--color-text-muted)]">
          Classes
        </h2>
        <div className="flex flex-col gap-6">
          <AddClassForm />
          <ClassRoster />
        </div>
      </section>
      {/* M15.1. Last: the export the whole pipeline builds toward, and the
          least frequent action on the page — an admin looks at this once a
          dataset is worth pulling, not every visit. */}
      <section>
        <h2 className="mb-2 text-sm uppercase tracking-wide text-[var(--color-text-muted)]">
          Dataset snapshots
        </h2>
        <SnapshotPanel />
      </section>
    </main>
  );
}
