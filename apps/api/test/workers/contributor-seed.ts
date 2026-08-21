import { env } from "cloudflare:test";
import { SESSION_COOKIE_NAME } from "../../src/session-cookie";

/**
 * `users` and `sessions` rows written straight to D1, for tests that need a
 * signed-in contributor without driving the whole OAuth round trip — the same
 * split `seed.ts` draws for jobs: `auth-google.test.ts` is what exercises the
 * login flow itself, everything else just needs an account that already
 * exists.
 */

export async function seedUser(
  overrides: {
    googleSub?: string;
    email?: string;
    displayName?: string | null;
    trusted?: 0 | 1;
  } = {},
): Promise<number> {
  const {
    googleSub = `sub-${crypto.randomUUID()}`,
    email = "friend@example.com",
    displayName = "Friend",
    trusted = 0,
  } = overrides;

  const row = await env.DB.prepare(
    `INSERT INTO users (google_sub, email, display_name, trusted)
          VALUES (?, ?, ?, ?)
       RETURNING id`,
  )
    .bind(googleSub, email, displayName, trusted)
    .first<{ id: number }>();

  if (!row) throw new Error("seedUser inserted nothing");
  return row.id;
}

/** A session row, and the cookie header a request needs to present it. `expiresIn` is seconds from now — negative for an already-expired row. */
export async function seedSession(
  userId: number,
  { expiresIn = 3600 }: { expiresIn?: number } = {},
): Promise<{ sessionId: string; cookieHeader: string }> {
  const sessionId = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;

  await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(sessionId, userId, expiresAt)
    .run();

  return { sessionId, cookieHeader: `${SESSION_COOKIE_NAME}=${sessionId}` };
}
