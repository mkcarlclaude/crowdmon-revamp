import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../../src/app";

describe("GET /health", () => {
  it("returns 200 with service identity", async () => {
    const res = await app.request("/health", {}, env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: "ok",
      service: "crowdmon-api",
      // From wrangler.toml, the same var production sets: the point of the
      // field is to prove which deployment answered.
      environment: "production",
    });
  });
});

describe("unknown routes", () => {
  it("returns a JSON 404 rather than an HTML body", async () => {
    const res = await app.request("/nope", {}, env);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "not found" });
  });
});
