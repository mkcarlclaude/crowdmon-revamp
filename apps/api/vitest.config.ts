import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Two projects, split by what the tests actually need.
 *
 * `test/workers` runs inside workerd against a real D1. A SQLite stand-in
 * behind the `D1Database` interface would have been testing the stand-in: the
 * claim endpoint's correctness argument is that `UPDATE ... RETURNING` is
 * atomic because SQLite serialises writers, and `meta.changes` is what
 * distinguishes "renewed a lease" from "that job is not yours". Neither
 * survives a fake.
 *
 * `test/node` runs on plain Node, for the two things workerd cannot do: the
 * spec drift check reads the committed file off disk with `node:fs`, and
 * @opentelemetry/api's ESM build does not resolve under workerd's module
 * loader. Both test code that has no bindings in it anyway.
 *
 * Storage isolation between files is the pool's own default in 0.20 — there is
 * no longer an `isolatedStorage` option to set.
 */

// Read at config time and handed to the Worker as a binding: the migration
// files live on disk, which the test process can see and workerd cannot.
const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            // The same wrangler.toml production uses, so the test D1 is bound
            // the same way and migrations land in the database under test.
            wrangler: { configPath: "./wrangler.toml" },
            miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
          }),
        ],
        test: {
          name: "workers",
          include: ["test/workers/**/*.test.ts"],
          setupFiles: ["./test/workers/setup.ts"],
        },
      },
      {
        test: {
          name: "node",
          include: ["test/node/**/*.test.ts"],
        },
      },
    ],
  },
});
