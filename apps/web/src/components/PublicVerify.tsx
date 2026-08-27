import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  publicFrameKey,
  usePrefetchNextPublicFrame,
  usePublicFrame,
  useSubmitPublicVerdicts,
} from "../api/queries";
import { SwipeCard } from "./SwipeCard";
import type { StagedRuling } from "./swipe-verify-reducer";

/**
 * The public mount of `/demo` (M14/M23; renamed from `/verify` in M24, plan
 * §B — see `pages/Demo.tsx`'s own comment for the rename and its redirect).
 *
 * **The swipe itself lives in `SwipeCard` (M24, plan §C2).** This component
 * owns exactly what `/contribute`'s mount cannot share: fetching one frame
 * at a time from `/api/public/frame`, prefetching the next one in the
 * background, submitting a completed frame's rulings to
 * `/api/public/images/{id}/verdicts` with the anonymous session id, and the
 * page's own header, disclosure copy and Skip control. Everything about
 * rendering a frame's boxes, the desktop layout, the gesture and the
 * keyboard bindings is `SwipeCard`'s.
 *
 * **No adjust, on purpose (CONTEXT.md §Q10, §Q11).** `PublicVerdictKind` is
 * `["accept", "reject"]` at the schema layer; `SwipeCard` never had an
 * adjust gesture to hide, so there is nothing to disable here the way
 * `VerificationCard`'s mounts pass `allowAdjust={false}`.
 *
 * **Swipes are buffered, never one write per gesture.** `SwipeCard` holds
 * what a visitor has decided about the frame on screen and calls `onSubmit`
 * exactly once, with every ruling, the instant the frame's last box is
 * decided — see that component's own comment. A frame abandoned before that
 * point — an explicit skip, or simply navigating away — never calls
 * `onSubmit` at all, so its staged rulings are discarded rather than sent;
 * that discard happens inside `SwipeCard` itself, the moment `frame.id`
 * changes, which `advance()` below is what makes happen.
 */

export function PublicVerify() {
  const queryClient = useQueryClient();
  const frame = usePublicFrame();
  // Plan §C (M23): fetched in the background while the visitor decides the
  // frame currently on screen, so `advance()` below can usually promote an
  // already-resolved response instead of making the visitor wait on a fresh
  // request at exactly the moment the interaction feels fastest. Keyed off
  // the current frame's id, so a new prefetch starts the moment `advance()`
  // promotes this one to current.
  const nextFrame = usePrefetchNextPublicFrame(frame.data?.id);
  const submit = useSubmitPublicVerdicts();

  // Same retry-once guard as the desktop mount had, and for the same reason
  // its own comment gives: `/api/public/frame` selects with `ORDER BY
  // RANDOM()`, so a retry after a broken image almost never comes back with
  // the same id. Tracking "have I already spent this attempt's one retry"
  // rather than comparing frame ids is what makes the guard trip on a truly
  // broken pool instead of never tripping at all.
  const [awaitingRetryResult, setAwaitingRetryResult] = useState(false);
  const [broken, setBroken] = useState(false);
  const [justSubmitted, setJustSubmitted] = useState<number | null>(null);

  const busy = submit.isPending;

  async function advance() {
    setAwaitingRetryResult(false);
    setBroken(false);
    if (nextFrame.data) {
      // Already resolved — promote it instead of making the visitor wait on
      // a request that would fetch the exact same next frame again.
      queryClient.setQueryData(publicFrameKey, nextFrame.data);
    } else {
      await queryClient.refetchQueries({ queryKey: publicFrameKey });
    }
  }

  function handleComplete(rulings: StagedRuling[]) {
    if (!frame.data) return;
    // A frame with no proposed boxes reaches completion immediately with
    // nothing decided — `CreatePublicVerdictsRequest` requires at least one
    // ruling, and there is nothing here worth sending.
    if (rulings.length === 0) return;

    submit.mutate(
      { imageId: frame.data.id, verdicts: rulings },
      {
        onSuccess: (result) => {
          setJustSubmitted(result.verdicts);
          void advance();
        },
      },
    );
  }

  function skip() {
    if (busy) return;
    // Cleared here rather than in `advance()` itself: a successful flush
    // also calls `advance()`, and that path wants the "recorded N verdicts"
    // receipt to survive onto the next frame, not be wiped the instant it's
    // shown.
    setJustSubmitted(null);
    void advance();
  }

  function handleImageError() {
    if (awaitingRetryResult) {
      setBroken(true);
      setAwaitingRetryResult(false);
      return;
    }
    setAwaitingRetryResult(true);
    void queryClient.invalidateQueries({ queryKey: publicFrameKey });
  }

  if (frame.isPending) {
    return <p className="p-4 text-sm text-[var(--color-text-muted)]">Loading a frame…</p>;
  }

  if (frame.isError) {
    return (
      <p role="alert" className="p-4 text-sm text-[var(--color-failed)]">
        {frame.error.message}
      </p>
    );
  }

  const { data } = frame;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3 sm:px-6">
        <div>
          <h1 className="text-lg font-semibold">Try it</h1>
          {/* ROADMAP M14.4's own requirement, carried over from the desktop
              copy word for word: nothing typed here becomes a label, and a
              visitor who thinks otherwise has been misled by the absence of
              this sentence. */}
          <p className="mt-1 max-w-md text-xs text-[var(--color-text-muted)]">
            Here's a real frame from the dataset and what the detector thinks is in it. Swipe or use
            the buttons below — you're trying the interface, not labelling the live dataset. Your
            verdicts are recorded but never used to train anything.
          </p>
        </div>
        <button
          type="button"
          onClick={skip}
          disabled={busy}
          className="shrink-0 rounded border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-muted)] disabled:opacity-50"
        >
          Skip frame
        </button>
      </header>

      {broken && (
        <p role="alert" className="px-4 pt-3 text-sm text-[var(--color-failed)] sm:px-6">
          That frame's image could not be loaded, and re-requesting it did not fix it. Try another
          frame.
        </p>
      )}

      {submit.isError && (
        <p role="alert" className="px-4 pt-3 text-sm text-[var(--color-failed)] sm:px-6">
          {submit.error.message}
        </p>
      )}

      {/* Shown back immediately, so the page is not theatre (ROADMAP M14.4) —
          a visitor's swipe has to visibly do something even though nothing
          it produces ever becomes a label. */}
      {justSubmitted !== null && (
        <p className="px-4 pt-3 text-xs text-[var(--color-text-muted)] sm:px-6">
          Recorded {justSubmitted} {justSubmitted === 1 ? "verdict" : "verdicts"} — here's another
          frame.
        </p>
      )}

      <SwipeCard
        frame={data}
        busy={busy}
        onSubmit={handleComplete}
        onImageError={handleImageError}
        emptyMessage="Nothing was proposed on this frame — try Skip."
      />
    </div>
  );
}
