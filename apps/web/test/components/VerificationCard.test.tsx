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
 *
 * **Rulings are staged, not written.** Nothing leaves this component until
 * Submit, and the reason is the frame in the screenshot that prompted it: five
 * boxes of one class, each ruling removing a row and renumbering the rest under
 * a moving cursor. Most of what follows is about the frame holding still.
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

const submitButton = () => screen.getByRole("button", { name: /^submit/i });

describe("VerificationCard", () => {
  it("draws each proposed box from its normalized coordinates", () => {
    render(<VerificationCard frame={frame()} onSubmit={vi.fn()} />);

    expect(screen.getByRole("img")).toHaveAttribute("src", frame().url);
    expect(screen.getByTestId("box-1")).toHaveStyle({
      left: "10%",
      top: "20%",
      width: "40%",
      height: "40%",
    });
  });

  it("numbers every box and every row the same way", () => {
    // The frame that made this necessary: five boxes, all Paimon, confidences
    // within 0.05 of each other. Without a number on the rectangle the rows
    // are five identical lines and choosing between them is a guess.
    const boxes = [box({ id: 1 }), box({ id: 2 }), box({ id: 3 })];
    render(<VerificationCard frame={frame({ predictions: boxes })} onSubmit={vi.fn()} />);

    for (const [index, drawn] of boxes.entries()) {
      const label = String(index + 1);
      expect(within(screen.getByTestId(`box-${drawn.id}`)).getByText(label)).toBeInTheDocument();
      expect(within(screen.getByTestId(`row-${drawn.id}`)).getByText(label)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: `Accept Paimon ${label}` })).toBeInTheDocument();
    }
  });

  it("lights up the box belonging to the row being pointed at", async () => {
    const boxes = [box({ id: 1 }), box({ id: 2 })];
    render(<VerificationCard frame={frame({ predictions: boxes })} onSubmit={vi.fn()} />);

    await userEvent.pointer({ target: screen.getByTestId("row-2") });

    expect(screen.getByTestId("box-2")).toHaveAttribute("data-highlighted", "true");
    expect(screen.getByTestId("box-1")).toHaveAttribute("data-highlighted", "false");
  });

  it("lights up the same box when the row is reached by keyboard", async () => {
    const boxes = [box({ id: 1 }), box({ id: 2 })];
    render(<VerificationCard frame={frame({ predictions: boxes })} onSubmit={vi.fn()} />);

    // Four tabs: three buttons on the first row, then the second row's first.
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();

    expect(screen.getByRole("button", { name: "Accept Paimon 2" })).toHaveFocus();
    expect(screen.getByTestId("box-2")).toHaveAttribute("data-highlighted", "true");
  });
});

