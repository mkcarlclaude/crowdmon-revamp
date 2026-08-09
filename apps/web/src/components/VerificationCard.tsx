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

/** One staged ruling, in the shape the submit endpoint takes. */
export interface StagedVerdict {
  prediction_id: number;
  verdict: VerdictKind;
  adjusted_x_min?: number;
  adjusted_y_min?: number;
  adjusted_x_max?: number;
  adjusted_y_max?: number;
}

export type VerdictKind = "accept" | "adjust" | "reject";

export interface VerificationCardProps {
  frame: VerificationFrame;
  /**
   * The whole frame's rulings, once the operator submits them.
   *
   * Not one callback per click, and that is the point of the staging area: a
   * ruling written the moment it was clicked meant the box disappeared from
   * the list, which renumbered every box below it while the cursor was still
   * moving toward the next one. Nothing leaves this component until Submit.
   */
  onSubmit: (verdicts: StagedVerdict[]) => void;
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

/**
 * What a box is called on screen: its position in this frame's list, one-based.
 *
 * Not the prediction id, which is a database number an operator has no use
 * for and which would be five digits wide beside a two-character confidence.
 * Positional, so it is stable for as long as the frame is on screen and starts
 * again at 1 on the next one — a frame is judged whole and nobody carries a
 * box number between frames.
 */
const ordinal = (index: number) => index + 1;

const asBox = (drag: Drag) => ({
  x_min: Math.min(drag.x1, drag.x2),
  y_min: Math.min(drag.y1, drag.y2),
  x_max: Math.max(drag.x1, drag.x2),
  y_max: Math.max(drag.y1, drag.y2),
});

export function VerificationCard({
  frame,
  onSubmit,
  onReportMissing,
  classes,
  onImageError,
  busy = false,
}: VerificationCardProps) {
  const missingId = useId();
  const surface = useRef<HTMLDivElement>(null);
  /**
   * The staging area: what the operator has decided, not yet written.
   *
   * Keyed by prediction id and holding at most one ruling per box, so clicking
   * Accept and then Reject on the same box replaces rather than queues — the
   * schema would happily accept both, and two contradictory rows written in
   * one submission are indistinguishable afterwards from a genuine change of
   * mind recorded later.
   */
  const [staged, setStaged] = useState<ReadonlyMap<number, StagedVerdict>>(new Map());
  const [adjusting, setAdjusting] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // Whether the pointer is still down. Separate from `drag` being non-null,
  // which only says a box has been drawn: without this, `onPointerMove` keeps
  // tracking the cursor after the button is released, so moving from the frame
  // down to "Save adjustment" stretches the box on the way and saves whatever
  // it had become. Every adjustment would be wrong, and a test that replays
  // down/move/up with no movement afterwards would not see it.
  const [dragging, setDragging] = useState(false);
  // Which box the operator is pointing at, by prediction id. The only state
  // here that changes nothing about what gets written — it exists because five
  // boxes of one class produce five rows that are identical down to the
  // confidence, and picking the wrong one writes a verdict about the wrong
  // rectangle.
  const [highlighted, setHighlighted] = useState<number | null>(null);
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

  function stage(ruling: StagedVerdict) {
    setStaged((current) => new Map(current).set(ruling.prediction_id, ruling));
  }

  function unstage(predictionId: number) {
    setStaged((current) => {
      const next = new Map(current);
      next.delete(predictionId);
      return next;
    });
  }

  function saveAdjustment() {
    if (adjusting === null || !drawn || !drawnIsUsable) return;

    stage({
      prediction_id: adjusting,
      verdict: "adjust",
      adjusted_x_min: drawn.x_min,
      adjusted_y_min: drawn.y_min,
      adjusted_x_max: drawn.x_max,
      adjusted_y_max: drawn.y_max,
    });
    cancelAdjustment();
  }

  /**
   * Submitted in the order the boxes are drawn, not the order they were
   * clicked. Nothing downstream reads the order, and a stable one makes the
   * request diffable against what the screen showed.
   */
  const rulings = frame.predictions
    .map((box) => staged.get(box.id))
    .filter((ruling): ruling is StagedVerdict => ruling !== undefined);

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

        {frame.predictions.map((box, index) => (
          <span
            key={box.id}
            // The staged ruling is on the rectangle, not only in the row: a
            // frame is judged by looking at the picture, and an operator
            // scanning for what they have not decided yet should not have to
            // read a list to find out.
            className={`absolute border-2 ${
              adjusting === box.id
                ? "border-[var(--color-failed)] border-dashed"
                : staged.get(box.id)?.verdict === "reject"
                  ? "border-[var(--color-failed)] opacity-60"
                  : staged.has(box.id)
                    ? "border-[var(--color-done)]"
                    : "border-[var(--color-claimed)]"
            } ${highlighted !== null && highlighted !== box.id ? "opacity-25" : ""}`}
            style={{
              left: `${box.x_min * 100}%`,
              top: `${box.y_min * 100}%`,
              width: `${(box.x_max - box.x_min) * 100}%`,
              height: `${(box.y_max - box.y_min) * 100}%`,
            }}
            // On the box rather than in a legend, for `DryRunPanel`'s reason: a
            // number somewhere else is a number nobody connects to the
            // rectangle it belongs to.
            title={`${ordinal(index)}. ${box.class_name} — confidence ${box.confidence.toFixed(2)}`}
            data-testid={`box-${box.id}`}
            data-highlighted={highlighted === box.id}
            data-staged={staged.get(box.id)?.verdict ?? ""}
          >
            {/* The badge is the whole fix for "which row is this box?". Five
                boxes of one class produce five rows reading `Paimon 0.15`, and
                without a mark on the rectangle itself the only way to tell
                them apart is to guess. Drawn inside the box rather than beside
                it so it cannot drift from what it names, and offset outward at
                the top-left so it does not cover the thing being judged. */}
            <span className="absolute -top-0.5 -left-0.5 bg-[var(--color-claimed)] px-1 text-[10px] font-mono leading-tight text-[var(--color-bg)]">
              {ordinal(index)}
            </span>
          </span>
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
        {frame.predictions.map((box, index) => (
          <li
            key={box.id}
            // Pointing at a row lights up its rectangle and dims the rest.
            // `onFocus`/`onBlur` alongside the pointer pair rather than instead
            // of it: the buttons inside are the keyboard path through this
            // list, and their focus bubbles here, so tabbing highlights the
            // same box hovering does.
            onPointerEnter={() => setHighlighted(box.id)}
            onPointerLeave={() =>
              setHighlighted((current) => (current === box.id ? null : current))
            }
            onFocus={() => setHighlighted(box.id)}
            onBlur={() => setHighlighted((current) => (current === box.id ? null : current))}
            className={`flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] pb-2 text-sm ${
              highlighted === box.id ? "bg-[var(--color-surface)]" : ""
            }`}
            data-testid={`row-${box.id}`}
            data-highlighted={highlighted === box.id}
            data-staged={staged.get(box.id)?.verdict ?? ""}
          >
            {/* The same number drawn on the rectangle. Five boxes of one class
                make five rows that are otherwise identical down to the
                confidence, and this is the only thing telling them apart. */}
            <span className="w-5 shrink-0 text-center font-mono text-xs text-[var(--color-text-muted)]">
              {ordinal(index)}
            </span>
            <span className="font-medium">{box.class_name}</span>
            <span className="font-mono text-[var(--color-text-muted)]">
              {box.confidence.toFixed(2)}
            </span>
            {/* What is staged, in words. The button's own `aria-pressed` says
                the same thing, but only to whoever is on that button — this is
                for the operator scanning five rows for the one they have not
                decided yet. */}
            {staged.has(box.id) && (
              <span className="rounded bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text-muted)]">
                {staged.get(box.id)?.verdict}
              </span>
            )}
            <span className="ml-auto flex gap-2">
              {/* The ordinal is in every label, not just the row, because
                  "Accept Paimon" five times over is five identical accessible
                  names for five different boxes.

                  These three are a radio group in behaviour, not a set of
                  actions: clicking one replaces whatever was staged for this
                  box, and `aria-pressed` is what says so to anybody who cannot
                  see the highlight. */}
              {(["accept", "adjust", "reject"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  disabled={busy}
                  aria-pressed={staged.get(box.id)?.verdict === kind}
                  onClick={() => {
                    if (kind === "adjust") {
                      setDrag(null);
                      setAdjusting(box.id);
                      return;
                    }
                    // Clicking the staged ruling again takes it back. Nothing
                    // has been written yet, so undo costs a click rather than
                    // a second contradictory row.
                    if (staged.get(box.id)?.verdict === kind) {
                      unstage(box.id);
                      return;
                    }
                    stage({ prediction_id: box.id, verdict: kind });
                  }}
                  className={`rounded border px-3 py-1 disabled:opacity-50 ${
                    staged.get(box.id)?.verdict === kind
                      ? "border-[var(--color-done)] bg-[var(--color-surface)] font-medium"
                      : "border-[var(--color-border)]"
                  }`}
                >
                  {kind === "accept" ? "Accept" : kind === "adjust" ? "Adjust" : "Reject"}{" "}
                  {box.class_name} {ordinal(index)}
                </button>
              ))}
            </span>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        {/* Staging is what makes this one button rather than one per box: it
            fills the whole frame in, and the submit below writes it. The
            menu-and-black-frame case is the common one in a sampled timeline
            and still costs two clicks total. */}
        <button
          type="button"
          disabled={busy || frame.predictions.length === 0}
          onClick={() =>
            setStaged(
              new Map(
                frame.predictions.map((box) => [
                  box.id,
                  { prediction_id: box.id, verdict: "reject" as const },
                ]),
              ),
            )
          }
          className="rounded border border-[var(--color-failed)] px-3 py-1 text-sm disabled:opacity-50"
        >
          Reject whole frame
        </button>

        <button
          type="button"
          disabled={busy || rulings.length === 0}
          onClick={() => onSubmit(rulings)}
          className="rounded border border-[var(--color-done)] px-3 py-1 text-sm font-medium disabled:opacity-50"
        >
          {busy ? "Submitting…" : `Submit ${rulings.length} of ${frame.predictions.length}`}
        </button>

        {rulings.length > 0 && !busy && (
          <button
            type="button"
            onClick={() => setStaged(new Map())}
            className="rounded border border-[var(--color-border)] px-3 py-1 text-sm"
          >
            Clear
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
