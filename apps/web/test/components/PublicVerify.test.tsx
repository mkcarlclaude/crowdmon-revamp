import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicVerify } from "../../src/components/PublicVerify";

/**
 * The public mount (M14.2, M14.4).
 *
 * What is under test here is what `LabellingSession`'s own tests cover for
 * the admin tier, minus the batch: there is one frame at a time from a pool
 * that never drains, so what this component owns is fetching the next one —
 * on submit, on a broken image, and on request — not paging through several.
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

const box = (id: number) => ({
  id,
  class_id: 3,
  class_name: "Paimon",
  x_min: 0.1,
  y_min: 0.2,
  x_max: 0.5,
  y_max: 0.6,
  confidence: 0.87,
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

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("PublicVerify", () => {
  it("posts a ruling with the visitor's session id and never an admin identity", async () => {
    const fetchMock = stubApi();

    render(wrap(<PublicVerify />));
    await userEvent.click(await screen.findByRole("button", { name: /accept paimon/i }));
    await userEvent.click(screen.getByRole("button", { name: /^submit/i }));

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

  it("shows the recorded count immediately and moves on to another frame", async () => {
    stubApi({ frames: [frame(1), frame(2)] });

    render(wrap(<PublicVerify />));
    await userEvent.click(await screen.findByRole("button", { name: /accept paimon/i }));
    await userEvent.click(screen.getByRole("button", { name: /^submit/i }));

    expect(await screen.findByText(/recorded 1 verdict\b/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", frame(2).url));
  });

  it("offers no Adjust button — only accept and reject are legal here", async () => {
    stubApi();

    render(wrap(<PublicVerify />));
    await screen.findByRole("img");

    expect(screen.queryByRole("button", { name: /adjust/i })).not.toBeInTheDocument();
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

    // The retry swaps in a different frame — VerificationCard remounts under
    // its `key={data.id}`, so this is a new element, not the one above.
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

  it("fetches another frame on request", async () => {
    const fetchMock = stubApi({ frames: [frame(1), frame(2)] });

    render(wrap(<PublicVerify />));
    await screen.findByRole("img");

    await userEvent.click(screen.getByRole("button", { name: /skip to another frame/i }));

    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", frame(2).url));
    expect(
      fetchMock.mock.calls.filter(([url]) => (url as string).startsWith("/api/public/frame")),
    ).toHaveLength(2);
  });

  /**
   * `exclude` (M18, plan §C): `usePublicFrame`'s own comment explains the
   * mechanism — `nextFrame()` triggers a refetch, and the refetch's `queryFn`
   * reads the still-cached previous frame's id off the query client at the
   * moment it runs, before the new response replaces it.
   */
  it("asks the API to exclude the frame currently on screen when moving to another one", async () => {
    const fetchMock = stubApi({ frames: [frame(1), frame(2)] });

    render(wrap(<PublicVerify />));
    await screen.findByRole("img");

    await userEvent.click(screen.getByRole("button", { name: /skip to another frame/i }));
    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", frame(2).url));

    const frameRequests = fetchMock.mock.calls
      .map(([url]) => url as string)
      .filter((url) => url.startsWith("/api/public/frame"));

    expect(frameRequests[0]).toBe("/api/public/frame");
    expect(frameRequests[1]).toBe("/api/public/frame?exclude=1");
  });

  it("does not exclude anything on the very first load — there is nothing on screen yet", async () => {
    const fetchMock = stubApi();

    render(wrap(<PublicVerify />));
    await screen.findByRole("img");

    const frameRequests = fetchMock.mock.calls
      .map(([url]) => url as string)
      .filter((url) => url.startsWith("/api/public/frame"));

    expect(frameRequests).toEqual(["/api/public/frame"]);
  });
});
