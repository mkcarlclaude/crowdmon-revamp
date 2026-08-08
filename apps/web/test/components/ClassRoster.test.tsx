import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassRoster } from "../../src/components/ClassRoster";

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

function klass(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    name: "Paimon",
    appearance_prompt: "a small white-haired floating fairy companion",
    prompt_version: "2026-08-08-a",
    active: true,
    created_at: 1_754_099_000,
    updated_at: 1_754_100_030,
    ...overrides,
  };
}

/**
 * Routes a stubbed fetch by path rather than by call order.
 *
 * Each card mounts a `DryRunPanel`, which issues two GETs of its own, so a
 * sequence of `mockResolvedValueOnce` would answer whichever request happened
 * to be second — a test that broke the moment a card grew another query, which
 * is exactly what M12.2 did to it.
 */
function stubApi(routes: { classes: unknown; patch?: () => Response }) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      return Promise.resolve(routes.patch?.() ?? json(klass()));
    }
    if (url.startsWith("/api/admin/classes?") || url === "/api/admin/classes") {
      return Promise.resolve(json(routes.classes));
    }
    if (url.includes("/dryruns")) return Promise.resolve(json({ dryruns: [] }));
    if (url.startsWith("/api/admin/videos")) return Promise.resolve(json({ videos: [] }));
    return Promise.resolve(json({ error: `unexpected ${url}` }, 404));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("ClassRoster", () => {
  it("shows retired classes rather than hiding them", async () => {
    // The only way a retired class comes back is an admin reactivating it, so
    // a roster that filtered them out would make retirement permanent through
    // the UI while the row it exists to preserve sits untouched in D1.
    stubApi({
      classes: { classes: [klass(), klass({ id: 2, name: "Retired Character", active: false })] },
    });

    render(wrap(<ClassRoster />));

    expect(await screen.findByRole("region", { name: "Retired Character" })).toHaveTextContent(
      /retired/,
    );
    expect(screen.getByRole("button", { name: /activate/i, hidden: false })).toBeInTheDocument();
  });

  it("shows the prompt version, the column that says which boxes came from which wording", async () => {
    stubApi({ classes: { classes: [klass()] } });

    render(wrap(<ClassRoster />));

    expect(await screen.findByText("2026-08-08-a")).toBeInTheDocument();
  });

  it("saves reworded text as a PATCH carrying only the prompt", async () => {
    const fetchMock = stubApi({
      classes: { classes: [klass()] },
      patch: () => json(klass({ prompt_version: "2026-08-08-b" })),
    });

    render(wrap(<ClassRoster />));
    const field = await screen.findByLabelText(/paimon appearance prompt/i);
    await userEvent.clear(field);
    await userEvent.type(field, "a tiny floating companion");
    await userEvent.click(screen.getByRole("button", { name: /save wording/i }));

    const patch = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    ) as [string, RequestInit];
    expect(patch[0]).toBe("/api/admin/classes/1");
    // `active` is deliberately absent: a save is not a state change, and
    // sending the current flag back would make every reword a second write of
    // something nobody asked to touch.
    expect(JSON.parse(patch[1].body as string)).toEqual({
      appearance_prompt: "a tiny floating companion",
    });
  });

  it("keeps the save button quiet until the wording actually differs", async () => {
    // Resubmitting identical text is a no-op the API refuses to bump a version
    // for, so offering the button is offering a request with nothing behind it.
    stubApi({ classes: { classes: [klass()] } });

    render(wrap(<ClassRoster />));
    await screen.findByLabelText(/paimon appearance prompt/i);

    expect(screen.getByRole("button", { name: /save wording/i })).toBeDisabled();
  });

  it("retires an active class by flipping only the flag", async () => {
    // The roster answers `active: true` until the PATCH lands and `false`
    // after, which is what the refetch the mutation triggers actually sees.
    let retired = false;
    const fetchMock = stubApi({
      get classes() {
        return { classes: [klass({ active: !retired })] };
      },
      patch: () => {
        retired = true;
        return json(klass({ active: false }));
      },
    });

    render(wrap(<ClassRoster />));
    await userEvent.click(await screen.findByRole("button", { name: /retire/i }));

    const patch = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    ) as [string, RequestInit];
    expect(JSON.parse(patch[1].body as string)).toEqual({ active: false });
    // And it is still on the page, because nothing was deleted.
    expect(await screen.findByRole("region", { name: "Paimon" })).toHaveTextContent(/retired/);
  });

  it("surfaces the API's own refusal when activation would exceed the bound", async () => {
    stubApi({
      classes: { classes: [klass({ active: false })] },
      patch: () => json({ error: "activating this class would exceed the 30 active classes" }, 409),
    });

    render(wrap(<ClassRoster />));
    await userEvent.click(await screen.findByRole("button", { name: /activate/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/would exceed the 30 active/i);
  });

  it("says so when there are no classes at all", async () => {
    stubApi({ classes: { classes: [] } });

    render(wrap(<ClassRoster />));

    expect(await screen.findByText(/no classes yet/i)).toBeInTheDocument();
  });
});
