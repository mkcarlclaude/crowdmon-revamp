import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/routes";

// The Admin routes mount components that call `useQuery`/`useMutation` (M5.2's
// SubmitForm onward), so `App` needs a QueryClientProvider in tests just as it
// gets one from `main.tsx` at runtime.
function renderApp(initialEntry: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** An unauthenticated `GET /api/admin/session` — the 401 `requireAccess` answers with. */
function stubNoSession() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "missing Access assertion" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("routing", () => {
  it("renders the public page at /", () => {
    renderApp("/");
    expect(screen.getByRole("heading", { name: "crowdmon" })).toBeInTheDocument();
  });

  // M16, CONTEXT.md §Q19 amendment: `/admin` used to render a heading
  // directly (M5). It now sits behind `AdminLayout`'s session probe, so an
  // unauthenticated browser is redirected client-side to the `/admin/login`
  // gate screen — cosmetics, not the boundary; every `/api/admin/*` endpoint
  // still verifies the caller independently regardless of what this test
  // renders.
  it("redirects an unauthenticated browser at /admin to the login gate screen", async () => {
    stubNoSession();
    renderApp("/admin");

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Dashboard" })).not.toBeInTheDocument();
  });

  it("redirects /admin/dashboard the same way — the probe runs in the shared layout, not per page", async () => {
    stubNoSession();
    renderApp("/admin/dashboard");

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });
});
