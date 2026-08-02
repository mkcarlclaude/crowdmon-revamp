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

  # Stated explicitly, though "disabled" is already the value in the account.
  # Omitted, the provider plans it to null on every run and the API rejects
  # that with `Invalid property: read_replication => Expected object, received
  # null` — so an unrelated apply fails on a database nobody meant to touch.
  #
  # Disabled rather than auto: replicas are eventually consistent, and the job
  # claim's whole correctness argument is that SQLite serialises writers
  # against one primary (CONTEXT.md §Q14). A worker reading a replica could see
  # a job as pending after another worker had already taken it.
  read_replication = {
    mode = "disabled"
  }
}

# Extracted frames. Source videos are never uploaded here: they are downloaded
# to local disk on the home box with a TTL and deleted after extraction.
resource "cloudflare_r2_bucket" "frames" {
  account_id = var.account_id
  name       = "${var.project_name}-frames"
  location   = var.r2_location
}
