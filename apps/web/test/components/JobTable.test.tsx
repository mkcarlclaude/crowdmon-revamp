import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobTable } from "../../src/components/JobTable";

/**
 * `/admin/queue`'s table (M19, plan §C): replaces `JobList.test.tsx`, and
 * asserts exactly what that grouped component could not — a `snapshot` job
 * rendering at all, `prelabel`/`dryrun` each carrying their own kind label,
 * and a status chip actually changing the fetched URL.
 */
function wrap(videoId = "dQw4w9WgXcQ") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/admin/videos/${videoId}`]}>
        <JobTable />
      </MemoryRouter>
    </QueryClientProvider>
  );
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubJobs(jobs: unknown[]) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ now: NOW, jobs })));
}

afterEach(() => vi.unstubAllGlobals());

describe("JobTable", () => {
  it("shows a snapshot job, which the old grouped list dropped for carrying no video", async () => {
    // Migration 0008, M15.1: a snapshot job's own video_id is null, which is
    // exactly the row JobList's group-by-video tree had nowhere to put.
    stubJobs([job({ kind: "snapshot", video_id: null, video_url: null })]);

    render(wrap());

    expect(await screen.findByText("snapshot")).toBeInTheDocument();
    // No video link for a job that names none — the video column falls back
    // to a plain dash rather than a `Link` to nowhere.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("labels a prelabel job and a dryrun job with their own kind, not a nameless row", async () => {
    stubJobs([job({ id: 1, kind: "prelabel" }), job({ id: 2, kind: "dryrun" })]);

    render(wrap());

    expect(await screen.findByText("prelabel")).toBeInTheDocument();
    expect(screen.getByText("dry-run")).toBeInTheDocument();
  });

  it("shows heartbeat age against the server clock, not the browser's", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date((NOW + 3600) * 1000));
    stubJobs([job({ status: "claimed", claimed_by: "carls-ubuntu-1", heartbeat_at: NOW - 30 })]);

    render(wrap());
    expect(await screen.findByText("30s ago")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("links a job's video to its detail page", async () => {
    stubJobs([job({ video_id: "dQw4w9WgXcQ" })]);

    render(wrap());

    expect(await screen.findByRole("link", { name: "dQw4w9WgXcQ" })).toHaveAttribute(
      "href",
      "/admin/videos/dQw4w9WgXcQ",
    );
  });

  it("shows the failure reason on a failed job", async () => {
    stubJobs([job({ status: "failed", attempts: 3, failure_reason: "video unavailable" })]);

    render(wrap());
    expect(await screen.findByText("video unavailable")).toBeInTheDocument();
  });

  it("says so when the queue is empty", async () => {
    stubJobs([]);

    render(wrap());
    expect(await screen.findByText(/no jobs/i)).toBeInTheDocument();
  });

  it("changes the fetched URL when a status chip is clicked", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ now: NOW, jobs: [] }));
    vi.stubGlobal("fetch", fetchMock);

    render(wrap());
    await screen.findByText(/no jobs/i);

    await userEvent.click(screen.getByRole("button", { name: "Pending" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/jobs?status=pending", expect.anything());
  });

  it("fetches with no status param on the default All chip", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ now: NOW, jobs: [] }));
    vi.stubGlobal("fetch", fetchMock);

    render(wrap());
    await screen.findByText(/no jobs/i);

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/jobs", expect.anything());
  });
});
