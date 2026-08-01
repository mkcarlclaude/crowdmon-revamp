import { Hono } from "hono";

export type Bindings = {
  // Populated by Terraform in M1.3 — see infra/. Bindings are added here as
  // they are provisioned, so the type stays honest about what actually exists.
  ENVIRONMENT: string;
  DB: D1Database;
  FRAMES: R2Bucket;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "crowdmon-api",
    environment: c.env?.ENVIRONMENT ?? "unknown",
  }),
);

app.notFound((c) => c.json({ error: "not found" }, 404));

export default app;
