import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContributeVerify } from "../../src/components/ContributeVerify";

/**
 * The contributor mount (M20; rebuilt on `SwipeCard` in M24, plan §C).
 *
 * What is specific to this mount, beyond what `PublicVerify.test.tsx` and
 * `SwipeCard.test.tsx` already prove about the swipe interaction itself:
 * that it posts to `/api/contribute/*`, not `/api/admin/*` or
 * `/api/public/*`; that **adjust is gone** (M24 §C1, reversing M20 plan
 * §B4 — `VerificationCard.test.tsx`'s own "offers Adjust" assertion no
 * longer applies to this mount at all); that it walks a 20-frame batch one
 * frame at a time rather than fetching per frame; and that the M23
 * guarantees (one request per completed frame, never one per swipe) hold
 * here exactly as they do on `/demo`.
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

const box = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  class_id: 3,
  class_name: "Paimon",
  x_min: 0.1,
  y_min: 0.2,
  x_max: 0.5,
  y_max: 0.6,
  confidence: 0.87,
  prompt_version: "2026-08-08-a",
  model_id: "owlvit-base-patch32.onnx",
  ...over,
});

const image = (id: number, boxes = [box(id * 10)]) => ({
  id,
  video_id: "dQw4w9WgXcQ",
  r2_key: `frames/dQw4w9WgXcQ/0000${id}.000.jpg`,
  timestamp_seconds: id,
  url: `https://r2.example/frames/0000${id}.jpg?X-Amz-Signature=abc`,
  predictions: boxes,
});

function batch(over: Record<string, unknown> = {}) {
  return {
    images: [image(1)],
    url_mode: "signed",
    expires_at: 1_754_099_900,
    // Required-nullable on the wire since M25.1's keyset cursor: a fixture
    // omitting it fails the response schema, and the component then renders
    // nothing with no error to say why.
    next_cursor: null,
    remaining: 1,
    remaining_capped: false,
    ...over,
  };
}

function stubApi({
  batches = [batch()],
  post,
}: {
  batches?: unknown[];
  post?: () => Response;
} = {}) {
  const queue = [...batches];

  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return Promise.resolve(post?.() ?? json({ image_id: 1, verdicts: 1 }, 201));
    }
    if (url.startsWith("/api/contribute/batch")) {
      const body = queue.length > 1 ? queue.shift() : queue[0];
      return Promise.resolve(json(body));
    }
    return Promise.resolve(json({ error: `unexpected ${url}` }, 404));
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const postsTo = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
    .map(([url, init]) => [url, JSON.parse(((init as RequestInit).body as string) ?? "null")]);

afterEach(() => vi.unstubAllGlobals());

describe("ContributeVerify", () => {
  // The M25.1 bug this field exists to fix: the server caps its count at 500,
  // so a pool of 1,098 reported 500 and the UI rendered it as an exact number
  // that did not move for ~600 frames of swiping. A frozen counter reads as
  // broken, not as bounded.
  it("renders a capped pool count as a lower bound, not an exact number", async () => {
    stubApi({ batches: [batch({ remaining: 500, remaining_capped: true })] });

    render(wrap(<ContributeVerify />));

    expect(await screen.findByText("500+")).toBeInTheDocument();
  });

  it("renders an exact count plainly when the server did not cap it", async () => {
    stubApi({ batches: [batch({ remaining: 7 })] });

    render(wrap(<ContributeVerify />));

    expect(await screen.findByText("7")).toBeInTheDocument();
    expect(screen.queryByText("7+")).not.toBeInTheDocument();
  });

  it("offers no Adjust control — M24 §C1 dropped it, admin keeps it on /admin/verify", async () => {
    stubApi();

    render(wrap(<ContributeVerify />));
    await screen.findByRole("img");

    expect(screen.queryByRole("button", { name: /adjust/i })).not.toBeInTheDocument();
  });

  it("a completed frame posts once to /api/contribute, not /api/admin or /api/public", async () => {
    const fetchMock = stubApi({ batches: [batch({ images: [image(1, [box(10), box(11)])] })] });

    render(wrap(<ContributeVerify />));
    await screen.findByRole("img");

    await userEvent.click(screen.getByRole("button", { name: /^yes/i }));
    await userEvent.click(screen.getByRole("button", { name: /^no/i }));

    await waitFor(() =>
      expect(postsTo(fetchMock)).toEqual([
        [
          "/api/contribute/images/1/verdicts",
          {
            verdicts: [
              { prediction_id: 10, verdict: "accept" },
              { prediction_id: 11, verdict: "reject" },
            ],
          },
        ],
      ]),
    );

    // Two boxes ruled is two button presses, not two requests — the same
    // exactly-once guarantee `PublicVerify.test.tsx` proves for `/demo`.
    const postCount = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    ).length;
    expect(postCount).toBe(1);
  });

  it("walks the batch one frame at a time, client-side, with no request between frames", async () => {
    const fetchMock = stubApi({
      batches: [batch({ images: [image(1), image(2)], remaining: 2 })],
    });

    render(wrap(<ContributeVerify />));
    await screen.findByRole("img");
    expect(screen.getByRole("img")).toHaveAttribute("src", image(1).url);

    await userEvent.click(screen.getByRole("button", { name: /^yes/i }));

    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", image(2).url));

    // Advancing within an already-fetched batch is local state — only the
    // one initial batch fetch and the one verdict POST should have reached
    // the network (plan §C2's "no prefetch is needed").
    const batchRequests = fetchMock.mock.calls.filter(([url]) =>
      (url as string).startsWith("/api/contribute/batch"),
    );
    expect(batchRequests).toHaveLength(1);
  });

  /**
   * M26.6, plan §C: the walk reaches the terminal state on its own once the
   * pool is genuinely empty (the wrapped-repeat ending is its own test
   * below) — no "Next batch" click is part of the normal flow any more, so
   * this no longer drives one to get there. `next_cursor` on the empty
   * second page follows the real server's own invariant (`next_cursor` is
   * null exactly when `images` is empty), which is what makes this page the
   * one the seen-id guard reads as "nothing new," not "no next page."
   */
  it("reaches 'nothing left to verify' on its own once the pool empties, with no click between frames", async () => {
    const fetchMock = stubApi({
      batches: [
        batch({ next_cursor: 42 }),
        {
          images: [],
          url_mode: "signed",
          expires_at: 1,
          remaining: 0,
          remaining_capped: false,
          next_cursor: null,
        },
      ],
    });

    render(wrap(<ContributeVerify />));
    await screen.findByRole("img");

    await userEvent.click(screen.getByRole("button", { name: /^yes/i }));

    expect(await screen.findByText(/nothing left to verify/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /check again|next batch/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start over/i })).toBeInTheDocument();

    // Exactly the initial fetch and the one prefetch it triggered — nothing
    // looping, and nothing waiting on a click to happen.
    const batchRequests = fetchMock.mock.calls.filter(([url]) =>
      (url as string).startsWith("/api/contribute/batch"),
    );
    expect(batchRequests).toHaveLength(2);
  });

  /**
   * M26.6, plan §B: the second request must carry the first response's
   * `next_cursor` — this is the fix itself. Before it, `useContributeBatch`
   * never sent `cursor` at all (`useContributeBatch`'s own comment has the
   * full story), so this assertion is exactly what would have failed against
   * the pre-M26.6 client.
   */
  it("sends the previous page's next_cursor on the following request", async () => {
    const fetchMock = stubApi({
      batches: [
        batch({ next_cursor: 4_242 }),
        { ...batch({ images: [image(2)] }), next_cursor: null, remaining: 0 },
      ],
    });

    render(wrap(<ContributeVerify />));
    await screen.findByRole("img");

    await waitFor(() => {
      const batchRequests = fetchMock.mock.calls
        .map(([url]) => url as string)
        .filter((url) => url.startsWith("/api/contribute/batch"));
      expect(batchRequests).toHaveLength(2);
      expect(batchRequests[1]).toContain("cursor=4242");
    });
  });

  /**
   * M26.6, plan §C verification 5: the walk crosses a page boundary with no
   * click of its own — only the swipe/accept gestures that rule each frame.
   * The prefetch margin (5) is larger than this fixture's page size, so the
   * second page is already in hand by the time the walk needs it; a real
   * `CONTRIBUTE_BATCH_SIZE` (20) page just makes that gap wider, not
   * different in kind.
   */
  it("crosses a page boundary on its own — the frame after the last of page one is page two's first, no manual step", async () => {
    stubApi({
      batches: [
        batch({ images: [image(1), image(2)], remaining: 3, next_cursor: 99 }),
        { ...batch({ images: [image(3)] }), next_cursor: null, remaining: 1 },
      ],
    });

    render(wrap(<ContributeVerify />));
    await screen.findByRole("img");
    expect(screen.getByRole("img")).toHaveAttribute("src", image(1).url);

    await userEvent.click(screen.getByRole("button", { name: /^yes/i }));
    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", image(2).url));

    await userEvent.click(screen.getByRole("button", { name: /^yes/i }));
    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", image(3).url));

    expect(
      screen.queryByRole("button", { name: /check again|next batch/i }),
    ).not.toBeInTheDocument();
  });

  /**
   * M26.6, plan §C verification 6 — the untrusted contributor of plan §B
   * reproduced exactly: their own verdicts never remove a box from
   * `CONTRIBUTOR_UNRULED_BOX`, so once the cursor wraps, the pool hands the
   * same frames straight back. Without the seen-id guard this loops forever
   * (`next_cursor` never goes null while the pool holds anything); with it,
   * the repeat is read as "nothing new" and the walk stops instead.
   */
  it("terminates on a page that repeats every frame the session already walked, rather than looping", async () => {
    const fetchMock = stubApi({
      batches: [
        batch({ images: [image(1), image(2)], remaining: 5, next_cursor: 7 }),
        batch({ images: [image(1), image(2)], remaining: 5, next_cursor: 7 }),
      ],
    });

    render(wrap(<ContributeVerify />));
    await screen.findByRole("img");

    await userEvent.click(screen.getByRole("button", { name: /^yes/i }));
    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", image(2).url));
    await userEvent.click(screen.getByRole("button", { name: /^yes/i }));

    expect(
      await screen.findByText(/frames still waiting, but none new for this session/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start over/i })).toBeInTheDocument();

    // The repeating page was fetched exactly once, not retried in a loop.
    await waitFor(() => {
      const batchRequests = fetchMock.mock.calls
        .map(([url]) => url as string)
        .filter((url) => url.startsWith("/api/contribute/batch"));
      expect(batchRequests).toHaveLength(2);
    });
  });

  describe("the M23 guarantees hold on this mount too", () => {
    /** The whole-stage swipe surface — the element carrying the pointer handlers. */
    function stageSurface() {
      const img = screen.getByRole("img");
      const stage = img.parentElement?.parentElement as HTMLElement;
      stage.setPointerCapture = vi.fn();
      stage.hasPointerCapture = () => false;
      stage.releasePointerCapture = vi.fn();
      return stage;
    }

    async function swipe(stage: HTMLElement, points: Array<{ x: number; y: number }>) {
      const [first, ...rest] = points;
      if (!first) throw new Error("swipe() needs at least one point");
      await userEvent.pointer([
        { target: stage, coords: { clientX: first.x, clientY: first.y }, keys: "[MouseLeft>]" },
        ...rest.map((p) => ({ target: stage, coords: { clientX: p.x, clientY: p.y } })),
        { target: stage, keys: "[/MouseLeft]" },
      ]);
    }

    it("a gesture arcing ~52° off horizontal at its lock point still rules, once it clears the threshold", async () => {
      const fetchMock = stubApi();
      render(wrap(<ContributeVerify />));
      await screen.findByRole("img");
      const stage = stageSurface();

      await swipe(stage, [
        { x: 100, y: 100 }, // pointerdown
        { x: 110, y: 113 }, // +10,+13 — the steep early sample that decides the axis
        { x: 195, y: 130 }, // net dx=95 (past 72px), still well off a straight line
      ]);

      await waitFor(() =>
        expect(postsTo(fetchMock)).toEqual([
          [
            "/api/contribute/images/1/verdicts",
            { verdicts: [{ prediction_id: 10, verdict: "accept" }] },
          ],
        ]),
      );
    });
  });
});
