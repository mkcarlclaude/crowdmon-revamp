# Account-level resources only. Terraform owns what outlives a deploy — the
# database, the bucket, DNS, the tunnel, Access apps. wrangler owns bundling,
# secrets and code deploys. The split matters: `terraform destroy` followed by
# `terraform apply` must reproduce the account, and it cannot do that if half
# the resources were created imperatively by wrangler.

# Metadata and the job queue. The queue is a D1 table rather than Cloudflare
# Queues because Queues requires a paid plan — see CONTEXT.md.
resource "cloudflare_d1_database" "main" {
  account_id = var.account_id
  name       = var.project_name
}

# Extracted frames. Source videos are never uploaded here: they are downloaded
# to local disk on the home box with a TTL and deleted after extraction.
resource "cloudflare_r2_bucket" "frames" {
  account_id = var.account_id
  name       = "${var.project_name}-frames"
  location   = var.r2_location
}
