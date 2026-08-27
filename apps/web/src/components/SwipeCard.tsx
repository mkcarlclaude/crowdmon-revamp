import type { CSSProperties, PointerEventHandler } from "react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import "./SwipeCard.css";
import { type Axis, lockAxis, resolveSwipe, SWIPE_THRESHOLD_PX } from "./swipe-gesture";
import {
  activeId,
  initSwipeState,
  isComplete,
  type StagedRuling,
  type SwipeState,
  type SwipeVerdict,
  stagedRulings,
  swipeReducer,
} from "./swipe-verify-reducer";

/**
 * One frame, its proposed boxes, and a swipe-driven ruling on each (M23;
 * pulled out of `PublicVerify.tsx` into its own component in M24, plan §C2).
 *
 * **`VerificationCard`'s split, one interaction later.** `VerificationCard`
 * (M13.1) was built as one component with two mounts from the start: no
 * fetching, no mutating, no endpoint knowledge, every action a callback the
 * mount supplies. This is that same split for the swipe interaction —
 * `PublicVerify` (the `/demo` mount) and `ContributeVerify` (the `/contribute`
 * mount, M24 §C) both drive this component off a `frame` prop and an
 * `onSubmit` callback, and neither mount's endpoint, batching, or
 * batch-walking logic lives in here. Notably there is still no `allowAdjust`
 * prop and there should not be one — this component never had an adjust
 * gesture to hide. `/contribute` losing adjust (M24 §C1, reversing M20 plan
 * §B4) is exactly the fact that *this* component, rather than
 * `VerificationCard`, is what the contributor mount now renders.
 *
 * **Desktop, M24 plan §A.** Below `lg:` (1024px) this is pixel-for-pixel the
 * validated, hand-tested M23 mobile layout — same classes, same DOM order for
 * the frame and the mobile ticks row, same sticky action bar. `lg:`-prefixed
 * utilities are strictly additive: a two-column row (frame left, a panel
 * right carrying the claim at real size, the ticks again, the buttons as a
 * static stacked control group with their key bindings printed, and one
 * hint line), validated against
 * `design/swipe-prototype:prototypes/verify/desktop-mockup-optionB.html`.
 * The progress ticks render twice — once inline under the frame (`lg:hidden`)
 * and once in the desktop panel (`hidden lg:flex`) — because the mockup puts
 * them in the panel at `lg:` and inline on a phone, and a single element
 * cannot occupy both positions in the flex/grid order at once. Both copies
 * read the same `swipeState`, so there is nothing to keep in sync by hand.
 *
 * **The frame is capped by width, unconditionally (plan §A1).** `max-w-[720px]`
 * sits on the frame's own wrapper (`data-testid="framewrap"`), not behind a
 * `lg:` prefix — a phone's viewport is already narrower than 720px, so this
 * is a no-op below that width and a real bound above it. **Never** capped by
 * `max-height` plus `object-contain`: the boxes below are positioned in
 * percentages *of this wrapper*, so letterboxing the image inside a taller
 * container would silently desync every rectangle from the image it
 * describes — boxes that look plausible and are wrong, the worst failure
 * this screen can have.
 *
 * **The pointer handlers are scoped to the frame column only, not the whole
 * returned tree.** M23's `PublicVerify` put them on a container spanning
 * from the frame down to the action bar because at that width the two were
 * the same column. Now that the action bar can sit in a separate desktop
 * column, keeping the swipe surface scoped to {frame, mobile ticks} keeps a
 * button press from also starting a (harmless but pointless) zero-distance
 * gesture, and keeps `touch-action: pan-y` — which hands vertical drags back
 * to the page — off the one region (the button column) that was never meant
 * to carry it.
 */

export interface SwipeBox {
  id: number;
  class_name: string;
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
  confidence: number;
}

export interface SwipeFrame {
  id: number;
  /** For the `<img>`'s `alt` text — a frame is identified by where it came from. */
  r2_key: string;
  url: string;
  predictions: readonly SwipeBox[];
}

