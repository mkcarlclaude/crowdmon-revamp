import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * M14.3, CONTEXT.md §12: the public verification page must carry `noindex`.
 *
 * One `index.html` serves every route (M5.1's single-origin SPA), so there is
 * no per-route document to check — this is the one tag that decides it for
 * `/verify` and everything else.
 */
const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"),
  "utf8",
);

describe("index.html", () => {
  it("tells search indexes not to crawl any route", () => {
    expect(html).toMatch(/<meta\s+name="robots"\s+content="noindex"\s*\/?>/);
  });
});
