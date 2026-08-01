terraform {
  required_version = ">= 1.9"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # State lives in R2 via its S3-compatible API. It is never committed: it
  # contains resource IDs and, for some resources, secret material.
  #
  # Chicken-and-egg: this bucket cannot be created by Terraform, because
  # Terraform needs it to hold the state that would record its creation.
  # Create it by hand once (see infra/README.md), then let Terraform manage
  # everything else.
  #
  # Credentials come from the environment, never from this file:
  #   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY  (R2 S3-compatible token)
  backend "s3" {
    bucket = "crowdmon-tfstate"
    key    = "infra/terraform.tfstate"
    region = "auto"

    # R2 is not AWS; these skips stop the S3 backend from calling AWS-only APIs.
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true

    # endpoints.s3 is supplied at init time, because it embeds the account ID:
    #   terraform init -backend-config=backend.hcl
    # See backend.hcl.example.
  }
}

provider "cloudflare" {
  # Read from the CLOUDFLARE_API_TOKEN environment variable. Never set this
  # in a .tf file — anything here is committed.
}
