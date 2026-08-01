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
