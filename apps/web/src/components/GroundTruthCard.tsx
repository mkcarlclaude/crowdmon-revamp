import { useRef, useState } from "react";
import { BoxOverlay, type BoxVariant, type OverlayBox } from "./BoxOverlay";

/**
 * The surface M26 needs and nothing before it could do: drawing a box where
 * no prediction exists (M26, #176). Plan:
 * docs/superpowers/plans/2026-08-28-eval-harness.md §A1, §A3.
 *
 * `VerificationCard` never draws — PRD §9's own warning against a
 * draw-from-scratch UI is why — and that warning still holds for the
 * *verification* surface. It does not hold here: the whole point of the
 * frozen pool's exhaustive pass is finding what the detector never
 * proposed, and `missing_reports` (migration 0003) can only say "something
 * is here," never "here, exactly." So this is a second component, not a
 * mode flag on `VerificationCard` — one draws, the other never does, and a
 * shared component with a flag deciding which is a component whose tests
 * cannot tell you which behaviour they are looking at.
 *
 * **The gesture is `VerificationCard`'s adjust tool, not a new one.**
 * Press-drag-release on `BoxOverlay`'s surface, the same `onPointerDown`/
 * `Move`/`Up`/`Cancel` shape, because M20 already solved it and CLAUDE.md
 * records exactly how expensive getting it wrong was (#155: passed a
 * synthetic and an HTTP round trip end to end and was still unusable by
 * hand, because an `<img>` is natively draggable and a real press-and-move
 * tears it loose as a drag ghost). `BoxOverlay`'s `draggable={false}` on
 * the `<img>` and `select-none` on its container are what this component
 * leans on for that; `touch-none` here is this component's own half, scoped
 * to while a box is actually being drawn, matching `VerificationCard`'s own
 * reasoning for why it is not applied all the time.
 *
 * **Predictions are shown, never editable.** An annotator who cannot see
 * what the detector already found will redraw the same boxes by hand and
 * produce a slightly-worse copy of the existing labels — this file's own
 * reason `getImageAnnotationRoute` (`admin-ground-truth.ts`) exists at all.
 * They render as `neutral` (`BoxOverlay`'s "what the detector proposed"
 * meaning); ground truth already drawn renders as `positive`, visually
 * distinct and delete-able below.
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

export interface DrawnBox {
  id: number;
  class_id: number;
  class_name: string;
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
}

export interface AnnotationClass {
  class_id: number;
  name: string;
  exhaustive: boolean;
}

export interface AnnotationFrame {
  image_id: number;
  url: string;
  r2_key: string;
  predictions: ProposedBox[];
  ground_truth: DrawnBox[];
  classes: AnnotationClass[];
}

/** A box in [0, 1] — `CreateGroundTruthBoxRequest`'s own shape (schemas.ts). */
export interface NewBox {
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
}

export interface GroundTruthCardProps {
  frame: AnnotationFrame;
  onDrawBox: (classId: number, box: NewBox) => void;
  onDeleteBox: (groundTruthId: number) => void;
  onSetExhaustive: (classId: number, exhaustive: boolean) => void;
  onImageError?: () => void;
  /** Set while a write is in flight, so a double click cannot fire two requests. */
  busy?: boolean;
}

