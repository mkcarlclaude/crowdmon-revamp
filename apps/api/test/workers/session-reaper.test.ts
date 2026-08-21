import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { reapExpiredSessions } from "../../src/session-reaper";
import { seedSession, seedUser } from "./contributor-seed";

/**
 * `reapExpiredSessions` (M20, plan §B2: "expired sessions are deleted by the
 * existing reaper cron"). `scheduled.ts`'s own wiring of this into the cron
 * tick is not re-tested here — it is one line, and `reaper.test.ts` already
 * covers the wiring pattern this follows.
 */
describe("reapExpiredSessions", () => {
  it("deletes a session past its expires_at", async () => {
    const userId = await seedUser();
    const { sessionId } = await seedSession(userId, { expiresIn: -1 });

    const deleted = await reapExpiredSessions(env.DB);

    expect(deleted).toBe(1);
    const row = await env.DB.prepare("SELECT id FROM sessions WHERE id = ?")
      .bind(sessionId)
      .first();
    expect(row).toBeNull();
  });

  it("leaves an unexpired session alone", async () => {
    const userId = await seedUser();
    const { sessionId } = await seedSession(userId, { expiresIn: 3600 });

    const deleted = await reapExpiredSessions(env.DB);

    expect(deleted).toBe(0);
    const row = await env.DB.prepare("SELECT id FROM sessions WHERE id = ?")
      .bind(sessionId)
      .first();
    expect(row).not.toBeNull();
  });
});
