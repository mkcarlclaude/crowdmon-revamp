import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import type { AppEnv, Bindings } from "../bindings";
import { errorResponse, GoogleAuthCallbackQuery, GoogleAuthStartQuery } from "../schemas";
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from "../session-cookie";

/**
 * Google OAuth in the Worker, and the sessions it mints (M20, plan §B2).
 *
 * Three routes, all outside `/api/admin` and `/api/contribute` on purpose —
 * see `app.ts`'s registration order, which is what actually keeps
 * `requireAccess` from ever running against these paths rather than this
 * file's own path strings being trusted to. `requireUser` (middleware/
 * session.ts) is what gates `/api/contribute/*`; nothing here does, because a
 * caller with no session yet has to be able to reach `/start` to get one.
 *
 * **Why this hand-rolls the protocol instead of a library.** `arctic` was the
 * OAuth client this project chose the last time contributor accounts were on
 * the table (CONTEXT.md §Q7's "Stack" entry) and it is not a dependency here
 * — that decision predates v2's two-tier retreat and was never revisited when
 * this milestone brought accounts back. `jose` already is a dependency: it
 * verifies the Cloudflare Access assertion (`middleware/access.ts`), and
 * verifying Google's `id_token` is the same operation — an RS256 JWT against
 * a JWKS — against a different issuer. State, PKCE and the token exchange
 * are each a few lines of `fetch` and `crypto.subtle`, not enough surface to
 * justify a second OAuth dependency for one provider.
 *
 * **Non-negotiables, matching the plan's own list:**
 * 1. `id_token`'s `iss`, `aud` and signature are verified by `jwtVerify`
 *    against Google's own JWKS — never trusted because the token exchange
 *    request that produced it went to `googleapis.com`. `middleware/
 *    access.ts`'s own comment on why an unchecked `audience` is the
 *    load-bearing failure applies verbatim: every application any Google
 *    Cloud project's OAuth client can mint a token for is signed by the same
 *    keys, so without `audience` here a token minted for an unrelated app
 *    would verify perfectly well.
 * 2. `state` is mandatory, single-use, and read back from an `HttpOnly`
 *    cookie rather than trusted from the query string alone — a caller who
 *    can set their own `state` query parameter could not also forge the
 *    cookie, so the two only agree when this Worker itself set both legs of
 *    the pair. PKCE runs alongside it even though this is a confidential
 *    client (a `client_secret` exists): it costs one SHA-256 and closes code
 *    interception between `/start` and `/callback`.
 * 3. The session id is opaque, random, and checked against `sessions` on
 *    every `requireUser`-gated request — never a self-verifying token. Logout
 *    has to actually revoke a session, and nothing self-verifying can be
 *    revoked without the row lookup a session table already is.
 * 4. **The post-login redirect target is hardcoded to `/contribute`, never
 *    read from a request parameter.** CONTEXT.md §Q19 records this exact bug
 *    class already shipping once in this repo — `/api/admin/login` used to
 *    honour a `redirect_url` parameter before that was corrected, on the
 *    reasoning the callback here is even more exposed to: it is the one
 *    endpoint guaranteed to be reached with a freshly minted session, which
 *    makes it the worst possible open redirect if it ever honoured one.
 * 5. `GOOGLE_CLIENT_SECRET` is a `wrangler secret`, never `wrangler.toml` —
 *    see that file's own warning about TOML table scoping, which is how
 *    `ACCESS_AUD` once made every admin request 503 by landing inside the
 *    wrong `[[table]]`.
 */

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Where a completed login lands. Hardcoded — see this file's module comment, point 4. */
const POST_LOGIN_REDIRECT = "/contribute";

/** How long the OAuth state cookie survives — long enough for a human to work through Google's consent screen, short enough to bound a stale replay's window. */
const OAUTH_STATE_TTL_SECONDS = 10 * 60;

/** The cookie carrying `state` and the PKCE `code_verifier` between `/start` and `/callback`. Scoped to the one path pair that ever reads it. */
const OAUTH_STATE_COOKIE_NAME = "cm_oauth_state";
const OAUTH_STATE_COOKIE_PATH = "/api/auth/google";

/**
 * One JWKS, cached for the isolate's lifetime — `middleware/access.ts`'s own
 * reasoning for why a `Map` per team domain exists there applies here with
 * one entry rather than several: Google is the only issuer this route ever
 * verifies against, so a single module-level set is the whole cache.
 * `createRemoteJWKSet` refetches on its own whenever it meets an unknown
 * `kid`, which is what makes Google's own key rotation a non-event.
 */
let googleJwksSet: ReturnType<typeof createRemoteJWKSet> | undefined;
function googleJwks() {
  if (!googleJwksSet) googleJwksSet = createRemoteJWKSet(new URL(JWKS_URL));
  return googleJwksSet;
}