export interface SwipeCardProps {
  frame: SwipeFrame;
  /** Set while a ruling is in flight, so a double swipe cannot write two requests. */
  busy?: boolean;
  /**
   * Fired exactly once per frame, the instant its last box is decided —
   * there is no separate Submit button on this surface. Carries every
   * ruling in the frame's own order, `StagedRuling[]`, same shape
   * `VerificationCard.onSubmit` hands its own mount. An empty array is
   * possible (a frame with no proposed boxes reaches completion
   * immediately) and is the mount's call to make, not this component's —
   * `PublicVerify` skips the network entirely in that case, matching M23.
   */
  onSubmit: (rulings: StagedRuling[]) => void;
  /**
   * A frame whose bytes would not load. Same contract as
   * `VerificationCard.onImageError`: this component cannot tell an expired
   * presigned URL from a genuinely broken object, so it reports and lets
   * the mount decide (M13.4's retry-once shape, reused by both `/demo` and
   * `/contribute`).
   */
  onImageError?: () => void;
  /** Shown when `frame.predictions` is empty. Mount-specific because only `/demo` has a Skip control to point at. */
  emptyMessage?: string;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

interface Gesture {
  x0: number;
  y0: number;
  dx: number;
  axis: Axis | null;
}

export function SwipeCard({
  frame,
  busy = false,
  onSubmit,
  onImageError,
  emptyMessage = "Nothing was proposed on this frame.",
}: SwipeCardProps) {
  const [swipeState, setSwipeState] = useState<SwipeState>(() =>
    initSwipeState(frame.predictions.map((box) => box.id)),
  );
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
  // (M23 plan §A2's "a frame abandoned mid-way discards its staged
  // rulings"). Keyed on `frame.id` rather than the whole `frame` object —
  // every mount hands this a new object identity each render regardless of
  // whether the id changed, and resetting on that would drop mid-swipe
  // state on an ordinary re-render, not just a genuine change of frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the id on purpose, see above.
  useEffect(() => {
    setSwipeState(initSwipeState(frame.predictions.map((box) => box.id)));
  }, [frame.id]);

  const activePredictionId = activeId(swipeState);
  const activePrediction = frame.predictions.find((box) => box.id === activePredictionId) ?? null;

  /**
   * The one entry point both a swipe and a button/keyboard ruling go
   * through, and the one call site that decides "was that the frame's last
   * box" (M23's own reasoning, unchanged): deciding the *active* box, never
   * a specific id, and calling `onSubmit` synchronously the moment the
   * reducer says the frame is complete is what makes a completed frame
   * exactly one call to `onSubmit` rather than something a `useEffect`
   * could double-fire on a re-render.
   */
  function ruleActive(verdict: SwipeVerdict) {
    if (busy) return;
    const next = swipeReducer(swipeState, { type: "rule", verdict });
    if (next === swipeState) return;
    setSwipeState(next);
    if (isComplete(next)) onSubmit(stagedRulings(next));
  }

  function undo() {
    if (busy) return;
    setSwipeState((current) => swipeReducer(current, { type: "undo" }));
  }

  function unstage(id: number) {
    if (busy) return;
    setSwipeState((current) => swipeReducer(current, { type: "unstage", id }));
  }

  // Re-subscribed on every render rather than memoized: a `keydown`
  // listener costs nothing to re-attach, and a stale closure over
  // `swipeState` would silently keep ruling the box from a previous render.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (busy) return;
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
    // of this gesture — see `lockAxis`'s own comment for why a second look
    // partway through would undo the whole point of the arc bias.
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
    // sideways commits regardless of how much it also rose.
    const verdict = resolveSwipe(gesture.axis, gesture.dx);
    if (verdict) ruleActive(verdict);
  };

  const ticks = (
    <>
      {frame.predictions.map((box) => (
        <span
          key={box.id}
          className={cn(
            "h-[3px] flex-1 rounded-full bg-[var(--color-border)]",
            swipeState.verdicts[box.id] !== undefined && "bg-[var(--color-text-muted)]",
            box.id === activePredictionId && "bg-[var(--color-primary)]",
          )}
        />
      ))}
    </>
  );

