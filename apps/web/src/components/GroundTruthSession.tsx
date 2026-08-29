import type { GroundTruthPool } from "@crowdmon/api/schemas";
import { useEffect, useState } from "react";
import type { z } from "zod";
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
 * **The unfinished worklist, walked one batch at a time (M26.5).** This was
 * every pool image, finished or not, on the reasoning that an annotator
 * revisiting a marked frame needs a way back to it. A real sitting showed
 * the cost of that: Carl drew boxes on ~50 images and pressed "every
 * instance found" on 18, and nothing on screen distinguished the two, so
 * 32 frames' worth of real boxes sat outside the scored set with no sign
 * they were missing. `useGroundTruthPool` now asks for `unmarked=true`, so
 * a frame leaves this list the moment it is marked and what remains is
 * exactly the work still to do.
 *
 * **Deliberately no way to jump to a chosen frame, and no control over the
 * filter either.** The order (`WORKLIST_ORDER`, a deterministic shuffle —
 * `listGroundTruthPoolHandler`'s own comment on why plain `ORDER BY id`
 * was wrong) is what keeps the annotation *order* from becoming a second,
 * hand-picked sample sitting on top of the frozen pool's already-unbiased
 * one: `GET /api/admin/eval-source` scores whatever has been marked
 * exhaustive rather than refusing until the whole pool is done (#177), so
 * for as long as the sitting is incomplete, which images get annotated
 * *first* is which images the eval set is actually drawn from. `unmarked`
 * is a constant here and not a toggle for exactly that reason — narrowing
 * the list to unfinished work takes nothing away from the annotator,
 * whereas a switch they could flip is one more way to steer which frames
 * come up, which is the choice that fact makes dangerous.
 *
 * **`batch` is a snapshot, and that is the whole point of it.** The pool
 * query stays invalidated by every mutation (`queries.ts`) so `total`
 * counts down live as a sitting progresses. Under `unmarked=true` that
 * background refetch returns a *shorter* array — the frame just marked is
 * gone from it — so rendering `pool.data.images` directly would shift
 * every later index by one and throw the annotator to a different frame
 * mid-walk, on the very action that is supposed to advance them. Holding
 * the batch locally and replacing it only when it is exhausted is what
 * keeps a mark from moving the ground under the person making it.
 */
/** One page of the worklist, held as a snapshot — see the header comment. */
type GroundTruthPoolImages = z.infer<typeof GroundTruthPool>["images"];

export function GroundTruthSession() {
  const pool = useGroundTruthPool();
  const [batch, setBatch] = useState<GroundTruthPoolImages | null>(null);
  const [index, setIndex] = useState(0);

  // Adopts a page exactly once — on first load, and after `loadNextBatch`
  // below clears the snapshot to signal the walk is finished with it. The
  // `batch === null` guard is what makes every *other* settle of this query
  // (a mutation's invalidation, a window refocus) a no-op for the walk.
  //
  // `!pool.isFetching` is load-bearing and was found the hard way: without
  // it, `loadNextBatch`'s `setBatch(null)` re-adopts `pool.data` on the very
  // next render, because a refetch leaves the *previous* page in `data`
  // while it is in flight. The walk would restart on the batch it had just
  // finished, and only a test that served a second, different page could
  // tell — the bug is invisible whenever both pages happen to match.
  useEffect(() => {
    if (batch === null && pool.data && !pool.isFetching) setBatch(pool.data.images);
  }, [batch, pool.data, pool.isFetching]);

  const images = batch ?? [];
  const current = images[index];
  const imageId = current?.id ?? null;

  // Asked for only when the walk reaches the end of its snapshot, never on
  // a mark: `refetch` under `unmarked=true` returns the next unfinished
  // frames, which is a new batch to walk from the top rather than an
  // updated view of the current one.
  function loadNextBatch() {
    setIndex(0);
    setBatch(null);
    void pool.refetch();
  }

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

  // Under `unmarked=true` an empty page means the work is finished, not
  // that the pool is empty — the distinction matters, because "nothing to
  // annotate" read as "the pool is empty" would look like a bug on the day
  // the sitting is actually complete.
  if (images.length === 0) {
    return pool.isFetching ? (
      <p className="text-sm">Loading the next batch…</p>
    ) : (
      <p className="text-sm">
        Every image in the frozen pool is marked exhaustively annotated — nothing left to do.
      </p>
    );
  }

  const busy = drawBox.isPending || deleteBox.isPending || setExhaustive.isPending;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          <span className="font-mono">
            {index + 1} / {images.length}
          </span>{" "}
          in this batch · <span className="font-mono">{pool.data?.total ?? images.length}</span>{" "}
          images still unmarked · {current?.video_id} @ {current?.timestamp_seconds}s ·{" "}
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
          {/* At the end of the snapshot, Next fetches the following batch
              rather than dead-ending: the pool is walked in pages of
              `GROUND_TRUTH_POOL_BATCH_SIZE` (`queries.ts`) and a sitting
              runs longer than one of them. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pool.isFetching}
            onClick={() =>
              index >= images.length - 1
                ? loadNextBatch()
                : setIndex((i) => Math.min(images.length - 1, i + 1))
            }
          >
            {index >= images.length - 1 ? "Next batch" : "Next"}
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
