# These outputs are the handoff to wrangler: the IDs they emit are pasted into
# apps/api/wrangler.toml, which cannot know them until the account is built.

output "d1_database_id" {
  description = "Paste into the [[d1_databases]] binding in apps/api/wrangler.toml."
  value       = cloudflare_d1_database.main.id
}

output "d1_database_name" {
  value = cloudflare_d1_database.main.name
}

output "r2_bucket_name" {
  description = "Paste into the [[r2_buckets]] binding in apps/api/wrangler.toml."
  value       = cloudflare_r2_bucket.frames.name
}

# The aud tag ties an assertion to this application specifically. Every app in
# one Access organisation is signed by the same keys, so the Worker must check
# it — a token minted for otlp.mkcarl.com would otherwise verify here.
output "access_aud" {
  description = "Paste into ACCESS_AUD in apps/api/wrangler.toml."
  value       = cloudflare_zero_trust_access_application.admin.aud
}

output "app_hostname" {
  description = "The Worker's custom domain. It serves the SPA and the API; Access covers its /api/admin path."
  value       = local.app_hostname
}
