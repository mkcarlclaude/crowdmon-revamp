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

  // Presigned frame serving for a labelling session (M13.4, CONTEXT.md §Q25).
  // All three optional, and the mode is decided by whether they are all set:
  // signing needs an R2 S3 access key, which only a human at the Cloudflare
  // dashboard can mint, so a deployment without one falls back to the
  // Access-gated `/api/admin/image` proxy rather than refusing to serve the
  // verification UI at all. See `src/frame-urls.ts` for why that fallback is
  // the same posture rather than a weaker one.
  //
  // The base URL is a plain var — it is the account's S3 endpoint plus the
  // bucket name, both of which are already in this repo's Terraform. The key
  // and secret are wrangler secrets and appear nowhere in the tree.
  FRAMES_S3_BASE_URL?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;

  // M14.3: the public verification surface's rate limit. Provisioned entirely
  // in wrangler.toml — unlike every other binding above, there is no
  // dashboard step and nothing to mint.
  PUBLIC_RATE_LIMITER: RateLimit;
};
