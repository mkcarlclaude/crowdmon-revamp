# Cloudflare Access in front of the admin API (M3.5).
#
# Two things have to exist for this to mean anything, and only one of them is
# here. Terraform owns the gate; apps/api/src/middleware/access.ts owns the
# verification behind it. Neither is sufficient alone — see the note on
# workers.dev below.

# The Worker is deployed by wrangler and reached at
# crowdmon-api.<subdomain>.workers.dev. That hostname is not on a zone, so no
# Access application can cover it. A custom domain on mkcarl.com gives the
# Worker a hostname Access can be attached to.
#
# `service` names the wrangler-deployed script rather than creating it:
# Terraform owns account resources, wrangler owns code (CONTEXT.md §3). If the
# script does not exist yet, this fails — deploy first, then apply.
resource "cloudflare_workers_custom_domain" "api" {
  account_id = var.account_id
  zone_name  = var.zone_name
  hostname   = local.api_hostname
  service    = "${var.project_name}-api"
  # `environment` is deprecated in provider 5.x and omitted: wrangler.toml
  # declares no named environments, so there is only the default one.
}

# Path-scoped, not host-scoped. The Go worker polls /api/jobs/* constantly and
# has no Access identity; covering the whole hostname would break the queue
# rather than secure it.
resource "cloudflare_zero_trust_access_application" "admin" {
  account_id       = var.account_id
  name             = "${var.project_name} admin API"
  type             = "self_hosted"
  domain           = "${local.api_hostname}/api/admin"
  session_duration = "24h"

  # GitHub and one-time PIN are the identity providers configured on this
  # account. Listed explicitly so adding a third to the organisation does not
  # silently become a way into the admin API.
  allowed_idps              = var.access_idp_ids
  auto_redirect_to_identity = length(var.access_idp_ids) == 1

  # Defined inline rather than as a separate account-level policy: this policy
  # is meaningless anywhere else, and a reusable one invites being attached to
  # a second application by accident.
  policies = [{
    name       = "${var.project_name} administrators"
    decision   = "allow"
    precedence = 1
    include = [
      for email in var.admin_emails : {
        email = { email = email }
      }
    ]
  }]
}

locals {
  api_hostname = "api.${var.project_name}.${var.zone_name}"
}
