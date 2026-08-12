import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminAnnotationsPage } from "../../src/pages/admin/Annotations";

/**
 * `/admin/annotations` (M16, ROADMAP M16.4; M18, plan §A's filters and
 * total, plan §B's preview dialog): `LabellingStats` (moved, unchanged)
 * above the verdict list reading `GET /api/admin/verdicts`, now filterable
 * six ways and opening a preview on row click.
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
    x_min: 0.1,
    y_min: 0.2,
    x_max: 0.5,
    y_max: 0.6,
    confidence: 0.87,
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

/** A full `AdminClass` row — the class filter dropdown's own query validates the whole shape, not just `id`/`name`. */
function adminClass(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 3,
    name: "Paimon",
    appearance_prompt: "a small white-haired flying companion with pointed ears",
    prompt_version: "2026-08-08-a",
    active: true,
    created_at: 1_754_099_000,
    updated_at: 1_754_099_000,
    ...over,
  };
}

/** A full `AdminVideo` row — the video filter dropdown's own query validates the whole shape, not just `id`/`title`. */
function adminVideo(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "dQw4w9WgXcQ",
    title: null,
    image_count: 1,
    created_at: 1_754_099_000,
    frames_sampled: 0,
    model_id: null,
    prelabelled_at: null,
    ...over,
  };
}

/**
 * Every request this page can issue, routed to a canned response — the
 * verdict list, the labelling stats, and the three filter dropdowns' own
 * data (`useClasses`, `useVideos`, `useAdminVerdictAnnotators`). The
 * annotators check comes before the general verdicts one on purpose:
 * `/api/admin/verdicts/annotators` also starts with `/api/admin/verdicts`.
 */
