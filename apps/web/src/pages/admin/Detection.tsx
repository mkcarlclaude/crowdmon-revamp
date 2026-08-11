import { Link } from "react-router";
import { useVideos } from "../../api/queries";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";

/**
 * `/admin/detection` (M16, ROADMAP M16.6): prelabel coverage per video,
 * read-only on purpose.
 *
 * The plan's own "scope line" is why there is no re-run button here: a
 * re-run needs a migration (the job row carries no sample parameter today),
 * an admin enqueue route, a Go worker change that samples only frames not
 * already sampled, and an answer to CONTEXT.md §Q19's provenance rule —
 * thresholds get stamped onto the rows they produced, or this table becomes
 * an unrecorded mixture of regimes the moment two sampling runs disagree.
 * That is a milestone with a worker release in it, not a button. This page
 * exists so the page that eventually grows one already tells the truth
 * without it — an admin can see exactly which videos are under-sampled
 * today, they just cannot fix it from here yet.
 *
 * Reuses `useVideos()` rather than a route of its own: `AdminVideo`
 * (`schemas.ts`) carries `frames_sampled`, `model_id` and `prelabelled_at`
 * precisely so this page and the dry-run picker can share one request.
 */
export function AdminDetectionPage() {
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
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
