/**
 * Everything the Worker receives from Cloudflare at runtime.
 *
 * Split out from index.ts so the tracing config can name these types without
 * importing the Hono app, which imports the tracing config back.
 */
/**
 * What `requireAccess` leaves behind for the handlers past it.
 *
 * The middleware already verified the assertion and read the email off it, so
 * a handler that needs to record *who* asked — M12.2's `dryruns.requested_by`,
 * and M13's verdict identity after it — reads it from here rather than
 * verifying the token a second time. Declared as part of the app's env type
 * rather than passed around, because there is exactly one producer and it runs
 * before every consumer by path prefix.
 *
 * Only set on `/api/admin/*`. Everywhere else it is genuinely absent, which is
 * why the value is typed as possibly undefined rather than as a string the
 * unauthenticated routes would be lying about.
 */
export type Variables = {
  adminEmail?: string;
};

/** The app's env: bindings plus whatever middleware has set. */
export type AppEnv = { Bindings: Bindings; Variables: Variables };

export type Bindings = {
  ENVIRONMENT: string;

  // Provisioned by Terraform (M1.3), bound in wrangler.toml.
  DB: D1Database;
  FRAMES: R2Bucket;

  // Where spans go. A plain var, not a secret — the hostname is public
  // knowledge, and CONTEXT.md §9 accepts that because Access gates it.
  OTLP_ENDPOINT: string;

  // Cloudflare Access service token, set via `wrangler secret put`. Without
  // both of these every export is rejected at the edge with a 403.
  CF_ACCESS_CLIENT_ID: string;
  CF_ACCESS_CLIENT_SECRET: string;

  // Where the Access assertions on /api/admin/* are verified against, and
  // which application they must have been minted for. Plain vars: the team
  // domain is in every login URL and the aud tag identifies an application
  // rather than authorising anything.
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;

  // The reaper's two thresholds (M6.2), documented on `ReapOptions` in
  // reaper.ts and chosen in CONTEXT.md §Q14. Numbers rather than strings: TOML
  // types them and wrangler passes them through as-is. `reapOptions` still
  // parses defensively, because a deployment variable edited by hand arrives
  // as whatever was typed.
  LEASE_STALE_SECONDS: number;
  MAX_ATTEMPTS: number;

  // Comma-separated allowlist, checked after the assertion verifies. A secret
  // only because it is a list of real email addresses and this repo is public
  // — it grants nothing on its own.
  ADMIN_EMAILS: string;
};
