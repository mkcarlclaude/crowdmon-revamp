import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobList } from "../../src/components/JobList";

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

const NOW = 1_754_100_000;

function job(overrides: Record<string, unknown>) {
  return {
    id: 1,
    kind: "download",
    video_id: "dQw4w9WgXcQ",
    video_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    status: "pending",
    attempts: 0,
    claimed_by: null,
    claimed_at: null,
    heartbeat_at: null,
    failure_reason: null,
    created_at: NOW - 100,
    updated_at: NOW - 100,
    ...overrides,
  };
}

function stubJobs(jobs: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ now: NOW, jobs }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("JobList", () => {
  it("shows heartbeat age against the server clock, not the browser's", async () => {
    // The browser is deliberately an hour ahead. An age computed from
    // Date.now() would read 3630s and look like a dead worker.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date((NOW + 3600) * 1000));
    stubJobs([job({ status: "claimed", claimed_by: "carls-ubuntu-1", heartbeat_at: NOW - 30 })]);

    render(wrap(<JobList />));
    expect(await screen.findByText("30s ago")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("nests chunk jobs under the download job for the same video", async () => {
    stubJobs([
      job({
        id: 5,
        kind: "chunk",
        chunk: { segment_index: 1, start_seconds: 60, end_seconds: 120 },
      }),
      job({ id: 1, kind: "download" }),
    ]);

    render(wrap(<JobList />));
    // A <section> with an accessible name exposes the `region` role, not
    // `group`. Querying by role rather than by test id keeps the assertion tied
    // to what a screen reader would announce.
    const group = await screen.findByRole("region", { name: /dQw4w9WgXcQ/ });
    expect(within(group).getByText(/segment 1/i)).toBeInTheDocument();
  });

  it("shows the failure reason on a failed job", async () => {
    stubJobs([job({ status: "failed", attempts: 3, failure_reason: "video unavailable" })]);

    render(wrap(<JobList />));
    expect(await screen.findByText("video unavailable")).toBeInTheDocument();
  });

  it("renders a never-claimed job without inventing an age", async () => {
    stubJobs([job({ status: "pending", heartbeat_at: null })]);

    render(wrap(<JobList />));
    expect(await screen.findByText("never")).toBeInTheDocument();
  });

  it("says so when the queue is empty", async () => {
    stubJobs([]);

    render(wrap(<JobList />));
    expect(await screen.findByText(/no jobs yet/i)).toBeInTheDocument();
  });
});
