import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  labellingBatchKey,
  useClasses,
  useLabellingBatch,
  useReportMissing,
  useSetPublicSample,
  useSubmitVerdicts,
} from "../api/queries";
import { Button } from "./ui/button";
import { VerificationCard } from "./VerificationCard";

/**
 * The admin mount of the verification component (M13.1, M13.4).
 *
 * Everything that knows a URL, an endpoint or an identity lives here.
 * `VerificationCard` is handed a frame and some callbacks; M14's public mount
 * will hand it the same frame shape from a different endpoint, and neither
 * component has to grow a mode flag for that to work.
 *
 * **What this owns that the card does not.** Which frame is current, and when
 * to ask for more: a batch is a queue the operator walks, and a frame leaves
 * it when every box on it has been ruled on — locally, without a round trip,
 * because the server's own definition of "unruled" would only agree after a
 * refetch that reshuffles the page under the cursor.
 *
 * **An image that will not load is an expiry, until proven otherwise.** M13.4
 * requires the UI to re-request the batch on a 403 rather than treat it as an
 * error, and a presigned URL is exactly a thing that stops working on a clock.
 * The one refresh per batch is the guard: a second failure on freshly-signed
 * URLs is not an expiry, and re-requesting forever would turn one missing R2
 * object into a request loop.
 */
