import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BoxOverlay, type OverlayBox } from "../../src/components/BoxOverlay";

/**
 * The read-only box renderer both `VerificationCard` and
 * `VerdictPreviewDialog` draw through (M18, plan §B).
 *
 * `VerificationCard.test.tsx` and `AdminAnnotations.test.tsx`'s preview
 * dialog suite already exercise this component through both of its real
 * callers, which is where a coordinate-handling regression would actually
 * be noticed. What is worth pinning down here in isolation is the contract
 * itself — the part a caller relies on without re-deriving it every time:
 * position math, that a box carries its own testid regardless of caller,
 * dimming, and that `children` lands inside the same relative container a
 * caller's own overlay (a live drag rectangle, say) needs to share.
 */

const box = (over: Partial<OverlayBox> = {}): OverlayBox => ({
  id: 1,
  box: { x_min: 0.1, y_min: 0.2, x_max: 0.5, y_max: 0.6 },
  label: "1",
  variant: "neutral",
  ...over,
});

describe("BoxOverlay", () => {
  it("positions a box from its normalized coordinates", () => {
    render(<BoxOverlay frameUrl="https://example/frame.jpg" alt="a frame" boxes={[box()]} />);

    expect(screen.getByRole("img")).toHaveAttribute("src", "https://example/frame.jpg");
    expect(screen.getByTestId("box-1")).toHaveStyle({
      left: "10%",
      top: "20%",
      width: "40%",
      height: "40%",
    });
  });

  it("renders each box's label in its corner badge", () => {
    render(
      <BoxOverlay
        frameUrl="https://example/frame.jpg"
        alt="a frame"
        boxes={[
          box({ id: "proposed", label: "Proposed" }),
          box({ id: "adjusted", label: "Adjusted" }),
        ]}
      />,
    );

    expect(screen.getByTestId("box-proposed")).toHaveTextContent("Proposed");
    expect(screen.getByTestId("box-adjusted")).toHaveTextContent("Adjusted");
  });

  it("dims a box without changing which testid or label it carries", () => {
    render(
      <BoxOverlay
        frameUrl="https://example/frame.jpg"
        alt="a frame"
        boxes={[box({ dimmed: true })]}
      />,
    );

    expect(screen.getByTestId("box-1").className).toContain("opacity-25");
  });

  it("forwards extraData as data-* attributes on the box, not on the container", () => {
    render(
      <BoxOverlay
        frameUrl="https://example/frame.jpg"
        alt="a frame"
        boxes={[box({ extraData: { highlighted: "true", staged: "reject" } })]}
      />,
    );

    const rendered = screen.getByTestId("box-1");
    expect(rendered).toHaveAttribute("data-highlighted", "true");
    expect(rendered).toHaveAttribute("data-staged", "reject");
  });

  it("renders children after the boxes, inside the same container the ref points at", () => {
    render(
      <BoxOverlay frameUrl="https://example/frame.jpg" alt="a frame" boxes={[box()]}>
        <span data-testid="live-drag">drag preview</span>
      </BoxOverlay>,
    );

    const surface = screen.getByTestId("box-1").parentElement;
    expect(surface).toContainElement(screen.getByTestId("live-drag"));
  });

  it("forwards the ref to the same element pointer handlers are attached to, for position math callers do themselves", () => {
    let captured: HTMLDivElement | null = null;
    render(
      <BoxOverlay
        ref={(node) => {
          captured = node;
        }}
        frameUrl="https://example/frame.jpg"
        alt="a frame"
        boxes={[]}
      />,
    );

    expect(captured).not.toBeNull();
    expect(captured).toBe(screen.getByRole("img").parentElement);
  });

  it("reports a broken image through onImageError", () => {
    const onImageError = vi.fn();
    render(
      <BoxOverlay
        frameUrl="https://example/frame.jpg"
        alt="a frame"
        boxes={[]}
        onImageError={onImageError}
      />,
    );

    screen.getByRole("img").dispatchEvent(new Event("error"));

    expect(onImageError).toHaveBeenCalled();
  });
});
