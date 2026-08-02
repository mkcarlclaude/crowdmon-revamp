import { writeFileSync } from "node:fs";
import { app } from "../src/app";
import { openApiConfig } from "../src/openapi";
import { specPath } from "./spec-path";

/**
 * Writes the OpenAPI document to `apps/api/openapi.json`.
 *
 * The file is committed rather than built on demand. M3.3 generates the Go
 * worker's types from it, and a committed spec means that generation needs no
 * Node toolchain and a contract change shows up as a reviewable diff in the
 * PR that causes it.
 *
 * Forgetting to run this is caught by `test/openapi.test.ts`, which compares
 * the committed file against what the routes currently declare.
 */
writeFileSync(specPath, `${JSON.stringify(app.getOpenAPIDocument(openApiConfig), null, 2)}\n`);

console.log(`wrote ${specPath}`);