describe("staging", () => {
  it("writes nothing until the frame is submitted", async () => {
    const onSubmit = vi.fn();
    const boxes = [box({ id: 1 }), box({ id: 2 })];
    render(<VerificationCard frame={frame({ predictions: boxes })} onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole("button", { name: "Accept Paimon 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Reject Paimon 2" }));

    expect(onSubmit).not.toHaveBeenCalled();

    await userEvent.click(submitButton());

    expect(onSubmit).toHaveBeenCalledWith([
      { prediction_id: 1, verdict: "accept" },
      { prediction_id: 2, verdict: "reject" },
    ]);
  });

  it("holds the frame still while it is being ruled on", async () => {
    // The bug this whole shape exists for: a ruling that wrote immediately
    // removed its row, renumbering everything below it under a moving cursor.
    const boxes = [box({ id: 1 }), box({ id: 2 }), box({ id: 3 })];
    render(<VerificationCard frame={frame({ predictions: boxes })} onSubmit={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Accept Paimon 1" }));

    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByTestId("row-1")).toBeInTheDocument();
    // Box 2 is still box 2, which is the whole claim.
    expect(within(screen.getByTestId("row-2")).getByText("2")).toBeInTheDocument();
  });

  it("marks what is staged, on the row and on the rectangle", async () => {
    const boxes = [box({ id: 1 }), box({ id: 2 })];
    render(<VerificationCard frame={frame({ predictions: boxes })} onSubmit={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Reject Paimon 1" }));

    expect(screen.getByTestId("row-1")).toHaveAttribute("data-staged", "reject");
    expect(screen.getByTestId("box-1")).toHaveAttribute("data-staged", "reject");
    expect(screen.getByRole("button", { name: "Reject Paimon 1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("row-2")).toHaveAttribute("data-staged", "");
  });

  it("replaces a ruling rather than queueing both", async () => {
    // Two contradictory rows written in one submission are indistinguishable
    // afterwards from a genuine change of mind recorded later, and the API
    // refuses the pair outright.
    const onSubmit = vi.fn();
    render(<VerificationCard frame={frame()} onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole("button", { name: "Accept Paimon 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Reject Paimon 1" }));
    await userEvent.click(submitButton());

    expect(onSubmit).toHaveBeenCalledWith([{ prediction_id: 1, verdict: "reject" }]);
  });

  it("takes a ruling back when its own button is clicked again", async () => {
    render(<VerificationCard frame={frame()} onSubmit={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Accept Paimon 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Accept Paimon 1" }));

    expect(screen.getByTestId("row-1")).toHaveAttribute("data-staged", "");
    expect(submitButton()).toBeDisabled();
  });

  it("counts what is staged against what the frame carries", async () => {
    const boxes = [box({ id: 1 }), box({ id: 2 }), box({ id: 3 })];
    render(<VerificationCard frame={frame({ predictions: boxes })} onSubmit={vi.fn()} />);

    expect(submitButton()).toHaveTextContent("Submit 0 of 3");

    await userEvent.click(screen.getByRole("button", { name: "Accept Paimon 2" }));

    expect(submitButton()).toHaveTextContent("Submit 1 of 3");
  });

  it("will not submit an empty frame", () => {
    // The API refuses an empty submission; refusing it here means the refusal
    // is visible before the click rather than after it.
    render(<VerificationCard frame={frame()} onSubmit={vi.fn()} />);

    expect(submitButton()).toBeDisabled();
  });

  it("clears everything staged in one action", async () => {
    const boxes = [box({ id: 1 }), box({ id: 2 })];
    render(<VerificationCard frame={frame({ predictions: boxes })} onSubmit={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Accept Paimon 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Accept Paimon 2" }));
    await userEvent.click(screen.getByRole("button", { name: /^clear$/i }));

    expect(submitButton()).toBeDisabled();
    expect(screen.getByTestId("row-1")).toHaveAttribute("data-staged", "");
  });

  it("stages a reject for every box when the whole frame is rejected", async () => {
    // Menus, loading screens and black frames are the common case in a sampled
    // timeline. Two clicks total, whatever the box count.
    const onSubmit = vi.fn();
    const boxes = [box({ id: 1 }), box({ id: 2 }), box({ id: 3 })];
    render(<VerificationCard frame={frame({ predictions: boxes })} onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole("button", { name: /reject whole frame/i }));
    await userEvent.click(submitButton());

    expect(onSubmit).toHaveBeenCalledWith([
      { prediction_id: 1, verdict: "reject" },
      { prediction_id: 2, verdict: "reject" },
      { prediction_id: 3, verdict: "reject" },
    ]);
  });

  it("disables every control while a submission is in flight", () => {
    render(<VerificationCard frame={frame()} onSubmit={vi.fn()} busy />);

    expect(screen.getByRole("button", { name: "Accept Paimon 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /reject whole frame/i })).toBeDisabled();
    expect(submitButton()).toBeDisabled();
  });
});

describe("adjusting", () => {
  it("stages an adjustment drawn over the frame", async () => {
    const onSubmit = vi.fn();
    render(<VerificationCard frame={frame()} onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole("button", { name: "Adjust Paimon 1" }));
    const surface = layOutFrame();

    // 20..120 of 200 across, 10..60 of 100 down.
    await userEvent.pointer([
      { target: surface, coords: { clientX: 20, clientY: 10 }, keys: "[MouseLeft>]" },
      { target: surface, coords: { clientX: 120, clientY: 60 } },
      { target: surface, keys: "[/MouseLeft]" },
    ]);

    expect(screen.getByTestId("adjustment")).toHaveStyle({ left: "10%", top: "10%" });

    await userEvent.click(screen.getByRole("button", { name: /save adjustment/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("row-1")).toHaveAttribute("data-staged", "adjust");

    await userEvent.click(submitButton());

    expect(onSubmit).toHaveBeenCalledWith([
      {
        prediction_id: 1,
        verdict: "adjust",
        adjusted_x_min: 0.1,
        adjusted_y_min: 0.1,
        adjusted_x_max: 0.6,
        adjusted_y_max: 0.6,
      },
    ]);
  });

  it("normalizes a drag made in either direction", async () => {
    // Dragged bottom-right to top-left. The schema requires x_max >= x_min, so
    // a component that passed the raw start and end would produce a 400 for an
    // action the operator has no reason to think is different.
    const onSubmit = vi.fn();
    render(<VerificationCard frame={frame()} onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole("button", { name: "Adjust Paimon 1" }));
    const surface = layOutFrame();

    await userEvent.pointer([
      { target: surface, coords: { clientX: 120, clientY: 60 }, keys: "[MouseLeft>]" },
      { target: surface, coords: { clientX: 20, clientY: 10 } },
      { target: surface, keys: "[/MouseLeft]" },
    ]);
    await userEvent.click(screen.getByRole("button", { name: /save adjustment/i }));
    await userEvent.click(submitButton());

    expect(onSubmit).toHaveBeenCalledWith([
      {
        prediction_id: 1,
        verdict: "adjust",
        adjusted_x_min: 0.1,
        adjusted_y_min: 0.1,
        adjusted_x_max: 0.6,
        adjusted_y_max: 0.6,
      },
    ]);
  });

  it("stops drawing when the pointer is released", async () => {
    // With no "button is down" state, a pointermove after release keeps
    // stretching the box — so moving the cursor from the frame down to "Save
    // adjustment" saves a box nobody drew.
    const onSubmit = vi.fn();
    render(<VerificationCard frame={frame()} onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole("button", { name: "Adjust Paimon 1" }));
    const surface = layOutFrame();

    await userEvent.pointer([
      { target: surface, coords: { clientX: 20, clientY: 10 }, keys: "[MouseLeft>]" },
      { target: surface, coords: { clientX: 120, clientY: 60 } },
      { target: surface, keys: "[/MouseLeft]" },
      // On the way to the button, button up.
      { target: surface, coords: { clientX: 200, clientY: 100 } },
    ]);
    await userEvent.click(screen.getByRole("button", { name: /save adjustment/i }));
    await userEvent.click(submitButton());

    expect(onSubmit).toHaveBeenCalledWith([
      expect.objectContaining({ adjusted_x_max: 0.6, adjusted_y_max: 0.6 }),
    ]);
  });

  it("will not save an adjustment that was never drawn", async () => {
    render(<VerificationCard frame={frame()} onSubmit={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Adjust Paimon 1" }));

    expect(screen.getByRole("button", { name: /save adjustment/i })).toBeDisabled();
  });
});

describe("the two mounts", () => {
  it("renders the admin-only controls only for a mount that passes them", () => {
    // The M14 mount, in every respect that matters to this component: a
    // stranger gets the rulings and the submit, and no missing-object report.
    // Absent rather than disabled — a disabled control is a promise that
    // signing in would help, and the public page has nothing to sign into.
    render(<VerificationCard frame={frame()} onSubmit={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Accept Paimon 1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /report missing/i })).not.toBeInTheDocument();
  });

  it("reports a missing object with no class named", async () => {
    const onReportMissing = vi.fn();
    render(
      <VerificationCard
        frame={frame()}
        onSubmit={vi.fn()}
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
        onSubmit={vi.fn()}
        onReportMissing={onReportMissing}
        classes={[{ id: 3, name: "Paimon" }]}
      />,
    );

    await userEvent.selectOptions(screen.getByLabelText(/something is missing/i), "3");
    await userEvent.click(screen.getByRole("button", { name: /report missing/i }));

    expect(onReportMissing).toHaveBeenCalledWith(3);
  });

  it("tells the mount when the frame's bytes will not load", () => {
    const onImageError = vi.fn();
    render(<VerificationCard frame={frame()} onSubmit={vi.fn()} onImageError={onImageError} />);

    screen.getByRole("img").dispatchEvent(new Event("error"));

    expect(onImageError).toHaveBeenCalled();
  });
});
