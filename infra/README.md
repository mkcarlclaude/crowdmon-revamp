# Infrastructure

Terraform owns account-level Cloudflare resources. wrangler owns bundling,
secrets and code deploys. Anything long-lived belongs here, so that
`terraform destroy` followed by `terraform apply` reproduces the account.

> **Applied.** D1 and R2 are live, and destroy/re-apply was exercised in M1.3.
> Note what that proved: `database_id` is server-assigned and a re-apply mints a
> new one, so `apps/api/wrangler.toml` must be re-pasted from
> `terraform output d1_database_id` afterwards. The bucket name is the bucket's
> identity and survives.

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
| `access.tf` | The Worker's custom domain, and the Access application over `/api/admin/*` |
| `outputs.tf` | IDs consumed by `wrangler.toml` |

Still to come: the Access application over the admin SPA route (M5.1), and the
cron trigger for the job reaper (M6.2).

### Ordering, for `access.tf`

`cloudflare_workers_custom_domain` names a script rather than creating one, so
the Worker must already be deployed when it is applied. On a from-nothing
rebuild that means: apply `main.tf`, paste the D1 and R2 IDs into
`wrangler.toml`, deploy the Worker, then apply again for the custom domain and
the Access application. Terraform owns account resources and wrangler owns
code, and this is where that boundary costs something.

After applying, two values have to reach the Worker:

```sh
terraform output access_aud     # -> ACCESS_AUD in apps/api/wrangler.toml
pnpm --filter @crowdmon/api exec wrangler secret put ADMIN_EMAILS
```

The allowlist exists twice on purpose. `admin_emails` here decides who
Cloudflare will issue an assertion to; `ADMIN_EMAILS` decides who the Worker
will act for. Widening one does not widen the other, which is the point — and
it matters because the Worker is also served on its `workers.dev` hostname,
where no Access application exists and nothing but the Worker's own check
stands in front of the admin API.

**Not here, deliberately:** the cloudflared tunnel and the OTLP endpoint. Those
belong to the monitoring stack, which is a separate project with its own
repository. This project consumes `otlp.mkcarl.com` as a URL and owns nothing
about it. The reasoning — chiefly that `terraform destroy` is run here on
purpose, and a shared tunnel would make that take Grafana down for unrelated
projects — is in `CONTEXT.md` §6, along with the runbook for how the endpoint
was gated.

## Migrating to a single hostname (M5)

`access.tf` currently declares two custom domains: `cloudflare_workers_custom_domain.app`
at `crowdmon.mkcarl.com` and `cloudflare_workers_custom_domain.legacy_api` at the
retired `api.crowdmon.mkcarl.com`. Both exist at once on purpose — see the ordering
constraint below — and `legacy_api` is meant to be deleted in a second change, not
carried forward indefinitely.

**Changing the Access application's `domain` replaces the resource.** Terraform has
no in-place update for that attribute, so pointing it at `local.app_hostname` mints a
brand new `aud` — the old one stops verifying anything the moment the replacement
applies. `ACCESS_AUD` in `apps/api/wrangler.toml` and a `wrangler deploy` carrying the
new value must land in the same change as the `terraform apply` that replaces the
application. Skip that and every request to `/api/admin/*` gets a 503 from
`apps/api/src/middleware/access.ts` — the error says nothing about hostnames or
`aud`, so if admin requests start failing closed right after an infra apply, check
`terraform output access_aud` against `ACCESS_AUD` first.

**The Go worker must be repointed before `legacy_api` is removed.** It polls
`/api/jobs/*` constantly and holds no Access identity, so nothing but changing its
configured base URL and restarting it can redirect it. Deleting
`cloudflare_workers_custom_domain.legacy_api` before that happens stops the job
queue outright — the worker starts failing every poll with no route to the host at
all. The order is:

1. Apply with both custom domains present (the committed state) and the Access
   application pointed at `local.app_hostname`.
2. Paste the new `access_aud` into `wrangler.toml` and deploy the Worker, so
   `/api/admin` verifies again.
3. Repoint the Go worker's API base URL and the repository's `API_BASE_URL`
   variable at `local.app_hostname`, and confirm it is polling successfully on the
   new host.
4. Only then delete `cloudflare_workers_custom_domain.legacy_api` and
   `local.legacy_api_hostname` from `access.tf`, and apply again. Sample the old
   hostname several times, not once, before calling it retired — a single response
   cannot distinguish a removed hostname from a rollout still serving two versions.
