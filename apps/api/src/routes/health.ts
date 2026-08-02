import { createRoute, type RouteHandler, z } from "@hono/zod-openapi";
import type { Bindings } from "../bindings";

const HealthResponse = z
  .object({
    status: z.literal("ok"),
    service: z.literal("crowdmon-api"),
    // Echoed back so a response proves *which* deployment answered, not just
    // that something did. The deploy workflow curls this after every release.
    environment: z.string().openapi({ example: "production" }),
  })
  .openapi("HealthResponse");

export const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["meta"],
  summary: "Liveness and deployment identity",
  responses: {
    200: {
      description: "The Worker is up",
      content: { "application/json": { schema: HealthResponse } },
    },
  },
});

export const healthHandler: RouteHandler<typeof healthRoute, { Bindings: Bindings }> = (c) =>
  c.json({
    status: "ok" as const,
    service: "crowdmon-api" as const,
    // `c.env` is undefined when the app is exercised without bindings, which
    // is how the tests call it — an unbound Worker reporting "unknown" is more
    // useful than one that throws.
    environment: c.env?.ENVIRONMENT ?? "unknown",
  });
