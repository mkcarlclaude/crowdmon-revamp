/**
 * The one thing `routes/auth.ts` (which sets this cookie) and
 * `middleware/session.ts` (which reads it) have to agree on.
 *
 * Split into its own module rather than declared in either file, because
 * either direction would make one of them import from the other for a single
 * string — `middleware/session.ts` importing a route module to get a
 * constant, or `routes/auth.ts` importing a middleware module it does not
 * otherwise depend on. Both are worse than a third file with nothing but the
 * contract itself.
 */

/** The contributor session cookie. `Path=/` — unlike the OAuth state cookie, this has to be sent on every `/api/contribute/*` request. */
export const SESSION_COOKIE_NAME = "cm_session";

/**
 * How long a contributor session lasts before `requireUser` refuses it.
 *
 * 30 days. There is no security reason this could not be shorter — the
 * session id is opaque and revocable, not a capability that widens with age —
 * so the number is a product one: a contributor who verifies a few frames
 * this week and comes back next month should not have to sign in again for
 * that, the same way most consumer products with a "remember me" cookie
 * behave. Contrast Cloudflare Access's 24-hour default (CONTEXT.md §Q19):
 * that session gates production infrastructure and is Cloudflare's own
 * choice, not this application's; this one gates a rate-limited box-drawing
 * form an untrusted account cannot use to affect a label either way.
 */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
