import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { vi } from "vitest";

/**
 * A working Google identity for tests that exercise `/api/auth/google/*`.
 *
 * Mirrors `admin-identity.ts`'s own shape for the same reason: mint a keypair
 * in-process, serve its public half at the URL `googleJwks()` (routes/auth.ts)
 * actually fetches, and sign real JWTs against it — so `jwtVerify` runs for
 * real rather than being stubbed out, and a test that weakens verification
 * would actually fail rather than passing on a mock that never checked
 * anything.
 */

export const GOOGLE_CLIENT_ID = "test-google-client-id";
export const GOOGLE_ISSUER = "https://accounts.google.com";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

let signingKey: CryptoKey | undefined;

/** Call once per file, from `beforeAll` — an RSA keypair is slow enough to notice per test. */
export async function installGoogleIdentity() {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  signingKey = privateKey;

  const jwk = { ...(await exportJWK(publicKey)), kid: "google-test-key", alg: "RS256", use: "sig" };

  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url === JWKS_URL) {
      return Promise.resolve(Response.json({ keys: [jwk] }));
    }

    // The token exchange itself is stubbed per-test via `stubTokenExchange`
    // below, not here — what `id_token` it should hand back (and whether the
    // exchange should even succeed) is the thing each test is about.
    return realFetch(input as RequestInfo, init);
  });
}

/**
 * Answers `POST https://oauth2.googleapis.com/token` with a fixed `id_token`
 * (or a non-2xx, for the "google rejected the code" case) regardless of what
 * the request body says — the tests that call this are about what
 * `googleAuthCallbackHandler` does with the response, not about exercising
 * Google's own token endpoint.
 *
 * Replaces whatever `fetch` `installGoogleIdentity` installed with one that
 * still answers the JWKS URL and now also answers the token URL, falling
 * through to the real fetch for anything else — the same layered-stub shape
 * `admin-identity.ts` does not need because it only ever has one URL to fake.
 */
export function stubTokenExchange(idToken: string | null, status = 200) {
  const current = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url === TOKEN_URL) {
      if (idToken === null) {
        return Promise.resolve(new Response("invalid_grant", { status }));
      }
      return Promise.resolve(
        Response.json({ id_token: idToken, access_token: "unused" }, { status }),
      );
    }

    return current(input as RequestInfo, init);
  });
}

export interface GoogleClaims {
  sub?: string;
  email?: string;
  name?: string;
  aud?: string | string[];
  iss?: string;
  /** A jose duration string ("1h") for a token that is still good, or an absolute unix-seconds number in the past for one that has already expired. */
  exp?: string | number;
  /** Omitted defaults to `true` — a verified email is the common case every test but the one about this claim specifically should not have to state. */
  emailVerified?: boolean;
}

/** Mints an `id_token` — real RS256 signature, caller-controlled claims for the failure cases. */
export async function googleIdToken(claims: GoogleClaims = {}): Promise<string> {
  if (!signingKey) throw new Error("call installGoogleIdentity() in beforeAll first");

  const {
    sub = "1234567890",
    email = "friend@example.com",
    name = "Friend",
    aud = GOOGLE_CLIENT_ID,
    iss = GOOGLE_ISSUER,
    exp = "1h",
    emailVerified = true,
  } = claims;

  return new SignJWT({ email, name, email_verified: emailVerified })
    .setSubject(sub)
    .setProtectedHeader({ alg: "RS256", kid: "google-test-key" })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(signingKey);
}
