import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminDetectionPage } from "../../src/pages/admin/Detection";

/**
 * `/admin/detection` (M16, ROADMAP M16.6): prelabel coverage per video,
 * reusing `GET /api/admin/videos` rather than a route of its own — see
 * `AdminVideo`'s own comment in `schemas.ts` for why.
 */
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AdminDetectionPage />
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

describe("AdminDetectionPage", () => {
  it("tables frame count, sampled count, model and last-ran per video", async () => {
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
  });

  it("reports zero coverage honestly rather than hiding a video with none", async () => {
    // The whole reason `frames_sampled` exists separately from a prediction
    // count: a video the sampler has not reached yet must read as "0
    // sampled, no model, never" rather than being indistinguishable from a
    // fully covered one — ROADMAP M16's own "tells the truth" framing.
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

  it("says so when no video has been submitted", async () => {
    stubVideos([]);

    renderPage();

    expect(await screen.findByText(/no videos submitted yet/i)).toBeInTheDocument();
  });
});
