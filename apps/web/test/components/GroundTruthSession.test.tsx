import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroundTruthSession } from "../../src/components/GroundTruthSession";

/**
 * The annotation mount (M26.5).
 *
 * What is under test is everything `GroundTruthCard` deliberately does not
 * know: which frame is current, that the worklist is the *unfinished* half of
 * the pool, and — the reason this file exists — that marking a frame does not
 * move the walk. Under `unmarked=true` a mark shortens the array the pool
 * query returns, so a session that rendered `pool.data.images` directly would
 * shift every later index and throw the annotator onto a different frame on
 * the very action meant to advance them. That failure needs a mark, a
 * background refetch, and a look at what is on screen afterwards — none of
 * which a static render shows.
 */

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const poolImage = (id: number) => ({
  id,
  video_id: "F1snt1pXqQc",
  r2_key: `frames/F1snt1pXqQc/0000${id}.000.jpg`,
  timestamp_seconds: id,
  ground_truth_count: 0,
  classes: [{ class_id: 3, name: "Paimon", exhaustive: false }],
});

const annotation = (id: number) => ({
  image_id: id,
  video_id: "F1snt1pXqQc",
  timestamp_seconds: id,
  r2_key: `frames/F1snt1pXqQc/0000${id}.000.jpg`,
  url: `https://r2.example/frames/0000${id}.jpg?X-Amz-Signature=abc`,
  predictions: [],
  ground_truth: [],
  classes: [{ class_id: 3, name: "Paimon", exhaustive: false }],
});

/**
 * Routes a stubbed fetch by path. `pools` is consumed in order so a test can
 * say what the *second* pool request answers — which is how both the
 * mark-shortens-the-list case and the next-batch case are set up.
 */
function stubApi({ pools }: { pools: unknown[] }) {
  const queue = [...pools];
  const poolUrls: string[] = [];

  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "POST" || init?.method === "PATCH" || init?.method === "DELETE") {
      return Promise.resolve(json({ image_id: 1, class_id: 3, exhaustive: true }, 200));
    }
    if (url.startsWith("/api/admin/ground-truth/pool")) {
      poolUrls.push(url);
      return Promise.resolve(json(queue.length > 1 ? queue.shift() : queue[0]));
    }
    const id = Number(url.match(/\/images\/(\d+)\//)?.[1] ?? 1);
    return Promise.resolve(json(annotation(id)));
  });

  vi.stubGlobal("fetch", fetchMock);
  return { poolUrls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GroundTruthSession", () => {
  it("asks for the unfinished half of the worklist, not the whole pool", async () => {
    const { poolUrls } = stubApi({ pools: [{ images: [poolImage(1)], total: 1 }] });

    render(wrap(<GroundTruthSession />));
    await screen.findByText(/1 \/ 1/);

    expect(poolUrls[0]).toContain("unmarked=true");
  });

  it("reports how much unfinished work is left pool-wide, not just in this batch", async () => {
    stubApi({ pools: [{ images: [poolImage(1), poolImage(2)], total: 237 }] });

    render(wrap(<GroundTruthSession />));

    expect(await screen.findByText(/237/)).toBeInTheDocument();
  });

  it("keeps the walk on the same frame when a mark shortens the pool underneath it", async () => {
    // The second pool response is what an `unmarked=true` refetch returns
    // after image 1 is marked: a *shorter* list, missing the frame that was
    // just finished. Reading `pool.data.images` directly, index 1 would slide
    // from image 2 onto image 3.
    stubApi({
      pools: [
        { images: [poolImage(1), poolImage(2), poolImage(3)], total: 3 },
        { images: [poolImage(2), poolImage(3)], total: 2 },
      ],
    });

    render(wrap(<GroundTruthSession />));
    await screen.findByText(/1 \/ 3/);

    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/2 \/ 3/)).toBeInTheDocument();
    const before = screen.getByText(/@ 2s/);

    await userEvent.click(screen.getByRole("button", { name: /every instance found/i }));

    // The frame on screen is still image 2 — same position, same batch length
    // — however many times the pool query settles in the background.
    await waitFor(() => expect(screen.getByText(/2 \/ 3/)).toBeInTheDocument());
    expect(before).toBeInTheDocument();
  });

  it("fetches the next batch at the end of the current one and restarts at its first frame", async () => {
    stubApi({
      pools: [
        { images: [poolImage(1)], total: 2 },
        { images: [poolImage(9)], total: 1 },
      ],
    });

    render(wrap(<GroundTruthSession />));
    await screen.findByText(/1 \/ 1/);

    await userEvent.click(screen.getByRole("button", { name: "Next batch" }));

    expect(await screen.findByText(/@ 9s/)).toBeInTheDocument();
    expect(screen.getByText(/1 \/ 1/)).toBeInTheDocument();
  });

  it("says the sitting is finished when a batch comes back empty, not that the pool is empty", async () => {
    stubApi({ pools: [{ images: [], total: 0 }] });

    render(wrap(<GroundTruthSession />));

    expect(await screen.findByText(/nothing left to do/i)).toBeInTheDocument();
  });
});
