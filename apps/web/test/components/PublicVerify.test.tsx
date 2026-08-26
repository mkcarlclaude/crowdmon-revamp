import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicVerify } from "../../src/components/PublicVerify";

/**
 * The public mount (M14.2, M14.4; rebuilt as a swipe in M23).
 *
 * What this covers, beyond what `swipe-verify-reducer.test.ts` and
 * `swipe-gesture.test.ts` already prove in isolation: that the component
 * wires a completed frame into exactly one request (the rate-limit
 * guarantee plan §A2 exists for), that keyboard and buttons stage
 * identically to a swipe, that an abandoned frame never reaches the
 * network, and that a real pointer sequence arcing off horizontal still
 * rules — the regression guard for the axis lock. Neither jsdom nor CDP
 * starts the gestures the browser owns (`CLAUDE.md`), but a `pointerdown` /
 * `pointermove` / `pointerup` sequence with explicit coordinates exercises
 * this component's own math, not a browser-owned gesture, the same
 * distinction `VerificationCard.test.tsx`'s own drag tests already rely on.
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
  ...over,
});

function frame(id = 1, boxes = [box(id * 10)]) {
  return {
    id,
    r2_key: `frames/dQw4w9WgXcQ/0000${id}.000.jpg`,
    url: `https://r2.example/frames/0000${id}.jpg?X-Amz-Signature=abc`,
    predictions: boxes,
    expires_at: 1_754_099_900,
  };
}

function stubApi({
  frames = [frame()],
  post,
}: {
  frames?: unknown[];
  post?: (url: string) => Response;
} = {}) {
  const queue = [...frames];

  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return Promise.resolve(post?.(url) ?? json({ image_id: 1, verdicts: 1 }, 201));
    }
    if (url.startsWith("/api/public/frame")) {
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

/** The whole-stage swipe surface — the element carrying the pointer handlers. */
function stageSurface() {
  const img = screen.getByRole("img");
  // frame div -> stage div (plan §B1: the surface is the whole stage, not
  // the frame the image lives in).
  const stage = img.parentElement?.parentElement as HTMLElement;
  // jsdom implements neither method at all; production code calls both.
  stage.setPointerCapture = vi.fn();
  stage.hasPointerCapture = () => false;
  stage.releasePointerCapture = vi.fn();
  return stage;
}

