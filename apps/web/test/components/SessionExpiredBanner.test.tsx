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

  it("navigates to an Access-gated path, not back to the current page", async () => {
    // The bug this pins, found only once M5 was deployed: the original
    // implementation navigated to `window.location.href`. `/admin` is a static
    // asset with no Access application in front of it, so that reload returned
    // the SPA shell, which re-fetched, failed identically, and re-rendered this
    // banner — a loop with no reachable login screen.
    //
    // The old test asserted `assign` was called with the current URL and passed
    // against the broken code, which is why it is written the other way round
    // now: the destination must be a path Access actually binds to.
    const assign = vi.fn();
    const href = "https://crowdmon.mkcarl.com/admin";
    vi.stubGlobal("location", { href, assign });

    render(<SessionExpiredBanner error={new SessionExpiredError()} />);
    await userEvent.click(screen.getByRole("button", { name: /sign in again/i }));

    // A full navigation, not a fetch: only a top-level load can follow Access's
    // redirect chain to an identity provider on another origin.
    expect(assign).toHaveBeenCalledTimes(1);
    const target = assign.mock.calls[0]?.[0] as string;

    expect(target).not.toBe(href);
    // Under `/api/admin`, which is the prefix the Access application binds to
    // (infra/access.tf). Anything outside it is served without a gate and
    // reproduces the loop.
    expect(target.startsWith("/api/admin/")).toBe(true);

    vi.unstubAllGlobals();
  });
});
