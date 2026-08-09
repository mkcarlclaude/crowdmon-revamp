import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../../src/app";

/**
 * M14.3: "not at scale" enforced by a mechanism, not asserted in a document.
 *
 * `wrangler.toml`'s `PUBLIC_RATE_LIMITER` binding allows 20 requests per 60
 * seconds per (bucket, ip). No `cf-connecting-ip` header reaches this test
 * harness, so every request in this file shares the one `"unknown"` bucket
 * `publicRateLimit` falls back to — which is exactly what makes the 21st
 * request in a tight loop provable without a real client IP to vary.
 *
 * A `404` on the frame route (no public-sample image seeded) proves the
 * limiter let the request through to the handler; a `429` proves it did not
 * reach the handler at all.
 */

async function hitFrame(): Promise<Response> {
  return app.request("/api/public/frame", {}, env);
}

describe("the public rate limit", () => {
  it("admits the first 20 requests and refuses the 21st", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      statuses.push((await hitFrame()).status);
    }

    expect(statuses.slice(0, 20)).toEqual(Array(20).fill(404));
    expect(statuses[20]).toBe(429);
  });
});
