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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** An unauthenticated `GET /api/admin/session` — the 401 `requireAccess` answers with. */
function stubNoSession() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(json({ error: "missing Access assertion" }, 401)),
  );
}

/**
 * A working session, plus empty responses for whatever page the redirect or
 * route under test lands on — `/admin/videos` reads `useVideos()`,
 * `/admin/queue` reads `useJobs()`, and both are harmless to stub with
 * nothing when the assertion only cares which page rendered.
 */
function stubAuthenticated() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/admin/session"))
        return Promise.resolve(json({ email: "admin@example.com" }));
      if (url.startsWith("/api/admin/videos")) return Promise.resolve(json({ videos: [] }));
      if (url.startsWith("/api/admin/jobs")) return Promise.resolve(json({ now: 0, jobs: [] }));
      return Promise.resolve(json({ error: "not found" }, 404));
    }),
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

  // M19, plan §B2: the coverage table folded into `/admin/videos`, and
  // `/admin/detection` — linked from this repo's own docs and issue #140 —
  // redirects there rather than 404ing.
  it("redirects an authenticated browser at /admin/detection to /admin/videos", async () => {
    stubAuthenticated();
    renderApp("/admin/detection");

    expect(await screen.findByText(/submit a video/i)).toBeInTheDocument();
  });

  // M19, plan §C1: a flat queue page, replacing the grouped `JobList` this
  // milestone deletes from `/admin/videos`.
  it("mounts the queue page at /admin/queue", async () => {
    stubAuthenticated();
    renderApp("/admin/queue");

    expect(await screen.findByRole("button", { name: "All" })).toBeInTheDocument();
  });
});
