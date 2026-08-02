import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError, SessionExpiredError } from "../../src/api/session";
import { SessionExpiredBanner } from "../../src/components/SessionExpiredBanner";

describe("SessionExpiredBanner", () => {
  it("renders nothing for an ordinary API error", () => {
    const { container } = render(<SessionExpiredBanner error={new ApiError(409, "duplicate")} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when there is no error", () => {
    const { container } = render(<SessionExpiredBanner error={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers a full-page navigation to re-authenticate", async () => {
    // A full navigation, not a fetch: only a top-level load can follow Access's
    // redirect chain to the identity provider and back.
    const assign = vi.fn();
    vi.stubGlobal("location", { href: "https://crowdmon.mkcarl.com/admin", assign });

    render(<SessionExpiredBanner error={new SessionExpiredError()} />);
    await userEvent.click(screen.getByRole("button", { name: /sign in again/i }));

    expect(assign).toHaveBeenCalledWith("https://crowdmon.mkcarl.com/admin");
    vi.unstubAllGlobals();
  });
});
