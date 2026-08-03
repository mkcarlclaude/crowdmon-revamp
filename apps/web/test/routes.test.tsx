import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { App } from "../src/routes";

// The Admin page mounts components that call `useQuery`/`useMutation` (M5.2's
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

describe("routing", () => {
  it("renders the public page at /", () => {
    renderApp("/");
    expect(screen.getByRole("heading", { name: "crowdmon" })).toBeInTheDocument();
  });

  it("renders the admin page at /admin", () => {
    renderApp("/admin");
    expect(screen.getByRole("heading", { name: "Admin" })).toBeInTheDocument();
  });
});
