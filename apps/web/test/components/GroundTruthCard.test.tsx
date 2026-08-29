import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  type AnnotationFrame,
  GroundTruthCard,
  type ProposedBox,
} from "../../src/components/GroundTruthCard";

/**
 * The drawing surface (M26, #176). See `GroundTruthCard.tsx`'s own comment
 * for why this is a second component rather than a mode on
 * `VerificationCard`.
 *
 * **What this file can and cannot prove.** CLAUDE.md's own recorded
 * lesson (#155) is that neither jsdom's `userEvent.pointer` nor CDP can
 * start the gestures a browser owns — an `<img>` press-and-move becomes
 * native drag-and-drop, a finger becomes a scroll — and both replay the
 * pointer stream an *uninterrupted* drag produces, which is the one case
 * that cannot fail. So the tests below that use `userEvent.pointer` (the
 * same idiom `VerificationCard.test.tsx` already uses for its own
 * adjust-and-save flow) are exercising this component's *write path* — what
 * gets staged and what callback fires with what coordinates — never
 * evidence that a real mouse or finger produces the pointer sequence being
 * replayed. What actually proves the gesture survives contact with a real
 * browser is the separate group below, asserting directly on
 * `draggable={false}`, `touch-none` and `select-none` — the attributes that
 * keep the browser's own drag-and-drop and scroll-takeover out of the way.
 * Even those do not replace a hand on a real mouse; they are this file's
 * evidence, not the milestone's.
 */

const prediction = (over: Partial<ProposedBox> = {}): ProposedBox => ({
  id: 1,
  class_id: 3,
  class_name: "Paimon",
  x_min: 0.1,
  y_min: 0.2,
  x_max: 0.3,
  y_max: 0.4,
  confidence: 0.14,
  ...over,
});

const frame = (over: Partial<AnnotationFrame> = {}): AnnotationFrame => ({
  image_id: 7,
  url: "https://r2.example/frames/dQw4w9WgXcQ/00042.000.jpg?X-Amz-Signature=abc",
  r2_key: "frames/dQw4w9WgXcQ/00042.000.jpg",
  predictions: [prediction()],
  ground_truth: [],
  classes: [{ class_id: 3, name: "Paimon", exhaustive: false }],
  ...over,
});

function layOutFrame(width = 200, height = 100) {
  const image = screen.getByRole("img");
  const surface = image.parentElement as HTMLElement;

  surface.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width, height, right: width, bottom: height }) as DOMRect;
  surface.setPointerCapture = vi.fn();
  surface.hasPointerCapture = () => false;
  surface.releasePointerCapture = vi.fn();
  return surface;
}

describe("GroundTruthCard — the attributes that keep the browser out of the way", () => {
  it("refuses the browser's native image drag", () => {
    render(
      <GroundTruthCard
        frame={frame()}
        onDrawBox={vi.fn()}
        onDeleteBox={vi.fn()}
        onSetExhaustive={vi.fn()}
      />,
    );

    expect(screen.getByRole("img")).toHaveAttribute("draggable", "false");
  });

  it("disables text/drag selection on the whole surface, not only while drawing", () => {
    render(
      <GroundTruthCard
        frame={frame()}
        onDrawBox={vi.fn()}
        onDeleteBox={vi.fn()}
        onSetExhaustive={vi.fn()}
      />,
    );

    const surface = screen.getByRole("img").parentElement as HTMLElement;
    expect(surface).toHaveClass("select-none");
  });

  it("takes the frame out of the browser's touch gestures only while a box is being drawn", async () => {
    render(
      <GroundTruthCard
        frame={frame()}
        onDrawBox={vi.fn()}
        onDeleteBox={vi.fn()}
        onSetExhaustive={vi.fn()}
      />,
    );

    const surface = () => screen.getByRole("img").parentElement as HTMLElement;
    expect(surface()).not.toHaveClass("touch-none");

    await userEvent.click(screen.getByRole("button", { name: "Draw a box" }));
    expect(surface()).toHaveClass("touch-none");

    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(surface()).not.toHaveClass("touch-none");
  });
});

