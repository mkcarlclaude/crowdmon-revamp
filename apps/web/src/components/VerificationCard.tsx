import { useId, useRef, useState } from "react";

/**
 * One frame, its proposed boxes, and a ruling on each (M13.1).
 *
 * **Built as one component with two mounts from the start.** M14 renders this
 * same thing against unauthenticated endpoints for a stranger with no account,
 * so nothing here fetches, mutates, or knows a URL: every action is a callback
 * the mount supplies, and every optional callback is a capability the mount
 * either has or does not. The admin mount passes all of them; the public one
 * will pass the verdict callback and leave `onReportMissing` off, and the
 * component renders a page without a missing-object control rather than a
 * control that 403s.
 *
 * **Verify, never draw.** There is no "add a box" action and there should not
 * be one. PRD.md §9 is explicit that 2023 failed from the opposite direction —
 * an annotation UI where every box was drawn from scratch, so hour ten cost
 * what hour one cost. The one thing verify-only cannot see, a character the
 * detector missed entirely, goes to `onReportMissing` as a report rather than
 * to a drawing tool (M13.3).
 *
 * **Rejecting the whole frame is one action.** Menus, loading screens and
 * black frames are the common case in a sampled timeline, and they carry as
 * many spurious boxes as the detector felt like proposing. Making that cost
 * one click per box would make the common case the expensive one.
 */

export interface ProposedBox {
  id: number;
  class_id: number;
  class_name: string;
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
  confidence: number;
}

export interface VerificationFrame {
  id: number;
  url: string;
  /** For the alt text and for the caption — a frame is identified by where it came from. */
  r2_key: string;
  predictions: ProposedBox[];
}

/** A box in [0, 1], the same shape the verdict endpoint takes. */
export interface AdjustedBox {
  adjusted_x_min: number;
  adjusted_y_min: number;
  adjusted_x_max: number;
  adjusted_y_max: number;
}

export interface VerificationCardProps {
  frame: VerificationFrame;
  /** Accept and reject carry no box; an adjust carries the corrected one. */
  onVerdict: (
    predictionId: number,
    verdict: "accept" | "adjust" | "reject",
    adjusted?: AdjustedBox,
  ) => void;
  /** Admin-only in v2, and absent rather than disabled on a mount without it. */
  onRejectFrame?: () => void;
  /** Admin-only (M13.3). `null` means "something is here" with no class named. */
  onReportMissing?: (classId: number | null) => void;
  /** The roster the missing-object picker offers. Ignored when `onReportMissing` is absent. */
  classes?: Array<{ id: number; name: string }>;
  /**
   * A frame whose bytes would not load. The admin mount treats this as an
   * expired presigned URL and re-requests the batch (M13.4) rather than
   * showing a broken image — the component itself has no way to tell an
   * expiry from a genuinely missing object, so it reports and lets the mount
   * decide.
   */
  onImageError?: () => void;
  /** Set while a ruling is in flight, so a double click cannot write two verdicts. */
  busy?: boolean;
}

