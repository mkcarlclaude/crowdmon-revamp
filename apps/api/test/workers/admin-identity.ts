import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { vi } from "vitest";

/**
 * A working Access identity for tests that are not about Access.
 *
 * `/api/admin/*` is gated, so every test that submits a video needs a valid
 * assertion whether or not that is what it is testing. This mints one against
 * a keypair generated in-process, and serves the matching JWKS at the team
 * domain so the middleware's own verification runs for real rather than being
 * stubbed out.
 */

export const TEAM_DOMAIN = "https://mkcarl.cloudflareaccess.com";
export const AUD = "test-aud-tag";
export const ADMIN_EMAIL = "admin@example.com";

let signingKey: CryptoKey | undefined;

/**
 * Call once per file, from `beforeAll`. Generating a 2048-bit RSA key is slow
 * enough to notice if it happens per test.
 */
export async function installAdminIdentity() {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  signingKey = privateKey;

  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };

  // Only the certs URL is intercepted; everything else falls through to the
  // real fetch. `createRemoteJWKSet` refetches whenever it meets an unknown
  // kid, so this has to keep answering rather than being a one-shot.
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
      return Promise.resolve(Response.json({ keys: [jwk] }));
    }
    return realFetch(input as RequestInfo, init);
  });
}

/** Call from `beforeEach`: individual tests overwrite these to test failures. */
export function configureAccess() {
  env.ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
  env.ACCESS_AUD = AUD;
  env.ADMIN_EMAILS = ADMIN_EMAIL;
}

export async function assertion(
  claims: Record<string, unknown> = {},
  aud: string | string[] = AUD,
) {
  if (!signingKey) throw new Error("call installAdminIdentity() in beforeAll first");

  return new SignJWT({ email: ADMIN_EMAIL, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(TEAM_DOMAIN)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signingKey);
}

/** Headers for a request that should be admitted. */
export async function adminHeaders(): Promise<Record<string, string>> {
  return { "Cf-Access-Jwt-Assertion": await assertion() };
}

/** The signing key, for tests that need to mint something deliberately wrong. */
export function testSigningKey(): CryptoKey {
  if (!signingKey) throw new Error("call installAdminIdentity() in beforeAll first");
  return signingKey;
}
