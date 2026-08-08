import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddClassForm } from "../../src/components/AddClassForm";

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

const created = {
  id: 6,
  name: "Nahida",
  appearance_prompt: "a small girl with long white-and-green hair",
  prompt_version: "2026-08-08-a",
  active: false,
  created_at: 1_754_099_000,
  updated_at: 1_754_099_000,
};

afterEach(() => vi.unstubAllGlobals());

describe("AddClassForm", () => {
  it("posts the name and prompt, trimmed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(created, 201));
    vi.stubGlobal("fetch", fetchMock);

    render(wrap(<AddClassForm />));
    await userEvent.type(screen.getByLabelText(/class name/i), "  Nahida  ");
    await userEvent.type(
      screen.getByLabelText(/appearance prompt/i),
      "  a small girl with long white-and-green hair  ",
    );
    await userEvent.click(screen.getByRole("button", { name: /add class/i }));

    await screen.findByText(/added nahida/i);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/classes");
    expect(init.method).toBe("POST");
    // No `active`, and no `prompt_version`: both are the server's to decide,
    // and a field here would be a second place they could be decided from.
    expect(JSON.parse(init.body as string)).toEqual({
      name: "Nahida",
      appearance_prompt: "a small girl with long white-and-green hair",
    });
  });

  it("says the new class is retired, because that is what happened", async () => {
    // The form offers no way to create an active class — M12.2's dry-run is
    // meant to sit between writing a prompt and letting it label anything — so
    // the outcome has to be stated rather than left to be discovered in the
    // roster.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(created, 201)));

    render(wrap(<AddClassForm />));
    await userEvent.type(screen.getByLabelText(/class name/i), "Nahida");
    await userEvent.type(screen.getByLabelText(/appearance prompt/i), "a small green-haired girl");
    await userEvent.click(screen.getByRole("button", { name: /add class/i }));

    expect(await screen.findByText(/added nahida .*, retired\./i)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("shows the API's message when the name is taken", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ error: "a class named Paimon already exists" }, 409)),
    );

    render(wrap(<AddClassForm />));
    await userEvent.type(screen.getByLabelText(/class name/i), "Paimon");
    await userEvent.type(screen.getByLabelText(/appearance prompt/i), "a wording");
    await userEvent.click(screen.getByRole("button", { name: /add class/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already exists/i);
  });

  it("does not post a half-filled form", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(wrap(<AddClassForm />));
    await userEvent.type(screen.getByLabelText(/class name/i), "Nahida");
    await userEvent.click(screen.getByRole("button", { name: /add class/i }));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
