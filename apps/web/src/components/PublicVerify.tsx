import { useQueryClient } from "@tanstack/react-query";
import type { CSSProperties, PointerEventHandler } from "react";
import { useEffect, useRef, useState } from "react";
import {
  publicFrameKey,
  usePrefetchNextPublicFrame,
  usePublicFrame,
  useSubmitPublicVerdicts,
} from "../api/queries";
import { cn } from "../lib/utils";
import "./PublicVerify.css";
import { type Axis, lockAxis, resolveSwipe, SWIPE_THRESHOLD_PX } from "./swipe-gesture";
import {
  activeId,
  initSwipeState,
  isComplete,
  type SwipeState,
  type SwipeVerdict,
  stagedRulings,
  swipeReducer,
} from "./swipe-verify-reducer";

/**
 * The public mount of `/verify` (M23, rebuilding M14.2/M14.4's desktop
 * component into one decision at a time, driven by a swipe).
 *
 * **Reference:** `docs/superpowers/plans/2026-08-26-swipe-verification-on-mobile.md`,
 * validated against `design/swipe-prototype:prototypes/verify/swipe-verify-prototype.html`
 * across four rounds of hand-testing. Every gesture constant below —
 * `SWIPE_THRESHOLD_PX`, the axis lock's arc bias, the 10px lock distance —
 * came from that prototype, not from this file, and lives in
 * `./swipe-gesture.ts` so it can be asserted on without a browser.
 *
 * **No adjust, on purpose (CONTEXT.md §Q10, plan's "what this deliberately
 * does not do").** `PublicVerdictKind` is `["accept", "reject"]` at the
 * schema layer; there is no third gesture or button here because there is
 * nowhere for it to go.
 *
 * **Swipes are buffered, never one write per gesture (plan §A2).** `swipeReducer`
 * holds what a visitor has decided about the frame on screen; nothing
 * reaches the network until the frame's last box is decided, at which point
 * `flush` sends the whole batch as one request — both because `verdicts` is
 * append-only (a mis-swipe written immediately is permanent) and because the
 * public route's rate limit is 20 requests/60s, which one request per swipe
 * would exhaust in about twenty seconds of ordinary use. A frame abandoned
 * before that point — an explicit skip, or simply navigating away — never
 * calls `flush` at all, so its staged rulings are discarded rather than
 * sent; see the effect below that reinitializes `swipeState` whenever the
 * frame's id changes, which is the one place that discard happens.
 *
 * **The whole stage is the swipe surface, not the frame (plan §B1).** The
 * pointer handlers below are on the container between the header and the
 * action bar; the image itself is `pointer-events-none` so a press anywhere
 * in that band — including on top of the picture — starts a gesture. A
 * resolved box re-enables its own `pointer-events-auto` as the tap-to-
 * unstage secondary path (plan §A3), which is why it's a real click target
 * layered back on top rather than a `pointer-events: none` descendant.
 */

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

interface Gesture {
  x0: number;
  y0: number;
  dx: number;
  axis: Axis | null;
}

