import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContributeVerify } from "../../src/components/ContributeVerify";

/**
 * The contributor mount (M20, plan §B4).
 *
 * Mirrors `LabellingSession.test.tsx`'s own shape — same batch-walking
 * component, a different endpoint and a different `source` the mount never
 * has to know about (`VerificationCard`'s own "no endpoint knowledge"
 * design, M13.1). What is specific to this mount and worth its own
 * assertion: it posts to `/api/contribute/*`, not `/api/admin/*`, and it
 * offers Adjust — the one capability the anonymous mount refuses.
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

afterEach(() => vi.unstubAllGlobals());

describe("ContributeVerify", () => {
  it("offers Adjust, unlike the anonymous mount", async () => {
    stubApi();

    render(wrap(<ContributeVerify />));
    await screen.findByRole("img");

    expect(screen.getByRole("button", { name: /adjust paimon/i })).toBeInTheDocument();
  });

  it("posts a ruling to /api/contribute, not /api/admin or /api/public", async () => {
    const fetchMock = stubApi();

    render(wrap(<ContributeVerify />));
    await userEvent.click(await screen.findByRole("button", { name: /accept paimon/i }));
    await userEvent.click(screen.getByRole("button", { name: /^submit/i }));

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      );
      expect(posts).toHaveLength(1);
      expect(posts[0]?.[0]).toBe("/api/contribute/images/1/verdicts");
    });
  });

  it("shows the next batch once the current one is finished, and 'nothing left' once the pool is empty", async () => {
    stubApi({
      batches: [batch(), { images: [], url_mode: "signed", expires_at: 1, remaining: 0 }],
    });

    render(wrap(<ContributeVerify />));
    await userEvent.click(await screen.findByRole("button", { name: /accept paimon/i }));
    await userEvent.click(screen.getByRole("button", { name: /^submit/i }));

    await userEvent.click(await screen.findByRole("button", { name: /check again|next batch/i }));

    expect(await screen.findByText(/nothing left to verify/i)).toBeInTheDocument();
  });
});
