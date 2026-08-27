import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `public/_headers` is the real `noindex`/`noimageindex` control for
 * `/demo`, `/verify` and `/admin` — an `X-Robots-Tag` a non-JS crawler sees
 * on the raw HTTP response, unlike `src/hooks/use-noindex.ts`'s
 * client-injected `<meta>` tag, which only exists after React has mounted.
 * Vite copies `public/` into `dist/`, the directory
 * `apps/api/wrangler.toml`'s `[assets]` binding serves, so this file ships
 * as-is.
 *
 * This matters beyond generic SEO hygiene: CONTEXT.md §Q25 names this
 * file's rules among the bounds keeping the public verification page
 * distinct from the "public browsable gallery of labelled crops" §Q11
 * rejected on licensing grounds. A regression here is a licensing-exposure
 * regression, not a ranking one — see `_headers`' own comment for what is
 * confirmed about how these rules apply under this app's SPA fallback
 * routing (settled against production 2026-08-21).
 *
 * M24, plan §B2 renamed `/verify` to `/demo` and swapped its tag from
 * `noindex` to `noimageindex` — the page is now deliberately indexable,
 * and what has to stay out of image search is the frames Googlebot can
 * fetch and cache, not the page itself. The old `/verify` path keeps
 * `noindex`: it now serves nothing but a client-side redirect
 * (`routes.tsx`), and a non-JS crawler that never runs that redirect
 * should not index the empty shell it saw instead.
 */
const headers = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "public", "_headers"),
  "utf8",
);

describe("public/_headers", () => {
  it("sets X-Robots-Tag: noimageindex on /demo — the page is indexable, the frames are not", () => {
    expect(headers).toMatch(/\/demo\s*\n(?:[ \t]+[^\n]*\n)*[ \t]+X-Robots-Tag:\s*noimageindex/);
  });

  it("sets X-Robots-Tag: noindex on /verify — the redirect stub, not a page worth indexing", () => {
    expect(headers).toMatch(/\/verify\s*\n(?:[ \t]+[^\n]*\n)*[ \t]+X-Robots-Tag:\s*noindex/);
  });

  it("sets X-Robots-Tag: noindex under /admin", () => {
    expect(headers).toMatch(/\/admin\s*\n(?:[ \t]+[^\n]*\n)*[ \t]+X-Robots-Tag:\s*noindex/);
    expect(headers).toMatch(/\/admin\/\*\s*\n(?:[ \t]+[^\n]*\n)*[ \t]+X-Robots-Tag:\s*noindex/);
  });

  it("uses at most one splat per rule", () => {
    // Only path lines (unindented, not a `#` comment) are rules — the
    // `_headers` format's own constraint, not something to check against
    // comment prose, which is free to use "**" for markdown emphasis.
    const pathLines = headers.split("\n").filter((line) => /^\/\S/.test(line));
    expect(pathLines.length).toBeGreaterThan(0);
    for (const line of pathLines) {
      const splats = line.match(/\*/g);
      expect(splats?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });
});

describe("robots.txt and sitemap.xml", () => {
  const readPublic = (name: string) =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "public", name), "utf8");

  /**
   * Both files exist because without them the SPA fallback answers
   * `/robots.txt` and `/sitemap.xml` with `index.html` and a 200 — not a
   * 404, which a crawler would handle cleanly, but a malformed document
   * every crawler is free to interpret its own way.
   */
  it("serves a real robots.txt that declares the sitemap", () => {
    const robots = readPublic("robots.txt");
    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots).toMatch(/^Sitemap: https:\/\/crowdmon\.mkcarl\.com\/sitemap\.xml$/m);
    expect(robots).toMatch(/^Disallow: \/api\/$/m);
  });

  /**
   * The interaction that gets this wrong everywhere: a path blocked by
   * robots.txt is never fetched, so its `X-Robots-Tag: noindex` is never
   * seen, and the URL can still be listed from an external link. Disallow
   * and noindex pull against each other and noindex is the one that
   * actually removes a page — so every noindexed path here must stay
   * crawlable.
   */
  it("does not disallow the paths that rely on a noindex header", () => {
    const robots = readPublic("robots.txt");
    for (const path of ["/admin", "/contribute", "/verify", "/demo"]) {
      expect(robots).not.toMatch(new RegExp(`^Disallow: ${path}`, "m"));
    }
  });

  it("lists exactly the two indexable URLs in the sitemap", () => {
    const sitemap = readPublic("sitemap.xml");
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual([
      "https://crowdmon.mkcarl.com/",
      "https://crowdmon.mkcarl.com/demo",
    ]);
  });

  /**
   * A sitemap advertising a page the same deployment tells crawlers not to
   * index is a deployment arguing with itself, and the rename to `/demo` is
   * exactly the kind of change that would leave one behind.
   */
  it("never lists a path that carries a noindex header", () => {
    const sitemap = readPublic("sitemap.xml");
    for (const path of ["/admin", "/contribute", "/verify"]) {
      expect(sitemap).not.toContain(`https://crowdmon.mkcarl.com${path}`);
    }
  });

  it("keeps /contribute on a header rule, not just the injected meta tag", () => {
    const headers = readPublic("_headers");
    expect(headers).toMatch(/^\/contribute\n\s+X-Robots-Tag: noindex$/m);
  });
});
