import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  type ProposedBox,
  VerificationCard,
  type VerificationFrame,
} from "../../src/components/VerificationCard";

/**
 * The verification component (M13.1).
 *
 * Rendered here with plain props and no query client, which is the point of
 * the milestone's third bullet: the component is built as one thing with two
 * mounts from the start, so M14 can render it against different endpoints
 * without a mode flag. If a test here ever needs a `QueryClientProvider`, the
 * component has grown knowledge of an endpoint and that split has been lost.
 */

const box = (over: Partial<ProposedBox> = {}): ProposedBox => ({
  id: 1,
  class_id: 3,
  class_name: "Paimon",
  x_min: 0.1,
  y_min: 0.2,
  x_max: 0.5,
  y_max: 0.6,
  confidence: 0.87,
  ...over,
});

const frame = (over: Partial<VerificationFrame> = {}): VerificationFrame => ({
  id: 7,
  url: "https://r2.example/frames/dQw4w9WgXcQ/00042.000.jpg?X-Amz-Signature=abc",
  r2_key: "frames/dQw4w9WgXcQ/00042.000.jpg",
  predictions: [box()],
  ...over,
});

/**
 * jsdom lays nothing out, so every rect is zero — and the component reads one
 * to normalize a pointer position. Stubbed to a 200x100 frame so a drag can be
 * expressed in pixels a test can compute the expected fraction from.
 */
function layOutFrame(width = 200, height = 100) {
  const image = screen.getByRole("img");
  const surface = image.parentElement as HTMLElement;

  surface.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width, height, right: width, bottom: height }) as DOMRect;
  // jsdom has no pointer capture at all; the component calls both.
  surface.setPointerCapture = vi.fn();
  surface.hasPointerCapture = () => false;
  surface.releasePointerCapture = vi.fn();

  return surface;
}

