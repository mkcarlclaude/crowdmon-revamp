import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  contributeBatchKey,
  useContributeBatch,
  useSubmitContributeVerdicts,
} from "../api/queries";
import { SwipeCard } from "./SwipeCard";
import type { StagedRuling } from "./swipe-verify-reducer";
import { Button } from "./ui/button";

/**
 * How many frames of buffer the walk keeps ahead of it before fetching the
 * next page (M26.6, plan §C). Not the boundary itself: fetching only once
 * the currently-loaded pages are exhausted puts a spinner in front of every
 * `CONTRIBUTE_BATCH_SIZE`th judgement, which is the click this milestone
 * exists to remove, wearing a different hat.
 */
const PREFETCH_MARGIN = 5;

/**
 * The contributor mount of the swipe component (M20; rebuilt on `SwipeCard`
 * in M24, plan §C; auto-advancing across pages as of M26.6, plan §C).
 * Structurally the batch-walking half of what `LabellingSession` (the admin
 * mount) still does over `VerificationCard` — "walk a pool that drains, one
 * frame at a time" — over a different pool and a different endpoint, the
 * same "one interaction, several mounts" shape M13.1 established.
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
 * **The walk now crosses page boundaries on its own (M26.6).** Before this,
 * `frameIndex` walked one fetched batch and stopped dead at its end,
 * waiting for a "Next batch" click that called `refetchQueries` with no
 * cursor at all — silently re-running the *first* page from the bottom of
 * the key space every time (`useContributeBatch`'s own comment has the full
 * story, including why a trusted contributor never noticed and an untrusted
 * one got the same twenty frames back forever). `useContributeBatch` is now
 * an infinite query; `images` below is its pages flattened, and
 * `fetchNextPage` is called once the walk is within `PREFETCH_MARGIN` frames
 * of the end of what has been fetched, rather than at the boundary itself.
 *
 * **Termination is a seen-id guard, not "no more pages."** The server
 * *wraps* rather than running dry (`contributeBatchHandler`'s own comment):
 * once a cursor passes every key in the pool it comes back around, so
 * `next_cursor` stays non-null forever and "there is no next page" never
 * arrives from the server on its own for a pool with anything in it. The
 * `useMemo` below tracks every image id this session has already shown and
 * drops a fetched page's already-seen ids before appending it to the walk;
 * the instant a fetched page contributes *zero* unseen frames, `drained`
 * goes true and the effect that calls `fetchNextPage` stops calling it. That
 * single guard covers both endings a contributor can actually hit: a
 * genuinely exhausted pool (the very first page comes back with no images at
 * all) and an untrusted contributor's pages repeating forever
 * (`CONTRIBUTOR_UNRULED_BOX`'s own asymmetry, `routes/contribute.ts`) — from
 * here they are the same event: a page with nothing new in it.
 *
 * **The data shape differs from `/demo`'s, and this is the easier half of
 * it (plan §C2).** `/api/public/frame` returns one frame; `/api/contribute/batch`
 * returns `CONTRIBUTE_BATCH_SIZE` (20) with a `remaining` count. `frameIndex`
 * is the walk: it never decreases, and never resets except when the
 * terminal screen's own button is pressed.
 *
 * **The manual button survives only in the terminal state.** With
 * auto-advance doing the paging, there is no "batch done, click for more"
 * step left in the normal flow. The button that used to mean "next batch"
 * only ever appears once the walk has drained, where it means "start over":
 * `queryClient.resetQueries` drops every fetched page, which drops every
 * seen id along with it, the same as a brand new session.
 */
export function ContributeVerify() {
  const queryClient = useQueryClient();
  const batch = useContributeBatch();
  const submit = useSubmitContributeVerdicts();

  const [frameIndex, setFrameIndex] = useState(0);
  const [refreshedFor, setRefreshedFor] = useState<ReadonlySet<number>>(new Set());
  const [brokenFrames, setBrokenFrames] = useState<ReadonlySet<number>>(new Set());

  // Flattened across every page fetched so far, with each page's already
  // seen ids dropped before it is appended — a wrapped page legitimately
  // repeats frames the session has already walked, and re-showing one would
  // both waste a judgement and desynchronize `frameIndex` from what is on
  // screen. `latestRemaining`/`latestRemainingCapped`/`latestPageStart`
  // travel with it: each accepted page's own `remaining` is a snapshot at
  // that page's fetch time, and `latestPageStart` (`images.length` the
  // moment that page was appended) is what lets the render below subtract
  // only the rulings made *since* that snapshot, rather than every ruling
  // this whole session — the same "reset per batch" arithmetic the old
  // per-batch component had, generalized to a walk with no batch boundaries
  // left to reset on.
  const { images, drained, latestRemaining, latestRemainingCapped, latestPageStart } =
    useMemo(() => {
      const seen = new Set<number>();
      const images: NonNullable<typeof batch.data>["pages"][number]["images"] = [];
      let drained = false;
      let latestRemaining = 0;
      let latestRemainingCapped = false;
      let latestPageStart = 0;

      for (const page of batch.data?.pages ?? []) {
        const start = images.length;
        const unseen = page.images.filter((image) => !seen.has(image.id));
        if (unseen.length === 0) {
          drained = true;
          break;
        }
        for (const image of unseen) seen.add(image.id);
        images.push(...unseen);
        latestRemaining = page.remaining;
        latestRemainingCapped = page.remaining_capped;
        latestPageStart = start;
      }

      return { images, drained, latestRemaining, latestRemainingCapped, latestPageStart };
    }, [batch.data]);

  const frame = images[frameIndex];

  // Tops the buffer up once the walk is within `PREFETCH_MARGIN` of its end
  // — but never once `drained` is true, or this would refetch the same
  // repeating (or empty) page forever, which is exactly the silent loop
  // the seen-id guard above exists to stop.
  useEffect(() => {
    if (drained) return;
    if (!batch.hasNextPage || batch.isFetchingNextPage) return;
    if (images.length - frameIndex > PREFETCH_MARGIN) return;
    void batch.fetchNextPage();
  }, [
    drained,
    batch.hasNextPage,
    batch.isFetchingNextPage,
    batch.fetchNextPage,
    images.length,
    frameIndex,
  ]);

  // "Still waiting, beyond what this sitting has already done since the
  // last time the server told us a number" — see the `useMemo` above for
  // why the subtraction starts counting again at `latestPageStart` rather
  // than at 0.
  const stillWaiting = Math.max(0, latestRemaining - Math.max(0, frameIndex - latestPageStart));
  // Rendered as "500+" while the server says its count hit the ceiling. Not
  // decremented in that state either: subtracting progress from a lower
  // bound produces a number that is neither the bound nor the truth, and it
  // would tick down as if the pool were 500 exactly.
  const waitingLabel = latestRemainingCapped ? `${latestRemaining}+` : String(stillWaiting);

  async function startOver() {
    await queryClient.resetQueries({ queryKey: contributeBatchKey });
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
    // Not drained: the buffer just has not caught up with the walk yet (a
    // page is in flight, or the effect above has not fired for this render
    // yet). Rendering the terminal screen here would flash "nothing left" in
    // front of every ordinary prefetch instead of only once the pool
    // actually is exhausted.
    if (!drained) return <p className="text-sm">Loading more frames…</p>;

    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm">
          {stillWaiting > 0
            ? `${waitingLabel} frames still waiting, but none new for this session.`
            : "Nothing left to verify right now — every frame has a ruling."}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={startOver}
        >
          Start over
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        <span className="font-mono">{waitingLabel}</span> in the pool · {frame.video_id} @{" "}
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
