variable "account_id" {
  description = "Cloudflare account ID (dashboard, right sidebar)."
  type        = string
}

variable "zone_name" {
  description = "Apex domain already onboarded to Cloudflare."
  type        = string
  default     = "mkcarl.com"
}

variable "project_name" {
  description = "Prefix for resource names, so a second environment can coexist."
  type        = string
  default     = "crowdmon"
}

variable "r2_location" {
  description = "R2 bucket location hint."
  type        = string
  default     = "APAC"

  validation {
    condition     = contains(["WNAM", "ENAM", "WEUR", "EEUR", "APAC"], var.r2_location)
    error_message = "r2_location must be one of: WNAM, ENAM, WEUR, EEUR, APAC."
  }
}

variable "admin_emails" {
  description = <<-EOT
    Identities allowed through Access to /api/admin/*.

    The Worker keeps its own copy of this list in the ADMIN_EMAILS secret and
    checks it after verifying the assertion. Two lists is deliberate: this one
    decides who Cloudflare will issue an assertion to, the other decides who
    the Worker will act for, and widening one must not widen the other.
  EOT
  type        = list(string)

  validation {
    condition     = length(var.admin_emails) > 0
    error_message = "An Access policy with no included identities locks everyone out, including you."
  }
}

variable "access_idp_ids" {
  description = <<-EOT
    Identity provider IDs allowed to authenticate to the admin application.

    Listed explicitly rather than left empty — empty means "every IdP on the
    account", so adding one to the organisation later would silently become a
    new way into the admin API. Find them with:

      curl -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        https://api.cloudflare.com/client/v4/accounts/<id>/access/identity_providers
  EOT
  type        = list(string)

  validation {
    condition     = length(var.access_idp_ids) > 0
    error_message = "At least one identity provider must be allowed, or nobody can log in."
  }
}
