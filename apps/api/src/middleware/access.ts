import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Bindings } from "../bindings";

/**
 * Verifies the Cloudflare Access assertion on admin requests.
 *
 * Access already sits in front of `api.crowdmon.mkcarl.com/api/admin`, so this
 * looks redundant. It is not. The same Worker is served on
 * `crowdmon-api.mkcarl-dev.workers.dev`, where no Access application exists
 * and no assertion is ever added — reaching this code does not mean a request
 * passed Access. Without the check below, knowing the workers.dev hostname
 * would be enough to reach the admin API.
 *
 * The two gates also fail independently. The Access policy lives in Terraform;
 * the allowlist is a Worker secret. Widening one does not widen the other.
 */

/**
 * One JWKS per team domain, cached for the isolate's lifetime.
 *
 * `createRemoteJWKSet` does its own caching and refetches when it meets an
 * unknown `kid`, which is what makes Cloudflare's key rotation a non-event.
 * Building a new one per request would throw that away and fetch on every
 * admin call.
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(teamDomain: string) {
  let set = jwksCache.get(teamDomain);
  if (!set) {
    set = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, set);
  }
  return set;
}

export const requireAccess = createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
  const teamDomain = c.env.ACCESS_TEAM_DOMAIN;
  const aud = c.env.ACCESS_AUD;
  const admins = c.env.ADMIN_EMAILS;

  // Fail closed, and loudly. A deploy that forgets one of these must not be a
  // deploy that publishes the admin API unprotected — 503 rather than 500
  // because the endpoint is genuinely unavailable rather than broken, and it
  // says so in a way that shows up as an outage instead of as silence.
  if (!teamDomain || !aud || !admins) {
    return c.json({ error: "admin access is not configured" }, 503);
  }

  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token) {
    return c.json({ error: "missing Access assertion" }, 401);
  }

  let email: string;
  try {
    // `audience` is the load-bearing option. Every application in one Access
    // organisation is signed by the same keys, so without it a token minted
    // for otlp.mkcarl.com would verify here perfectly well.
    const { payload } = await jwtVerify(token, jwks(teamDomain), {
      issuer: teamDomain,
      audience: aud,
    });
    email = typeof payload.email === "string" ? payload.email : "";
  } catch {
    // Deliberately not reporting which check failed. The caller is either
    // Access, in which case it knows, or someone who should not be told
    // whether their forgery was rejected for its signature or its audience.
    return c.json({ error: "invalid Access assertion" }, 401);
  }

  if (!isAdmin(email, admins)) {
    return c.json({ error: "not an administrator" }, 403);
  }

  await next();
});

/**
 * Case- and whitespace-insensitive, because the allowlist is typed by hand
 * into a secret and email addresses are not case-sensitive in the part that
 * matters here.
 */
function isAdmin(email: string, allowlist: string): boolean {
  if (!email) return false;

  return allowlist
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.trim().toLowerCase());
}
