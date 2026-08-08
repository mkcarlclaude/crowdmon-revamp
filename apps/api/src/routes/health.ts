import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../bindings";
import { HealthResponse } from "../schemas";

export const healthRoute = createRoute({
  method: "get",
  path: "/health",
  operationId: "getHealth",
  tags: ["meta"],
  summary: "Liveness and deployment identity",
  responses: {
    200: {
      description: "The Worker is up",
      content: { "application/json": { schema: HealthResponse } },
    },
  },
});

export const healthHandler: RouteHandler<typeof healthRoute, AppEnv> = (c) =>
  c.json({
    status: "ok" as const,
    service: "crowdmon-api" as const,
    // Optional-chained because `app.request()` can be called with no bindings
    // at all. A Worker deployed without ENVIRONMENT reporting "unknown" beats
    // one that throws on its own health check.
    environment: c.env?.ENVIRONMENT ?? "unknown",
  });
