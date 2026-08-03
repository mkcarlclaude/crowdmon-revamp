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
resource "cloudflare_workers_custom_domain" "app" {
  account_id = var.account_id
  zone_name  = var.zone_name
  hostname   = local.app_hostname
  service    = "${var.project_name}-api"
}

# `cloudflare_workers_custom_domain.legacy_api` lived here from 2026-08-03 until
# the same day, holding `api.crowdmon.mkcarl.com` alive across the M5 hostname
# consolidation. It existed for one reason: the Go worker polls /api/jobs/*
# with no Access identity and cannot be told to wait, so the old hostname had to
# outlive the new one's creation and be removed only once the worker had been
# repointed. Both of those happened; it is gone.

# Path-scoped, not host-scoped. The Go worker polls /api/jobs/* constantly and
# has no Access identity; covering the whole hostname would break the queue
# rather than secure it.
resource "cloudflare_zero_trust_access_application" "admin" {
  account_id       = var.account_id
  name             = "${var.project_name} admin API"
  type             = "self_hosted"
  domain           = "${local.app_hostname}/api/admin"
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
  # One hostname for everything: the SPA, /api/*, /health and /openapi.json.
  #
  # It was `api.crowdmon.mkcarl.com` until M5. Splitting the SPA onto a second
  # hostname would have made every admin call cross-origin — CORS with
  # credentials, a load-bearing cookie policy nobody wrote down, and M5.4's
  # documented expiry symptom replaced by a CORS failure. Two hostnames on one
  # Worker is worse still: an Access application binds to host *and* path, so a
  # second hostname republishes /api/admin with the outer gate missing.
  app_hostname = "${var.project_name}.${var.zone_name}"
}
