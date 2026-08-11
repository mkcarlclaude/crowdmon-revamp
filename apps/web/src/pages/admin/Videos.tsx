import { useJobs } from "../../api/queries";
import { JobList } from "../../components/JobList";
import { SessionExpiredBanner } from "../../components/SessionExpiredBanner";
import { SubmitForm } from "../../components/SubmitForm";

/**
 * `/admin/videos` (M16): the deleted `Admin.tsx`'s "Submit a video" and
 * "Queue" sections, unchanged past their own restyle (a later commit) —
 * `SubmitForm` and `JobList` mount exactly as they did there.
 *
 * `SessionExpiredBanner` moves here rather than into `AdminLayout`: it reads
 * `useJobs()`'s own error (the same query `JobList` renders, deduped by
 * TanStack Query), which is a fact about this page's polling, not a fact
 * `AdminLayout`'s one-shot session probe on mount could see — a session that
 * expires an hour into a visit is invisible to a check that only ran once.
 */
export function AdminVideosPage() {
  // Reads the same cached query `JobList` renders — TanStack Query dedupes
  // it, so this is the existing poll's error, not a second request.
  const { error } = useJobs();

  return (
    <div className="flex flex-col gap-8">
      <SessionExpiredBanner error={error} />
      <section>
        <h2 className="mb-2 text-sm uppercase tracking-wide text-muted-foreground">
          Submit a video
        </h2>
        <SubmitForm />
      </section>
      <section>
        <h2 className="mb-2 text-sm uppercase tracking-wide text-muted-foreground">Queue</h2>
        <JobList />
      </section>
    </div>
  );
}
