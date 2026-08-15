import { useJobs } from "../../api/queries";
import { JobTable } from "../../components/JobTable";
import { SessionExpiredBanner } from "../../components/SessionExpiredBanner";

/**
 * `/admin/queue` (M19, plan §C): every job of every kind, flat, newest first
 * — see `JobTable`'s own comment for what that fixes over the `JobList` this
 * page replaces.
 *
 * `SessionExpiredBanner` lives here now, not on `/admin/videos` (plan §B):
 * only a query that actually polls can catch a session expiring mid-visit,
 * and after §B this is the one admin page left where that is true. Reads its
 * own unfiltered `useJobs()` for the error — the same query TanStack dedupes
 * against `JobTable`'s own call whenever its status chip is on "All" (the
 * default) — rather than reaching into `JobTable`'s internal, filter-scoped
 * query, which has no reason to hand its error out to a sibling component.
 */
export function AdminQueuePage() {
  const { error } = useJobs();

  return (
    <div className="flex flex-col gap-4">
      <SessionExpiredBanner error={error} />
      <JobTable />
    </div>
  );
}