export function PublicVerify() {
  const queryClient = useQueryClient();
  const frame = usePublicFrame();
  // Plan §C: fetched in the background while the visitor decides the frame
  // currently on screen, so `advance()` below can usually promote an
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
  const [swipeState, setSwipeState] = useState<SwipeState>(() => initSwipeState([]));
  const [reducedMotion, setReducedMotion] = useState(
    () => typeof window !== "undefined" && window.matchMedia(REDUCED_MOTION_QUERY).matches,
  );

  const frameRef = useRef<HTMLDivElement>(null);
  const washYesRef = useRef<HTMLDivElement>(null);
  const washNoRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = () => setReducedMotion(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // The one place a frame's staged rulings ever go away without being sent
  // (plan §A2's "a frame abandoned mid-way discards its staged rulings").
  // This fires whenever the id on screen changes for *any* reason — a
  // successful flush promoting the prefetched next frame, an explicit skip,
  // or the very first load — and there is deliberately no other path that
  // carries `swipeState` across that boundary.
  useEffect(() => {
    if (frame.data) {
      setSwipeState(initSwipeState(frame.data.predictions.map((box) => box.id)));
    }
  }, [frame.data]);

  const busy = submit.isPending;
  const activePredictionId = frame.data ? activeId(swipeState) : null;
  const activePrediction =
    frame.data?.predictions.find((box) => box.id === activePredictionId) ?? null;

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

  function flush(completed: SwipeState) {
    if (!frame.data) return;
    const rulings = stagedRulings(completed);
    // A frame with no proposed boxes reaches `isComplete` immediately with
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

  /**
   * The one entry point both a swipe and a button/keyboard ruling go
   * through. Deciding the *active* box (never a specific id) and checking
   * completion synchronously, right here, is what makes the flush in `flush`
   * above exactly-once: there is one call site where "was that the frame's
   * last box" gets answered, not a `useEffect` reacting to state that undo
   * could also have produced.
   */
  function ruleActive(verdict: SwipeVerdict) {
    if (busy || !frame.data) return;
    const next = swipeReducer(swipeState, { type: "rule", verdict });
    if (next === swipeState) return;
    setSwipeState(next);
    if (isComplete(next)) flush(next);
  }

  function undo() {
    if (busy) return;
    setSwipeState((current) => swipeReducer(current, { type: "undo" }));
  }

  function unstage(id: number) {
    if (busy) return;
    setSwipeState((current) => swipeReducer(current, { type: "unstage", id }));
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

  // Arrows and Backspace are alternatives to the buttons, not the only path
  // — matching `VerificationCard`'s own posture that swipe/keyboard/pointer
  // are peers. Re-subscribed on every relevant change rather than memoized:
  // a `keydown` listener costs nothing to re-attach and a stale closure over
  // `swipeState` would silently keep ruling the box from three frames ago.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (busy || !frame.data) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        ruleActive("accept");
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        ruleActive("reject");
      } else if (event.key === "Backspace") {
        event.preventDefault();
        undo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function resetGestureVisuals() {
    if (washYesRef.current) washYesRef.current.style.opacity = "0";
    if (washNoRef.current) washNoRef.current.style.opacity = "0";
  }

  const onStagePointerDown: PointerEventHandler<HTMLDivElement> = (event) => {
    if (busy || activePredictionId === null) return;
    gestureRef.current = { x0: event.clientX, y0: event.clientY, dx: 0, axis: null };
    if (frameRef.current) frameRef.current.style.transition = "none";
  };

  const onStagePointerMove: PointerEventHandler<HTMLDivElement> = (event) => {
    const gesture = gestureRef.current;
    if (!gesture) return;

    const ax = event.clientX - gesture.x0;
    const ay = event.clientY - gesture.y0;

    // Decided once, after 10px of travel, and never revisited for the rest
    // of this gesture (plan §B2) — see `lockAxis`'s own comment for why a
    // second look partway through would undo the whole point of the bias.
    if (gesture.axis === null) {
      const axis = lockAxis(ax, ay);
      if (axis === null) return;
      gesture.axis = axis;
      // Captured only on the axis this gesture claimed. A vertical lock has
      // to stay uncaptured, or `touch-action: pan-y` never gets a chance to
      // hand the gesture to the page as a scroll.
      if (axis === "x") event.currentTarget.setPointerCapture(event.pointerId);
    }

    if (gesture.axis !== "x") return;
    gesture.dx = ax;

    if (frameRef.current && !reducedMotion) {
      frameRef.current.style.transform = `translateX(${ax}px) rotate(${ax / 60}deg)`;
    }
    const travel = Math.min(Math.abs(ax) / SWIPE_THRESHOLD_PX, 1);
    if (washYesRef.current) washYesRef.current.style.opacity = ax > 0 ? String(travel) : "0";
    if (washNoRef.current) washNoRef.current.style.opacity = ax < 0 ? String(travel) : "0";
  };

  const endStageGesture: PointerEventHandler<HTMLDivElement> = () => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture) return;

    if (frameRef.current) {
      frameRef.current.style.transition = reducedMotion ? "none" : "transform 0.2s";
      frameRef.current.style.transform = "";
    }
    resetGestureVisuals();

    // Horizontal displacement only — an arc that traveled far enough
    // sideways commits regardless of how much it also rose (plan §B3).
    const verdict = resolveSwipe(gesture.axis, gesture.dx);
    if (verdict) ruleActive(verdict);
  };

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

      {/* Plan §B4: `flex-1` lets this grow, never a fixed height, so the
          document as a whole can exceed the viewport and scroll. `pan-y`
          hands vertical drags to the page; only a horizontal-locked gesture
          is ours. */}
      <div
        className="flex flex-1 flex-col justify-center gap-4 px-4 py-4 [touch-action:pan-y] select-none sm:px-6"
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={endStageGesture}
        onPointerCancel={endStageGesture}
      >
        <div
          ref={frameRef}
          // No `touch-action` override here — the plan is explicit that
          // `none` never belongs on this surface, and this element doesn't
          // need one anyway: `pointer-events-none` already keeps it from
          // ever being the hit target itself. The stage above carries
          // `pan-y`; the resolved-box `<button>`s below carry their own
          // default `auto`.
          className="swipe-frame relative w-full overflow-hidden rounded-xl border border-[var(--color-border)] bg-black pointer-events-none will-change-transform"
        >
          <img
            src={data.url}
            alt={data.r2_key}
            draggable={false}
            className="block w-full select-none"
            onError={() => {
              if (awaitingRetryResult) {
                setBroken(true);
                setAwaitingRetryResult(false);
                return;
              }
              setAwaitingRetryResult(true);
              void queryClient.invalidateQueries({ queryKey: publicFrameKey });
            }}
          />

          <div
            ref={washYesRef}
            className="pointer-events-none absolute inset-0 opacity-0"
            style={{
              background:
                "linear-gradient(270deg, color-mix(in oklch, var(--color-done) 45%, transparent), transparent 60%)",
            }}
          />
          <div
            ref={washNoRef}
            className="pointer-events-none absolute inset-0 opacity-0"
            style={{
              background:
                "linear-gradient(90deg, color-mix(in oklch, var(--color-failed) 45%, transparent), transparent 60%)",
            }}
          />

          {data.predictions.map((box) => {
            const verdict = swipeState.verdicts[box.id];
            const active = box.id === activePredictionId;
            const position: CSSProperties = {
              left: `${box.x_min * 100}%`,
              top: `${box.y_min * 100}%`,
              width: `${(box.x_max - box.x_min) * 100}%`,
              height: `${(box.y_max - box.y_min) * 100}%`,
            };

            // Resolved boxes are a real `<button>`, not a `<span>` with an
            // `onClick` bolted on — plan §A3's "tapping a resolved box" is a
            // secondary path to Undo, and a genuine interactive element gets
            // keyboard/AT support for that tap for free instead of needing a
            // hand-rolled `onKeyDown` to match. Undecided boxes stay inert
            // `<span>`s: there is nothing to tap yet.
            if (verdict) {
              return (
                <button
                  key={box.id}
                  type="button"
                  data-testid={`box-${box.id}`}
                  onClick={() => unstage(box.id)}
                  aria-label={`Undo ${verdict === "accept" ? "Yes" : "No"} on ${box.class_name}`}
                  className={cn(
                    "pointer-events-auto absolute cursor-pointer appearance-none border-2 bg-transparent p-0",
                    verdict === "accept"
                      ? "border-[var(--color-done)] opacity-50"
                      : "swipe-box-rejected border-dashed border-[var(--color-failed)] opacity-35",
                  )}
                  style={position}
                />
              );
            }

            return (
              <span
                key={box.id}
                data-testid={`box-${box.id}`}
                className={cn(
                  "absolute border-2",
                  active
                    ? "border-[3px] border-[var(--color-primary)]"
                    : "border-[var(--color-claimed)] opacity-20",
                )}
                style={position}
              />
            );
          })}

          {/* Plan §A1: the claim rides on the active rectangle, not a
              dimmed/undimmed distinction — coincident boxes (this dataset's
              own "Paimon 0.20"/"Raiden Shogun 0.17" over one rectangle) make
              opacity alone convey nothing. `key`ing on the prediction id
              means React remounts this node whenever the active claim
              changes, which is what replays the pop-in every time rather
              than only on the first box. */}
          {activePrediction && (
            <div
              key={activePrediction.id}
              className="swipe-tag swipe-tag-pop pointer-events-none absolute flex origin-top-left items-baseline gap-1.5 rounded-br-md bg-[var(--color-primary)] px-2 py-1 text-[13px] font-semibold whitespace-nowrap text-[var(--color-primary-foreground)]"
              style={{
                left: `${activePrediction.x_min * 100}%`,
                top: `${activePrediction.y_min * 100}%`,
              }}
            >
              {activePrediction.class_name}
              <span className="font-mono text-[11px] font-normal opacity-80">
                {activePrediction.confidence.toFixed(2)}
              </span>
            </div>
          )}
        </div>

        {/* Progress, not a score (plan §A1) — a row of ticks so a visitor
            who can no longer see a list still knows where they are in this
            frame's boxes. */}
        <div className="flex gap-1.5" aria-hidden="true">
          {data.predictions.map((box) => (
            <span
              key={box.id}
              className={cn(
                "h-[3px] flex-1 rounded-full bg-[var(--color-border)]",
                swipeState.verdicts[box.id] !== undefined && "bg-[var(--color-text-muted)]",
                box.id === activePredictionId && "bg-[var(--color-primary)]",
              )}
            />
          ))}
        </div>

        {data.predictions.length === 0 && (
          <p className="text-center text-xs text-[var(--color-text-muted)]">
            Nothing was proposed on this frame — try Skip.
          </p>
        )}
      </div>

      {/* Plan §B4: sticky, not fixed, so it stays in the thumb zone without
          being taken out of the document flow — and plan §A3: Undo is a
          peer of Yes/No, disabled rather than hidden so the row never
          reflows. */}
      <div
        className="sticky bottom-0 flex gap-2.5 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-4 pt-3 sm:px-6"
        style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
      >
        <button
          type="button"
          onClick={() => ruleActive("reject")}
          disabled={busy || activePredictionId === null}
          className="flex-1 rounded-xl border border-[var(--color-failed)] bg-[var(--color-surface-raised)] py-4 font-semibold disabled:opacity-40"
        >
          <span className="mr-1.5 font-mono font-normal opacity-55" aria-hidden="true">
            ←
          </span>
          No
        </button>
        <button
          type="button"
          onClick={undo}
          disabled={busy || swipeState.lastDecided === null}
          className="w-20 flex-none rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] py-4 text-sm text-[var(--color-text-muted)] disabled:opacity-30"
        >
          Undo
        </button>
        <button
          type="button"
          onClick={() => ruleActive("accept")}
          disabled={busy || activePredictionId === null}
          className="flex-1 rounded-xl border border-[var(--color-done)] bg-[var(--color-surface-raised)] py-4 font-semibold disabled:opacity-40"
        >
          Yes
          <span className="ml-1.5 font-mono font-normal opacity-55" aria-hidden="true">
            →
          </span>
        </button>
      </div>
    </div>
  );
}
