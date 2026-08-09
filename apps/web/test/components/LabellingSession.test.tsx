import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LabellingSession } from "../../src/components/LabellingSession";

/**
 * The admin mount (M13.1, M13.4).
 *
 * What is under test here is everything `VerificationCard` deliberately does
 * not know: which frame is current, when a frame is finished, when to ask for
 * more, and what to do when a presigned URL has expired underneath the
 * operator.
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

const box = (id: number, className = "Paimon") => ({
  id,
  class_id: 3,
  class_name: className,
  x_min: 0.1,
  y_min: 0.2,
  x_max: 0.5,
  y_max: 0.6,
  confidence: 0.87,
  prompt_version: "2026-08-08-a",
  model_id: "owlvit-base-patch32.onnx",
});

const image = (id: number, boxes = [box(id * 10)]) => ({
  id,
  video_id: "dQw4w9WgXcQ",
  r2_key: `frames/dQw4w9WgXcQ/0000${id}.000.jpg`,
  timestamp_seconds: id,
  url: `https://r2.example/frames/0000${id}.jpg?X-Amz-Signature=abc`,
  predictions: boxes,
  public_sample: false,
});

function batch(over: Record<string, unknown> = {}) {
  return {
    images: [image(1)],
    url_mode: "signed",
    expires_at: 1_754_099_900,
    remaining: 1,
    ...over,
  };
}

/**
 * The default POST answer. A real submission result rather than `{ ok: true }`,
 * because `apiFetch` parses every response against the contract — a stub that
 * only looked plausible would fail at the boundary, which is `client.ts` doing
 * exactly what it is for.
 */
const writtenVerdicts = { image_id: 1, verdicts: 1 };

const CLASSES = {
  classes: [
    {
      id: 3,
      name: "Paimon",
      appearance_prompt: "a small white-haired floating companion",
      prompt_version: "2026-08-08-a",
      active: true,
      created_at: 1_754_099_000,
      updated_at: 1_754_099_000,
    },
  ],
};

/**
 * Routes a stubbed fetch by path. `batches` is consumed in order so a test can
 * say what the *second* request answers — which is the whole subject of the
 * expiry and next-batch cases.
 */
