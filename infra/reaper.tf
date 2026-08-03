# The reaper's schedule (M6.2).
#
# The handler is code and belongs to wrangler; the schedule outlives any one
# deploy and belongs here, on the same rule as the D1 database and the Access
# application. `script_name` names the wrangler-deployed script rather than
# creating it — same as cloudflare_workers_custom_domain.app in access.tf, and
# with the same ordering consequence: deploy first, then apply.
#
# The split is only safe because wrangler leaves schedules alone while
# `[triggers]` is absent from wrangler.toml — and an *empty* `[triggers]` would
# silently delete what this resource creates. Reasoning in CONTEXT.md §Q14;
# `apps/api/test/node/wrangler-config.test.ts` is what keeps the table absent.
resource "cloudflare_workers_cron_trigger" "reaper" {
  account_id  = var.account_id
  script_name = "${var.project_name}-api"

  # Every five minutes, which CONTEXT.md §Q20 budgeted before the reaper was
  # written: "288/day for the reaper" is this cadence. It is a request budget
  # decision, not a latency one — the Workers free tier allows 100,000/day and
  # idle polling already dominates. Detection latency is therefore 0-5 minutes
  # on top of LEASE_STALE_SECONDS, which is invisible against the 10-20 minute
  # jobs this queue carries.
  schedules = [
    {
      cron = "*/5 * * * *"
    }
  ]
}
