import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `index.html` is the one static document every route shares (M5.1's
 * single-origin SPA), so it is also the only place a crawler that does not
 * execute JavaScript — the Discord/Reddit link-preview kind M20 plan §A4
 * cares about, and the reason Open Graph tags live here rather than being
 * injected by React — ever sees anything at all.
 *
 * `robots: noindex` used to live here too, covering every route (M14.3).
 * Plan §A4 makes `/` indexable and keeps `/verify` and `/admin` opted out
 * via `src/hooks/use-noindex.ts` instead — that hook's own test file is
 * `test/hooks/use-noindex.test.tsx`; this file only owns the static shell.
 */
const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"),
  "utf8",
);

describe("index.html", () => {
  it("does not tell search indexes to skip the whole site", () => {
    // `/` is meant to be found. A per-route `noindex` for `/verify` and
    // `/admin` is asserted in use-noindex.test.tsx, not here — this file
    // can only speak to the one document every route shares.
    expect(html).not.toMatch(/<meta\s+name="robots"/);
  });

  it("carries a <title>", () => {
    expect(html).toMatch(/<title>[^<]+<\/title>/);
  });

  it("carries Open Graph tags a link-preview bot can read without running JavaScript", () => {
    expect(html).toMatch(/<meta\s+property="og:title"\s+content="[^"]+"\s*\/?>/);
    expect(html).toMatch(/<meta\s+property="og:description"\s+content="[^"]+"\s*\/?>/);
    expect(html).toMatch(/<meta\s+property="og:image"\s+content="[^"]+"\s*\/?>/);
  });

  // A strict CSP applies in production and there is no CDN allowance
  // (CLAUDE.md, M20 plan §A1) — a `fonts.googleapis.com` or any other
  // external stylesheet/font reference here would fail closed in
  // production and fall back silently in dev, which is exactly the failure
  // mode that makes this worth asserting directly rather than trusting a
  // visual check.
  it("references no external font or stylesheet host", () => {
    expect(html).not.toMatch(/href="https?:\/\/[^"]*font[^"]*"/i);
    expect(html).not.toMatch(/rel="preconnect"/i);
  });
});
