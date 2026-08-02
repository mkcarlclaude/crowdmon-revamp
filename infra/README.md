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
| `access.tf` | The Worker's custom domains (current and, during the M5 migration, legacy), and the Access application over `/api/admin/*` |
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

**Merge before you apply.** The Worker has to actually be deployed serving both the
SPA and the API before `crowdmon.mkcarl.com` is a hostname worth pointing anyone at.
Applying `access.tf` before that code is merged and deployed just gives Access
something to gate that isn't ready yet; deploying the Worker before the apply gives
`crowdmon.mkcarl.com` no custom domain to be reached on at all, while `api.` keeps
answering as if nothing changed — either order out of sequence leaves the SPA
unreachable at the new hostname for no reason. Merge the code, deploy it, *then*
run the apply below.

**Read the plan before applying — this is not a plain `terraform apply`.** The old
`cloudflare_workers_custom_domain.api` resource no longer exists anywhere in this
configuration; it was renamed to `.app` and a new `.legacy_api` was added next to
it. Terraform has no idea the two are related — it addresses resources by the name
in the config, not by the hostname they hold — so a naive plan reads as: destroy
`.api`, create `.app`, create `.legacy_api`. `.legacy_api`'s hostname is
byte-identical to `.api`'s old one, but that similarity is invisible to Terraform's
plan; nothing stops the destroy from running before the matching create, and in
that window `api.crowdmon.mkcarl.com` has no custom domain at all. That is exactly
the failure this whole migration is structured to avoid — the Go worker, which
polls that hostname with no Access identity and can't be told to wait, would start
failing every poll. If the plan proposes destroying `cloudflare_workers_custom_domain.api`
rather than adopting it into `.legacy_api`, stop and move it in state first:

```sh
terraform -chdir=infra state mv \
  cloudflare_workers_custom_domain.api cloudflare_workers_custom_domain.legacy_api
```

That tells Terraform the existing object *is* `.legacy_api` now, or was `.api` and
should be re-planned as `.legacy_api`, rather than something to tear down and
recreate. Only after that (or after confirming the plan already reads as a clean
adopt, not a destroy) is it safe to apply.

**Changing the Access application's `domain` replaces the resource.** Terraform has
no in-place update for that attribute, so pointing it at `local.app_hostname` mints a
brand new `aud` — the old one stops verifying anything the moment the replacement
applies. `ACCESS_AUD` in `apps/api/wrangler.toml` and a `wrangler deploy` carrying the
new value must land in the same change as the `terraform apply` that replaces the
application. Skip that and every request to `/api/admin/*` gets a 503 from
`apps/api/src/middleware/access.ts` — the error says nothing about hostnames or
`aud`, so if admin requests start failing closed right after an infra apply, check
`terraform output access_aud` against `ACCESS_AUD` first.

**Between the apply and the Go worker's repoint, `api.crowdmon.mkcarl.com` is
unprotected by Access — and that's fine.** Once `access.tf` applies, the Access
application only covers `crowdmon.mkcarl.com/api/admin`; `api.crowdmon.mkcarl.com`
is still served by the same Worker (that's the whole point of keeping `legacy_api`
alive) but no Access application names it any more. This is safe because
`apps/api/src/middleware/access.ts` fails closed on its own: with no Access
application in front of it, requests to `api.crowdmon.mkcarl.com/api/admin/*` arrive
with no `Cf-Access-Jwt-Assertion` header, and the middleware returns 401 for exactly
that reason (see the "missing Access assertion" branch). The admin API is briefly
reachable at two hostnames but never *unauthenticated* at either — the outer gate is
temporarily gone from one of them, the inner one still is not.

**The Go worker must be repointed before `legacy_api` is removed.** It polls
`/api/jobs/*` constantly and holds no Access identity, so nothing but changing its
configured base URL and restarting it can redirect it. Deleting
`cloudflare_workers_custom_domain.legacy_api` before that happens stops the job
queue outright — the worker starts failing every poll with no route to the host at
all. The order is:

1. Merge and deploy the Worker code that serves both the SPA and the API.
2. Apply with both custom domains present (the committed state) and the Access
   application pointed at `local.app_hostname` — reading the plan first, per above.
3. Paste the new `access_aud` into `wrangler.toml` and deploy the Worker again, so
   `/api/admin` verifies against the new `aud`.
4. Repoint the Go worker's API base URL and the repository's `API_BASE_URL`
   variable at `local.app_hostname`, and confirm it is polling successfully on the
   new host.
5. Only then delete `cloudflare_workers_custom_domain.legacy_api` and
   `local.legacy_api_hostname` from `access.tf`, and apply again. Sample the old
   hostname several times, not once, before calling it retired — a single response
   cannot distinguish a removed hostname from a rollout still serving two versions.