describe("GroundTruthCard — what the detector proposed, shown but not editable", () => {
  it("renders predictions and ground truth as visually distinct, non-interactive boxes", () => {
    render(
      <GroundTruthCard
        frame={frame({
          ground_truth: [
            {
              id: 9,
              class_id: 3,
              class_name: "Paimon",
              x_min: 0.5,
              y_min: 0.5,
              x_max: 0.7,
              y_max: 0.7,
            },
          ],
        })}
        onDrawBox={vi.fn()}
        onDeleteBox={vi.fn()}
        onSetExhaustive={vi.fn()}
      />,
    );

    const proposed = screen.getByTestId("box-prediction-1");
    const ground = screen.getByTestId("box-ground-truth-9");
    expect(proposed.className).not.toBe(ground.className);
    // Neither carries a click handler of its own — `BoxOverlay`'s own
    // "read-only on purpose" — the only way to act on a box is the row list
    // and the draw/save controls, both ordinary buttons.
    expect(proposed).not.toHaveAttribute("onclick");
    expect(ground).not.toHaveAttribute("onclick");
  });

  it("lists ground-truth boxes with a delete action, but has none for predictions", () => {
    render(
      <GroundTruthCard
        frame={frame({
          ground_truth: [
            {
              id: 9,
              class_id: 3,
              class_name: "Paimon",
              x_min: 0.5,
              y_min: 0.5,
              x_max: 0.7,
              y_max: 0.7,
            },
          ],
        })}
        onDrawBox={vi.fn()}
        onDeleteBox={vi.fn()}
        onSetExhaustive={vi.fn()}
      />,
    );

    expect(screen.getByTestId("ground-truth-row-9")).toBeInTheDocument();
    expect(screen.queryByText(/0\.87/)).not.toBeInTheDocument();
  });
});

