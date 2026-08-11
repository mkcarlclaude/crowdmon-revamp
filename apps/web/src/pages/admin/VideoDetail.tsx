import { useState } from "react";
import { Link, useParams } from "react-router";
import { useAdminVideoImages, useSetPublicSample } from "../../api/queries";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";

/** How many frames one page shows. Small enough that a grid of thumbnails stays legible. */
const PAGE_SIZE = 24;

/**
 * `verdict_state`'s colour and label, reusing the same three hues `JobList`
 * already assigns per-status rather than inventing a fourth palette: "no
 * predictions" is a fact, not a warning, so it borrows the muted text
 * colour rather than the pending amber that would suggest something is
 * owed to it.
 */
const STATE_COLOR: Record<string, string> = {
  no_predictions: "var(--color-text-muted)",
  unverified: "var(--color-claimed)",
  verified: "var(--color-done)",
};

const STATE_LABEL: Record<string, string> = {
  no_predictions: "no predictions",
  unverified: "unverified",
  verified: "verified",
};

/**
 * `/admin/videos/:id` (M16, ROADMAP M16.5): the browsable frame grid.
 *
 * Reads `GET /api/admin/videos/{id}/images` — a route built for exactly this
 * screen, not a reuse of the worker-facing `/api/videos/{video_id}/images`
 * (see that route's own comment in `admin-video-images.ts` for why a held
 * lease makes that one unusable from a browser). Frame bytes still go
 * through `/api/admin/image`, the same Access-gated proxy `DryRunPanel`
 * already uses — a grid of frames per video is the same request shape as
 * the dry-run grid that route was built for.
 */
export function AdminVideoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const videoId = id ?? "";
  const [offset, setOffset] = useState(0);

  const images = useAdminVideoImages(videoId, { limit: PAGE_SIZE, offset });
  const setPublicSample = useSetPublicSample();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <Link
            to="/admin/videos"
            className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            ← Videos
          </Link>
          <h1 className="mt-1 font-mono text-xl font-semibold text-foreground">{videoId}</h1>
        </div>
        {images.data && images.data.total > 0 && (
          <p className="text-sm text-muted-foreground">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, images.data.total)} of {images.data.total}
          </p>
        )}
      </div>

      {images.isPending && <p className="text-sm">Loading frames…</p>}
      {images.isError && (
        <p role="alert" className="text-sm text-destructive">
          {images.error.message}
        </p>
      )}
      {images.data && images.data.images.length === 0 && (
        <p className="text-sm text-muted-foreground">No frames extracted for this video yet.</p>
      )}

      {images.data && images.data.images.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {images.data.images.map((image) => (
            <figure
              key={image.id}
              className="overflow-hidden rounded-lg border border-border bg-card"
            >
              <img
                src={`/api/admin/image?key=${encodeURIComponent(image.r2_key)}`}
                alt={image.r2_key}
                className="block aspect-video w-full object-cover"
              />
              <figcaption className="flex flex-col gap-1.5 p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-muted-foreground">
                    {image.timestamp_seconds}s
                  </span>
                  <Badge
                    variant="outline"
                    style={{
                      borderColor: STATE_COLOR[image.verdict_state],
                      color: STATE_COLOR[image.verdict_state],
                    }}
                  >
                    {STATE_LABEL[image.verdict_state]}
                  </Badge>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">
                    {image.predictions} {image.predictions === 1 ? "prediction" : "predictions"}
                  </span>
                  {/* Same shape as `LabellingSession`'s own public-sample
                      checkbox — a checkbox rather than a button so its own
                      state is the only indicator needed. */}
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={image.public_sample}
                      disabled={setPublicSample.isPending}
                      onChange={(event) =>
                        setPublicSample.mutate({
                          imageId: image.id,
                          publicSample: event.target.checked,
                        })
                      }
                    />
                    public
                  </label>
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {images.data && images.data.total > PAGE_SIZE && (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={offset + PAGE_SIZE >= images.data.total}
            onClick={() => setOffset((current) => current + PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
