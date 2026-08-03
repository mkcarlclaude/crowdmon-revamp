import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";

beforeAll(installAdminIdentity);
beforeEach(configureAccess);

/**
 * The route exists so a browser has somewhere to navigate that Access will
 * intercept. `/admin` is a static asset with no Access application in front of
 * it (M5.1), so the SPA's old recovery — reload the current URL — could never
 * reach a login screen and looped instead.
 *
 * Cloudflare Access sits in front of this path in production and is not
 * simulated here; what these tests pin is the half the Worker owns. Reaching
 * the handler must require an assertion, and reaching it must send the caller
 * back to the dashboard rather than answering with anything they could read.
 */
describe("GET /api/admin/login", () => {
  it("is gated like every other admin route", async () => {
    const res = await app.request("/api/admin/login", {}, env);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing Access assertion" });
  });

  it("redirects an authenticated caller to the dashboard", async () => {
    const res = await app.request("/api/admin/login", { headers: await adminHeaders() }, env);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin");
  });

  it("ignores a caller-supplied redirect target", async () => {
    // The one endpoint guaranteed to be reached with a freshly minted session
    // is the worst possible open redirect: honouring `redirect_url` here would
    // hand an attacker a credential-phishing hop off a trusted origin.
    const res = await app.request(
      "/api/admin/login?redirect_url=https://evil.example.com/steal",
      { headers: await adminHeaders() },
      env,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin");
  });
});
