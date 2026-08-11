import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminAnnotationsPage } from "../../src/pages/admin/Annotations";

/**
 * `/admin/annotations` (M16, ROADMAP M16.4): `LabellingStats` (moved,
 * unchanged) above the new verdict list reading `GET /api/admin/verdicts`.
 */
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AdminAnnotationsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const STATS = {
  pool: {
    images_with_predictions: 10,
    images_verified: 4,
    images_remaining: 6,
    missing_reports: 1,
  },
  classes: [],
};

function verdict(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    prediction_id: 42,
    verdict: "accept",
    adjusted_x_min: null,
    adjusted_y_min: null,
    adjusted_x_max: null,
    adjusted_y_max: null,
    source: "admin",
    annotator_id: "admin@example.com",
    created_at: 1_754_099_000,
    image_id: 7,
    video_id: "dQw4w9WgXcQ",
    r2_key: "frames/dQw4w9WgXcQ/00042.000.jpg",
    timestamp_seconds: 42,
    class_id: 1,
    class_name: "Paimon",
    ...over,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("AdminAnnotationsPage", () => {
  it("renders the labelling pool stats above the verdict list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("/api/admin/labelling/stats")) return Promise.resolve(json(STATS));
        return Promise.resolve(json({ verdicts: [verdict()] }));
      }),
    );

    renderPage();

    expect(await screen.findByText("Paimon")).toBeInTheDocument();
    // `LabellingStats`' own pool line — proof the moved component is what's
    // rendering here, not a re-implementation of it.
    expect(screen.getByText(/pre-labelled frames verified/i)).toBeInTheDocument();
  });

  it("defaults to the admin tab, matching the IA's own framing", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/admin/labelling/stats")) return Promise.resolve(json(STATS));
      return Promise.resolve(json({ verdicts: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    await screen.findByText(/nothing ruled on yet/i);
    const call = fetchMock.mock.calls.find((args: unknown[]) =>
      String(args[0]).startsWith("/api/admin/verdicts"),
    );
    expect(String(call?.[0])).toContain("source=admin");
  });

  it("switching tabs asks the API for the other tier", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/admin/labelling/stats")) return Promise.resolve(json(STATS));
      return Promise.resolve(json({ verdicts: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText(/nothing ruled on yet/i);

    await userEvent.click(screen.getByRole("tab", { name: "Anonymous" }));

    await waitFor(() => {
      // The most recent matching call, not the first: the initial render
      // already asked for `source=admin`, and switching tabs is a second
      // request layered on top of it rather than a replacement of the mock.
      const calls = fetchMock.mock.calls.filter((args: unknown[]) =>
        String(args[0]).startsWith("/api/admin/verdicts"),
      );
      expect(String(calls.at(-1)?.[0])).toContain("source=anon");
    });
  });

  it("links a verdict's frame to its video detail page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("/api/admin/labelling/stats")) return Promise.resolve(json(STATS));
        return Promise.resolve(json({ verdicts: [verdict()] }));
      }),
    );

    renderPage();

    const link = await screen.findByRole("link", { name: /dQw4w9WgXcQ @ 42s/ });
    expect(link).toHaveAttribute("href", "/admin/videos/dQw4w9WgXcQ");
  });
});
