import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Contribute } from "../../src/pages/Contribute";

/**
 * `/contribute` (M20, plan §B4). What is under test is the branch on
 * `/api/contribute/me`'s outcome — the sign-in prompt versus the signed-in
 * session and its own counts — not the verification session itself, which
 * `ContributeVerify.test.tsx` covers.
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

const me = (over: Record<string, unknown> = {}) => ({
  email: "friend@example.com",
  display_name: "Friend",
  trusted: false,
  frames_touched: 3,
  verdicts: { accept: 2, adjust: 1, reject: 0 },
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("Contribute", () => {
  it("shows a working sign-in link when signed out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(json({ error: "missing session" }, 401))),
    );

    render(wrap(<Contribute />));

    const link = await screen.findByRole("link", { name: /sign in with google/i });
    expect(link).toHaveAttribute("href", "/api/auth/google/start");
  });

  it("shows the signed-in contributor's own counts, honest about trust", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.startsWith("/api/contribute/me")) return Promise.resolve(json(me()));
        if (url.startsWith("/api/contribute/batch")) {
          return Promise.resolve(
            json({ images: [], url_mode: "signed", expires_at: 1, remaining: 0 }),
          );
        }
        return Promise.resolve(json({ error: `unexpected ${url}` }, 404));
      }),
    );

    render(wrap(<Contribute />));

    expect(await screen.findByText(/signed in as friend/i)).toBeInTheDocument();
    expect(screen.getByText(/2 accepted, 1 adjusted, 0 rejected/i)).toBeInTheDocument();
    expect(screen.getByText(/not yet trusted/i)).toBeInTheDocument();
  });

  it("does not claim a trusted account's verdicts are unpromoted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.startsWith("/api/contribute/me"))
          return Promise.resolve(json(me({ trusted: true })));
        return Promise.resolve(
          json({ images: [], url_mode: "signed", expires_at: 1, remaining: 0 }),
        );
      }),
    );

    render(wrap(<Contribute />));

    expect(await screen.findByText(/can be selected as labels/i)).toBeInTheDocument();
    expect(screen.queryByText(/not yet trusted/i)).not.toBeInTheDocument();
  });

  it("signing out clears the session and returns to the sign-in prompt", async () => {
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url.startsWith("/api/auth/logout"))
        return Promise.resolve(new Response(null, { status: 204 }));
      if (url.startsWith("/api/contribute/me")) {
        // Signed in until logout has actually been posted.
        const loggedOut = fetchMock.mock.calls.some(([u]) =>
          (u as string).startsWith("/api/auth/logout"),
        );
        return Promise.resolve(loggedOut ? json({ error: "missing session" }, 401) : json(me()));
      }
      if (url.startsWith("/api/contribute/batch")) {
        return Promise.resolve(
          json({ images: [], url_mode: "signed", expires_at: 1, remaining: 0 }),
        );
      }
      return Promise.resolve(json({ error: `unexpected ${url}` }, 404));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(wrap(<Contribute />));
    await screen.findByText(/signed in as friend/i);

    await userEvent.click(screen.getByRole("button", { name: /sign out/i }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u, i]) => u === "/api/auth/logout" && (i as RequestInit)?.method === "POST",
        ),
      ).toBe(true),
    );
    expect(await screen.findByRole("link", { name: /sign in with google/i })).toBeInTheDocument();
  });
});
