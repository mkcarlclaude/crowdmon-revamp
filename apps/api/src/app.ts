import { Hono } from "hono";
import type { Bindings } from "./bindings";
import { nameSpanAfterRoute } from "./middleware/trace-route";

/**
 * The routes, with no knowledge of how the Worker is bootstrapped.
 *
 * Kept apart from index.ts on purpose: `instrument()` reaches for
 * `cloudflare:workers`, a module only workerd can resolve, so anything that
 * imports the entry point can only run inside the real runtime. Tests import
 * this file and stay on plain Node.
 */
export const app = new Hono<{ Bindings: Bindings }>();

app.use("*", nameSpanAfterRoute);

app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "crowdmon-api",
    environment: c.env?.ENVIRONMENT ?? "unknown",
  }),
);

app.notFound((c) => c.json({ error: "not found" }, 404));
