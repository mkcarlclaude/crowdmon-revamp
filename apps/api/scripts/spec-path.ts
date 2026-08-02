import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the emitted OpenAPI document lives. Shared by the writer and the test
 * that reads it back, so the two cannot end up pointing at different files.
 *
 * Resolved against this module rather than `process.cwd()`, so it is the same
 * path whether a command runs from the package or the repo root. Built from
 * the *string* form of `import.meta.url` because @cloudflare/workers-types
 * replaces the global `URL`, and node's typings reject that one even though
 * it is the same object at runtime.
 *
 * Lives under `scripts/` rather than `src/` deliberately: `src` is bundled
 * into the Worker, and nothing that reaches for `node:path` belongs there.
 */
export const specPath = join(dirname(fileURLToPath(import.meta.url)), "..", "openapi.json");