/** 256 bits of randomness, base64url-encoded — `crypto.getRandomValues`, matching migration 0012's own description of a session id. */
function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // btoa/replace rather than a base64url library: three characters need
  // translating and Workers ships no `Buffer`, so a dependency would buy
  // nothing a three-line translation does not already do.
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE's `code_challenge`: `BASE64URL(SHA256(code_verifier))`, per RFC 7636. */
async function codeChallengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/**
 * The exact URL Google must redirect back to, and the exact URL this route
 * exchanges the code against — the two have to be byte-identical, which is
 * why both `googleStartHandler` and `googleCallbackHandler` call this rather
 * than each building their own.
 *
 * Derived from the *inbound request's* own origin rather than a configured
 * `APP_BASE_URL` var: this deployment is reachable at exactly one hostname in
 * production (`wrangler.toml`'s own comment on `workers_dev = false`), so the
 * request's origin and the registered redirect URI are the same string by
 * construction, and there is nothing a second binding would add except one
 * more value to keep in sync with DNS. This is not the open-redirect hazard
 * point 4 above warns about: Google validates whatever URI arrives here
 * against the exact set registered in its own Console (see the PR body for
 * that list), so an attacker who could somehow control the Host header of
 * the request that reaches `/start` would produce a `redirect_uri` Google
 * simply refuses, not one it follows.
 */
function googleRedirectUri(requestUrl: string): string {
  return `${new URL(requestUrl).origin}/api/auth/google/callback`;
}

/**
 * Turnstile on the signup path (plan §B2). Returns `true` when
 * `TURNSTILE_SECRET_KEY` is unset — see `bindings.ts`'s own comment on why
 * that is a deliberately different posture from `requireAccess`'s fail-closed
 * one: Turnstile stops scripted volume, it is not the boundary between a
 * signed-up account and one that can affect a label, which is `trusted`.
 */
async function verifyTurnstile(env: Bindings, token: string | undefined): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (!token) return false;

  const response = await fetch(TURNSTILE_VERIFY_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret, response: token }),
  });
  if (!response.ok) return false;

  const body = (await response.json()) as { success?: boolean };
  return body.success === true;
}

export const googleAuthStartRoute = createRoute({
  method: "get",
  path: "/api/auth/google/start",
  operationId: "googleAuthStart",
  tags: ["auth"],
  summary: "Begin a Google sign-in",
  description:
    "Mints `state` and a PKCE verifier, stores both in a short-lived `HttpOnly` cookie " +
    "scoped to this path, and 302s to Google's own consent screen. Verified by Turnstile " +
    "first whenever this deployment has `TURNSTILE_SECRET_KEY` configured.",
  request: { query: GoogleAuthStartQuery },
  responses: {
    302: {
      description: "Redirecting to Google's consent screen",
      headers: {
        Location: {
          description: "Google's authorization endpoint",
          schema: { type: "string" as const },
        },
      },
    },
    403: errorResponse("Turnstile verification failed"),
    503: errorResponse("Google sign-in is not configured on this deployment"),
  },
});

export const googleAuthStartHandler: RouteHandler<typeof googleAuthStartRoute, AppEnv> = async (
  c,
) => {
  const clientId = c.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return c.json({ error: "google sign-in is not configured on this deployment" }, 503);
  }

  const { turnstile_token } = c.req.valid("query");
  if (!(await verifyTurnstile(c.env, turnstile_token))) {
    return c.json({ error: "turnstile verification failed" }, 403);
  }

  const state = randomToken(24);
  const verifier = randomToken(32);
  const challenge = await codeChallengeFor(verifier);

  // One cookie, `state` and `verifier` joined by a character neither ever
  // contains — both are base64url output, whose alphabet excludes `.` by
  // construction, so this needs no JSON and no second encoding step.
  setCookie(c, OAUTH_STATE_COOKIE_NAME, `${state}.${verifier}`, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: OAUTH_STATE_COOKIE_PATH,
    maxAge: OAUTH_STATE_TTL_SECONDS,
  });

  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", googleRedirectUri(c.req.url));
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "openid email profile");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  return c.redirect(authorizeUrl.toString(), 302);
};

export const googleAuthCallbackRoute = createRoute({
  method: "get",
  path: "/api/auth/google/callback",
  operationId: "googleAuthCallback",
  tags: ["auth"],
  summary: "Complete a Google sign-in",
  description:
    "Verifies `state` against the cookie `/start` set, exchanges the code for an " +
    "`id_token` (PKCE, no `state` reuse), verifies it against Google's JWKS, upserts " +
    "`users` by `google_sub`, opens a session, and redirects to `/contribute` — always " +
    "that path, never a caller-supplied one (see this file's module comment).",
  request: { query: GoogleAuthCallbackQuery },
  responses: {
    302: {
      description: "Signed in; redirecting to /contribute",
      headers: {
        Location: { description: "Always /contribute", schema: { type: "string" as const } },
      },
    },
    401: errorResponse(
      "Google declined consent, the state did not match, the code exchange failed, or the " +
        "id_token failed verification",
    ),
    503: errorResponse("Google sign-in is not configured on this deployment"),
  },
});

export const googleAuthCallbackHandler: RouteHandler<
  typeof googleAuthCallbackRoute,
  AppEnv