/** Where a drag started and where it is now, in normalized [0, 1] coordinates. */
interface Drag {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const asBox = (drag: Drag): NewBox => ({
  x_min: Math.min(drag.x1, drag.x2),
  y_min: Math.min(drag.y1, drag.y2),
  x_max: Math.max(drag.x1, drag.x2),
  y_max: Math.max(drag.y1, drag.y2),
});

/**
 * The smallest box a release commits, in the same normalized [0, 1] units
 * as everything else here (M26.4, plan §A2). Below this, `drawnIsUsable`
 * used to be sufficient on its own — `x_max > x_min && y_max > y_min`,
 * rejecting only a truly zero-area box — because a human pressing a
 * physical `Save box` button was never going to press it on a 2-pixel
 * smudge. That human judgment is gone along with the button: with a box
 * committing the instant the pointer lifts, every twitch that moves the
 * cursor one pixel between press and release would otherwise become a
 * `ground_truth` row. The exact value matters less than what happens below
 * it — a release smaller than this is discarded silently, the same as a
 * click that was never a drag, not surfaced as an error the annotator has
 * to dismiss. The existing box list is the undo path for everything that
 * *does* commit, and it already has a delete; that is enough, because a
 * mistake is visible there immediately rather than pending behind a button
 * that no longer exists.
 */
const MIN_BOX_DIMENSION = 0.01;

export function GroundTruthCard({
  frame,
  onDrawBox,
  onDeleteBox,
  onSetExhaustive,
  onImageError,
  busy = false,
}: GroundTruthCardProps) {
  const surface = useRef<HTMLDivElement>(null);

  // Which class a new box is attributed to. Defaults to the roster's first
  // entry rather than requiring a click first — the common case is one
  // active class (ROADMAP M26: "95 images and one class"), and a selector
  // that starts on nothing would cost every annotator an extra click for a
  // choice that is not actually open today.
  const [selectedClass, setSelectedClass] = useState<number | null>(
    frame.classes[0]?.class_id ?? null,
  );
  const [drawing, setDrawing] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  // Separate from `drag !== null`, `VerificationCard`'s own reason, carried
  // over rather than rediscovered: without it, `onPointerMove` keeps
  // tracking the cursor after release. There is no `Save box` button to
  // move toward any more (M26.4 removed it — a box now commits the instant
  // the pointer lifts), but the hazard this guards against is the same
  // shape either way — a pointer that is not actually down must never be
  // able to keep stretching a box that already finished.
  const [dragging, setDragging] = useState(false);

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
  const drawnIsUsable =
    drawn !== null &&
    drawn.x_max - drawn.x_min >= MIN_BOX_DIMENSION &&
    drawn.y_max - drawn.y_min >= MIN_BOX_DIMENSION;

  function cancelDrawing() {
    setDrawing(false);
    setDrag(null);
    setDragging(false);
  }

  const overlayBoxes: OverlayBox[] = [
    ...frame.predictions.map(
      (box, index): OverlayBox => ({
        id: `prediction-${box.id}`,
        box,
        label: index + 1,
        variant: "neutral" as BoxVariant,
        title: `Proposed: ${box.class_name} — confidence ${box.confidence.toFixed(2)}`,
      }),
    ),
    ...frame.ground_truth.map(
      (box): OverlayBox => ({
        id: `ground-truth-${box.id}`,
        box,
        label: "GT",
        variant: "positive" as BoxVariant,
        title: `Ground truth: ${box.class_name}`,
      }),
    ),
  ];

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {frame.classes.length > 1 && (
          <select
            aria-label="Class for a new box"
            value={selectedClass ?? ""}
            onChange={(event) => setSelectedClass(Number(event.target.value))}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm"
          >
            {frame.classes.map((klass) => (
              <option key={klass.class_id} value={klass.class_id}>
                {klass.name}
              </option>
            ))}
          </select>
        )}
        {!drawing ? (
          <button
            type="button"
            disabled={busy || selectedClass === null}
            onClick={() => setDrawing(true)}
            className="rounded border border-[var(--color-border)] px-3 py-1 text-sm disabled:opacity-50"
          >
            Draw a box
          </button>
        ) : (
          <>
            <p className="text-sm text-[var(--color-text-muted)]">
              Drag on the frame to draw a box — releasing saves it, and drawing stays on for the
              next one.
            </p>
            <button
              type="button"
              onClick={cancelDrawing}
              className="rounded border border-[var(--color-border)] px-3 py-1 text-sm"
            >
              Cancel
            </button>
          </>
        )}
      </div>

      {/* No keyboard equivalent. Unlike the claim this comment used to
          make, the class picker and Cancel are not "the keyboard path
          through the same action" — no keyboard control can produce a
          *box*, because geometry needs a drag, and removing `Save box`
          (M26.4) only made that plainer than it already was. What a
          keyboard user gets from them is control over the surface around
          the drag: which class a box belongs to, and a way out of drawing
          mode. Drawing the box itself has no substitute. */}
      <BoxOverlay
        ref={surface}
        frameUrl={frame.url}
        alt={frame.r2_key}
        boxes={overlayBoxes}
        onImageError={onImageError}
        // Scoped to while a box is actually being drawn — `VerificationCard`'s
        // own comment on `touch-none`: a frame nobody is annotating can
        // still be scrolled past on a phone, and this is the touch-side half
        // of the native-drag bug `draggable={false}` fixes for a mouse.
        className={drawing ? "cursor-crosshair touch-none" : undefined}
        onPointerDown={(event) => {
          if (!drawing) return;
          const at = positionOf(event);
          if (!at) return;
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
        // The commit, now that there is no button to press instead (M26.4,
        // plan §A1): a usable box posts the instant the pointer lifts, and
        // `drawing` is left untouched so the surface is still armed for the
        // next drag — several boxes on one frame are several drags, not
        // several round trips through a button. Below `MIN_BOX_DIMENSION`,
        // `drawn` is simply dropped: no request, no row, no error the
        // annotator has to dismiss, the same silent discard a click that
        // never became a drag already got.
        onPointerUp={(event) => {
          setDragging(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          if (drawn && drawnIsUsable && selectedClass !== null) {
            onDrawBox(selectedClass, drawn);
          }
          setDrag(null);
        }}
        // A cancelled pointer — a touch turned into a scroll, a device lost
        // — never sends `pointerup`, so nothing above ever runs for it.
        // `drag` is cleared here rather than left to linger: with no Save
        // button to later commit an abandoned drag from, keeping its
        // dashed rectangle on screen would only be a stale box nothing can
        // finish, until the next `pointerdown` happened to overwrite it.
        onPointerCancel={() => {
          setDragging(false);
          setDrag(null);
        }}
      >
        {drawn && (
          <span
            data-testid="drawn-box"
            className="absolute border-2 border-dashed border-[var(--color-done)]"
            style={{
              left: `${drawn.x_min * 100}%`,
              top: `${drawn.y_min * 100}%`,
              width: `${(drawn.x_max - drawn.x_min) * 100}%`,
              height: `${(drawn.y_max - drawn.y_min) * 100}%`,
            }}
          />
        )}
      </BoxOverlay>

      <ul className="flex flex-col gap-1">
        {frame.ground_truth.map((box) => (
          <li
            key={box.id}
            data-testid={`ground-truth-row-${box.id}`}
            className="flex items-center gap-2 border-b border-[var(--color-border)] pb-1 text-sm"
          >
            <span className="font-medium">{box.class_name}</span>
            <span className="font-mono text-xs text-[var(--color-text-muted)]">
              {box.x_min.toFixed(2)}, {box.y_min.toFixed(2)} – {box.x_max.toFixed(2)},{" "}
              {box.y_max.toFixed(2)}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => onDeleteBox(box.id)}
              className="ml-auto rounded border border-[var(--color-failed)] px-2 py-0.5 text-xs disabled:opacity-50"
            >
              Delete
            </button>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        {frame.classes.map((klass) => (
          <button
            key={klass.class_id}
            type="button"
            disabled={busy}
            aria-pressed={klass.exhaustive}
            onClick={() => onSetExhaustive(klass.class_id, !klass.exhaustive)}
            className={`rounded border px-3 py-1 text-sm disabled:opacity-50 ${
              klass.exhaustive
                ? "border-[var(--color-done)] bg-[var(--color-surface)] font-medium"
                : "border-[var(--color-border)]"
            }`}
          >
            {klass.exhaustive ? "✓ " : ""}
            {klass.name}: every instance found
          </button>
        ))}
      </div>
    </section>
  );
}