export function LabellingSession() {
  const queryClient = useQueryClient();
  const batch = useLabellingBatch();
  const classes = useClasses();
  const submit = useSubmitVerdicts();
  const reportMissing = useReportMissing();
  const setPublicSample = useSetPublicSample();

  // Prediction and image ids this session has finished with. Kept as ids
  // rather than an index, because a frame is finished by having no boxes left
  // — an index would have to be recomputed whenever a ruling landed anyway.
  const [ruled, setRuled] = useState<ReadonlySet<number>>(new Set());
  const [done, setDone] = useState<ReadonlySet<number>>(new Set());
  // Which frames a re-request has already been spent on, and which are broken
  // beyond one. Image ids rather than booleans: a batch is twenty frames and a
  // signature lasts fifteen minutes, so a second frame expiring later in the
  // same sitting is ordinary — a boolean would spend the session's one refresh
  // on the first expiry and call every later one a missing object. It would
  // also leave that alert on screen for every frame after it.
  const [refreshedFor, setRefreshedFor] = useState<ReadonlySet<number>>(new Set());
  const [brokenFrames, setBrokenFrames] = useState<ReadonlySet<number>>(new Set());

  const remainingFrames = (batch.data?.images ?? [])
    .filter((image) => !done.has(image.id))
    .map((image) => ({
      ...image,
      predictions: image.predictions.filter((box) => !ruled.has(box.id)),
    }))
    .filter((image) => image.predictions.length > 0);

  const frame = remainingFrames[0];

  /**
   * How many frames are still waiting, including this batch's leftovers.
   *
   * The server's count minus what this session has finished from the batch it
   * was counted with. `remaining` is captured when the batch is fetched and a
   * verdict deliberately does not refetch it (`useLabellingBatch`), so shown
   * raw it never moves: an operator who has just cleared the whole pool would
   * be told twenty frames are waiting and handed a "Next batch" button that
   * returns nothing.
   */
  const consumed = (batch.data?.images.length ?? 0) - remainingFrames.length;
  const stillWaiting = Math.max(0, (batch.data?.remaining ?? 0) - consumed);

  async function nextBatch() {
    // Refetched *before* the local sets are cleared, not after. React Query
    // serves the previous data while a refetch is in flight, so clearing first
    // would re-render the batch just finished with every box unfiltered — an
    // operator looking at frames they already ruled on, with live buttons that
    // would append a second verdict to each.
    await queryClient.refetchQueries({ queryKey: labellingBatchKey });
    setRuled(new Set());
    setDone(new Set());
    setRefreshedFor(new Set());
    setBrokenFrames(new Set());
  }

  if (batch.isPending) return <p className="text-sm">Loading frames…</p>;

  if (batch.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {batch.error.message}
      </p>
    );
  }

  if (!frame) {
    // Two different states with one control: a batch that was worked through
    // with more waiting behind it, and a pool with nothing left in it.
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm">
          {stillWaiting > 0
            ? `Batch done. ${stillWaiting} frames still waiting.`
            : "Nothing left to verify — every pre-labelled frame has been ruled on."}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={nextBatch}
        >
          {stillWaiting > 0 ? "Next batch" : "Check again"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          <span className="font-mono">{remainingFrames.length}</span> in this batch,{" "}
          <span className="font-mono">{stillWaiting}</span> in the pool · {frame.video_id} @{" "}
          {frame.timestamp_seconds}s
        </p>

        {/* M14.1: the only place an admin flags a legible frame into the
            public verification page. A checkbox rather than a button, so its
            own state is the only indicator needed — no separate "flagged"
            badge to keep in sync with it. */}
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={frame.public_sample}
            disabled={setPublicSample.isPending}
            onChange={(event) =>
              setPublicSample.mutate({ imageId: frame.id, publicSample: event.target.checked })
            }
          />
          In public sample
        </label>
      </div>

      {brokenFrames.has(frame.id) && (
        <p role="alert" className="text-sm text-destructive">
          That frame's image could not be loaded, and re-requesting the batch did not fix it. The
          object may be missing from R2.
        </p>
      )}

      <VerificationCard
        // Keyed on the frame, so its internal state does not outlive the frame
        // it belongs to. Without this, "Adjust" armed on frame A survives the
        // move to frame B — and a box drawn on B would be saved as an
        // adjustment to A's prediction, which is a corrupted row in the one
        // table the append-only design exists to keep trustworthy.
        key={frame.id}
        frame={frame}
        classes={classes.data?.classes}
        busy={submit.isPending || reportMissing.isPending}
        onSubmit={(verdicts) =>
          submit.mutate(
            { imageId: frame.id, verdicts },
            // Marked ruled on success rather than optimistically: a submission
            // that failed and still moved the frame on is a set of boxes
            // silently dropped from the dataset, which is the one outcome this
            // screen exists to prevent.
            {
              onSuccess: () =>
                setRuled((seen) => {
                  const next = new Set(seen);
                  for (const ruling of verdicts) next.add(ruling.prediction_id);
                  return next;
                }),
            },
          )
        }
        // A missing-object report is not a ruling on any box, so the frame
        // stays put: whatever the detector *did* propose on it still needs
        // accepting or rejecting.
        onReportMissing={(classId) =>
          reportMissing.mutate({ imageId: frame.id, class_id: classId })
        }
        onImageError={() => {
          // One re-request per frame, not per batch: the second failure on a
          // freshly signed URL is a missing R2 object rather than an expiry,
          // and the frame it happened to is the one the alert is about.
          if (refreshedFor.has(frame.id)) {
            setBrokenFrames((seen) => new Set(seen).add(frame.id));
            return;
          }
          setRefreshedFor((seen) => new Set(seen).add(frame.id));
          void queryClient.invalidateQueries({ queryKey: labellingBatchKey });
        }}
      />

      {submit.isError && (
        <p role="alert" className="text-sm text-destructive">
          {submit.error.message}
        </p>
      )}
      {reportMissing.isError && (
        <p role="alert" className="text-sm text-destructive">
          {reportMissing.error.message}
        </p>
      )}
      {/* Scoped to the frame the report was filed against, not to the mutation
          being successful: the report does not advance the session, so a bare
          `isSuccess` would keep the confirmation on screen across every later
          frame and read as a claim about whichever one is showing. */}
      {reportMissing.data?.image_id === frame.id && (
        <p className="text-sm text-muted-foreground">Missing-object report recorded.</p>
      )}
    </div>
  );
}