> = async (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID;
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return c.json({ error: "google sign-in is not configured on this deployment" }, 503);
  }

  const { code, state: returnedState, error } = c.req.valid("query");

  // Consumed once regardless of outcome below — a state cookie that survives
  // a failed callback is a second chance for the same value to be replayed,
  // and single-use is the whole point of it.
  const stored = getCookie(c, OAUTH_STATE_COOKIE_NAME);
  deleteCookie(c, OAUTH_STATE_COOKIE_NAME, { path: OAUTH_STATE_COOKIE_PATH });

  // Google's own escape hatch — declined consent or a misconfigured client
  // arrives as `error`, never alongside a `code`. Checked before `state` so a
  // visitor who declined consent gets a message about that rather than one
  // about a missing cookie their browser was never going to have sent for a
  // flow it didn't complete.
  if (error) return c.json({ error: `google sign-in failed: ${error}` }, 401);

  if (!stored) return c.json({ error: "missing or expired oauth state" }, 401);

  const [expectedState, verifier] = stored.split(".");
  if (!expectedState || !verifier || expectedState !== returnedState) {
    return c.json({ error: "oauth state did not match" }, 401);
  }

  if (!code) return c.json({ error: "google returned no authorization code" }, 401);

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: googleRedirectUri(c.req.url),
        grant_type: "authorization_code",
        code_verifier: verifier,
      }),
    });
  } catch {
    return c.json({ error: "could not reach google's token endpoint" }, 401);
  }

  if (!tokenResponse.ok) {
    return c.json({ error: "google rejected the authorization code" }, 401);
  }

  const tokenBody = (await tokenResponse.json()) as { id_token?: unknown };
  if (typeof tokenBody.id_token !== "string") {
    return c.json({ error: "google's token response carried no id_token" }, 401);
  }

  let payload: JWTPayload;
  try {
    // `audience` is the load-bearing option here for exactly the reason
    // `middleware/access.ts`'s comment gives for its own JWKS verification —
    // see this file's module comment, point 1.
    ({ payload } = await jwtVerify(tokenBody.id_token, googleJwks(), {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: clientId,
    }));
  } catch {
    // Deliberately not reporting which check failed — `middleware/access.ts`
    // makes the same choice for the same reason: the caller is either Google,
    // which knows, or someone who should not be told which part of their
    // forgery was rejected.
    return c.json({ error: "invalid id_token" }, 401);
  }

  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const email = typeof payload.email === "string" ? payload.email : "";
  const displayName = typeof payload.name === "string" ? payload.name : null;

  if (!sub || !email) {
    return c.json({ error: "id_token carried no sub or email claim" }, 401);
  }

  // Google issues an `id_token` for an account whose email address it has
  // not confirmed the holder controls — a freshly-added, unverified alias on
  // an otherwise real account is enough. `sub` is this table's identity
  // (migration 0012's own comment, echoed above), so this is deliberately
  // *not* the same class of check as `audience` or `issuer`: nothing here
  // authorizes off `users.email` — it is display and admin recognition only,
  // and rejecting on it does not close an auth hole the way the audience
  // check does. What it protects is the two screens that *show* the address
  // back — `/api/contribute/me` and the admin annotations page — from
  // rendering one a signed-in account does not actually control. Checked
  // with `=== false` rather than `!payload.email_verified`: Google's own
  // docs describe the claim as present and boolean on every response this
  // flow requests, but treating an absent claim as a pass rather than a
  // failure is the conservative reading if some response ever omits it.
  if (payload.email_verified === false) {
    return c.json({ error: "invalid id_token" }, 401);
  }

  // Upserted by `google_sub`, never by `email` — migration 0012's own
  // comment on why the subject, not the address, is this table's identity.
  // `RETURNING id` rather than a read-then-write: two concurrent logins for
  // the same brand-new account would otherwise race between the check and
  // the insert, the same shape `idx_jobs_one_prelabel_per_video`'s own
  // comment describes for a different table.
  const user = await c.env.DB.prepare(
    `INSERT INTO users (google_sub, email, display_name)
          VALUES (?, ?, ?)
     ON CONFLICT (google_sub) DO UPDATE SET email = excluded.email, display_name = excluded.display_name
     RETURNING id`,
  )
    .bind(sub, email, displayName)
    .first<{ id: number }>();

  if (!user) return c.json({ error: "could not record the account" }, 401);

  const sessionId = randomToken(32);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;

  await c.env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(sessionId, user.id, expiresAt)
    .run();

  setCookie(c, SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });

  return c.redirect(POST_LOGIN_REDIRECT, 302);
};

export const logoutRoute = createRoute({
  method: "post",
  path: "/api/auth/logout",
  operationId: "logout",
  tags: ["auth"],
  summary: "End the caller's contributor session",
  description:
    "Deletes the `sessions` row the cookie names, if any, and clears the cookie either " +
    "way. Never fails on a missing or already-invalid session — logging out of a session " +
    "that no longer exists is success, not an error, the same as it would be for any " +
    "caller who simply waited for it to expire.",
  responses: {
    204: { description: "Logged out (or already was)" },
  },
});

export const logoutHandler: RouteHandler<typeof logoutRoute, AppEnv> = async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE_NAME);

  if (sessionId) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
  }

  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });

  return c.body(null, 204);
};
