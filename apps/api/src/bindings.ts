/**
 * Everything the Worker receives from Cloudflare at runtime.
 *
 * Split out from index.ts so the tracing config can name these types without
 * importing the Hono app, which imports the tracing config back.
 */
/**
 * What `requireAccess` and `requireUser` each leave behind for the handlers
 * past them.
 *
 * Both middlewares already verified an identity by the time a handler runs,
 * so a handler that needs to record *who* asked — M12.2's
 * `dryruns.requested_by`, M13's verdict identity, M20's contributor identity —
 * reads it from here rather than verifying anything a second time. Declared
 * as part of the app's env type rather than passed around, because there is
 * exactly one producer of each field and it runs before every consumer by
 * path prefix.
 *
 * `adminEmail` is set only on `/api/admin/*`; `user` only on
 * `/api/contribute/*`. Everywhere else both are genuinely absent, which is
 * why each is typed as possibly undefined rather than as a value the
 * unauthenticated routes would be lying about. The two are never both set on
 * one request — CONTEXT.md §7's v4 amendment and `requireUser`'s own comment
 * are both explicit that an admin is not automatically a contributor, and the
 * two middlewares are deliberately never composed on the same route.
 */
export type Variables = {
  adminEmail?: string;
  /**
   * The signed-in contributor `requireUser` verified. `id` is what
   * `verdicts.annotator_id` stores for `source = 'user'` rows — see
   * `contribute.ts`'s own comment on why that is the numeric id and not the
   * email.
   */
  user?: { id: number; email: string; displayName: string | null; trusted: boolean };
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

  // Contributor accounts (M20, plan §B2): Google OAuth in the Worker. Both
  // `wrangler secret` values, never `wrangler.toml` — a client secret is a
  // credential by definition, and the client id is treated the same way here
  // so nothing that looks like a real one is ever typed into a file this repo
  // publishes. See the PR body for the exact Google Cloud Console steps and
  // the redirect URI to register.
  //
  // Optional, like the R2 signing pair above and for the same reason: a
  // deployment that has not minted a Google OAuth client yet should still
  // boot and serve everything else, not 503 on startup. `routes/auth.ts`
  // answers 503 on its own routes when either is missing, the same posture
  // `requireAccess` takes for its own missing config.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;

  // Turnstile on `/api/auth/google/start` (M20, plan §B2) — stops scripted
  // mass-signup, which is the realistic threat; it does not stop a human who
  // signs up to draw bad boxes; `users.trusted` is what handles that one.
  // Both `wrangler secret` values for the same reason the Google pair above
  // is, even though a Turnstile *site* key is ordinarily rendered into public
  // HTML rather than kept secret — this repo fabricates neither.
  //
  // Optional, but asymmetrically: `verifyTurnstile` (routes/auth.ts) treats a
  // missing `TURNSTILE_SECRET_KEY` as "not configured yet" and skips the
  // check rather than failing closed the way `requireAccess` does for its own
  // missing config. The two are not the same kind of gap — an unprotected
  // admin API is the one failure this repo cannot tolerate; an unprotected
  // signup form is bounded by a real Google account being required either
  // way, and `trusted` defaulting to 0 (migration 0012) is the actual
  // backstop against what a signed-up account can do.
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
};
