# Infrastructure

Terraform owns account-level Cloudflare resources. wrangler owns bundling,
secrets and code deploys. Anything long-lived belongs here, so that
`terraform destroy` followed by `terraform apply` reproduces the account.

> **Not yet applied.** These files have never been run — no `terraform init`,
> no `plan`, no `apply`. They were written without account credentials and
> without a `terraform` binary available, so the provider schema is unverified.
> Expect the first `terraform plan` to need corrections.

## Bootstrap

The state bucket cannot be created by Terraform, because Terraform needs it to
hold the state that would record its creation. Create that one bucket by hand,
once, then let Terraform manage everything else.

1. **Create the state bucket manually.** Cloudflare dashboard → R2 → create
   bucket named `crowdmon-tfstate`. Do not put anything else in it.

2. **Create an R2 S3-compatible API token.** R2 → Manage API Tokens. You need
   the access key ID and secret, with object read/write on that bucket.

3. **Create a Cloudflare API token** with edit scope on Workers, D1, R2, DNS
   and Access.

4. **Configure the backend.** Copy `backend.hcl.example` to `backend.hcl` and
   fill in the account ID. Both `backend.hcl` and `terraform.tfvars` are
   gitignored.

   ```sh
   cp backend.hcl.example backend.hcl
   cp terraform.tfvars.example terraform.tfvars
   ```

5. **Export credentials.** Never put these in a `.tf` file.

   ```sh
   export CLOUDFLARE_API_TOKEN=...        # provider
   export AWS_ACCESS_KEY_ID=...           # R2 token, for the state backend
   export AWS_SECRET_ACCESS_KEY=...
   ```

6. **Init and plan.**

   ```sh
   terraform init -backend-config=backend.hcl
   terraform plan
   ```

## Handoff to wrangler

`terraform apply` emits the IDs that `apps/api/wrangler.toml` cannot know until
the account exists:

```sh
terraform output d1_database_id
terraform output r2_bucket_name
```

Paste them into the commented binding blocks in `apps/api/wrangler.toml`.

## What lives here

| File | Contents |
|---|---|
| `versions.tf` | Provider constraints, R2-backed state backend |
| `variables.tf` | Account ID, zone, naming, bucket location |
| `main.tf` | D1 database, R2 frames bucket |
| `outputs.tf` | IDs consumed by `wrangler.toml` |

Still to come: the cloudflared tunnel and OTLP hostname (M2.1), Access
applications and service tokens (M2.2, M3.5, M5.1), and the cron trigger for
the job reaper (M6.2).