describe("GroundTruthCard — a box commits on release (write-path only, see this file's header)", () => {
  it("commits a box the instant the pointer is released, with no further interaction", async () => {
    const onDrawBox = vi.fn();
    render(
      <GroundTruthCard
        frame={frame()}
        onDrawBox={onDrawBox}
        onDeleteBox={vi.fn()}
        onSetExhaustive={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Draw a box" }));
    const surface = layOutFrame();

    await userEvent.pointer([
      { target: surface, coords: { clientX: 20, clientY: 10 }, keys: "[MouseLeft>]" },
      { target: surface, coords: { clientX: 120, clientY: 60 } },
      { target: surface, keys: "[/MouseLeft]" },
    ]);

    // No button clicked after the release — the release itself is the commit.
    expect(onDrawBox).toHaveBeenCalledWith(3, { x_min: 0.1, y_min: 0.1, x_max: 0.6, y_max: 0.6 });
  });

  it("leaves drawing mode on after a commit, so the next drag is another box", async () => {
    const onDrawBox = vi.fn();
    render(
      <GroundTruthCard
        frame={frame()}
        onDrawBox={onDrawBox}
        onDeleteBox={vi.fn()}
        onSetExhaustive={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Draw a box" }));
    const surface = layOutFrame();

    await userEvent.pointer([
      { target: surface, coords: { clientX: 20, clientY: 10 }, keys: "[MouseLeft>]" },
      { target: surface, coords: { clientX: 120, clientY: 60 } },
      { target: surface, keys: "[/MouseLeft]" },
    ]);

    // There is no `Save box` button any more, and no `Draw a box` button
    // either — the surface never left drawing mode.
    expect(screen.queryByRole("button", { name: /save box/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Draw a box" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("several drags on one frame are several boxes, with no button between them", async () => {
    const onDrawBox = vi.fn();
    render(
      <GroundTruthCard
        frame={frame()}
        onDrawBox={onDrawBox}
        onDeleteBox={vi.fn()}
        onSetExhaustive={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Draw a box" }));
    const surface = layOutFrame();

    await userEvent.pointer([
      { target: surface, coords: { clientX: 0, clientY: 0 }, keys: "[MouseLeft>]" },
      { target: surface, coords: { clientX: 40, clientY: 20 } },
      { target: surface, keys: "[/MouseLeft]" },
    ]);
    await userEvent.pointer([
      { target: surface, coords: { clientX: 60, clientY: 30 }, keys: "[MouseLeft>]" },
      { target: surface, coords: { clientX: 100, clientY: 50 } },
      { target: surface, keys: "[/MouseLeft]" },
    ]);

    expect(onDrawBox).toHaveBeenCalledTimes(2);
    expect(onDrawBox).toHaveBeenNthCalledWith(1, 3, { x_min: 0, y_min: 0, x_max: 0.2, y_max: 0.2 });
    expect(onDrawBox).toHaveBeenNthCalledWith(2, 3, {
      x_min: 0.3,
      y_min: 0.3,
      x_max: 0.5,
      y_max: 0.5,
    });
  });

  it("discards a release below the minimum size silently — no request, no row, no error", async () => {
    const onDrawBox = vi.fn();
    render(
      <GroundTruthCard
        frame={frame()}
        onDrawBox={onDrawBox}
        onDeleteBox={vi.fn()}
        onSetExhaustive={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Draw a box" }));
    const surface = layOutFrame();

    // A press-and-release with no meaningful movement — a click, not a
    // drag, exactly the case `MIN_BOX_DIMENSION` exists to keep out of
    // `ground_truth` now that there is no human judgment behind a Save
    // button to catch it.
    await userEvent.pointer([
      { target: surface, coords: { clientX: 20, clientY: 10 }, keys: "[MouseLeft>]" },
      { target: surface, keys: "[/MouseLeft]" },
    ]);

    expect(onDrawBox).not.toHaveBeenCalled();
    // Silently, not as a dismissible error — and drawing mode is
    // untouched, not reset or exited by the failed attempt.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByTestId("drawn-box")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("cancel exits drawing mode outright, with nothing drawn yet to discard", async () => {
    // A drag in progress can no longer be "cancelled" by clicking Cancel
    // instead of releasing: the pointer is captured (`setPointerCapture`),
    // so a real browser cannot deliver a click to Cancel while the primary
    // button is still down elsewhere — releasing it is what a click on
    // Cancel would require first, and that release is the commit. What
    // Cancel actually does now is exit drawing mode outright, whether that
    // is before any drag was started or after a too-small release already
    // discarded itself.
    const onDrawBox = vi.fn();
    render(
      <GroundTruthCard
        frame={frame()}
        onDrawBox={onDrawBox}
        onDeleteBox={vi.fn()}
        onSetExhaustive={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Draw a box" }));
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(onDrawBox).not.toHaveBeenCalled();
    expect(screen.queryByTestId("drawn-box")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Draw a box" })).toBeInTheDocument();
  });
});

describe("GroundTruthCard — deleting a box and marking a class exhaustive", () => {
  it("deletes a ground-truth box by its own id", async () => {
    const onDeleteBox = vi.fn();
    render(
      <GroundTruthCard
        frame={frame({
          ground_truth: [
            {
              id: 9,
              class_id: 3,
              class_name: "Paimon",
              x_min: 0.5,
              y_min: 0.5,
              x_max: 0.7,
              y_max: 0.7,
            },
          ],
        })}
        onDrawBox={vi.fn()}
        onDeleteBox={onDeleteBox}
        onSetExhaustive={vi.fn()}
      />,
    );

    await userEvent.click(
      within(screen.getByTestId("ground-truth-row-9")).getByRole("button", { name: /delete/i }),
    );

    expect(onDeleteBox).toHaveBeenCalledWith(9);
  });

  it("toggles a class's exhaustive flag both ways", async () => {
    const onSetExhaustive = vi.fn();
    render(
      <GroundTruthCard
        frame={frame()}
        onDrawBox={vi.fn()}
        onDeleteBox={vi.fn()}
        onSetExhaustive={onSetExhaustive}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /Paimon: every instance found/ }));
    expect(onSetExhaustive).toHaveBeenCalledWith(3, true);

    render(
      <GroundTruthCard
        frame={frame({ classes: [{ class_id: 3, name: "Paimon", exhaustive: true }] })}
        onDrawBox={vi.fn()}
        onDeleteBox={vi.fn()}
        onSetExhaustive={onSetExhaustive}
      />,
    );
    const buttons = screen.getAllByRole("button", { name: /Paimon: every instance found/ });
    await userEvent.click(buttons[buttons.length - 1] as HTMLElement);
    expect(onSetExhaustive).toHaveBeenLastCalledWith(3, false);
  });
});