/** Where a drag started and where it is now, in normalized [0, 1] coordinates. */
interface Drag {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const asBox = (drag: Drag) => ({
  x_min: Math.min(drag.x1, drag.x2),
  y_min: Math.min(drag.y1, drag.y2),
  x_max: Math.max(drag.x1, drag.x2),
  y_max: Math.max(drag.y1, drag.y2),
});

export function VerificationCard({
  frame,
  onVerdict,
  onRejectFrame,
  onReportMissing,
  classes,
  onImageError,
  busy = false,
}: VerificationCardProps) {
  const missingId = useId();
  const surface = useRef<HTMLDivElement>(null);
  const [adjusting, setAdjusting] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // Whether the pointer is still down. Separate from `drag` being non-null,
  // which only says a box has been drawn: without this, `onPointerMove` keeps
  // tracking the cursor after the button is released, so moving from the frame
  // down to "Save adjustment" stretches the box on the way and saves whatever
  // it had become. Every adjustment would be wrong, and a test that replays
  // down/move/up with no movement afterwards would not see it.
  const [dragging, setDragging] = useState(false);
  const [missingClass, setMissingClass] = useState("");

  /**
   * A pointer position as a fraction of the rendered frame.
   *
   * Normalized here rather than stored in pixels for the reason migration 0003
   * stores boxes that way: the frame is rendered at whatever width the layout
   * gives it, and a pixel coordinate would mean something different on the
   * next viewport. A zero-sized rect — a frame that has not laid out yet —
   * returns null rather than dividing by it.
   */
  function positionOf(event: {
    clientX: number;
    clientY: number;
  }): { x: number; y: number } | null {
    const rect = surface.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;

    const clamp = (value: number) => Math.min(1, Math.max(0, value));
    return {
      x: clamp((event.clientX - rect.left) / rect.width),
      y: clamp((event.clientY - rect.top) / rect.height),
    };
  }

  const drawn = drag ? asBox(drag) : null;
  // A drag that never moved is a click, not a box: saving it would write a
  // degenerate zero-area correction that the schema happily accepts.
  const drawnIsUsable = drawn !== null && drawn.x_max > drawn.x_min && drawn.y_max > drawn.y_min;

  function cancelAdjustment() {
    setAdjusting(null);
    setDrag(null);
    setDragging(false);
  }

  function saveAdjustment() {
    if (adjusting === null || !drawn || !drawnIsUsable) return;

    onVerdict(adjusting, "adjust", {
      adjusted_x_min: drawn.x_min,
      adjusted_y_min: drawn.y_min,
      adjusted_x_max: drawn.x_max,
      adjusted_y_max: drawn.y_max,
    });
    cancelAdjustment();
  }

  return (
    <section className="flex flex-col gap-3">
      {/* The drag surface carries pointer handlers and no keyboard equivalent,
          which is deliberate rather than an oversight: it is an *alternative*
          to the Accept and Reject buttons below, which are ordinary focusable
          buttons and are how every verdict except an adjustment is recorded.
          Drawing a rectangle by keyboard is a control worth inventing when
          somebody needs it, not before. */}
      <div
        ref={surface}
        className="relative select-none overflow-hidden rounded border border-[var(--color-border)]"
        onPointerDown={(event) => {
          if (adjusting === null) return;
          const at = positionOf(event);
          if (!at) return;
          // Captured so a drag that leaves the frame still finishes here
          // rather than being lost to whatever it passed over.
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
          setDrag({ x1: at.x, y1: at.y, x2: at.x, y2: at.y });
        }}
        onPointerMove={(event) => {
          if (!dragging || drag === null) return;
          const at = positionOf(event);
          if (!at) return;
          setDrag({ ...drag, x2: at.x, y2: at.y });
        }}
        onPointerUp={(event) => {
          setDragging(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        // A pointer that is cancelled — a touch turned into a scroll, a device
        // lost — never sends `pointerup`, so without this the box would stay
        // live and the next mouse move would resume drawing it.
        onPointerCancel={() => setDragging(false)}
      >
        <img src={frame.url} alt={frame.r2_key} className="block w-full" onError={onImageError} />

        {frame.predictions.map((box) => (
          <span
            key={box.id}
            className={`absolute border-2 ${
              adjusting === box.id
                ? "border-[var(--color-failed)]"
                : "border-[var(--color-claimed)]"
            }`}
            style={{
              left: `${box.x_min * 100}%`,
              top: `${box.y_min * 100}%`,
              width: `${(box.x_max - box.x_min) * 100}%`,
              height: `${(box.y_max - box.y_min) * 100}%`,
            }}
            // On the box rather than in a legend, for `DryRunPanel`'s reason: a
            // number somewhere else is a number nobody connects to the
            // rectangle it belongs to.
            title={`${box.class_name} — confidence ${box.confidence.toFixed(2)}`}
            data-testid={`box-${box.id}`}
          />
        ))}

        {drawn && (
          <span
            data-testid="adjustment"
            className="absolute border-2 border-dashed border-[var(--color-done)]"
            style={{
              left: `${drawn.x_min * 100}%`,
              top: `${drawn.y_min * 100}%`,
              width: `${(drawn.x_max - drawn.x_min) * 100}%`,
              height: `${(drawn.y_max - drawn.y_min) * 100}%`,
            }}
          />
        )}
      </div>

      {adjusting !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-[var(--color-text-muted)]">
            Drag on the frame to draw the corrected box.
          </p>
          <button
            type="button"
            disabled={!drawnIsUsable || busy}
            onClick={saveAdjustment}
            className="rounded border border-[var(--color-border)] px-3 py-1 text-sm disabled:opacity-50"
          >
            Save adjustment
          </button>
          <button
            type="button"
            onClick={cancelAdjustment}
            className="rounded border border-[var(--color-border)] px-3 py-1 text-sm"
          >
            Cancel
          </button>
        </div>
      )}

      <ul className="flex flex-col gap-2">
        {frame.predictions.map((box) => (
          <li
            key={box.id}
            className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] pb-2 text-sm"
          >
            <span className="font-medium">{box.class_name}</span>
            <span className="font-mono text-[var(--color-text-muted)]">
              {box.confidence.toFixed(2)}
            </span>
            <span className="ml-auto flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => onVerdict(box.id, "accept")}
                className="rounded border border-[var(--color-border)] px-3 py-1 disabled:opacity-50"
              >
                Accept {box.class_name}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDrag(null);
                  setAdjusting(box.id);
                }}
                className="rounded border border-[var(--color-border)] px-3 py-1 disabled:opacity-50"
              >
                Adjust {box.class_name}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onVerdict(box.id, "reject")}
                className="rounded border border-[var(--color-border)] px-3 py-1 disabled:opacity-50"
              >
                Reject {box.class_name}
              </button>
            </span>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        {onRejectFrame && (
          <button
            type="button"
            disabled={busy}
            onClick={onRejectFrame}
            className="rounded border border-[var(--color-failed)] px-3 py-1 text-sm disabled:opacity-50"
          >
            Reject whole frame
          </button>
        )}

        {onReportMissing && (
          <span className="flex items-center gap-2">
            <label htmlFor={missingId} className="text-xs text-[var(--color-text-muted)]">
              Something is missing
            </label>
            <select
              id={missingId}
              value={missingClass}
              onChange={(event) => setMissingClass(event.target.value)}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm"
            >
              {/* The unnamed case first, and it is not a placeholder: a
                  character that is not in the roster at all is exactly the
                  report worth having, and forcing a class would lose it. */}
              <option value="">no particular class</option>
              {classes?.map((klass) => (
                <option key={klass.id} value={klass.id}>
                  {klass.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy}
              onClick={() => onReportMissing(missingClass === "" ? null : Number(missingClass))}
              className="rounded border border-[var(--color-border)] px-3 py-1 text-sm disabled:opacity-50"
            >
              Report missing
            </button>
          </span>
        )}
      </div>
    </section>
  );
}
