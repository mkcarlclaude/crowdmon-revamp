import { applyD1Migrations, env } from "cloudflare:test";

/**
 * Applies `migrations/` to the test D1 before any test runs.
 *
 * The same files production runs, in the same order, rather than a schema
 * written for tests: the queue's guarantees are largely constraints — the
 * partial unique index that makes a second download job impossible, the CHECK
 * on `status` — and a test schema that omitted one would prove nothing.
 */
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
