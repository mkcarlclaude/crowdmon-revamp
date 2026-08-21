import { env } from "cloudflare:test";
import { generateKeyPair, SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_ISSUER,
  googleIdToken,
  installGoogleIdentity,
  stubTokenExchange,
} from "./google-identity";

/**
 * `/api/auth/google/*` (M20, plan §B2, §B6).
 *
 * `id_token` verification is the security-critical half of this file —
 * `middleware/access.ts`'s own comment on why an unchecked `audience` is the
 * load-bearing failure in JWT verification applies verbatim to Google's
 * token, and each of the four rejection cases plan §B6 lists gets its own
 * test rather than one parametrized "invalid token" case, so a regression in
 * any one check shows up as a named failure rather than a shared one.
 */

beforeAll(installGoogleIdentity);

beforeEach(() => {
  env.GOOGLE_CLIENT_ID = GOOGLE_CLIENT_ID;
  env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
  env.TURNSTILE_SECRET_KEY = undefined;
});

/**
 * The one `Set-Cookie` header whose name matches, as a `name=value` pair a
 * request's own `cookie` header can carry. `Headers.get("set-cookie")` only
 * ever returns one of possibly several `Set-Cookie` headers on a response —
 * `getSetCookie()` is the array-returning method the Fetch spec added for
 * exactly this ambiguity, needed here because `googleAuthCallbackHandler`
 * sets two on one response: the oauth-state cookie's deletion and the new
 * session cookie.
 */
function cookieNamed(res: Response, name: string): string {
  const header = res.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  if (!header) throw new Error(`no Set-Cookie header named ${name}`);
  return header.split(";")[0] ?? "";
}

/** Starts the flow and returns the state cookie and the `state` Google would echo back. */
async function start(): Promise<{ cookie: string; state: string }> {
  const res = await app.request("/api/auth/google/start", { redirect: "manual" }, env);
  expect(res.status).toBe(302);

  const cookie = cookieNamed(res, "cm_oauth_state");

  const location = new URL(res.headers.get("location") ?? "");
  const state = location.searchParams.get("state");
  if (!state) throw new Error("no state on the authorize URL");

  return { cookie, state };
}

async function callback(query: string, cookie?: string): Promise<Response> {
  return app.request(
    `/api/auth/google/callback?${query}`,
    { redirect: "manual", headers: cookie ? { cookie } : {} },
    env,
  );
}

