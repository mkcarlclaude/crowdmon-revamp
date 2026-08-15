import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminVideosPage } from "../../src/pages/admin/Videos";

/**
 * `/admin/videos` (M16; M19, plan §B): submit form, then the video table
 * `/admin/detection` used to own — table assertions moved from the deleted
 * `AdminDetection.test.tsx`, plus the "Submitted" column §B1 adds. Before
 * M19 this page had no test of its own; it was covered incidentally by
 * `JobList.test.tsx` and `SubmitForm.test.tsx`, and §C removes the first of
 * those.
 */
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AdminVideosPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function stubVideos(videos: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ videos }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("AdminVideosPage", () => {
  it("mounts the submit form above the video table", async () => {
    stubVideos([]);

    renderPage();

    expect(screen.getByLabelText(/youtube url/i)).toBeInTheDocument();
    expect(await screen.findByText(/no videos submitted yet/i)).toBeInTheDocument();
  });

  it("tables frame count, sampled count, model, last-ran and submitted-at per video", async () => {
    stubVideos([
      {
        id: "dQw4w9WgXcQ",
        title: "Archon quest",
        image_count: 2685,
        created_at: 1_754_099_000,
        frames_sampled: 200,
        model_id: "owlvit-base-patch32.onnx",
        prelabelled_at: 1_754_099_500,
      },
    ]);

    renderPage();

    expect(await screen.findByText("Archon quest")).toBeInTheDocument();
    expect(screen.getByText("2685")).toBeInTheDocument();
    expect(screen.getByText("200")).toBeInTheDocument();
    expect(screen.getByText("owlvit-base-patch32.onnx")).toBeInTheDocument();
    // The one column §B1 adds: `created_at`, formatted the same way
    // `prelabelled_at`'s "last ran" column already was.
    expect(screen.getByText(new Date(1_754_099_000 * 1000).toLocaleString())).toBeInTheDocument();
  });

  it("reports zero coverage honestly rather than hiding a video with none", async () => {
    // The whole reason `frames_sampled` exists separately from a prediction
    // count: a video the sampler has not reached yet must read as "0
    // sampled, no model, never" rather than being indistinguishable from a
    // fully covered one — the same "tells the truth" framing ROADMAP M16
    // gives, carried into this table's new home.
    stubVideos([
      {
        id: "freshvideo1",
        title: null,
        image_count: 40,
        created_at: 1_754_099_000,
        frames_sampled: 0,
        model_id: null,
        prelabelled_at: null,
      },
    ]);

    renderPage();

    // No title: falls back to the video id, matching the dry-run picker's
    // own `candidate.title ?? candidate.id`.
    expect(await screen.findByText("freshvideo1")).toBeInTheDocument();
    expect(screen.getByText("never")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("does not mount a queue or a session-expiry banner — both moved to /admin/queue", async () => {
    // M19, plan §B1: `useVideos()` carries no `refetchInterval`, so a banner
    // on this page could never actually catch a session expiring mid-visit —
    // the polling, and therefore `SessionExpiredBanner`, now lives on
    // `/admin/queue` instead.
    stubVideos([]);

    renderPage();

    await screen.findByText(/no videos submitted yet/i);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
