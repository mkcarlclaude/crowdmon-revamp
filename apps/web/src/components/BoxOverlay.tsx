import { type ComponentPropsWithoutRef, forwardRef, type ReactNode } from "react";
import { cn } from "../lib/utils";

/**
 * The read-only box-over-frame renderer, extracted out of
 * `VerificationCard.tsx` (M18, plan §B).
 *
 * `VerificationCard`'s box rendering used to be the only place in the
 * codebase that turned a normalized `{x_min, y_min, x_max, y_max}` box into a
 * percentage-positioned absolute `<span>` over an `<img>`. M18 needed a
 * second place — a verdict-preview dialog showing a prediction's original
 * box next to what an admin ruled — and copying the JSX would have meant two
 * box renderers that could quietly drift the day coordinate handling changed
 * in only one of them. This is the one renderer both use now.
 *
 * **Read-only on purpose, and that is a narrower thing than it sounds.**
 * `VerificationCard`'s surface is entangled with drag-to-adjust state: which
 * box is mid-drag, where the pointer currently is, which row is hovered.
 * None of that moved here. What did move is purely presentational — given a
 * box, a label and a variant, draw it — and `VerificationCard` still owns
 * every pixel of interactivity, wiring pointer handlers onto this
 * component's root `<div>` via ordinary prop passthrough (`ref` included,
 * via `forwardRef`) and rendering its own live drag rectangle through
 * `children` rather than through the `boxes` list, because a box being
 * actively drawn has no prediction id and nothing in common with a proposed
 * box except that it is also a rectangle on the same image.
 */

export interface OverlayBoxCoords {
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
}

/**
 * What a box's border (and corner badge) look like — a vocabulary shared by
 * both mounts rather than named after either one's meaning. `neutral` is
 * "nothing decided yet" in `VerificationCard` and "what the detector
 * proposed" in the preview dialog; `positive` is "staged accept/adjust" in
 * one and "the admin's adjusted box" in the other. Naming the variant after
 * the colour it produces, not after either caller's semantics, is what lets
 * both keep using it without pulling the other's vocabulary into their own
 * markup.
 */
export type BoxVariant = "neutral" | "positive" | "negative" | "editing";

const VARIANT_BORDER: Record<BoxVariant, string> = {
  neutral: "border-[var(--color-claimed)]",
  positive: "border-[var(--color-done)]",
  negative: "border-[var(--color-failed)] opacity-60",
  editing: "border-[var(--color-failed)] border-dashed",
};

const VARIANT_BADGE: Record<BoxVariant, string> = {
  neutral: "bg-[var(--color-claimed)]",
  positive: "bg-[var(--color-done)]",
  negative: "bg-[var(--color-failed)]",
  editing: "bg-[var(--color-failed)]",
};

export interface OverlayBox {
  /** React's key, and the source of `data-testid="box-${id}"` — stable for as long as the box is on screen. */
  id: string | number;
  box: OverlayBoxCoords;
  /** The corner badge — an ordinal in `VerificationCard`, a word ("Proposed", "Adjusted") in the preview dialog. */
  label: ReactNode;
  variant: BoxVariant;
  /** Dims the box without changing what it means — `VerificationCard`'s "a different row is highlighted" state. */
  dimmed?: boolean;
  /** Hover tooltip. */
  title?: string;
  /**
   * Extra `data-*` attributes, keyed without the `data-` prefix. Exists so a
   * caller's own test-facing state (`VerificationCard`'s `data-highlighted`
   * and `data-staged`) can still land on the rectangle it describes without
   * this component knowing either concept by name.
   */
  extraData?: Record<string, string>;
}

export interface BoxOverlayProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  frameUrl: string;
  /** Alt text for the underlying `<img>` — `VerificationCard` passes the frame's `r2_key`, the same choice it always made. */
  alt: string;
  boxes: OverlayBox[];
  onImageError?: () => void;
  /**
   * Rendered after every box, inside the same relative container — the live
   * drag rectangle `VerificationCard` draws while an adjustment is in
   * progress, which is not a member of `boxes` because it has no prediction
   * id and no variant that means anything until it is saved.
   */
  children?: ReactNode;
}

export const BoxOverlay = forwardRef<HTMLDivElement, BoxOverlayProps>(function BoxOverlay(
  { frameUrl, alt, boxes, onImageError, children, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "relative select-none overflow-hidden rounded border border-[var(--color-border)]",
        className,
      )}
      {...rest}
    >
      <img src={frameUrl} alt={alt} className="block w-full" onError={onImageError} />

      {boxes.map((entry) => {
        const dataAttrs: Record<string, string> = {};
        for (const [key, value] of Object.entries(entry.extraData ?? {})) {
          dataAttrs[`data-${key}`] = value;
        }

        return (
          <span
            key={entry.id}
            data-testid={`box-${entry.id}`}
            title={entry.title}
            className={cn(
              "absolute border-2",
              VARIANT_BORDER[entry.variant],
              entry.dimmed && "opacity-25",
            )}
            style={{
              left: `${entry.box.x_min * 100}%`,
              top: `${entry.box.y_min * 100}%`,
              width: `${(entry.box.x_max - entry.box.x_min) * 100}%`,
              height: `${(entry.box.y_max - entry.box.y_min) * 100}%`,
            }}
            {...dataAttrs}
          >
            {/* The badge is the whole fix for "which box is this?" — see
                `VerificationCard`'s own original comment on the same span,
                unchanged by the extraction: five boxes of one class read
                identically without a mark on the rectangle itself. */}
            <span
              className={cn(
                "absolute -top-0.5 -left-0.5 px-1 text-[10px] font-mono leading-tight text-[var(--color-bg)]",
                VARIANT_BADGE[entry.variant],
              )}
            >
              {entry.label}
            </span>
          </span>
        );
      })}

      {children}
    </div>
  );
});
