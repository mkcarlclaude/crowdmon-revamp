import { env } from "cloudflare:test";
import { generateKeyPair, SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import {
  ADMIN_EMAIL,
  AUD,
  assertion,
  configureAccess,
  installAdminIdentity,
  TEAM_DOMAIN,
  testSigningKey,
} from "./admin-identity";

/**
 * Access is the outer gate; this covers the inner one.
 *
 * The Worker verifies the assertion itself rather than trusting that a request
 * reached it at all, because reaching it does not imply passing Access: the
 * same code is served on `crowdmon-api.mkcarl-dev.workers.dev`, where no
 * Access application exists. Anyone who knows that hostname would otherwise
 * have an unauthenticated path straight to the admin API.
 */

function submit(headers: Record<string, string>) {
  return app.request(
    "/api/admin/videos",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ url: "https://youtu.be/dQw4w9WgXcQ" }),
    },
    env,
  );
}

beforeAll(installAdminIdentity);
beforeEach(configureAccess);

describe("admin endpoints without a valid assertion", () => {
  it("rejects a request with no assertion header", async () => {
    const res = await submit({});

    expect(res.status).toBe(401);
  });

  it("rejects an assertion signed by someone else", async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const forged = await new SignJWT({ email: ADMIN_EMAIL })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(TEAM_DOMAIN)
      .setAudience(AUD)
      .setExpirationTime("1h")
      .sign(privateKey);

    const res = await submit({ "Cf-Access-Jwt-Assertion": forged });

    expect(res.status).toBe(401);
  });

  it("rejects an assertion for a different Access application", async () => {
    // The aud tag is what ties the token to *this* application. Every app in
    // one Access organisation is signed by the same keys, so without this
    // check a token minted for otlp.mkcarl.com would open the admin API.
    const res = await submit({ "Cf-Access-Jwt-Assertion": await assertion({}, "some-other-app") });

    expect(res.status).toBe(401);
  });

  it("rejects an expired assertion", async () => {
    const expired = await new SignJWT({ email: ADMIN_EMAIL })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(TEAM_DOMAIN)
      .setAudience(AUD)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(testSigningKey());

    const res = await submit({ "Cf-Access-Jwt-Assertion": expired });

    expect(res.status).toBe(401);
  });
});

describe("the role check behind Access", () => {
  it("refuses an identity Access let through but this Worker does not know", async () => {
    // Defence in depth, and not theoretical: the Access policy is edited in
    // Terraform, the allowlist is a Worker secret, and widening one does not
    // widen the other.
    const res = await submit({
      "Cf-Access-Jwt-Assertion": await assertion({ email: "stranger@example.com" }),
    });

    expect(res.status).toBe(403);
  });

  it("admits an allowlisted identity", async () => {
    const res = await submit({ "Cf-Access-Jwt-Assertion": await assertion() });

    expect(res.status).toBe(201);
  });

  it("matches the allowlist without regard to case or spacing", async () => {
    env.ADMIN_EMAILS = " Admin@Example.com , someone@else.com ";

    const res = await submit({ "Cf-Access-Jwt-Assertion": await assertion() });

    expect(res.status).toBe(201);
  });
});

describe("a Worker that is not configured for Access", () => {
  it("refuses admin requests rather than serving them unprotected", async () => {
    env.ACCESS_AUD = "";

    // Fail closed. A deploy that forgets the aud tag must not be a deploy that
    // publishes the admin API — the failure has to be visible immediately, not
    // discovered later.
    const res = await submit({ "Cf-Access-Jwt-Assertion": await assertion() });

    expect(res.status).toBe(503);
  });
});

describe("endpoints outside /api/admin", () => {
  it("does not require an assertion on the worker queue", async () => {
    const res = await app.request(
      "/api/jobs/claim",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worker_id: "w1" }),
      },
      env,
    );

    // The Go worker has no Access identity and polls this constantly. Gating
    // it would break the queue rather than secure it.
    expect(res.status).toBe(204);
  });

  it("does not require an assertion on health", async () => {
    const res = await app.request("/health", {}, env);

    expect(res.status).toBe(200);
  });
});
