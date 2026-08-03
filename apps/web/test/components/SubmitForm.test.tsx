import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubmitForm } from "../../src/components/SubmitForm";

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

afterEach(() => vi.unstubAllGlobals());

describe("SubmitForm", () => {
  it("posts the URL and reports the created job", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ video_id: "dQw4w9WgXcQ", job_id: 7 }, 201));
    vi.stubGlobal("fetch", fetchMock);

    render(wrap(<SubmitForm />));
    await userEvent.type(
      screen.getByLabelText(/youtube url/i),
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(await screen.findByText(/job 7/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // `expect.objectContaining` on `method` alone would ignore `body`
    // entirely — a renamed field, a dropped body, or a skipped trim would
    // all pass. Parse the actual body sent rather than the raw JSON string,
    // so a harmless key-order change in the serialiser doesn't fail this.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/videos");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
  });

  it("trims the URL before sending it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ video_id: "dQw4w9WgXcQ", job_id: 7 }, 201));
    vi.stubGlobal("fetch", fetchMock);

    render(wrap(<SubmitForm />));
    await userEvent.type(
      screen.getByLabelText(/youtube url/i),
      "  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ",
    );
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));

    await screen.findByText(/job 7/i);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
  });

  it("shows the API's message when the video was already submitted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ error: "this video has already been submitted" }, 409)),
    );

    render(wrap(<SubmitForm />));
    await userEvent.type(screen.getByLabelText(/youtube url/i), "https://youtu.be/dQw4w9WgXcQ");
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already been submitted/i);
  });

  it("shows per-field validation issues", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          json(
            { error: "invalid request", issues: [{ path: "url", message: "Invalid URL" }] },
            400,
          ),
        ),
    );

    render(wrap(<SubmitForm />));
    await userEvent.type(screen.getByLabelText(/youtube url/i), "not-a-url");
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/url: Invalid URL/i);
  });

  it("does not post an empty form", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(wrap(<SubmitForm />));
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
