import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../bindings";
import { SESSION_COOKIE_NAME } from "../session-cookie";

/**
 * Verifies a contributor's session cookie, alongside `requireAccess` rather
 * than composed with it (M20, plan §B3).
 *
 * The two middlewares answer different questions and must never both run on
 * one route. `requireAccess` verifies a Cloudflare Access assertion and asks
 * "is this caller one of the admin allowlist's fixed set of people";
 * `requireUser` verifies an opaque session id against a row this Worker
 * itself wrote and asks "is this caller *a* signed-in contributor," a set
 * that is open to anyone who completes a Google login. An admin is not
 * automatically a contributor and does not need to be — the admin already
 * has `/admin/verify`, with the whole unruled pool and none of the tier's
 * source stamping (plan §B4's table) — so `app.ts` registers this by the
 * `/api/contribute/*` prefix, the same way `requireAccess` is registered by
 * the disjoint `/api/admin/*` prefix, and neither route tree ever runs both.
 *
 * Unlike `requireAccess`, there is no "not configured" 503 here. A missing
 * `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` means nobody can ever *obtain* a
 * session (`routes/auth.ts` answers 503 on its own routes for that), but it
 * says nothing about whether a session cookie presented here is valid — the
 * two concerns are independent, and conflating them would make this
 * middleware's behaviour depend on bindings it has no reason to read.
 */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const sessionId = getCookie(c, SESSION_COOKIE_NAME);
  if (!sessionId) return c.json({ error: "missing session" }, 401);

  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.trusted, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`,
  )
    .bind(sessionId)
    .first<{
      id: number;
      email: string;
      display_name: string | null;
      trusted: number;
      expires_at: number;
    }>();

  // One response for "no such session" and "the session expired," matching
  // `requireAccess`'s own choice not to say which check failed a forged
  // assertion — the caller is either the legitimate holder of an expired
  // cookie, who does not need to be told which of the two it was to know to
  // sign in again, or someone probing session ids, who should learn nothing
  // from the distinction either.
  //
  // The row is not deleted here even when it has expired. `requireUser` runs
  // on every `/api/contribute/*` request and has no business writing on a
  // read path; the sweep is the reaper cron's job (`session-reaper.ts`),
  // exactly as a stale job lease is reaped on a schedule rather than by
  // whichever request happens to notice it first.
  if (!row || row.expires_at <= Math.floor(Date.now() / 1000)) {
    return c.json({ error: "missing or expired session" }, 401);
  }

  // Left for the handlers past this point (see `Variables` in bindings.ts):
  // the identity is already verified here, and a handler that re-derived it
  // would either verify the session twice or trust something nothing checked.
  c.set("user", {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    trusted: row.trusted === 1,
  });

  await next();
});
