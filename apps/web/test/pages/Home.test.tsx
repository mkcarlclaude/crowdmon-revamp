import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Home } from "../../src/pages/Home";

/**
 * `/` (M20 plan §A). `Home` fetches nothing, so — unlike almost every other
 * routed page in this app — it needs no `QueryClientProvider` at all; that
 * is itself part of what plan §A5 asks this file to prove, not an
 * incidental choice of test harness.
 */
function renderHome() {
  return render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.style.backgroundColor = "";
  document.documentElement.style.scrollBehavior = "";
});

describe("Home", () => {
  it("renders without a query client, since it fetches nothing", () => {
    // No QueryClientProvider anywhere above this — if Home reached into
    // react-query it would throw during render, not silently degrade.
    renderHome();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/paimon/i);
  });

  it("does not add a robots noindex tag — / is meant to be found", () => {
    renderHome();
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
  });

  it("gives the nav a Sign in control pointed at the live OAuth route", () => {
    renderHome();
    const signIn = screen.getByRole("link", { name: "Sign in" });
    expect(signIn).toHaveAttribute("href", "/api/auth/google/start");
  });

  it("points its primary CTAs at contributing, not the anonymous demo", () => {
    renderHome();
    const contributeLinks = screen.getAllByRole("link", { name: /start contributing/i });
    expect(contributeLinks.length).toBeGreaterThan(0);
    for (const link of contributeLinks) {
      expect(link).toHaveAttribute("href", "/contribute");
    }
  });

  it("keeps the anonymous demo reachable and honestly labelled as a demo", () => {
    renderHome();
    // Every link to /verify says "demo" somewhere in its own text — a
    // visitor should never discover only after signing up that what they
    // already clicked through did not count (plan §A3).
    const verifyLinks = screen
      .getAllByRole("link")
      .filter((el) => el.getAttribute("href") === "/verify");
    expect(verifyLinks.length).toBeGreaterThan(0);
    for (const link of verifyLinks) {
      expect(link.textContent?.toLowerCase()).toMatch(/demo/);
    }
  });

  it("never renders a confident-looking detection — the real 0.16 stays on the page", () => {
    renderHome();
    // The one box drawn on the hero frame is the detector's real, weak
    // output. A reader who never sees this number replaced with something
    // more convincing is the whole argument for the human step.
    expect(screen.getByText("0.16")).toBeInTheDocument();
  });
});

describe("Home.css — self-hosted fonts only", () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "pages", "Home.css"),
    "utf8",
  );

  it("declares the two brand typefaces this design depends on", () => {
    expect(css).toMatch(/Cabinet Grotesk/);
    expect(css).toMatch(/Satoshi/);
  });

  it("loads every @font-face src from a local path, never an external host", () => {
    const fontUrls = [...css.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((m) => m[1] ?? "");
    expect(fontUrls.length).toBeGreaterThan(0);
    for (const url of fontUrls) {
      expect(url.startsWith("http://")).toBe(false);
      expect(url.startsWith("https://")).toBe(false);
      expect(url.startsWith("//")).toBe(false);
      expect(url.startsWith("/fonts/")).toBe(true);
    }
  });

  it("contains no @import of an external stylesheet", () => {
    expect(css).not.toMatch(/@import\s+url\(["']?https?:/i);
  });
});
