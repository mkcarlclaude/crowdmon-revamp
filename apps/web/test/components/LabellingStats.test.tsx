import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LabellingStats } from "../../src/components/LabellingStats";

/**
 * The business numbers on /admin (M13.3, M13.4).
 *
 * The assertion worth having is about the missing-report *denominator*: the
 * rate is reports over frames actually verified, not over the boxes the class
 * produced. A prompt that grounds on nothing has no boxes to divide by, and it
 * is exactly the prompt whose miss rate matters.
 */

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function stubStats(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );
}

const klass = (over: Record<string, unknown> = {}) => ({
  class_id: 3,
  name: "Paimon",
  active: true,
  predictions: 128,
  accepted: 90,
  adjusted: 12,
  rejected: 8,
  anon_verdicts: 0,
  missing_reports: 3,
  ...over,
});

const stats = (over: Record<string, unknown> = {}) => ({
  pool: {
    images_with_predictions: 254,
    images_verified: 40,
    images_remaining: 214,
    missing_reports: 5,
  },
  classes: [klass()],
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("LabellingStats", () => {
  it("reports the pool as verified against the whole pre-labelled set", async () => {
    stubStats(stats());

    render(wrap(<LabellingStats />));

    expect(await screen.findByText(/pre-labelled frames verified/i)).toHaveTextContent(
      /40 of 254 pre-labelled frames verified · 214 waiting · 5 missing-object reports/,
    );
  });

  it("shows the missing-report rate over verified frames, as a fraction", async () => {
    stubStats(stats());

    render(wrap(<LabellingStats />));

    const row = (await screen.findByText("Paimon")).closest("tr") as HTMLElement;
    expect(within(row).getByText("3 / 40")).toBeInTheDocument();
  });

  it("keeps a retired class visible and says so", async () => {
    stubStats(stats({ classes: [klass({ active: false, name: "Nahida" })] }));

    render(wrap(<LabellingStats />));

    const row = (await screen.findByText("Nahida")).closest("tr") as HTMLElement;
    expect(within(row).getByText(/retired/i)).toBeInTheDocument();
  });

  it("surfaces a failure rather than rendering zeroes", async () => {
    stubStats({ error: "session expired" }, 500);

    render(wrap(<LabellingStats />));

    expect(await screen.findByRole("alert")).toHaveTextContent(/session expired/);
  });
});
