import type { AdminVideoDetailRow } from "@crowdmon/api/schemas";
import type { ReactNode } from "react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import {
  useAdminVideoDetail,
  useAdminVideoImages,
  useCreatePrelabel,
  useLabellingStats,
  useSetPublicSample,
} from "../../api/queries";
import { RelativeAge } from "../../components/RelativeAge";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";

/** How many frames one page shows. Small enough that a grid of thumbnails stays legible. */
const PAGE_SIZE = 24;

/** The "randomise N" input's starting value — enough to make a dent in a session without being a surprise. */
const DEFAULT_RANDOM_COUNT = 20;

/**
 * The "diversify N" input's starting value (M25, plan §A4), and it is
 * deliberately twenty times the random default rather than the same number.
 *
 * The arithmetic it comes from, measured on the 2026-08-27 production export:
 * 1,013 sampled images produced 580 verdicts and 125 labels across 95 images,
 * so roughly one sampled frame in ten ends up carrying a label, at about 1.3
 * labels each. The train split starts at **zero**, and M27 needs a training
 * set big enough that a first fine-tune is worth running at all. 400 frames
 * per video across the handful of videos in the corpus is a few hundred train
 * labels — a real starting set, not a demo.
 *
 * It is not larger because the governor here is verification throughput, not
 * extraction: an admin has to rule on every one of these by hand, and an
 * enormous unlabelled pool is a queue nobody works through rather than
 * progress. `MAX_SAMPLED_IMAGES_PER_JOB` (1,000) is the hard ceiling the API
 * enforces; this is the number a session should actually start from.
 */
const DEFAULT_DIVERSE_COUNT = 400;

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
 * The same three hues as `STATE_COLOR` above, keyed by job status instead of
 * verdict state — `JobList`'s own `STATUS_COLOR` (M19, plan §A3: "no new
 * colour tokens... a fourth palette for stat tiles is exactly what that
 * file's existing comment argues against"). Not imported from `JobList`
 * directly: that component is `/admin/queue`'s (plan §C), and this page has
 * no business depending on a file a later commit deletes.
 */
const JOB_STATUS_COLOR: Record<string, string> = {
  pending: "var(--color-pending)",
  claimed: "var(--color-claimed)",
  done: "var(--color-done)",
  failed: "var(--color-failed)",
};

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="font-mono text-sm">{value}</span>
    </div>
  );
}

/**
 * `chunks_done`/`chunks_total`, a failed count when non-zero, and the
 * download job's status while there is nothing else to report yet (M19, plan
 * §A3).
 *
 * Suppressed once extraction is actually finished — `chunks_total > 0` and
 * every chunk is `done` with none `failed` — so a video that completed weeks
 * ago does not carry a progress bar reporting completeness forever.
 * `chunks_total === 0` is deliberately *not* treated as "finished": it is
 * "fan-out has not run yet," the state a video mid-download is always in
 * before its download job completes, and the one case this line still has
 * something to say — the download job's own status.
 */
function ExtractionProgress({ jobs }: { jobs: AdminVideoDetailRow["jobs"] }) {
  const finished =
    jobs.chunks_total > 0 && jobs.chunks_done === jobs.chunks_total && jobs.chunks_failed === 0;
  if (finished) return null;

  if (jobs.chunks_total === 0) {
    if (jobs.download === null) return null;
    return (
      <p className="text-sm text-muted-foreground">
        Download{" "}
        <Badge
          variant="outline"
          style={{
            borderColor: JOB_STATUS_COLOR[jobs.download],
            color: JOB_STATUS_COLOR[jobs.download],
          }}
        >
          {jobs.download}
        </Badge>
      </p>
    );
  }

  return (
    <p className="text-sm text-muted-foreground">
      Extraction {jobs.chunks_done}/{jobs.chunks_total} chunks done
      {jobs.chunks_failed > 0 && (
        <span className="text-destructive"> · {jobs.chunks_failed} failed</span>
      )}
    </p>
  );
}

