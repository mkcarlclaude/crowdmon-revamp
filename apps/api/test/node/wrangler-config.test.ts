import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the placement of plain vars in wrangler.toml.
 *
 * TOML assigns a bare key to the most recent table header, so a var appended
 * to the end of the file lands inside `[[r2_buckets]]` rather than `[vars]`.
 * wrangler accepts that silently and deploys a Worker without the var. That
 * happened to ACCESS_AUD in M3.5, and the only symptom was every admin request
 * in production answering 503 — the fail-closed path, doing its job, for a
 * reason that had nothing to do with Access.
 *
 * Textual rather than a TOML parse: the failure is *where* a key sits relative
 * to the table headers, which is exactly what the text shows and what a parsed
 * object would flatten away.
 */

const config = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "wrangler.toml"),
  "utf8",
);

/** Plain vars the Worker reads from `c.env`. Secrets are not declared here. */
const EXPECTED_VARS = ["ENVIRONMENT", "OTLP_ENDPOINT", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD"];

function varsSection(): string {
  const lines = config.split("\n");
  const start = lines.findIndex((line) => line.trim() === "[vars]");
  expect(start, "wrangler.toml has no [vars] table").toBeGreaterThanOrEqual(0);

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\s*\[/.test(line));

  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/**
 * The text of the file before its first table header, [vars] — i.e. root
 * level, where `workers_dev` and `preview_urls` both have to live. A bare key
 * binds to the most recent table header, so either setting drifting past this
 * boundary (into [vars], or further down into [[d1_databases]] /
 * [[r2_buckets]]) silently rebinds it into that table. wrangler deploys
 * without it, the setting reverts to its default, and a presence-only regex
 * over the whole file would not notice, because the text is still there —
 * just owned by the wrong table. Mirrors varsSection() above, scoped in the
 * other direction.
 *
 * Line-anchored, like varsSection(): wrangler.toml has a comment reading
 * "Keep [vars] above the [[d1_databases]]..." above the real header, and a
 * raw `config.indexOf("[vars]")` matches that literal text inside the
 * comment first, not the table header this is meant to anchor on.
 */
function rootSection(): string {
  const lines = config.split("\n");
  const end = lines.findIndex((line) => line.trim() === "[vars]");
  expect(end, "wrangler.toml has no [vars] table").toBeGreaterThanOrEqual(0);
  return lines.slice(0, end).join("\n");
}

/**
 * Escapes regex metacharacters so a literal string — e.g. "/api/*" or
 * "/openapi.json" — matches only itself, not "any char" or "0-or-more".
 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("wrangler.toml", () => {
  it.each(EXPECTED_VARS)("declares %s inside [vars]", (name) => {
    expect(varsSection()).toMatch(new RegExp(`^${name}\\s*=`, "m"));
  });

  /**
   * The workers.dev hostname cannot be covered by an Access application —
   * Access binds to a route on a zone, and workers.dev is not one — so while
   * it was on, everything under /api/admin was gated by the Worker's own JWT
   * verification alone. That check is real and was verified, but it is one
   * layer where the design calls for two.
   *
   * The setting defaults to *on*, which is why this is asserted rather than
   * left to the file: deleting the line reopens the hostname, and nothing
   * else in the repo would notice.
   *
   * Presence alone would not have caught the M3.5 ACCESS_AUD failure mode: a
   * bare key still reads as "in the file" after TOML rebinds it to the wrong
   * table. The second assertion below pins the line to root level, above
   * [vars], so a drift that silently moved it into a later table fails here
   * even though the text-anywhere regex above would keep passing.
   */
  it("keeps the ungated workers.dev hostname closed", () => {
    expect(config).toMatch(/^workers_dev\s*=\s*false\s*$/m);
    expect(rootSection()).toMatch(/^workers_dev\s*=\s*false\s*$/m);
  });

  it("has no assignment after the last table header", () => {
    // The shape of the original mistake: a key appended to the end of the
    // file, which reads as belonging to whichever binding happens to be last.
    const afterLastTable = config.slice(config.lastIndexOf("\n[") + 1);
    const stray = afterLastTable
      .split("\n")
      .slice(1)
      .filter((line) => /^[A-Z][A-Z0-9_]*\s*=/.test(line));

    expect(stray, "SCREAMING_CASE assignment after the last table header").toEqual([]);
  });

  /**
   * Worker version preview URLs live on *.workers.dev, which is not a zone and
   * therefore cannot be covered by an Access application. Serving assets makes
   * per-PR previews attractive, and turning them on would republish
   * /api/admin/* on an ungated hostname — reopening exactly what M4.6 closed,
   * through a setting M4.6's own test does not mention.
   *
   * Scoped to rootSection() rather than the whole file: a presence-only match
   * would keep passing even if this line drifted below [vars] and TOML
   * silently rebound it into that table (or a later one) — wrangler would
   * deploy with preview URLs back at their default of on, and nothing here
   * would notice. That is the ACCESS_AUD/M3.5 failure mode, just for a
   * snake_case key the SCREAMING_CASE stray-assignment check above does not
   * cover.
   */
  it("keeps preview URLs off", () => {
    expect(rootSection()).toMatch(/^preview_urls\s*=\s*false\s*$/m);
  });

  /**
   * `not_found_handling = "single-page-application"` answers every unmatched
   * path with index.html. /health and /openapi.json are Hono routes and are not
   * under /api/, so omitting them here makes the deploy workflow's health check
   * curl the SPA shell and pass on a broken API.
   */
  it.each(["/api/*", "/health", "/openapi.json"])(
    "routes %s to the Worker before static assets",
    (pattern) => {
      const assets = config.slice(config.indexOf("[assets]"));
      expect(assets).toMatch(new RegExp(`run_worker_first[^\\]]*"${escapeRegExp(pattern)}"`));
    },
  );

  it("points [assets] at the web package's build output", () => {
    const assets = config.slice(config.indexOf("[assets]"));
    expect(assets).toMatch(/^directory\s*=\s*"\.\.\/web\/dist"\s*$/m);
  });

  /**
   * run_worker_first only carves exceptions out of this setting — without it,
   * run_worker_first has nothing to be an exception to, and the three routes
   * asserted above would be excluded from a behaviour that was never turned
   * on. Pinning it directly is what actually proves the SPA fallback exists.
   */
  it("answers unmatched paths with the SPA shell", () => {
    const assets = config.slice(config.indexOf("[assets]"));
    expect(assets).toMatch(/^not_found_handling\s*=\s*"single-page-application"\s*$/m);
  });
});
