import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "../src/app";
import { openApiConfig } from "../src/openapi";

/**
 * Writes the OpenAPI document to `apps/api/openapi.json`.
 *
 * The file is committed rather than built on demand. M3.3 generates the Go
 * worker's types from it, and a committed spec means that generation needs no
 * Node toolchain, a contract change shows up as a reviewable diff in the PR
 * that causes it, and CI can fail on drift with `git diff --exit-code`.
 *
 * Resolved against this file rather than `process.cwd()` so the output lands
 * in the same place whether it is run from the package or the repo root.
 * `fileURLToPath` takes the string form: @cloudflare/workers-types replaces
 * the global `URL`, and node's typings reject that one even though it is the
 * same object at runtime.
 */
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "openapi.json");

writeFileSync(out, `${JSON.stringify(app.getOpenAPIDocument(openApiConfig), null, 2)}\n`);

console.log(`wrote ${out}`);
