/**
 * Everything the Worker receives from Cloudflare at runtime.
 *
 * Split out from index.ts so the tracing config can name these types without
 * importing the Hono app, which imports the tracing config back.
 */
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

  // Comma-separated allowlist, checked after the assertion verifies. A secret
  // only because it is a list of real email addresses and this repo is public
  // — it grants nothing on its own.
  ADMIN_EMAILS: string;
};
