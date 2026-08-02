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
   */
  it("keeps the ungated workers.dev hostname closed", () => {
    expect(config).toMatch(/^workers_dev\s*=\s*false\s*$/m);
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
});
