import { Link } from "react-router";
import { useVideos } from "../../api/queries";
import { SubmitForm } from "../../components/SubmitForm";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";

/**
 * `/admin/videos` (M16; M19, plan §B folds `/admin/detection`'s coverage
 * table in here): submit a video, then the list of every video submitted so
 * far — frames, sampling coverage, prelabel status, and now when each was
 * submitted.
 *
 * `JobList` no longer mounts here (M19, plan §C: `/admin/queue` replaces it)
 * and neither does `SessionExpiredBanner` — `useVideos()` carries no
 * `refetchInterval` (see that hook's own comment), so a session that expires
 * mid-visit on this page would never be caught by it; a banner here would be
 * pretending to detect something it cannot. The banner now lives on
 * `/admin/queue`, where the polling actually is.
 *
 * Reuses `useVideos()` rather than a route of its own for the table:
 * `AdminVideo` (`schemas.ts`) already carries `image_count`, `frames_sampled`,
 * `model_id` and `prelabelled_at` for exactly this reason — one request feeds
 * both the dry-run picker and this table.
 *
 * **The M16.6 scope line, carried over verbatim from the deleted
 * `Detection.tsx` rather than dropped with the file it lived in** — why
 * there is no re-run button here: a re-run needs a migration (the job row
 * carries no sample parameter today), an admin enqueue route, a Go worker
 * change that samples only frames not already sampled, and an answer to
 * CONTEXT.md §Q19's provenance rule — thresholds get stamped onto the rows
 * they produced, or this table becomes an unrecorded mixture of regimes the
 * moment two sampling runs disagree. That is a milestone with a worker
 * release in it, not a button. This page exists so the page that eventually
 * grows one already tells the truth without it — an admin can see exactly
 * which videos are under-sampled today, they just cannot fix it from here
 * yet. (M17's on-demand prelabel plan, `2026-08-12-on-demand-prelabel-and-
 * single-frame-dryrun.md` §B, is the milestone that eventually does grow
 * that button, and assumes this coverage table is where it hangs — its own
 * §B references pointed at `/admin/detection`; read them as `/admin/videos`
 * now.)
 */
export function AdminVideosPage() {
  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="mb-2 text-sm uppercase tracking-wide text-muted-foreground">
          Submit a video
        </h2>
        <SubmitForm />
      </section>
      <section>
        <h2 className="mb-2 text-sm uppercase tracking-wide text-muted-foreground">Videos</h2>
        <VideoTable />
      </section>
    </div>
  );
}

/**
 * The table `Detection.tsx` used to own, plus a "Submitted" column
 * (`created_at`, M19 plan §B1) — every other column is unchanged from that
 * file, `useVideos()`'s own return still supplies all of it, so this is a
 * relocation, not a rewrite.
 */
function VideoTable() {
  const videos = useVideos();

  if (videos.isPending) return <p className="text-sm">Loading…</p>;

  if (videos.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {videos.error.message}
      </p>
    );
  }

  if (videos.data.videos.length === 0) {
    return <p className="text-sm text-muted-foreground">No videos submitted yet.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Video</TableHead>
          <TableHead>Frames</TableHead>
          <TableHead>Sampled</TableHead>
          <TableHead>Model</TableHead>
          <TableHead>Last ran</TableHead>
          <TableHead>Submitted</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {videos.data.videos.map((video) => (
          <TableRow key={video.id}>
            <TableCell>
              <Link
                to={`/admin/videos/${video.id}`}
                className="font-mono text-sm underline underline-offset-2 hover:text-foreground"
              >
                {video.title ?? video.id}
              </Link>
            </TableCell>
            <TableCell className="font-mono">{video.image_count}</TableCell>
            <TableCell className="font-mono">{video.frames_sampled}</TableCell>
            <TableCell className="text-muted-foreground">{video.model_id ?? "—"}</TableCell>
            <TableCell className="text-muted-foreground">
              {video.prelabelled_at === null
                ? "never"
                : new Date(video.prelabelled_at * 1000).toLocaleString()}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {new Date(video.created_at * 1000).toLocaleString()}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
