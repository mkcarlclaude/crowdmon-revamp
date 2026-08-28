import { useState } from "react";
import {
  useDeleteGroundTruthBox,
  useDrawGroundTruthBox,
  useGroundTruthAnnotation,
  useGroundTruthPool,
  useSetGroundTruthExhaustive,
} from "../api/queries";
import { GroundTruthCard } from "./GroundTruthCard";
import { Button } from "./ui/button";

/**
 * The admin mount for M26's labelling sitting (#176): walks the frozen
 * pool one frame at a time, the way `LabellingSession` walks a verification
 * batch. Everything that knows an endpoint or an image id lives here;
 * `GroundTruthCard` is handed one frame and callbacks, the same split
 * `LabellingSession`/`VerificationCard` already use.
 *
 * **A position in the worklist, not a queue that shrinks as it is worked.**
 * `LabellingSession` removes a box the moment it is ruled on, because a
 * ruled box has nothing left to show. A frame here does not disappear once
 * marked exhaustive — an annotator revisiting it to fix a missed instance
 * needs to be able to get back to it, and the plan itself treats "already
 * marked" and "not yet looked at" as two states of the same worklist, not
 * a done pile and a todo pile.
 */
export function GroundTruthSession() {
  const pool = useGroundTruthPool();
  const [index, setIndex] = useState(0);

  const images = pool.data?.images ?? [];
  const current = images[index];
  const imageId = current?.id ?? null;

  const annotation = useGroundTruthAnnotation(imageId);
  const drawBox = useDrawGroundTruthBox(imageId ?? -1);
  const deleteBox = useDeleteGroundTruthBox(imageId ?? -1);
  const setExhaustive = useSetGroundTruthExhaustive(imageId ?? -1);

  if (pool.isPending) return <p className="text-sm">Loading the frozen pool…</p>;

  if (pool.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {pool.error.message}
      </p>
    );
  }

  if (images.length === 0) {
    return <p className="text-sm">The frozen pool is empty — nothing to annotate.</p>;
  }

  const busy = drawBox.isPending || deleteBox.isPending || setExhaustive.isPending;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          <span className="font-mono">
            {index + 1} / {images.length}
          </span>{" "}
          · {current?.video_id} @ {current?.timestamp_seconds}s ·{" "}
          <span className="font-mono">{current?.ground_truth_count ?? 0}</span> ground-truth boxes
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={index === 0}
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={index >= images.length - 1}
            onClick={() => setIndex((i) => Math.min(images.length - 1, i + 1))}
          >
            Next
          </Button>
        </div>
      </div>

      {annotation.isPending && <p className="text-sm">Loading this frame…</p>}
      {annotation.isError && (
        <p role="alert" className="text-sm text-destructive">
          {annotation.error.message}
        </p>
      )}

      {annotation.data && (
        <GroundTruthCard
          // Keyed on the frame, `VerificationCard`'s own reason: a draw
          // armed on frame A must not survive the move to frame B and be
          // saved as a box on the wrong image.
          key={annotation.data.image_id}
          frame={annotation.data}
          busy={busy}
          onDrawBox={(classId, box) => drawBox.mutate({ class_id: classId, ...box })}
          onDeleteBox={(groundTruthId) => deleteBox.mutate(groundTruthId)}
          onSetExhaustive={(classId, exhaustive) =>
            setExhaustive.mutate({ class_id: classId, exhaustive })
          }
        />
      )}

      {(drawBox.isError || deleteBox.isError || setExhaustive.isError) && (
        <p role="alert" className="text-sm text-destructive">
          {(drawBox.error ?? deleteBox.error ?? setExhaustive.error)?.message}
        </p>
      )}
    </div>
  );
}