describe("GET /api/auth/google/start", () => {
  it("302s to Google's own consent screen with state and a PKCE challenge", async () => {
    const res = await app.request("/api/auth/google/start", { redirect: "manual" }, env);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(location.searchParams.get("client_id")).toBe(GOOGLE_CLIENT_ID);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("state")).toBeTruthy();

    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("answers 503 when no Google client is configured", async () => {
    env.GOOGLE_CLIENT_ID = undefined;

    const res = await app.request("/api/auth/google/start", {}, env);
    expect(res.status).toBe(503);
  });
});

describe("GET /api/auth/google/callback", () => {
  it("signs in on a valid id_token: creates a user, opens a session, redirects to /contribute", async () => {
    const { cookie, state } = await start();
    const idToken = await googleIdToken({ sub: "sub-happy-path", email: "friend@example.com" });
    stubTokenExchange(idToken);

    const res = await callback(`code=abc&state=${state}`, cookie);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/contribute");
    const sessionCookieHeader = res.headers
      .getSetCookie()
      .find((value) => value.startsWith("cm_session="));
    expect(sessionCookieHeader).toContain("cm_session=");
    expect(sessionCookieHeader).toContain("HttpOnly");

    const user = await env.DB.prepare("SELECT email, trusted FROM users WHERE google_sub = ?")
      .bind("sub-happy-path")
      .first<{ email: string; trusted: number }>();
    expect(user).toEqual({ email: "friend@example.com", trusted: 0 });
  });

  it("ignores a caller-supplied redirect target — the freshly-minted-session callback is the worst possible open redirect", async () => {
    const { cookie, state } = await start();
    stubTokenExchange(await googleIdToken({ sub: "sub-redirect-probe" }));

    const res = await callback(
      `code=abc&state=${state}&redirect_url=${encodeURIComponent("https://evil.example.com/steal")}`,
      cookie,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/contribute");
  });

  // Plan §B6: four separate id_token rejection cases.

  it("rejects a wrong aud", async () => {
    const { cookie, state } = await start();
    stubTokenExchange(await googleIdToken({ aud: "someone-elses-client-id" }));

    const res = await callback(`code=abc&state=${state}`, cookie);
    expect(res.status).toBe(401);
  });

  it("rejects a wrong iss", async () => {
    const { cookie, state } = await start();
    stubTokenExchange(await googleIdToken({ iss: "https://not-google.example.com" }));

    const res = await callback(`code=abc&state=${state}`, cookie);
    expect(res.status).toBe(401);
  });

  it("rejects an expired exp", async () => {
    const { cookie, state } = await start();
    stubTokenExchange(await googleIdToken({ exp: Math.floor(Date.now() / 1000) - 3600 }));

    const res = await callback(`code=abc&state=${state}`, cookie);
    expect(res.status).toBe(401);
  });

  it("rejects a bad signature — signed by a key other than the one at Google's own JWKS", async () => {
    const { cookie, state } = await start();

    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const forged = await new SignJWT({ email: "friend@example.com" })
      .setSubject("sub-forged")
      .setProtectedHeader({ alg: "RS256", kid: "google-test-key" })
      .setIssuer(GOOGLE_ISSUER)
      .setAudience(GOOGLE_CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    stubTokenExchange(forged);

    const res = await callback(`code=abc&state=${state}`, cookie);
    expect(res.status).toBe(401);

    const user = await env.DB.prepare("SELECT id FROM users WHERE google_sub = ?")
      .bind("sub-forged")
      .first();
    expect(user).toBeNull();
  });

  it("rejects an id_token whose email Google has not verified — a signed-in account should not be able to present an address it does not control", async () => {
    const { cookie, state } = await start();
    stubTokenExchange(await googleIdToken({ sub: "sub-unverified-email", emailVerified: false }));

    const res = await callback(`code=abc&state=${state}`, cookie);
    expect(res.status).toBe(401);

    const user = await env.DB.prepare("SELECT id FROM users WHERE google_sub = ?")
      .bind("sub-unverified-email")
      .first();
    expect(user).toBeNull();
  });

  it("rejects a missing state cookie", async () => {
    const res = await callback("code=abc&state=whatever");
    expect(res.status).toBe(401);
  });

  it("rejects a state that does not match the cookie", async () => {
    const { cookie } = await start();
    // A token exchange that would succeed if the mismatch were not caught —
    // without this, a broken state check would still answer 401 for the
    // wrong reason (no stubbed token endpoint to reach), and the test would
    // pass whether or not the comparison actually ran.
    stubTokenExchange(await googleIdToken({ sub: "sub-should-not-sign-in" }));

    const res = await callback("code=abc&state=not-the-real-state", cookie);
    expect(res.status).toBe(401);

    const user = await env.DB.prepare("SELECT id FROM users WHERE google_sub = ?")
      .bind("sub-should-not-sign-in")
      .first();
    expect(user).toBeNull();
  });

  it("rejects google's own error param without touching the state cookie logic", async () => {
    const { cookie } = await start();

    const res = await callback("error=access_denied&state=irrelevant", cookie);
    expect(res.status).toBe(401);
  });

  it("two logins for one google_sub produce one users row, and a fresh session each time", async () => {
    const first = await start();
    stubTokenExchange(await googleIdToken({ sub: "sub-repeat", email: "friend@example.com" }));
    const firstRes = await callback(`code=abc&state=${first.state}`, first.cookie);
    const firstSession = cookieNamed(firstRes, "cm_session");

    const second = await start();
    stubTokenExchange(await googleIdToken({ sub: "sub-repeat", email: "friend@example.com" }));
    const secondRes = await callback(`code=abc&state=${second.state}`, second.cookie);
    const secondSession = cookieNamed(secondRes, "cm_session");

    expect(firstRes.status).toBe(302);
    expect(secondRes.status).toBe(302);
    expect(firstSession).not.toEqual(secondSession);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE google_sub = ?")
      .bind("sub-repeat")
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("updates the stored email when the same google_sub returns with a new one, without creating a second row", async () => {
    const first = await start();
    stubTokenExchange(await googleIdToken({ sub: "sub-email-change", email: "old@example.com" }));
    await callback(`code=abc&state=${first.state}`, first.cookie);

    const second = await start();
    stubTokenExchange(await googleIdToken({ sub: "sub-email-change", email: "new@example.com" }));
    await callback(`code=abc&state=${second.state}`, second.cookie);

    const rows = await env.DB.prepare("SELECT id, email FROM users WHERE google_sub = ?")
      .bind("sub-email-change")
      .all<{ id: number; email: string }>();

    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.email).toBe("new@example.com");
  });

  it("answers 503 when no Google client is configured", async () => {
    env.GOOGLE_CLIENT_SECRET = undefined;

    const res = await callback("code=abc&state=whatever");
    expect(res.status).toBe(503);
  });
});

describe("POST /api/auth/logout", () => {
  it("revokes the session: the same cookie replayed afterward is unauthenticated", async () => {
    const { cookie, state } = await start();
    stubTokenExchange(await googleIdToken({ sub: "sub-logout", email: "friend@example.com" }));
    const loginRes = await callback(`code=abc&state=${state}`, cookie);
    const sessionCookie = cookieNamed(loginRes, "cm_session");

    const before = await app.request(
      "/api/contribute/me",
      { headers: { cookie: sessionCookie } },
      env,
    );
    expect(before.status).toBe(200);

    const logout = await app.request(
      "/api/auth/logout",
      { method: "POST", headers: { cookie: sessionCookie } },
      env,
    );
    expect(logout.status).toBe(204);

    const after = await app.request(
      "/api/contribute/me",
      { headers: { cookie: sessionCookie } },
      env,
    );
    expect(after.status).toBe(401);
  });

  it("succeeds even with no session cookie at all", async () => {
    const res = await app.request("/api/auth/logout", { method: "POST" }, env);
    expect(res.status).toBe(204);
  });
});
