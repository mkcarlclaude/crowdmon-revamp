import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminVideoDetailPage } from "../../src/pages/admin/VideoDetail";

/**
 * `/admin/videos/:id` (M16, ROADMAP M16.5): the browsable frame grid reading
 * `GET /api/admin/videos/{id}/images`.
 */
function renderPage(videoId = "dQw4w9WgXcQ") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/admin/videos/${videoId}`]}>
        <Routes>
          <Route path="/admin/videos/:id" element={<AdminVideoDetailPage />} />
        </Routes>
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

function image(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    r2_key: "frames/dQw4w9WgXcQ/00001.000.jpg",
    timestamp_seconds: 1,
    public_sample: false,
    predictions: 2,
    verdict_state: "unverified",
    ...over,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("AdminVideoDetailPage", () => {
  it("renders each frame's timestamp, prediction count and verdict state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ video_id: "dQw4w9WgXcQ", total: 1, images: [image()] })),
    );

    renderPage();

    expect(await screen.findByText("1s")).toBeInTheDocument();
    expect(screen.getByText("2 predictions")).toBeInTheDocument();
    expect(screen.getByText("unverified")).toBeInTheDocument();
  });

  it("says so when the video has no extracted frames", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ video_id: "empty000000", total: 0, images: [] })),
    );

    renderPage("empty000000");

    expect(await screen.findByText(/no frames extracted for this video yet/i)).toBeInTheDocument();
  });

  it("toggles the public-sample flag through the same endpoint the batch view uses", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/admin/images/1/public-sample")) {
        return Promise.resolve(json({ id: 1, public_sample: true }));
      }
      return Promise.resolve(
        json({ video_id: "dQw4w9WgXcQ", total: 1, images: [image({ public_sample: false })] }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    const checkbox = await screen.findByRole("checkbox");
    await userEvent.click(checkbox);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/images/1/public-sample",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("shows a page range once the video has more frames than one page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          video_id: "dQw4w9WgXcQ",
          total: 30,
          images: Array.from({ length: 24 }, (_, i) => image({ id: i + 1, timestamp_seconds: i })),
        }),
      ),
    );

    renderPage();

    expect(await screen.findByText("1–24 of 30")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).not.toBeDisabled();
  });
});
