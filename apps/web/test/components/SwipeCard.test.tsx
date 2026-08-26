import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SwipeCard } from "../../src/components/SwipeCard";

/**
 * The shared swipe component (M24, plan §C2) both `/demo`'s `PublicVerify`
 * and `/contribute`'s `ContributeVerify` mount. `PublicVerify.test.tsx`
 * already exercises the gesture, the reducer wiring and the one-request
 * guarantee end to end through this component; what is worth asserting
 * directly against `SwipeCard` itself is the desktop layout plan §A adds —
 * structural facts a mount-level test would just be repeating.
 */

const box = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  class_name: "Paimon",
  x_min: 0.1,
  y_min: 0.2,
  x_max: 0.5,
  y_max: 0.6,
  confidence: 0.87,
  ...over,
});

function frame(boxes = [box(10)]) {
  return {
    id: 1,
    r2_key: "frames/dQw4w9WgXcQ/00001.000.jpg",
    url: "https://r2.example/frames/00001.jpg?X-Amz-Signature=abc",
    predictions: boxes,
  };
}

describe("SwipeCard", () => {
  // Plan §A1's regression guard. Whether this actually bounds the frame at
  // 720px on a real monitor is not something jsdom can show — it does no
  // layout — but the intended fix has to at least be the class riding on
  // the element the boxes are positioned against, which this can check.
  it("carries a max-width on the frame's own wrapper, never on an ancestor via max-height", () => {
    render(<SwipeCard frame={frame()} onSubmit={vi.fn()} />);

    const framewrap = screen.getByTestId("framewrap");
    expect(framewrap.className).toMatch(/max-w-\[720px\]/);
    // The letterboxing trap this plan names by name: capping height while
    // scaling the image down (`object-contain`) would desync every
    // percentage-positioned box from the image it describes.
    expect(framewrap.className).not.toMatch(/max-h-/);
    expect(framewrap.className).not.toMatch(/object-contain/);
  });

  it("offers no Adjust control — this component never had one to hide", () => {
    render(<SwipeCard frame={frame()} onSubmit={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /adjust/i })).not.toBeInTheDocument();
  });

  it("prints the arrow and backspace key bindings for the desktop control group", () => {
    render(<SwipeCard frame={frame()} onSubmit={vi.fn()} />);

    // Each binding appears twice in markup — the mobile-only inline glyph
    // and the desktop-only key badge (plan §A3) — and CSS, which jsdom does
    // not evaluate, decides which one a given viewport shows. Both are
    // `aria-hidden`, so neither ever leaks into a button's accessible name
    // (see the button-name assertions in `PublicVerify.test.tsx`).
    expect(screen.getAllByText("←")).toHaveLength(2);
    expect(screen.getAllByText("→")).toHaveLength(2);
    expect(screen.getAllByText("⌫")).toHaveLength(1);
  });

  it("repeats the active claim in the desktop panel, at the same time as the tag on the box", () => {
    render(
      <SwipeCard
        frame={frame([box(10), box(11, { class_name: "Raiden Shogun" })])}
        onSubmit={vi.fn()}
      />,
    );

    // Plan §A2: "the tag stays on the rectangle, and the panel repeats it" —
    // both exist in markup simultaneously (CSS decides which one a given
    // viewport shows), so this is deliberate duplication, not a bug.
    expect(screen.getByTestId("active-tag")).toHaveTextContent("Paimon");
    expect(screen.getByTestId("claim-panel")).toHaveTextContent("Paimon");
    expect(screen.queryByText("Raiden Shogun")).not.toBeInTheDocument();
  });
});