  return (
    <div className="flex flex-1 flex-col justify-center gap-4 px-4 py-4 sm:px-6 lg:mx-auto lg:w-full lg:max-w-[1200px] lg:flex-row lg:items-center lg:gap-10 lg:p-10">
      {/* The swipe surface: the frame and the mobile progress row. `pan-y`
          hands vertical drags to the page; only a horizontal-locked gesture
          is ours. Scoped here, not around the panel below (see this file's
          own comment on why the buttons stay outside it). */}
      <div
        className="flex flex-col gap-4 [touch-action:pan-y] select-none lg:min-w-0 lg:flex-1"
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={endStageGesture}
        onPointerCancel={endStageGesture}
      >
        <div
          ref={frameRef}
          data-testid="framewrap"
          // Plan §A1: capped by width, always — see this file's top comment
          // for why `max-height` + `object-contain` must never replace this.
          className="swipe-frame relative w-full max-w-[720px] overflow-hidden rounded-xl border border-[var(--color-border)] bg-black pointer-events-none will-change-transform"
        >
          <img
            src={frame.url}
            alt={frame.r2_key}
            draggable={false}
            className="block w-full select-none"
            onError={onImageError}
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

          {frame.predictions.map((box) => {
            const verdict = swipeState.verdicts[box.id];
            const active = box.id === activePredictionId;
            const position: CSSProperties = {
              left: `${box.x_min * 100}%`,
              top: `${box.y_min * 100}%`,
              width: `${(box.x_max - box.x_min) * 100}%`,
              height: `${(box.y_max - box.y_min) * 100}%`,
            };

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

          {/* The claim rides on the active rectangle — coincident boxes
              (two proposals sharing identical geometry) make opacity alone
              convey nothing. Keyed on the prediction id so React remounts
              this node whenever the active claim changes, which is what
              replays the pop-in every time rather than only on the first
              box. */}
          {activePrediction && (
            <div
              key={activePrediction.id}
              data-testid="active-tag"
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

        {/* Progress, not a score — a row of ticks so a visitor who can no
            longer see a list still knows where they are in this frame's
            boxes. Inline here below `lg:`; the desktop panel below renders
            its own copy and hides this one. */}
        <div className="flex gap-1.5 lg:hidden" aria-hidden="true">
          {ticks}
        </div>

        {frame.predictions.length === 0 && (
          <p className="text-center text-xs text-[var(--color-text-muted)]">{emptyMessage}</p>
        )}
      </div>

      {/* Desktop panel (plan §A2): the claim at real size, the ticks again,
          the buttons, and one line of context. Below `lg:` only the buttons
          render anything visible — `claim` and the hint line are `hidden`,
          and this element's own copy of the ticks defers to the inline one
          above so the two never render at once. */}
      <div className="flex flex-col gap-4 lg:w-[260px] lg:flex-none">
        <div className="hidden lg:block" data-testid="claim-panel">
          <div className="text-[26px] leading-[1.15] font-semibold tracking-[-0.02em]">
            {activePrediction?.class_name ?? "—"}
          </div>
          <div className="mt-0.5 font-mono text-[26px] tabular-nums text-[var(--color-primary)]">
            {(activePrediction?.confidence ?? 0).toFixed(2)}
          </div>
          <p className="mt-2.5 text-xs leading-relaxed text-[var(--color-text-muted)]">
            The detector's own confidence. It has never seen these characters, so most of these
            boxes are wrong.
          </p>
        </div>

        <div className="hidden gap-1.5 lg:flex" aria-hidden="true">
          {ticks}
        </div>

        {/* Sticky at the bottom of the viewport below `lg:` (plan §B4 from
            M23) — a thumb zone with nothing to stick past once the layout
            goes two-column, so it becomes an ordinary static control group
            with the key bindings printed (plan §A3), the biggest available
            desktop throughput win at zero markup cost. The negative margin
            below cancels this element's ancestor padding so the bar still
            reaches the same horizontal inset it had as a page-level
            sibling in M23 — nesting it in the desktop panel changes where
            it sits in the tree, not where its edges land on a phone. */}
        <div
          className="sticky bottom-0 -mx-4 flex gap-2.5 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-4 pt-3 sm:-mx-6 sm:px-6 lg:static lg:mx-0 lg:flex-col lg:border-0 lg:bg-transparent lg:px-0 lg:pt-0"
          style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
        >
          <button
            type="button"
            onClick={() => ruleActive("reject")}
            disabled={busy || activePredictionId === null}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-[var(--color-failed)] bg-[var(--color-surface-raised)] py-4 font-semibold disabled:opacity-40 lg:w-full lg:flex-none lg:justify-start lg:gap-3 lg:rounded-lg lg:px-4 lg:py-[15px] lg:text-left"
          >
            <span
              aria-hidden="true"
              className="hidden min-w-[30px] rounded border border-[var(--color-border)] px-1.5 py-0.5 text-center font-mono text-xs text-[var(--color-text-muted)] lg:inline-block"
            >
              ←
            </span>
            <span aria-hidden="true" className="font-mono font-normal opacity-55 lg:hidden">
              ←
            </span>
            No
          </button>
          <button
            type="button"
            onClick={undo}
            disabled={busy || swipeState.lastDecided === null}
            className="w-20 flex-none rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] py-4 text-sm text-[var(--color-text-muted)] disabled:opacity-30 lg:flex lg:w-full lg:items-center lg:justify-start lg:gap-3 lg:rounded-lg lg:px-4 lg:py-[15px] lg:text-left lg:text-base"
          >
            <span
              aria-hidden="true"
              className="hidden min-w-[30px] rounded border border-[var(--color-border)] px-1.5 py-0.5 text-center font-mono text-xs text-[var(--color-text-muted)] lg:inline-block"
            >
              ⌫
            </span>
            Undo
          </button>
          <button
            type="button"
            onClick={() => ruleActive("accept")}
            disabled={busy || activePredictionId === null}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-[var(--color-done)] bg-[var(--color-surface-raised)] py-4 font-semibold disabled:opacity-40 lg:w-full lg:flex-none lg:justify-start lg:gap-3 lg:rounded-lg lg:px-4 lg:py-[15px] lg:text-left"
          >
            <span
              aria-hidden="true"
              className="hidden min-w-[30px] rounded border border-[var(--color-border)] px-1.5 py-0.5 text-center font-mono text-xs text-[var(--color-text-muted)] lg:inline-block"
            >
              →
            </span>
            Yes
            <span aria-hidden="true" className="font-mono font-normal opacity-55 lg:hidden">
              →
            </span>
          </button>
        </div>

        <p className="hidden text-xs leading-relaxed text-[var(--color-text-muted)] lg:block">
          Arrow keys decide. You can still drag the frame.
        </p>
      </div>
    </div>
  );
}
