import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Bindings } from "../../src/bindings";

/**
 * What `cloudflare:test`'s `env` holds: the Worker's own bindings, plus the
 * migration files the config reads off disk and hands in — workerd cannot see
 * the filesystem, so they arrive as data rather than a path.
 */
declare global {
  namespace Cloudflare {
    interface Env extends Bindings {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