/**
 * The header `/admin/videos/:id` grows above the frame grid (M19, plan §A3),
 * reading `GET /api/admin/videos/{id}` (`admin-video-detail.ts`).
 *
 * **Poster.** `https://i.ytimg.com/vi/<id>/hqdefault.jpg` — no API key, no
 * migration. The alternative is the first frame this system already
 * extracted, sitting in R2 and presignable by `frameUrls` exactly as the
 * grid below serves its own tiles; ytimg was chosen instead because it costs
 * zero API work, at the price of telling Google which video an authenticated
 * admin is looking at. That is the same video the admin themselves submitted
 * from YouTube, so the leak is nominal — but it is a leak, and the plan this
 * page follows asks that the alternative be recorded here rather than left
 * invisible, not that it be picked.
 *
 * Every metadata field but the title heading falls back to `—`, never `0` or
 * a blank: a video mid-download genuinely has no duration yet, and that is a
 * different fact from a duration of zero.
 */
function VideoHeader({ detail }: { detail: AdminVideoDetailRow }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 sm:flex-row">
        <img
          src={`https://i.ytimg.com/vi/${detail.id}/hqdefault.jpg`}
          alt=""
          className="h-auto w-full max-w-60 shrink-0 rounded-md border border-border object-cover"
        />
        <div className="flex flex-1 flex-col gap-3">
          <div>
            {/* The id stays visible even once a title exists — it is the
                primary key everything else in this system names, and was the
                whole heading before this header had a title to promote
                instead (M16). */}
            <h1 className="text-xl font-semibold text-foreground">{detail.title ?? detail.id}</h1>
            <p className="font-mono text-sm text-muted-foreground">{detail.id}</p>
            <a
              href={detail.url}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Watch on YouTube ↗
            </a>
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <Stat label="Frames" value={detail.image_count} />
            <Stat label="Sampled" value={detail.frames_sampled} />
            <Stat label="Predictions" value={detail.predictions} />
            <Stat
              label="Verified / unverified"
              value={`${detail.frames_verified} / ${detail.frames_unverified}`}
            />
            <Stat label="Public samples" value={detail.public_samples} />
            <Stat
              label="Duration"
              value={detail.duration_seconds === null ? "—" : `${detail.duration_seconds}s`}
            />
            <Stat
              label="Resolution"
              value={
                detail.width === null || detail.height === null
                  ? "—"
                  : `${detail.width}×${detail.height}`
              }
            />
            <Stat
              label="Submitted"
              value={
                // `RelativeAge` wants a server `now`, the way the queue's own
                // poll supplies one — but this page never polls and
                // `AdminVideoDetail` carries no clock field of its own (its
                // fields are the video's data, not a heartbeat to measure).
                // A submission time read once to sanity-check "did this
                // happen recently" has none of the queue's failure mode,
                // where a laptop minutes off would misreport a live worker
                // as dead; the browser's own clock costs this nothing.
                <RelativeAge at={detail.created_at} now={Math.floor(Date.now() / 1000)} />
              }
            />
          </div>

          <ExtractionProgress jobs={detail.jobs} />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * `/admin/videos/:id` (M16, ROADMAP M16.5; M19, plan §A adds the header
 * above the grid): the browsable frame grid, and now the video's own summary
 * above it.
 *
 * Reads `GET /api/admin/videos/{id}/images` — a route built for exactly this
 * screen, not a reuse of the worker-facing `/api/videos/{video_id}/images`
 * (see that route's own comment in `admin-video-images.ts` for why a held
 * lease makes that one unusable from a browser) — for the grid, and `GET
 * /api/admin/videos/{id}` (`admin-video-detail.ts`) for the header. Two
 * separate queries rather than one: the header 404s on an unknown video id,
 * while the grid's own route answers the same case with an honest empty
 * page (see that route's comment for why), so a single combined query would
 * have to reconcile two different "not found" answers into one.
 *
 * Frame bytes come from whatever `url` the API put on each row — presigned
 * straight to R2 where the deployment has an S3 credential, the Access-gated
 * proxy where it does not. M16 shipped this building `/api/admin/image?key=…`
 * in the client instead, which routed every full-resolution frame through a
 * Worker: twenty-four invocations and twenty-four Worker-egress copies per
 * page. CONTEXT.md §Q25 settled batches this size as presigned URLs, and the
 * client had no business deciding otherwise — which is the narrower lesson
 * here. A URL to a private object is the API's to mint.
 *
 * `loading="lazy"` because a four-column grid is taller than the viewport and
 * the tiles below the fold were competing with the ones above it for the same
 * connections.
 *
 * **On-demand supplementary prelabel (M17, plan §B).** This grid is already
 * the selection surface `admin-prelabel.ts`'s own module comment assumes —
 * an operator looking at frames and deciding what to look at next — so the
 * refill controls live here rather than on a page of their own. Three
 * actions since M25, deliberately not styled or worded alike: "prelabel
 * selected" writes `manual` and lands a hand-picked frame in the permanent
 * *train* split; "randomise N un-sampled" writes `random` and lands in the
 * permanent *eval* split, same as the automatic first pass always has; and
 * "diversify N un-sampled" (M25, plan §A) writes `diverse` — a pHash
 * farthest-point draw over the same remainder, landing in *train*, which is
 * the control that makes a non-empty training set reachable without a human
 * naming every id. CONTEXT.md §Q16 is
 * why that distinction cannot be allowed to look like two colours of the
 * same button — an image can never be retro-declared unbiased once it is
 * chosen the wrong way, and the split it lands in is invisible on this
 * screen the moment the job finishes. Each button's own line of text names
 * its consequence for the same reason the colour does: belt and braces
 * against an operator who cannot see colour, or is not looking at either.
 */
export function AdminVideoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const videoId = id ?? "";
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [randomCount, setRandomCount] = useState(DEFAULT_RANDOM_COUNT);
  const [diverseCount, setDiverseCount] = useState(DEFAULT_DIVERSE_COUNT);

  const detail = useAdminVideoDetail(videoId);
  const images = useAdminVideoImages(videoId, { limit: PAGE_SIZE, offset });
  const setPublicSample = useSetPublicSample();
  const stats = useLabellingStats();
  const createPrelabel = useCreatePrelabel(videoId);

  function toggleSelected(imageId: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(imageId)) next.delete(imageId);
      else next.add(imageId);
      return next;
    });
  }

  function prelabelSelected() {
    if (selected.size === 0) return;
    createPrelabel.mutate(
      { image_ids: [...selected] },
      { onSuccess: () => setSelected(new Set()) },
    );
  }

  function randomiseUnsampled() {
    if (randomCount < 1) return;
    createPrelabel.mutate({ count: randomCount, strategy: "random" });
  }

  function diversifyUnsampled() {
    if (diverseCount < 1) return;
    createPrelabel.mutate({ count: diverseCount, strategy: "diverse" });
  }

  return (
    <div className="flex flex-col gap-4">
      <Link
        to="/admin/videos"
        className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        ← Videos
      </Link>

      {detail.isPending && <p className="text-sm">Loading…</p>}
      {detail.isError && (
        <p role="alert" className="text-sm text-destructive">
          {detail.error.message}
        </p>
      )}
      {detail.data && <VideoHeader detail={detail.data} />}

      {images.data && images.data.total > 0 && (
        <p className="text-sm text-muted-foreground">
          {offset + 1}–{Math.min(offset + PAGE_SIZE, images.data.total)} of {images.data.total}
        </p>
      )}

      <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-border bg-card p-3">
        {/* `pool.images_remaining` is `labellingStatsHandler`'s own drain-and-
            refill number — the whole reason this toolbar exists. Rendered
            only once loaded rather than as a placeholder zero, which would
            read as "the pool is empty" for the instant before the real
            number arrives. */}
        <p className="text-sm text-muted-foreground">
          {stats.data ? (
            <>
              Verification pool:{" "}
              <span className="font-medium text-foreground">
                {stats.data.pool.images_remaining}
              </span>{" "}
              {stats.data.pool.images_remaining === 1 ? "frame" : "frames"} waiting for a ruling
            </>
          ) : (
            "Verification pool: …"
          )}
        </p>

        <div className="flex flex-wrap items-start gap-4">
          <div className="flex flex-col gap-1">
            <Button
              type="button"
              size="sm"
              disabled={selected.size === 0 || createPrelabel.isPending}
              onClick={prelabelSelected}
              // Amber, `STATE_COLOR.unverified`'s own hue — the colour this
              // screen already uses for "needs a look" — because a
              // hand-picked selection is the action with a consequence
              // worth pausing on, not the safe default.
              style={{ backgroundColor: "var(--color-claimed)", color: "var(--color-surface)" }}
            >
              Prelabel {selected.size > 0 ? `${selected.size} ` : ""}selected
            </Button>
            <span className="text-xs text-muted-foreground">
              hand-picked → training data (biased on purpose, CONTEXT.md §Q16)
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                value={randomCount}
                onChange={(event) =>
                  setRandomCount(Math.max(1, Number.parseInt(event.target.value, 10) || 1))
                }
                aria-label="how many un-sampled frames to randomise"
                className="h-8 w-16 rounded-md border border-input bg-background px-2 text-sm"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={createPrelabel.isPending}
                onClick={randomiseUnsampled}
              >
                Randomise un-sampled
              </Button>
            </div>
            <span className="text-xs text-muted-foreground">
              random draw → evaluation data (stays unbiased)
            </span>
          </div>

          {/* M25, plan §A. The third control, worded like the other two and
              for the same reason: the split a frame lands in is permanent and
              invisible on this screen once the job finishes, so each button
              states its own consequence in text rather than relying on a
              colour or a position. This one is the reason the train split
              stops being empty — every image in production before M25 was
              drawn `random` and went to eval, so the only route into training
              data was hand-picking each id. */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                value={diverseCount}
                onChange={(event) =>
                  setDiverseCount(Math.max(1, Number.parseInt(event.target.value, 10) || 1))
                }
                aria-label="how many un-sampled frames to draw by pHash diversity"
                className="h-8 w-16 rounded-md border border-input bg-background px-2 text-sm"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={createPrelabel.isPending}
                onClick={diversifyUnsampled}
              >
                Diversify un-sampled
              </Button>
            </div>
            <span className="text-xs text-muted-foreground">
              pHash farthest-point → training data (biased on purpose, CONTEXT.md §Q16)
            </span>
          </div>
        </div>
      </div>

      {/* `updatePublicSampleHandler`'s 409 (M18, plan §C): flagging a frame in
          is refused when it lands within the spacing floor of one already
          flagged from this video, and the message names the conflict — shown
          here rather than swallowed, since the checkbox itself has nowhere
          to put a sentence this long. */}
      {setPublicSample.isError && (
        <p role="alert" className="text-sm text-destructive">
          {setPublicSample.error.message}
        </p>
      )}

      {/* `createPrelabelHandler`'s own refusals — an already-sampled id, an
          empty un-sampled pool — surface here for the same reason: neither
          button has anywhere else to put a sentence this long. */}
      {createPrelabel.isError && (
        <p role="alert" className="text-sm text-destructive">
          {createPrelabel.error.message}
        </p>
      )}

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
                src={image.url}
                alt={image.r2_key}
                loading="lazy"
                decoding="async"
                className="block aspect-video w-full object-cover"
              />
              <figcaption className="flex flex-col gap-1.5 p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-1.5">
                    {/* Disabled once `sampled` (M17, plan §B): an already-
                        sampled frame is exactly what `createPrelabelHandler`
                        refuses a hand-picked set for, naming it in a 400 —
                        greying it out here means an operator learns that
                        from the grid instead of from an error after
                        clicking. */}
                    <input
                      type="checkbox"
                      checked={selected.has(image.id)}
                      disabled={image.sampled}
                      onChange={() => toggleSelected(image.id)}
                      aria-label={`select frame at ${image.timestamp_seconds}s for prelabelling`}
                    />
                    <span className="font-mono text-muted-foreground">
                      {image.timestamp_seconds}s
                    </span>
                  </label>
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
                    {image.sampled
                      ? "already sampled"
                      : `${image.predictions} ${image.predictions === 1 ? "prediction" : "predictions"}`}
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
