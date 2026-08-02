import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { specPath } from "../scripts/spec-path";
import { app } from "../src/app";
import { openApiConfig } from "../src/openapi";

const committed = JSON.parse(readFileSync(specPath, "utf8")) as unknown;

describe("the committed spec", () => {
  it("matches what the routes currently declare", () => {
    // The drift guard. M3.3 generates the Go worker's types from the committed
    // file, so a route change that never reaches disk would ship an edge that
    // no longer matches the client calling it. Run `pnpm run openapi`.
    expect(app.getOpenAPIDocument(openApiConfig)).toEqual(committed);
  });

  it("is served by the Worker itself", async () => {
    const res = await app.request("/openapi.json", {}, { ENVIRONMENT: "test" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(committed);
  });
});