function mockFetch({
  verdicts = { verdicts: [], total: 0 },
  stats = STATS,
  classes = { classes: [] },
  videos = { videos: [] },
  annotators = { annotators: [] },
}: {
  verdicts?: unknown;
  stats?: unknown;
  classes?: unknown;
  videos?: unknown;
  annotators?: unknown;
} = {}) {
  const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/admin/labelling/stats")) return Promise.resolve(json(stats));
    if (url.startsWith("/api/admin/verdicts/annotators")) return Promise.resolve(json(annotators));
    if (url.startsWith("/api/admin/classes")) return Promise.resolve(json(classes));
    if (url.startsWith("/api/admin/videos")) return Promise.resolve(json(videos));
    return Promise.resolve(json(verdicts));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("AdminAnnotationsPage", () => {
  it("renders the labelling pool stats above the verdict list", async () => {
    mockFetch({ verdicts: { verdicts: [verdict()], total: 1 } });

    renderPage();

    expect(await screen.findByText("Paimon")).toBeInTheDocument();
    // `LabellingStats`' own pool line — proof the moved component is what's
    // rendering here, not a re-implementation of it.
    expect(screen.getByText(/pre-labelled frames verified/i)).toBeInTheDocument();
  });

  it("defaults to the admin tab, matching the IA's own framing", async () => {
    const fetchMock = mockFetch();

    renderPage();

    await screen.findByText(/nothing ruled on yet/i);
    const call = fetchMock.mock.calls.find((args: unknown[]) =>
      String(args[0]).startsWith("/api/admin/verdicts?"),
    );
    expect(String(call?.[0])).toContain("source=admin");
  });

  it("switching tabs asks the API for the other tier", async () => {
    const fetchMock = mockFetch();

    renderPage();
    await screen.findByText(/nothing ruled on yet/i);

    await userEvent.click(screen.getByRole("tab", { name: "Anonymous" }));

    await waitFor(() => {
      // The most recent matching call, not the first: the initial render
      // already asked for `source=admin`, and switching tabs is a second
      // request layered on top of it rather than a replacement of the mock.
      const calls = fetchMock.mock.calls.filter((args: unknown[]) =>
        String(args[0]).startsWith("/api/admin/verdicts?"),
      );
      expect(String(calls.at(-1)?.[0])).toContain("source=anon");
    });
  });

  it("links a verdict's frame to its video detail page", async () => {
    mockFetch({ verdicts: { verdicts: [verdict()], total: 1 } });

    renderPage();

    const link = await screen.findByRole("link", { name: /dQw4w9WgXcQ @ 42s/ });
    expect(link).toHaveAttribute("href", "/admin/videos/dQw4w9WgXcQ");
  });

  it("shows the total the filter combination matches, not just the page size", async () => {
    mockFetch({ verdicts: { verdicts: [verdict()], total: 142 } });

    renderPage();

    expect(await screen.findByText("142 results")).toBeInTheDocument();
  });

  it("tells 'nothing ruled on yet' apart from 'nothing matches this filter'", async () => {
    mockFetch({
      verdicts: { verdicts: [], total: 0 },
      classes: { classes: [adminClass()] },
    });

    renderPage();
    await screen.findByText(/nothing ruled on yet/i);
    // The class dropdown's own data (`useClasses`) resolves on its own
    // request; selecting before it lands would pick an option that is not
    // in the DOM yet.
    await screen.findByRole("option", { name: "Paimon" });

    await userEvent.selectOptions(screen.getByLabelText("Class"), "3");

    expect(await screen.findByText(/nothing matches this filter combination/i)).toBeInTheDocument();
  });

  describe("filters", () => {
    it("filters by verdict kind, toggled on the button and off again", async () => {
      const fetchMock = mockFetch();
      renderPage();
      await screen.findByText(/nothing ruled on yet/i);

      await userEvent.click(screen.getByRole("button", { name: "reject" }));

      await waitFor(() => {
        const calls = fetchMock.mock.calls.filter((args: unknown[]) =>
          String(args[0]).startsWith("/api/admin/verdicts?"),
        );
        expect(String(calls.at(-1)?.[0])).toContain("verdict=reject");
      });

      await userEvent.click(screen.getByRole("button", { name: "reject" }));

      await waitFor(() => {
        const calls = fetchMock.mock.calls.filter((args: unknown[]) =>
          String(args[0]).startsWith("/api/admin/verdicts?"),
        );
        expect(String(calls.at(-1)?.[0])).not.toContain("verdict=");
      });
    });

    it("sends more than one selected verdict kind as repeated params", async () => {
      const fetchMock = mockFetch();
      renderPage();
      await screen.findByText(/nothing ruled on yet/i);

      await userEvent.click(screen.getByRole("button", { name: "accept" }));
      await userEvent.click(screen.getByRole("button", { name: "reject" }));

      await waitFor(() => {
        const calls = fetchMock.mock.calls.filter((args: unknown[]) =>
          String(args[0]).startsWith("/api/admin/verdicts?"),
        );
        const query = new URL(String(calls.at(-1)?.[0]), "http://localhost").searchParams;
        expect(query.getAll("verdict").sort()).toEqual(["accept", "reject"]);
      });
    });

    it("filters by class, populated from the class roster", async () => {
      const fetchMock = mockFetch({ classes: { classes: [adminClass()] } });
      renderPage();
      await screen.findByText(/nothing ruled on yet/i);
      await screen.findByRole("option", { name: "Paimon" });

      await userEvent.selectOptions(screen.getByLabelText("Class"), "3");

      await waitFor(() => {
        const calls = fetchMock.mock.calls.filter((args: unknown[]) =>
          String(args[0]).startsWith("/api/admin/verdicts?"),
        );
        expect(String(calls.at(-1)?.[0])).toContain("class_id=3");
      });
    });

    it("filters by video, populated from the video list", async () => {
      const fetchMock = mockFetch({
        videos: { videos: [adminVideo()] },
      });
      renderPage();
      await screen.findByText(/nothing ruled on yet/i);
      await screen.findByRole("option", { name: "dQw4w9WgXcQ" });

      await userEvent.selectOptions(screen.getByLabelText("Video"), "dQw4w9WgXcQ");

      await waitFor(() => {
        const calls = fetchMock.mock.calls.filter((args: unknown[]) =>
          String(args[0]).startsWith("/api/admin/verdicts?"),
        );
        expect(String(calls.at(-1)?.[0])).toContain("video_id=dQw4w9WgXcQ");
      });
    });

    it("filters by annotator, rendering an admin email as itself and an anon id truncated", async () => {
      const fetchMock = mockFetch({
        annotators: {
          annotators: [
            { annotator_id: "admin@example.com", source: "admin", verdicts: 5 },
            { annotator_id: "3f2c1a9e-aaaa-bbbb-cccc-000000000000", source: "anon", verdicts: 2 },
          ],
        },
      });
      renderPage();
      await screen.findByText(/nothing ruled on yet/i);

      const select = screen.getByLabelText("Annotator") as HTMLSelectElement;
      const optionText = Array.from(select.options).map((option) => option.textContent);
      expect(optionText).toContain("admin@example.com (5)");
      expect(optionText).toContain("anon · 3f2c… (2)");

      await userEvent.selectOptions(select, "admin@example.com");

      await waitFor(() => {
        const calls = fetchMock.mock.calls.filter((args: unknown[]) =>
          String(args[0]).startsWith("/api/admin/verdicts?"),
        );
        expect(String(calls.at(-1)?.[0])).toContain("annotator_id=admin%40example.com");
      });
    });

    it("filters by a time range, from and to", async () => {
      const fetchMock = mockFetch();
      renderPage();
      await screen.findByText(/nothing ruled on yet/i);

      const fromInput = screen.getByLabelText("From");
      await userEvent.type(fromInput, "2026-01-01");
      const toInput = screen.getByLabelText("To");
      await userEvent.type(toInput, "2026-01-31");

      await waitFor(() => {
        const calls = fetchMock.mock.calls.filter((args: unknown[]) =>
          String(args[0]).startsWith("/api/admin/verdicts?"),
        );
        const query = new URL(String(calls.at(-1)?.[0]), "http://localhost").searchParams;
        expect(query.get("from")).toBeTruthy();
        expect(query.get("to")).toBeTruthy();
      });
    });

    it("resets the offset whenever any filter changes, not just source", async () => {
      // `PAGE_SIZE` rows on the first page so "Next" is enabled, then a
      // filter change — this pins down that the same reset `changeSource`
      // used to do alone now applies to every control.
      const page = {
        verdicts: Array.from({ length: 50 }, (_, i) => verdict({ id: i + 1 })),
        total: 100,
      };
      const fetchMock = mockFetch({
        verdicts: page,
        classes: { classes: [adminClass()] },
      });
      renderPage();
      await screen.findByText("100 results");
      await screen.findByRole("option", { name: "Paimon" });

      await userEvent.click(screen.getByRole("button", { name: "Next" }));
      await waitFor(() => {
        const calls = fetchMock.mock.calls.filter((args: unknown[]) =>
          String(args[0]).startsWith("/api/admin/verdicts?"),
        );
        expect(String(calls.at(-1)?.[0])).toContain("offset=50");
      });

      await userEvent.selectOptions(screen.getByLabelText("Class"), "3");

      await waitFor(() => {
        const calls = fetchMock.mock.calls.filter((args: unknown[]) =>
          String(args[0]).startsWith("/api/admin/verdicts?"),
        );
        expect(String(calls.at(-1)?.[0])).toContain("offset=0");
        expect(String(calls.at(-1)?.[0])).toContain("class_id=3");
      });
    });
  });

  describe("the verdict preview dialog", () => {
    it("opens on a row click and shows the proposed and adjusted boxes for an adjust", async () => {
      mockFetch({
        verdicts: {
          verdicts: [
            verdict({
              verdict: "adjust",
              adjusted_x_min: 0.15,
              adjusted_y_min: 0.25,
              adjusted_x_max: 0.55,
              adjusted_y_max: 0.65,
            }),
          ],
          total: 1,
        },
      });

      renderPage();
      const row = await screen.findByTestId("verdict-row-1");
      await userEvent.click(row);

      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("Paimon");
      expect(dialog).toHaveTextContent("adjust");
      // Both boxes drawn, visually distinct and labelled — the plan's own
      // requirement, checked as two differently-labelled rectangles rather
      // than by colour, which testing-library cannot assert reliably.
      expect(screen.getByText("Proposed")).toBeInTheDocument();
      expect(screen.getByText("Adjusted")).toBeInTheDocument();

      const image = screen.getByAltText("frames/dQw4w9WgXcQ/00042.000.jpg");
      expect(image).toHaveAttribute(
        "src",
        `/api/admin/image?key=${encodeURIComponent("frames/dQw4w9WgXcQ/00042.000.jpg")}`,
      );
    });

    it("shows only the proposed box, marked rejected, for a reject", async () => {
      mockFetch({ verdicts: { verdicts: [verdict({ verdict: "reject" })], total: 1 } });

      renderPage();
      await userEvent.click(await screen.findByTestId("verdict-row-1"));

      await screen.findByRole("dialog");
      expect(screen.getByText("Rejected")).toBeInTheDocument();
      expect(screen.queryByText("Adjusted")).not.toBeInTheDocument();
    });

    it("closes when dismissed", async () => {
      mockFetch({ verdicts: { verdicts: [verdict()], total: 1 } });

      renderPage();
      await userEvent.click(await screen.findByTestId("verdict-row-1"));
      await screen.findByRole("dialog");

      await userEvent.keyboard("{Escape}");

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("does not open the preview when the frame link inside the row is clicked", async () => {
      mockFetch({ verdicts: { verdicts: [verdict()], total: 1 } });

      renderPage();
      const link = await screen.findByRole("link", { name: /dQw4w9WgXcQ @ 42s/ });
      await userEvent.click(link);

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
