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
    // A presigned R2 URL, because that is what a configured deployment
    // returns — the page renders `url` verbatim and must not be able to tell
    // one mode from the other.
    url: "https://frames.example/frames/dQw4w9WgXcQ/00001.000.jpg?X-Amz-Signature=abc",
    timestamp_seconds: 1,
    public_sample: false,
    predictions: 2,
    verdict_state: "unverified",
    ...over,
  };
}

/** One page of the response, with the two envelope fields every reply carries. */
function page(over: Partial<Record<string, unknown>> = {}) {
  return {
    video_id: "dQw4w9WgXcQ",
    total: 1,
    images: [image()],
    url_mode: "signed",
    expires_at: 1_786_461_918,
    ...over,
  };
}

/** `GET /api/admin/videos/{id}`'s response (M19, plan §A). */
function detail(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "dQw4w9WgXcQ",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Archon quest",
    duration_seconds: 1200,
    width: 1920,
    height: 1080,
    created_at: 1_754_099_000,
    image_count: 2685,
    frames_sampled: 200,
    public_samples: 3,
    predictions: 340,
    frames_with_predictions: 190,
    frames_verified: 150,
    frames_unverified: 40,
    model_id: "owlvit-base-patch32.onnx",
    prelabelled_at: 1_754_099_500,
    jobs: {
      download: "done",
      chunks_total: 20,
      chunks_done: 20,
      chunks_failed: 0,
      prelabel: "done",
    },
    ...over,
  };
}

/**
 * Routes `/api/admin/videos/{id}` to `detail()` and everything else (the
 * frame grid) to `page()` — the two queries this page fires in parallel, and
 * a single blanket mock would answer both with whichever shape came first.
 */
function stubVideo(
  detailOver: Partial<Record<string, unknown>> = {},
  pageOver: Partial<Record<string, unknown>> = {},
) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/images")) return Promise.resolve(json(page(pageOver)));
      return Promise.resolve(json(detail(detailOver)));
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("AdminVideoDetailPage", () => {
  it("renders the header: title, id, verified/unverified frames and submitted-at", async () => {
    stubVideo();

    renderPage();

    expect(await screen.findByRole("heading", { name: "Archon quest" })).toBeInTheDocument();
    expect(screen.getByText("dQw4w9WgXcQ")).toBeInTheDocument();
    expect(screen.getByText("150 / 40")).toBeInTheDocument();
  });

  it("renders a null duration and resolution as — rather than 0", async () => {
    // A video mid-download has no duration or resolution yet — that is a
    // different fact from zero, and the plan is explicit that this header
    // must never blur the two (M19, plan §A3).
    stubVideo({ duration_seconds: null, width: null, height: null });

    renderPage();

    await screen.findByRole("heading", { name: "Archon quest" });
    expect(screen.getAllByText("—")).not.toHaveLength(0);
  });

  it("falls back to the video id as the heading when no title has landed yet", async () => {
    stubVideo({ title: null });

    renderPage();

    expect(await screen.findByRole("heading", { name: "dQw4w9WgXcQ" })).toBeInTheDocument();
  });

  it("hides extraction progress once every chunk is done and none failed", async () => {
    stubVideo({
      jobs: {
        download: "done",
        chunks_total: 20,
        chunks_done: 20,
        chunks_failed: 0,
        prelabel: "done",
      },
    });

    renderPage();

    await screen.findByRole("heading", { name: "Archon quest" });
    expect(screen.queryByText(/chunks done/i)).not.toBeInTheDocument();
  });

  it("shows the download job's status before any chunk has been created", async () => {
    stubVideo({
      duration_seconds: null,
      width: null,
      height: null,
      jobs: {
        download: "claimed",
        chunks_total: 0,
        chunks_done: 0,
        chunks_failed: 0,
        prelabel: null,
      },
    });

    renderPage();

    await screen.findByRole("heading", { name: "Archon quest" });
    expect(screen.getByText("claimed")).toBeInTheDocument();
  });

  it("shows chunk progress and a failed count once fan-out has run", async () => {
    stubVideo({
      jobs: {
        download: "done",
        chunks_total: 20,
        chunks_done: 17,
        chunks_failed: 2,
        prelabel: null,
      },
    });

    renderPage();

    expect(await screen.findByText(/17\/20 chunks done/)).toBeInTheDocument();
    expect(screen.getByText(/2 failed/)).toBeInTheDocument();
  });

  it("404s the header without blocking the frame grid's own honest empty-page answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/images")) return Promise.resolve(json(page()));
        return Promise.resolve(json({ error: "no video with id dQw4w9WgXcQ" }, 404));
      }),
    );

    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("no video with id dQw4w9WgXcQ");
    // The grid below still renders — the header's 404 is not swallowed, but it
    // is also not fatal to the rest of the page.
    expect(await screen.findByText("1s")).toBeInTheDocument();
  });

  it("renders each frame's timestamp, prediction count and verdict state", async () => {
    stubVideo();

    renderPage();

    expect(await screen.findByText("1s")).toBeInTheDocument();
    expect(screen.getByText("2 predictions")).toBeInTheDocument();
    expect(screen.getByText("unverified")).toBeInTheDocument();
  });

  it("renders the URL the API minted rather than building a proxy path", async () => {
    stubVideo();

    renderPage();

    const frame = await screen.findByAltText("frames/dQw4w9WgXcQ/00001.000.jpg");
    // The `src` is the fixture's signed URL verbatim. M16 built
    // `/api/admin/image?key=…` here instead, which routed every
    // full-resolution frame through a Worker and made CONTEXT.md §Q25's
    // presigned path unreachable from this screen no matter how the
    // deployment was configured.
    expect(frame).toHaveAttribute("src", image().url);
    expect(frame).toHaveAttribute("loading", "lazy");
  });

  it("says so when the video has no extracted frames", async () => {
    stubVideo({ id: "empty000000" }, { video_id: "empty000000", total: 0, images: [] });

    renderPage("empty000000");

    expect(await screen.findByText(/no frames extracted for this video yet/i)).toBeInTheDocument();
  });

  it("toggles the public-sample flag through the same endpoint the batch view uses", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/admin/images/1/public-sample")) {
        return Promise.resolve(json({ id: 1, public_sample: true }));
      }
      if (url.includes("/images")) {
        return Promise.resolve(json(page({ images: [image({ public_sample: false })] })));
      }
      return Promise.resolve(json(detail()));
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
    stubVideo(
      {},
      {
        total: 30,
        images: Array.from({ length: 24 }, (_, i) => image({ id: i + 1, timestamp_seconds: i })),
      },
    );

    renderPage();

    expect(await screen.findByText("1–24 of 30")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).not.toBeDisabled();
  });
});
