import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminLayout } from "../../src/components/AdminLayout";

/**
 * `AdminLayout` (M16, CONTEXT.md §Q19 amendment): the session probe, the
 * redirect it drives, and the sidebar shell once the probe succeeds.
 *
 * Rendered inside its own `<Routes>` with a real child route rather than a
 * bare `<AdminLayout />` — `Outlet` throws outside a matched route, and the
 * whole point of a layout test is checking that the child actually renders
 * where the sidebar expects it to.
 */
function renderLayout(initialEntry = "/admin/dashboard") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/admin/login" element={<div>login screen</div>} />
          <Route path="/admin" element={<AdminLayout />}>
            <Route path="dashboard" element={<div>dashboard content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function stubSession(response: { status: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("AdminLayout", () => {
  it("redirects to /admin/login when the session probe fails", async () => {
    stubSession({ status: 401, body: { error: "missing Access assertion" } });

    renderLayout();

    expect(await screen.findByText("login screen")).toBeInTheDocument();
    expect(screen.queryByText("dashboard content")).not.toBeInTheDocument();
  });

  it("renders the sidebar and the routed child once the probe succeeds", async () => {
    stubSession({ status: 200, body: { email: "admin@example.com" } });

    renderLayout();

    expect(await screen.findByText("dashboard content")).toBeInTheDocument();
    // Every destination the plan's information architecture names, not just
    // the one that happened to match — a sidebar missing a link is a bug the
    // dashboard test above cannot see, because it only renders one route.
    for (const label of [
      "Dashboard",
      "Videos",
      "Verify",
      "Annotations",
      "Detection",
      "Classes",
      "Snapshots",
    ]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByTestId("admin-email")).toHaveTextContent("admin@example.com");
  });

  it("marks only the current route's sidebar item active", async () => {
    stubSession({ status: 200, body: { email: "admin@example.com" } });

    renderLayout("/admin/dashboard");

    await screen.findByText("dashboard content");
    const activeLink = screen.getByRole("link", { name: "Dashboard" });
    const otherLink = screen.getByRole("link", { name: "Videos" });

    expect(activeLink.closest('[data-slot="sidebar-menu-button"]')).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(otherLink.closest('[data-slot="sidebar-menu-button"]')).toHaveAttribute(
      "data-active",
      "false",
    );
  });
});