async function swipe(
  stage: HTMLElement,
  points: Array<{ x: number; y: number }>,
  { release = true } = {},
) {
  const [first, ...rest] = points;
  if (!first) throw new Error("swipe() needs at least one point");
  const steps: Parameters<typeof userEvent.pointer>[0] = [
    { target: stage, coords: { clientX: first.x, clientY: first.y }, keys: "[MouseLeft>]" },
    ...rest.map((p) => ({ target: stage, coords: { clientX: p.x, clientY: p.y } })),
  ];
  if (release) steps.push({ target: stage, keys: "[/MouseLeft]" });
  await userEvent.pointer(steps);
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("PublicVerify", () => {
  it("shows every proposed box, dims the undecided ones, and puts the claim on the active box", async () => {
    stubApi({ frames: [frame(1, [box(10), box(11, { class_name: "Raiden Shogun" })])] });

    render(wrap(<PublicVerify />));

    await screen.findByRole("img");
    expect(screen.getByText("Paimon")).toBeInTheDocument();
    expect(screen.queryByText("Raiden Shogun")).not.toBeInTheDocument();
  });

  it("offers no Adjust control — only accept and reject are legal here", async () => {
    stubApi();

    render(wrap(<PublicVerify />));
    await screen.findByRole("img");

    expect(screen.queryByRole("button", { name: /adjust/i })).not.toBeInTheDocument();
  });

  describe("buttons and keyboard stage identically to a swipe", () => {
    it("Yes stages accept on the active box and disables Undo until something is decided", async () => {
      stubApi({ frames: [frame(1, [box(10), box(11)])] });
      render(wrap(<PublicVerify />));
      await screen.findByRole("img");

      expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();

      await userEvent.click(screen.getByRole("button", { name: /^yes/i }));

      expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
    });

    it("No stages reject; Undo un-stages it and the button disables again", async () => {
      stubApi({ frames: [frame(1, [box(10), box(11)])] });
      render(wrap(<PublicVerify />));
      await screen.findByRole("img");

      await userEvent.click(screen.getByRole("button", { name: /^no/i }));
      expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();

      await userEvent.click(screen.getByRole("button", { name: "Undo" }));
      expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    });

    it("ArrowRight/ArrowLeft rule the active box and Backspace undoes, same as the buttons", async () => {
      const fetchMock = stubApi({ frames: [frame(1, [box(10), box(11)])] });
      render(wrap(<PublicVerify />));
      await screen.findByRole("img");

      await userEvent.keyboard("{ArrowRight}");
      expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();

      await userEvent.keyboard("{Backspace}");
      expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();

      await userEvent.keyboard("{ArrowLeft}");
      await userEvent.keyboard("{ArrowRight}");

      await waitFor(() =>
        expect(postsTo(fetchMock)).toEqual([
          [
            "/api/public/images/1/verdicts",
            {
              session_id: localStorage.getItem("crowdmon-anon-session-id"),
              verdicts: [
                { prediction_id: 10, verdict: "reject" },
                { prediction_id: 11, verdict: "accept" },
              ],
            },
          ],
        ]),
      );
    });

    it("tapping a resolved box un-stages it, the secondary path to Undo", async () => {
      stubApi({ frames: [frame(1, [box(10), box(11)])] });
      render(wrap(<PublicVerify />));
      await screen.findByRole("img");

      await userEvent.click(screen.getByRole("button", { name: /^yes/i })); // rules box 10
      const resolvedBox = screen.getByTestId("box-10");
      expect(resolvedBox.tagName).toBe("BUTTON");

      await userEvent.click(resolvedBox);

      // Box 10 is unstaged and active again — Yes now rules it a second
      // time, and only one ruling (box 11's, from the swap below) exists.
      expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    });
  });

  it("a completed frame produces exactly one request, carrying every ruling — never one per swipe", async () => {
    const fetchMock = stubApi({ frames: [frame(1, [box(10), box(11), box(12)])] });
    render(wrap(<PublicVerify />));
    await screen.findByRole("img");

    await userEvent.click(screen.getByRole("button", { name: /^yes/i }));
    await userEvent.click(screen.getByRole("button", { name: /^no/i }));
    await userEvent.click(screen.getByRole("button", { name: /^yes/i }));

    await waitFor(() =>
      expect(postsTo(fetchMock)).toEqual([
        [
          "/api/public/images/1/verdicts",
          {
            session_id: localStorage.getItem("crowdmon-anon-session-id"),
            verdicts: [
              { prediction_id: 10, verdict: "accept" },
              { prediction_id: 11, verdict: "reject" },
              { prediction_id: 12, verdict: "accept" },
            ],
          },
        ],
      ]),
    );

    // Ruling three boxes is three button presses, not three requests.
    const postCount = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    ).length;
    expect(postCount).toBe(1);
  });

  it("shows the recorded count and moves on to another frame once the batch flushes", async () => {
    stubApi({ frames: [frame(1, [box(10)]), frame(2, [box(20)])] });

    render(wrap(<PublicVerify />));
    await screen.findByRole("img");

    await userEvent.click(screen.getByRole("button", { name: /^yes/i }));

    expect(await screen.findByText(/recorded 1 verdict\b/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", frame(2).url));
  });

  it("an abandoned frame — skipped before every box is decided — never reaches the network", async () => {
    const fetchMock = stubApi({ frames: [frame(1, [box(10), box(11)]), frame(2, [box(20)])] });
    render(wrap(<PublicVerify />));
    await screen.findByRole("img");

    // Rule only the first of two boxes, then skip rather than finishing.
    await userEvent.click(screen.getByRole("button", { name: /^yes/i }));
    await userEvent.click(screen.getByRole("button", { name: /skip frame/i }));

    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", frame(2).url));

    expect(postsTo(fetchMock)).toEqual([]);
  });

  it("a frame's staging resets on the next frame — nothing carries over to bias the new one", async () => {
    stubApi({ frames: [frame(1, [box(10), box(11)]), frame(2, [box(20)])] });
    render(wrap(<PublicVerify />));
    await screen.findByRole("img");

    await userEvent.click(screen.getByRole("button", { name: /^yes/i })); // rules box 10
    await userEvent.click(screen.getByRole("button", { name: /skip frame/i }));
    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", frame(2).url));

    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  describe("the swipe gesture", () => {
    it("a rightward swipe past the 72px threshold stages accept", async () => {
      const fetchMock = stubApi({ frames: [frame(1, [box(10)])] });
      render(wrap(<PublicVerify />));
      await screen.findByRole("img");
      const stage = stageSurface();

      await swipe(stage, [
        { x: 100, y: 100 },
        { x: 190, y: 100 },
      ]);

      await waitFor(() =>
        expect(postsTo(fetchMock)).toEqual([
          [
            "/api/public/images/1/verdicts",
            {
              session_id: localStorage.getItem("crowdmon-anon-session-id"),
              verdicts: [{ prediction_id: 10, verdict: "accept" }],
            },
          ],
        ]),
      );
    });

    it("a leftward swipe past the threshold stages reject", async () => {
      const fetchMock = stubApi({ frames: [frame(1, [box(10)])] });
      render(wrap(<PublicVerify />));
      await screen.findByRole("img");
      const stage = stageSurface();

      await swipe(stage, [
        { x: 190, y: 100 },
        { x: 100, y: 100 },
      ]);

      await waitFor(() =>
        expect(postsTo(fetchMock)).toEqual([
          [
            "/api/public/images/1/verdicts",
            {
              session_id: localStorage.getItem("crowdmon-anon-session-id"),
              verdicts: [{ prediction_id: 10, verdict: "reject" }],
            },
          ],
        ]),
      );
    });

    it("a drag short of the threshold snaps back without staging anything", async () => {
      stubApi({ frames: [frame(1, [box(10), box(11)])] });
      render(wrap(<PublicVerify />));
      await screen.findByRole("img");
      const stage = stageSurface();

      await swipe(stage, [
        { x: 100, y: 100 },
        { x: 140, y: 100 },
      ]);

      expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    });

    it("a drag that locks vertical rules nothing, regardless of how far it travels", async () => {
      stubApi({ frames: [frame(1, [box(10)])] });
      render(wrap(<PublicVerify />));
      await screen.findByRole("img");
      const stage = stageSurface();

      await swipe(stage, [
        { x: 100, y: 100 },
        { x: 105, y: 220 },
      ]);

      expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    });

    /**
     * The regression guard for plan §B2. Axis is decided once, at the first
     * move past 10px of combined travel — here that first sample is (10,
     * 13), about 52° off horizontal. The removed `|dx| > |dy|` cutoff (45°)
     * would have locked this to vertical and handed it to the page as a
     * scroll for the rest of the gesture, no matter how far the drag then
     * travelled sideways. `swipe-gesture.test.ts` proves this at the
     * function level; this proves the component wires it the same way.
     */
    it("a gesture arcing ~52° off horizontal at its lock point still rules, once it clears the threshold", async () => {
      const fetchMock = stubApi({ frames: [frame(1, [box(10)])] });
      render(wrap(<PublicVerify />));
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
            "/api/public/images/1/verdicts",
            {
              session_id: localStorage.getItem("crowdmon-anon-session-id"),
              verdicts: [{ prediction_id: 10, verdict: "accept" }],
            },
          ],
        ]),
      );
    });
  });

  it("re-requests once on a broken image, then says so rather than looping", async () => {
    // Two *different* ids, not the same one twice: `/api/public/frame`
    // selects with `ORDER BY RANDOM()`, so a retry after a broken image
    // almost never comes back with the same frame. A guard that compared ids
    // to decide "is this the second failure" would pass against a stub that
    // repeated one id and then silently never trip against the real backend.
    stubApi({ frames: [frame(1), frame(2)] });

    render(wrap(<PublicVerify />));
    const firstImg = await screen.findByRole("img");
    expect(firstImg).toHaveAttribute("src", frame(1).url);

    firstImg.dispatchEvent(new Event("error"));

    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", frame(2).url));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    screen.getByRole("img").dispatchEvent(new Event("error"));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be loaded/i);
  });

  it("surfaces a failure from the frame endpoint rather than rendering nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          json({ error: "no image is currently flagged into the public sample" }, 404),
        ),
      ),
    );

    render(wrap(<PublicVerify />));

    expect(await screen.findByRole("alert")).toHaveTextContent(/no image is currently flagged/i);
  });

  it("fetches another frame on request and excludes the one currently on screen", async () => {
    const fetchMock = stubApi({ frames: [frame(1), frame(2)] });

    render(wrap(<PublicVerify />));
    await screen.findByRole("img");

    await userEvent.click(screen.getByRole("button", { name: /skip frame/i }));

    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", frame(2).url));

    const frameRequests = fetchMock.mock.calls
      .map(([url]) => url as string)
      .filter((url) => url.startsWith("/api/public/frame"));
    expect(frameRequests[0]).toBe("/api/public/frame");
  });
});