function stubApi({
  batches = [batch()],
  post,
  patch,
  holdBatchAfterFirst = false,
}: {
  batches?: unknown[];
  post?: (url: string) => Response;
  patch?: (url: string, body: unknown) => Response;
  /**
   * Holds every batch response after the first until `releaseBatch` is called,
   * so a test can look at the screen *while* a refetch is in flight. That
   * window is where a session that cleared its local state too early shows the
   * batch it just finished with live buttons on it.
   */
  holdBatchAfterFirst?: boolean;
} = {}) {
  const queue = [...batches];
  const held: Array<() => void> = [];
  let served = 0;

  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return Promise.resolve(post?.(url) ?? json(writtenVerdicts, 201));
    }
    if (init?.method === "PATCH") {
      const body = JSON.parse((init.body as string) ?? "null");
      return Promise.resolve(
        patch?.(url, body) ??
          json({ id: Number(url.match(/\/images\/(\d+)\//)?.[1]), ...body }, 200),
      );
    }
    if (url.startsWith("/api/admin/labelling/batch")) {
      const body = queue.length > 1 ? queue.shift() : queue[0];
      served += 1;

      if (holdBatchAfterFirst && served > 1) {
        return new Promise<Response>((resolve) => held.push(() => resolve(json(body))));
      }
      return Promise.resolve(json(body));
    }
    if (url.startsWith("/api/admin/labelling/stats")) {
      return Promise.resolve(
        json({
          pool: {
            images_with_predictions: 1,
            images_verified: 0,
            images_remaining: 1,
            missing_reports: 0,
          },
          classes: [],
        }),
      );
    }
    if (url.startsWith("/api/admin/classes")) return Promise.resolve(json(CLASSES));
    return Promise.resolve(json({ error: `unexpected ${url}` }, 404));
  });

  vi.stubGlobal("fetch", fetchMock);
  return Object.assign(fetchMock, {
    releaseBatch: () => {
      for (const release of held.splice(0)) release();
    },
  });
}

const postsTo = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
    .map(([url, init]) => [url, JSON.parse(((init as RequestInit).body as string) ?? "null")]);

afterEach(() => vi.unstubAllGlobals());

describe("LabellingSession", () => {
  it("posts the frame's staged rulings as one request", async () => {
    // One call per frame, not one per box. The staging area is what makes that
    // possible, and it is also what keeps the frame still while it is judged.
    const fetchMock = stubApi({
      batches: [batch({ images: [image(1, [box(10), box(11, "Nahida")])] })],
    });

    render(wrap(<LabellingSession />));
    await userEvent.click(await screen.findByRole("button", { name: /accept paimon/i }));
    await userEvent.click(screen.getByRole("button", { name: /reject nahida/i }));

    expect(postsTo(fetchMock)).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: /^submit/i }));

    await waitFor(() =>
      expect(postsTo(fetchMock)).toEqual([
        [
          "/api/admin/images/1/verdicts",
          {
            verdicts: [
              { prediction_id: 10, verdict: "accept" },
              { prediction_id: 11, verdict: "reject" },
            ],
          },
        ],
      ]),
    );
  });

  it("moves to the next frame once every box on this one is ruled on", async () => {
    stubApi({ batches: [batch({ images: [image(1), image(2)], remaining: 2 })] });

    render(wrap(<LabellingSession />));
    expect(await screen.findByRole("img")).toHaveAttribute(
      "alt",
      "frames/dQw4w9WgXcQ/00001.000.jpg",
    );

    await userEvent.click(screen.getByRole("button", { name: /accept paimon/i }));
    await userEvent.click(screen.getByRole("button", { name: /^submit/i }));

    await waitFor(() =>
      expect(screen.getByRole("img")).toHaveAttribute("alt", "frames/dQw4w9WgXcQ/00002.000.jpg"),
    );
  });

  it("keeps a partly-submitted frame until its last box is gone", async () => {
    stubApi({ batches: [batch({ images: [image(1, [box(10), box(11, "Nahida")])] })] });

    render(wrap(<LabellingSession />));
    await userEvent.click(await screen.findByRole("button", { name: /accept paimon/i }));
    await userEvent.click(screen.getByRole("button", { name: /^submit/i }));

    // Same frame, one box fewer — not the next frame, and not a refetch. The
    // renumbering that follows is fine here: it is the consequence of an
    // explicit submit, not something that happened under a moving cursor.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /accept paimon/i })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("img")).toHaveAttribute("alt", "frames/dQw4w9WgXcQ/00001.000.jpg");
    expect(screen.getByRole("button", { name: /accept nahida/i })).toBeInTheDocument();
  });

  it("does not advance when the submission failed", async () => {
    // Boxes silently dropped from the dataset are the one outcome this screen
    // exists to prevent, so the frame stays and the failure is on screen.
    stubApi({
      batches: [batch({ images: [image(1), image(2)] })],
      post: () => json({ error: "not a prediction on image 1: 10" }, 404),
    });

    render(wrap(<LabellingSession />));
    await userEvent.click(await screen.findByRole("button", { name: /accept paimon/i }));
    await userEvent.click(screen.getByRole("button", { name: /^submit/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/not a prediction on image 1/);
    expect(screen.getByRole("img")).toHaveAttribute("alt", "frames/dQw4w9WgXcQ/00001.000.jpg");
  });

  it("rejects the whole frame in one submission and moves on", async () => {
    const fetchMock = stubApi({
      batches: [batch({ images: [image(1, [box(10), box(11, "Nahida")]), image(2)] })],
      post: () => json({ image_id: 1, verdicts: 2 }, 201),
    });

    render(wrap(<LabellingSession />));
    await userEvent.click(await screen.findByRole("button", { name: /reject whole frame/i }));
    await userEvent.click(screen.getByRole("button", { name: /^submit/i }));

    await waitFor(() =>
      expect(screen.getByRole("img")).toHaveAttribute("alt", "frames/dQw4w9WgXcQ/00002.000.jpg"),
    );
    expect(postsTo(fetchMock)).toEqual([
      [
        "/api/admin/images/1/verdicts",
        {
          verdicts: [
            { prediction_id: 10, verdict: "reject" },
            { prediction_id: 11, verdict: "reject" },
          ],
        },
      ],
    ]);
  });

  it("records a missing-object report without moving off the frame", async () => {
    // The report is not a ruling on any box: whatever the detector did propose
    // still needs accepting or rejecting.
    const fetchMock = stubApi({
      post: () => json({ id: 1, image_id: 1, class_id: 3, reporter: "a", created_at: 1 }, 201),
    });

    render(wrap(<LabellingSession />));
    await screen.findByRole("img");
    await userEvent.selectOptions(screen.getByLabelText(/something is missing/i), "3");
    await userEvent.click(screen.getByRole("button", { name: /report missing/i }));

    await waitFor(() =>
      expect(postsTo(fetchMock)).toEqual([["/api/admin/images/1/missing", { class_id: 3 }]]),
    );
    expect(screen.getByRole("img")).toHaveAttribute("alt", "frames/dQw4w9WgXcQ/00001.000.jpg");
    expect(await screen.findByText(/report recorded/i)).toBeInTheDocument();
  });

  it("does not carry the report confirmation onto the next frame", async () => {
    // The report does not advance the session, so nothing else clears the
    // confirmation — and left alone it would read as a claim about whichever
    // frame is showing when the operator eventually moves on.
    stubApi({
      batches: [batch({ images: [image(1), image(2)] })],
      post: (url) =>
        url.endsWith("/missing")
          ? json({ id: 1, image_id: 1, class_id: null, reporter: "a", created_at: 1 }, 201)
          : json(writtenVerdicts, 201),
    });

    render(wrap(<LabellingSession />));
    await screen.findByRole("img");
    await userEvent.click(screen.getByRole("button", { name: /report missing/i }));
    expect(await screen.findByText(/report recorded/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /accept paimon/i }));
    await userEvent.click(screen.getByRole("button", { name: /^submit/i }));

    await waitFor(() =>
      expect(screen.getByRole("img")).toHaveAttribute("alt", "frames/dQw4w9WgXcQ/00002.000.jpg"),
    );
    expect(screen.queryByText(/report recorded/i)).not.toBeInTheDocument();
  });

  it("does not carry an armed adjustment onto the next frame", async () => {
    // The worst reachable bug on this screen: "Adjust" armed on frame A, the
    // frame advanced by some other action, and a box then drawn on frame B
    // saved as an adjustment to A's prediction — a corrupted row in the one
    // table the append-only design exists to keep trustworthy.
    stubApi({
      batches: [batch({ images: [image(1), image(2)] })],
    });

    render(wrap(<LabellingSession />));
    await screen.findByRole("img");
    await userEvent.click(screen.getByRole("button", { name: /adjust paimon/i }));
    expect(screen.getByRole("button", { name: /save adjustment/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /reject whole frame/i }));
    await userEvent.click(screen.getByRole("button", { name: /^submit/i }));

    await waitFor(() =>
      expect(screen.getByRole("img")).toHaveAttribute("alt", "frames/dQw4w9WgXcQ/00002.000.jpg"),
    );
    expect(screen.queryByRole("button", { name: /save adjustment/i })).not.toBeInTheDocument();
  });

  it("counts down the pool as the session works through it", async () => {
    // `remaining` is the server's count from when the batch was fetched, and a
    // verdict deliberately does not refetch it. Shown raw it never moves, so an
    // operator who has just cleared the pool is told frames are still waiting
    // and handed a "Next batch" button that returns nothing.
    stubApi({ batches: [batch({ images: [image(1)], remaining: 1 })] });

    render(wrap(<LabellingSession />));
    await userEvent.click(await screen.findByRole("button", { name: /accept paimon/i }));
    await userEvent.click(screen.getByRole("button", { name: /^submit/i }));

    expect(await screen.findByText(/nothing left to verify/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /next batch/i })).not.toBeInTheDocument();
  });

  it("re-requests the batch when a frame's URL has expired", async () => {
    // M13.4: the UI treats a 403 on an expired presigned URL as a re-request,
    // not an error. An <img> reports only that it failed, so the refresh is
    // driven by the load failure rather than by a status code.
    const fetchMock = stubApi({
      batches: [batch(), batch({ images: [image(2)] })],
    });

    render(wrap(<LabellingSession />));
    (await screen.findByRole("img")).dispatchEvent(new Event("error"));

    await waitFor(() =>
      expect(screen.getByRole("img")).toHaveAttribute("alt", "frames/dQw4w9WgXcQ/00002.000.jpg"),
    );
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        (url as string).startsWith("/api/admin/labelling/batch"),
      ),
    ).toHaveLength(2);
  });

  it("spends a re-request on each frame that expires, not one per batch", async () => {
    // Fifteen-minute signatures over a twenty-frame batch: a second frame
    // expiring later in the same sitting is ordinary. A single boolean would
    // spend the session's one refresh on the first expiry and then call every
    // later one a missing object.
    const fetchMock = stubApi({
      batches: [
        batch({ images: [image(1), image(2)] }),
        batch({ images: [image(1), image(2)] }),
        batch({ images: [image(2)] }),
      ],
    });
    const batchCalls = () =>
      fetchMock.mock.calls.filter(([url]) =>
        (url as string).startsWith("/api/admin/labelling/batch"),
      ).length;

    render(wrap(<LabellingSession />));
    (await screen.findByRole("img")).dispatchEvent(new Event("error"));
    await waitFor(() => expect(batchCalls()).toBe(2));

    // Frame 1 ruled on, so the session is showing frame 2 — a different frame,
    // and its own expiry is worth its own re-request.
    await userEvent.click(screen.getByRole("button", { name: /accept paimon/i }));
    await userEvent.click(screen.getByRole("button", { name: /^submit/i }));
    await waitFor(() =>
      expect(screen.getByRole("img")).toHaveAttribute("alt", "frames/dQw4w9WgXcQ/00002.000.jpg"),
    );
    screen.getByRole("img").dispatchEvent(new Event("error"));

    await waitFor(() => expect(batchCalls()).toBe(3));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("stops re-requesting when freshly signed URLs also fail", async () => {
    // A missing R2 object rather than an expiry. Re-requesting forever would
    // turn one broken frame into a request loop.
    const fetchMock = stubApi();

    render(wrap(<LabellingSession />));
    (await screen.findByRole("img")).dispatchEvent(new Event("error"));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) =>
          (url as string).startsWith("/api/admin/labelling/batch"),
        ),
      ).toHaveLength(2),
    );

    screen.getByRole("img").dispatchEvent(new Event("error"));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be loaded/i);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        (url as string).startsWith("/api/admin/labelling/batch"),
      ),
    ).toHaveLength(2);
  });

  it("says the pool is empty rather than showing a blank frame", async () => {
    stubApi({ batches: [batch({ images: [], remaining: 0 })] });

    render(wrap(<LabellingSession />));

    expect(await screen.findByText(/nothing left to verify/i)).toBeInTheDocument();
  });

  it("does not re-show the finished batch while the next one is in flight", async () => {
    // React Query serves the previous data through a refetch, so a session
    // that cleared its ruled/done sets before awaiting the response would
    // re-render the batch it just finished with every box unfiltered — live
    // buttons that would append a second verdict to each.
    const fetchMock = stubApi({
      batches: [batch({ images: [image(1)], remaining: 5 }), batch({ images: [image(2)] })],
      holdBatchAfterFirst: true,
    });

    render(wrap(<LabellingSession />));
    await userEvent.click(await screen.findByRole("button", { name: /accept paimon/i }));
    await userEvent.click(screen.getByRole("button", { name: /^submit/i }));
    await userEvent.click(await screen.findByRole("button", { name: /next batch/i }));

    // Mid-refetch: no frame at all, and nothing to click twice.
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /accept paimon/i })).not.toBeInTheDocument();

    fetchMock.releaseBatch();

    await waitFor(() =>
      expect(screen.getByRole("img")).toHaveAttribute("alt", "frames/dQw4w9WgXcQ/00002.000.jpg"),
    );
  });

  it("offers the next batch when this one is worked through but the pool is not", async () => {
    stubApi({ batches: [batch({ images: [], remaining: 214 })] });

    render(wrap(<LabellingSession />));

    expect(await screen.findByText(/214 frames still waiting/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next batch/i })).toBeInTheDocument();
  });

  it("flags the frame on screen into the public sample (M14.1)", async () => {
    const fetchMock = stubApi();

    render(wrap(<LabellingSession />));
    const checkbox = await screen.findByRole("checkbox", { name: /in public sample/i });
    expect(checkbox).not.toBeChecked();

    await userEvent.click(checkbox);

    await waitFor(() => expect(checkbox).toBeChecked());
    const patchCalls = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCalls).toEqual([
      [
        "/api/admin/images/1/public-sample",
        expect.objectContaining({ body: JSON.stringify({ public_sample: true }) }),
      ],
    ]);
  });

  it("does not refetch the batch when the flag changes", async () => {
    // The pool query pages by unruled boxes and does not filter on
    // `public_sample` — a refetch here would reshuffle the operator's page
    // for a field that batch has no opinion about.
    const fetchMock = stubApi();

    render(wrap(<LabellingSession />));
    await userEvent.click(await screen.findByRole("checkbox", { name: /in public sample/i }));
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: /in public sample/i })).toBeChecked(),
    );

    const batchCalls = fetchMock.mock.calls.filter(([url]) =>
      (url as string).startsWith("/api/admin/labelling/batch"),
    );
    expect(batchCalls).toHaveLength(1);
  });
});