describe("VerificationCard", () => {
  it("draws each proposed box from its normalized coordinates", () => {
    render(<VerificationCard frame={frame()} onVerdict={vi.fn()} />);

    expect(screen.getByRole("img")).toHaveAttribute("src", frame().url);
    expect(screen.getByTestId("box-1")).toHaveStyle({
      left: "10%",
      top: "20%",
      width: "40%",
      height: "40%",
    });
  });

  it("numbers every box and every row the same way", async () => {
    // The frame that made this necessary: five boxes, all Paimon, confidences
    // within 0.05 of each other. Without a number on the rectangle the rows
    // are five identical lines and choosing between them is a guess.
    const boxes = [box({ id: 1 }), box({ id: 2 }), box({ id: 3 })];
    render(<VerificationCard frame={frame({ predictions: boxes })} onVerdict={vi.fn()} />);

    for (const [index, drawn] of boxes.entries()) {
      const label = String(index + 1);
      expect(within(screen.getByTestId(`box-${drawn.id}`)).getByText(label)).toBeInTheDocument();
      expect(within(screen.getByTestId(`row-${drawn.id}`)).getByText(label)).toBeInTheDocument();
      // In the accessible name too: "Accept Paimon" three times over is three
      // identical names for three different rectangles.
      expect(screen.getByRole("button", { name: `Accept Paimon ${label}` })).toBeInTheDocument();
    }
  });

  it("lights up the box belonging to the row being pointed at", async () => {
    const boxes = [box({ id: 1 }), box({ id: 2 })];
    render(<VerificationCard frame={frame({ predictions: boxes })} onVerdict={vi.fn()} />);

    await userEvent.pointer({ target: screen.getByTestId("row-2") });

    expect(screen.getByTestId("box-2")).toHaveAttribute("data-highlighted", "true");
    expect(screen.getByTestId("box-1")).toHaveAttribute("data-highlighted", "false");
  });

  it("lights up the same box when the row is reached by keyboard", async () => {
    // The buttons are the keyboard path through the list and their focus
    // bubbles to the row, so tabbing highlights what hovering highlights.
    const boxes = [box({ id: 1 }), box({ id: 2 })];
    render(<VerificationCard frame={frame({ predictions: boxes })} onVerdict={vi.fn()} />);

    // Four tabs: three buttons on the first row, then the second row's first.
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();

    expect(screen.getByRole("button", { name: "Accept Paimon 2" })).toHaveFocus();
    expect(screen.getByTestId("box-2")).toHaveAttribute("data-highlighted", "true");
    expect(screen.getByTestId("box-1")).toHaveAttribute("data-highlighted", "false");
  });

  it("accepts and rejects a box by id, carrying no coordinates", async () => {
    const onVerdict = vi.fn();
    render(<VerificationCard frame={frame()} onVerdict={onVerdict} />);

    await userEvent.click(screen.getByRole("button", { name: /accept paimon/i }));
    await userEvent.click(screen.getByRole("button", { name: /reject paimon/i }));

    expect(onVerdict.mock.calls).toEqual([
      [1, "accept"],
      [1, "reject"],
    ]);
  });

  it("adjusts a box by dragging a new one over the frame", async () => {
    const onVerdict = vi.fn();
    render(<VerificationCard frame={frame()} onVerdict={onVerdict} />);

    await userEvent.click(screen.getByRole("button", { name: /adjust paimon/i }));
    const surface = layOutFrame();

    // 20..120 of 200 across, 10..60 of 100 down.
    await userEvent.pointer([
      { target: surface, coords: { clientX: 20, clientY: 10 }, keys: "[MouseLeft>]" },
      { target: surface, coords: { clientX: 120, clientY: 60 } },
      { target: surface, keys: "[/MouseLeft]" },
    ]);

    expect(screen.getByTestId("adjustment")).toHaveStyle({ left: "10%", top: "10%" });

    await userEvent.click(screen.getByRole("button", { name: /save adjustment/i }));

    expect(onVerdict).toHaveBeenCalledWith(1, "adjust", {
      adjusted_x_min: 0.1,
      adjusted_y_min: 0.1,
      adjusted_x_max: 0.6,
      adjusted_y_max: 0.6,
    });
  });

  it("normalizes a drag made in either direction", async () => {
    // Dragged bottom-right to top-left. The schema requires x_max >= x_min, so
    // a component that passed the raw start and end would produce a 400 for an
    // action the operator has no reason to think is different.
    const onVerdict = vi.fn();
    render(<VerificationCard frame={frame()} onVerdict={onVerdict} />);

    await userEvent.click(screen.getByRole("button", { name: /adjust paimon/i }));
    const surface = layOutFrame();

    await userEvent.pointer([
      { target: surface, coords: { clientX: 120, clientY: 60 }, keys: "[MouseLeft>]" },
      { target: surface, coords: { clientX: 20, clientY: 10 } },
      { target: surface, keys: "[/MouseLeft]" },
    ]);
    await userEvent.click(screen.getByRole("button", { name: /save adjustment/i }));

    expect(onVerdict).toHaveBeenCalledWith(1, "adjust", {
      adjusted_x_min: 0.1,
      adjusted_y_min: 0.1,
      adjusted_x_max: 0.6,
      adjusted_y_max: 0.6,
    });
  });

  it("stops drawing when the pointer is released", async () => {
    // The bug this exists for: with no "button is down" state, a pointermove
    // after release keeps stretching the box — so moving the cursor from the
    // frame down to "Save adjustment" saves a box nobody drew.
    const onVerdict = vi.fn();
    render(<VerificationCard frame={frame()} onVerdict={onVerdict} />);

    await userEvent.click(screen.getByRole("button", { name: /adjust paimon/i }));
    const surface = layOutFrame();

    await userEvent.pointer([
      { target: surface, coords: { clientX: 20, clientY: 10 }, keys: "[MouseLeft>]" },
      { target: surface, coords: { clientX: 120, clientY: 60 } },
      { target: surface, keys: "[/MouseLeft]" },
      // On the way to the button, button up.
      { target: surface, coords: { clientX: 200, clientY: 100 } },
    ]);
    await userEvent.click(screen.getByRole("button", { name: /save adjustment/i }));

    expect(onVerdict).toHaveBeenCalledWith(1, "adjust", {
      adjusted_x_min: 0.1,
      adjusted_y_min: 0.1,
      adjusted_x_max: 0.6,
      adjusted_y_max: 0.6,
    });
  });

  it("will not save an adjustment that was never drawn", async () => {
    render(<VerificationCard frame={frame()} onVerdict={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /adjust paimon/i }));

    expect(screen.getByRole("button", { name: /save adjustment/i })).toBeDisabled();
  });

  it("rejects a whole frame in one action", async () => {
    const onRejectFrame = vi.fn();
    render(
      <VerificationCard
        frame={frame({ predictions: [box(), box({ id: 2, class_name: "Nahida" })] })}
        onVerdict={vi.fn()}
        onRejectFrame={onRejectFrame}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /reject whole frame/i }));

    // One call, whatever the box count — the menu-and-black-frame case must
    // not cost one request per spurious box.
    expect(onRejectFrame).toHaveBeenCalledTimes(1);
  });

  it("reports a missing object with no class named", async () => {
    const onReportMissing = vi.fn();
    render(
      <VerificationCard
        frame={frame()}
        onVerdict={vi.fn()}
        onReportMissing={onReportMissing}
        classes={[{ id: 3, name: "Paimon" }]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /report missing/i }));

    expect(onReportMissing).toHaveBeenCalledWith(null);
  });

  it("reports a missing object against the class the reporter picked", async () => {
    const onReportMissing = vi.fn();
    render(
      <VerificationCard
        frame={frame()}
        onVerdict={vi.fn()}
        onReportMissing={onReportMissing}
        classes={[{ id: 3, name: "Paimon" }]}
      />,
    );

    await userEvent.selectOptions(screen.getByLabelText(/something is missing/i), "3");
    await userEvent.click(screen.getByRole("button", { name: /report missing/i }));

    expect(onReportMissing).toHaveBeenCalledWith(3);
  });

  it("renders the admin-only controls only for a mount that passes them", () => {
    // The M14 mount, in every respect that matters to this component: a
    // stranger gets the verdict buttons and nothing else. Absent rather than
    // disabled — a disabled control is a promise that signing in would help,
    // and the public page has nothing to sign into.
    render(<VerificationCard frame={frame()} onVerdict={vi.fn()} />);

    expect(screen.getByRole("button", { name: /accept paimon/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reject whole frame/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /report missing/i })).not.toBeInTheDocument();
  });

  it("tells the mount when the frame's bytes will not load", () => {
    const onImageError = vi.fn();
    render(<VerificationCard frame={frame()} onVerdict={vi.fn()} onImageError={onImageError} />);

    screen.getByRole("img").dispatchEvent(new Event("error"));

    expect(onImageError).toHaveBeenCalled();
  });

  it("disables every ruling while one is in flight", () => {
    render(<VerificationCard frame={frame()} onVerdict={vi.fn()} onRejectFrame={vi.fn()} busy />);

    expect(screen.getByRole("button", { name: /accept paimon/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /reject whole frame/i })).toBeDisabled();
  });
});
