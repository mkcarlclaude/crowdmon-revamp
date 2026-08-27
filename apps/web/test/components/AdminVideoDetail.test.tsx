import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    // M17, plan §B: whether an earlier prelabel pass already claimed this
    // frame (`images.selection_reason IS NOT NULL`) — the multi-select
    // grid's own reason for disabling its checkbox.
    sampled: false,
    // M25.1: the reason itself, beside the boolean. Null for a frame no pass
    // has claimed, which is what `sampled: false` above means.
    selection_reason: null,
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

/** `POST /api/admin/videos/{id}/prelabel`'s response shape (M17, plan §B). */
function prelabelJob(over: Partial<Record<string, unknown>> = {}) {
  return {
    job_id: 42,
    video_id: "dQw4w9WgXcQ",
    selection_reason: "manual",
    images: 1,
    ...over,
  };
}

/** `GET /api/admin/labelling/stats`'s response shape, trimmed to what this page reads. */
function labellingStats(remaining: number) {
  return {
    pool: {
      images_with_predictions: remaining + 3,
      images_verified: 3,
      images_remaining: remaining,
      missing_reports: 0,
    },
    classes: [],
  };
}

/**
 * Routes `/api/admin/videos/{id}` to `detail()` and everything else (the
 * frame grid) to `page()` — the queries this page fires in parallel, and a
 * single blanket mock would answer them all with whichever shape came first.
 *
 * The stats and jobs branches are not this helper's subject: they exist so a
 * header test does not fail on M17 (plan §B)'s pool counter answering with a
 * video-detail body. A test whose subject *is* the prelabel controls stubs
 * `fetch` itself, below.
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
      if (url.startsWith("/api/admin/labelling/stats")) {
        return Promise.resolve(json(labellingStats(7)));
      }
      if (url.startsWith("/api/admin/jobs")) return Promise.resolve(json({ now: 0, jobs: [] }));
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

    // Two checkboxes per frame since M17 (plan §B) added the prelabel
    // multi-select one — named explicitly rather than `findByRole("checkbox")`
    // alone, which now matches both.
    const checkbox = await screen.findByRole("checkbox", { name: "public" });
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

  // On-demand supplementary prelabel (M17, plan §B): the two actions this
  // grid gained, and the property that matters most about them — a
  // hand-picked selection sends `image_ids`, never `count`/`strategy`, so
  // it can never be mistaken on the wire for the unbiased draw.
  describe("on-demand prelabel", () => {
    it("disables 'prelabel selected' until a frame is checked, then sends its id as a hand-picked set", async () => {
      const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/admin/videos/dQw4w9WgXcQ/prelabel") {
          return Promise.resolve(json(prelabelJob()));
        }
        if (url.startsWith("/api/admin/labelling/stats")) {
          return Promise.resolve(json(labellingStats(7)));
        }
        if (url.startsWith("/api/admin/jobs")) return Promise.resolve(json({ now: 0, jobs: [] }));
        return Promise.resolve(json(page()));
      });
      vi.stubGlobal("fetch", fetchMock);

      renderPage();

      const selectCheckbox = await screen.findByRole("checkbox", {
        name: "select frame at 1s for prelabelling",
      });
      expect(screen.getByRole("button", { name: "Prelabel selected" })).toBeDisabled();

      await userEvent.click(selectCheckbox);
      const prelabelButton = screen.getByRole("button", { name: "Prelabel 1 selected" });
      expect(prelabelButton).not.toBeDisabled();

      await userEvent.click(prelabelButton);

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/admin/videos/dQw4w9WgXcQ/prelabel",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ image_ids: [1] }),
          }),
        ),
      );
    });

    it("disables the select checkbox, and labels as such, for a frame an earlier pass already sampled", async () => {
      // Routed rather than `mockResolvedValue`, since M19 (plan §A) gave this
      // page a second query: a blanket mock answers `/api/admin/videos/{id}`
      // with a frame page, and the header's own parse failure is then the
      // only thing this test sees.
      // `sampled: true` with a null reason is a state production cannot
      // produce — the boolean *is* `selection_reason !== null` — so the
      // fixture names a reason (M25.1). The subject here is still the
      // disabled checkbox; the caption assertion follows the text the tile
      // actually renders now.
      stubVideo({}, { images: [image({ sampled: true, selection_reason: "random" })] });

      renderPage();

      const selectCheckbox = await screen.findByRole("checkbox", {
        name: "select frame at 1s for prelabelling",
      });
      expect(selectCheckbox).toBeDisabled();
      expect(screen.getByText("sampled: random")).toBeInTheDocument();
    });

    it("queues a random draw with the typed count, distinct from the hand-picked request shape", async () => {
      const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/admin/videos/dQw4w9WgXcQ/prelabel") {
          return Promise.resolve(json(prelabelJob({ selection_reason: "random", images: 5 })));
        }
        return Promise.resolve(json(page()));
      });
      vi.stubGlobal("fetch", fetchMock);

      renderPage();

      const countInput = await screen.findByRole("spinbutton", {
        name: "how many un-sampled frames to randomise",
      });
      // `fireEvent.change` rather than `userEvent.clear` + `type`: the input
      // clamps an empty value to 1 on every keystroke (so the field can
      // never sit at "nothing typed yet" and silently send `count: NaN`),
      // and that same clamp fires mid-sequence on a keystroke-by-keystroke
      // `type`, turning a cleared field mid-edit into "1" a moment before
      // "5" is appended after it. One change event sets the whole value at
      // once, the way a real "5" keystroke into an empty, unclamped field
      // would look from the DOM's side.
      fireEvent.change(countInput, { target: { value: "5" } });

      await userEvent.click(screen.getByRole("button", { name: "Randomise un-sampled" }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/admin/videos/dQw4w9WgXcQ/prelabel",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ count: 5, strategy: "random" }),
          }),
        ),
      );
    });

    // M25, plan §A. The third draw, and the one whose request body decides
    // whether the frames land in train or in the permanently frozen eval
    // pool. The assertion that matters is `strategy: "diverse"` — a control
    // that silently sent `random` would look identical on screen, queue a
    // real job, and quietly add nothing to the training set at all.
    it("queues a diverse draw with the typed count, distinct from the random request shape", async () => {
      const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/admin/videos/dQw4w9WgXcQ/prelabel") {
          return Promise.resolve(json(prelabelJob({ selection_reason: "diverse", images: 40 })));
        }
        return Promise.resolve(json(page()));
      });
      vi.stubGlobal("fetch", fetchMock);

      renderPage();

      const countInput = await screen.findByRole("spinbutton", {
        name: "how many un-sampled frames to draw by pHash diversity",
      });
      fireEvent.change(countInput, { target: { value: "40" } });

      await userEvent.click(screen.getByRole("button", { name: "Diversify un-sampled" }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/admin/videos/dQw4w9WgXcQ/prelabel",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ count: 40, strategy: "diverse" }),
          }),
        ),
      );
    });

    // Each control names the split it writes into, because the split is
    // permanent and nothing on this page shows it after the fact. A colour
    // alone would not survive an operator who cannot see colour.
    it("names the split each draw lands in", async () => {
      stubVideo();
      renderPage();

      expect(await screen.findByText(/random draw → evaluation data/)).toBeInTheDocument();
      expect(screen.getByText(/pHash farthest-point → training data/)).toBeInTheDocument();
    });

    /**
     * M25.1. The grid is the only surface that can answer "which frames did
     * that diverse pass draw" — the verification queue orders by `images.id`
     * globally, so a freshly stamped set can sit behind hundreds of unrelated
     * frames and never come up.
     */
    describe("the selection_reason filter", () => {
      it("names the reason on the tile rather than only that it was sampled", async () => {
        stubVideo({}, { images: [image({ sampled: true, selection_reason: "diverse" })] });

        renderPage();

        expect(await screen.findByText("sampled: diverse")).toBeInTheDocument();
      });

      it("sends the chosen reason to the API", async () => {
        const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url.includes("/images")) return Promise.resolve(json(page()));
          if (url.startsWith("/api/admin/labelling/stats")) {
            return Promise.resolve(json(labellingStats(7)));
          }
          if (url.startsWith("/api/admin/jobs")) return Promise.resolve(json({ now: 0, jobs: [] }));
          return Promise.resolve(json(detail()));
        });
        vi.stubGlobal("fetch", fetchMock);

        renderPage();

        const select = await screen.findByLabelText("Show");
        fireEvent.change(select, { target: { value: "diverse" } });

        await waitFor(() =>
          expect(
            fetchMock.mock.calls.some(([input]) =>
              String(input).includes("selection_reason=diverse"),
            ),
          ).toBe(true),
        );
      });

      // Page 12 of 600 sampled frames is past the end of a filtered set of
      // 40, so keeping the offset would answer a filter click with an empty
      // grid — which reads as a broken filter rather than an exhausted page.
      it("resets to the first page when the filter changes", async () => {
        const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url.includes("/images")) return Promise.resolve(json(page({ total: 200 })));
          if (url.startsWith("/api/admin/labelling/stats")) {
            return Promise.resolve(json(labellingStats(7)));
          }
          if (url.startsWith("/api/admin/jobs")) return Promise.resolve(json({ now: 0, jobs: [] }));
          return Promise.resolve(json(detail()));
        });
        vi.stubGlobal("fetch", fetchMock);

        renderPage();

        await userEvent.click(await screen.findByRole("button", { name: /next/i }));
        await waitFor(() =>
          expect(fetchMock.mock.calls.some(([input]) => String(input).includes("offset=24"))).toBe(
            true,
          ),
        );

        fireEvent.change(screen.getByLabelText("Show"), { target: { value: "diverse" } });

        await waitFor(() =>
          expect(
            fetchMock.mock.calls.some(
              ([input]) =>
                String(input).includes("selection_reason=diverse") &&
                String(input).includes("offset=0"),
            ),
          ).toBe(true),
        );
      });

      // "No frames extracted for this video" is a claim about the video. An
      // operator told that about a video holding 2,685 frames would go
      // looking for a broken chunk job.
      it("blames the filter, not the video, for an empty filtered grid", async () => {
        stubVideo({}, { images: [], total: 0 });

        renderPage();

        fireEvent.change(await screen.findByLabelText("Show"), { target: { value: "diverse" } });

        expect(await screen.findByText("No frames match this filter.")).toBeInTheDocument();
      });
    });

    it("shows the verification pool's remaining count from labelling stats", async () => {
      const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("/api/admin/labelling/stats")) {
          return Promise.resolve(json(labellingStats(7)));
        }
        return Promise.resolve(json(page()));
      });
      vi.stubGlobal("fetch", fetchMock);

      renderPage();

      expect(await screen.findByText(/frames waiting for a ruling/)).toBeInTheDocument();
      expect(screen.getByText("7")).toBeInTheDocument();
    });
  });
});
