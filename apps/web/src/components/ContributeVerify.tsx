import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  contributeBatchKey,
  useContributeBatch,
  useSubmitContributeVerdicts,
} from "../api/queries";
import { SwipeCard } from "./SwipeCard";
import type { StagedRuling } from "./swipe-verify-reducer";
import { Button } from "./ui/button";

/**
 * The contributor mount of the swipe component (M20; rebuilt on `SwipeCard`
 * in M24, plan §C). Structurally the batch-walking half of what
 * `LabellingSession` (the admin mount) still does over `VerificationCard` —
 * "walk a batch that drains, one frame at a time" — over a different pool
 * and a different endpoint, the same "one interaction, several mounts"
 * shape M13.1 established.
 *
 * **No adjust (M24, plan §C1 — reverses M20 plan §B4).** M20 gave a
 * contributor the adjust tool on the reasoning that their verdicts are
 * labels, so a tier that could only say "wrong" was the weakest signal
 * available. That is reversed now: every geometric correction comes from an
 * admin on `/admin/verify`. **This is UI-only.**
 * `submitContributeVerdictsHandler` still accepts `adjust` and
 * `CreateVerdictsRequest`'s schema still carries the coordinate fields —
 * this component simply never sends one, the same posture `PublicVerify`
 * already takes (`SwipeCard` never had an adjust gesture at all). Nothing
 * here narrows the API, which is what keeps the trade reversible.
 *
 * **The data shape differs from `/demo`'s, and this is the easier half of
 * it (plan §C2).** `/api/public/frame` returns one frame; `/api/contribute/batch`
 * returns `CONTRIBUTE_BATCH_SIZE` (20) with a `remaining` count. That is a
 * better fit for `SwipeCard`, not a worse one: the batch is already a queue
 * to walk, so there is no prefetch to write (unlike `PublicVerify`'s
 * `usePrefetchNextPublicFrame`) — advancing to the next frame in an
 * already-fetched batch is synchronous, local state, and only the batch
 * itself needs a network round trip. `frameIndex` is that walk: it never
 * decreases, and reaching the end of `batch.data.images` is what triggers
 * `nextBatch()`, mirroring the old per-box `ContributeVerify`'s own
 * "batch done" screen.
 */
export function ContributeVerify() {
  const queryClient = useQueryClient();
  const batch = useContributeBatch();
  const submit = useSubmitContributeVerdicts();

  const [frameIndex, setFrameIndex] = useState(0);
  const [refreshedFor, setRefreshedFor] = useState<ReadonlySet<number>>(new Set());
  const [brokenFrames, setBrokenFrames] = useState<ReadonlySet<number>>(new Set());

  const images = batch.data?.images ?? [];
  const frame = images[frameIndex];

  // `remaining` is the whole unruled pool, not just this batch — the same
  // count `ContributeBatch.remaining` always carried. Subtracting what this
  // sitting has already consumed (`frameIndex`, since each index only
  // advances once its frame's rulings are on the server) gives "still
  // waiting, beyond what I've already done," matching the old component's
  // own arithmetic.
  const stillWaiting = Math.max(0, (batch.data?.remaining ?? 0) - frameIndex);

  async function nextBatch() {
    await queryClient.refetchQueries({ queryKey: contributeBatchKey });
    setFrameIndex(0);
    setRefreshedFor(new Set());
    setBrokenFrames(new Set());
  }

  function handleComplete(rulings: StagedRuling[]) {
    if (!frame) return;
    // A frame with no proposed boxes cannot occur here —
    // `CONTRIBUTOR_UNRULED_BOX` only selects images with at least one
    // unruled box — but guard the same way `PublicVerify` does rather than
    // assume the API's own invariant forever.
    if (rulings.length === 0) return;

    submit.mutate(
      { imageId: frame.id, verdicts: rulings },
      { onSuccess: () => setFrameIndex((current) => current + 1) },
    );
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
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm">
          {stillWaiting > 0
            ? `Batch done. ${stillWaiting} frames still waiting.`
            : "Nothing left to verify right now — every frame has a ruling."}
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
      <p className="text-sm text-muted-foreground">
        <span className="font-mono">{images.length - frameIndex}</span> in this batch,{" "}
        <span className="font-mono">{stillWaiting}</span> in the pool · {frame.video_id} @{" "}
        {frame.timestamp_seconds}s
      </p>

      {brokenFrames.has(frame.id) && (
        <p role="alert" className="text-sm text-destructive">
          That frame's image could not be loaded, and re-requesting the batch did not fix it.
        </p>
      )}

      {submit.isError && (
        <p role="alert" className="text-sm text-destructive">
          {submit.error.message}
        </p>
      )}

      <SwipeCard
        key={frame.id}
        frame={frame}
        busy={submit.isPending}
        onSubmit={handleComplete}
        onImageError={() => {
          if (refreshedFor.has(frame.id)) {
            setBrokenFrames((seen) => new Set(seen).add(frame.id));
            return;
          }
          setRefreshedFor((seen) => new Set(seen).add(frame.id));
          void queryClient.invalidateQueries({ queryKey: contributeBatchKey });
        }}
      />
    </div>
  );
}
