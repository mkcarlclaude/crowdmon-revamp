# Crowdmon 2026 — Roadmap

**Scope:** [`PRD.md`](PRD.md) · **Design record:** [`CONTEXT.md`](CONTEXT.md)

Nine milestones for v1, all delivered; six for v2, none started; six for v3, none
started. Each is independently shippable and a valid stopping point — the project is
open-ended by choice, so no milestone may depend on finishing the next one to be worth
having.

Issue bodies below are written to be pasted directly into GitHub.

- **v1 — M1 to M9.** Closed 2026-08-08, all eight `PRD.md` §5 criteria verified against
  one real run.
- **[v2 — M10 to M15](#v2--labelling-platform).** Scope in `PRD.md` §9, design in
  `CONTEXT.md` §12, tracked as
  [issue #89](https://github.com/mkcarlclaude/crowdmon-revamp/issues/89).
- **[v3 — M16](#v3--admin-dashboard-proper).** Scope and design in `CONTEXT.md` §Q19,
  tracked as [issue #134](https://github.com/mkcarlclaude/crowdmon-revamp/issues/134).

---

## M1 — Foundations

*Goal: the account can be rebuilt from nothing, and CI can deploy.*
*Depends on: nothing.*
*Done when:* `terraform apply` provisions D1 and R2 from an empty account, and a
hello-world Worker is live via CI.

### Prerequisites — gather before starting

These are not code and cannot be generated. M1 stalls without them.

| Needed | Where from | Used by |
|---|---|---|
| Cloudflare account ID | Dashboard, right sidebar | Terraform, `wrangler.toml` |
| Cloudflare API token | My Profile → API Tokens. Needs Workers, D1, R2, DNS, Access edit scopes | Terraform provider |
| R2 S3-compatible credentials | R2 → Manage API Tokens → access key ID + secret | Terraform state backend |
| Zone / domain | `mkcarl.com`, already on Cloudflare | DNS records in M2 |
| GitHub repo | Pending — connector unauthorized | CI, GHCR |

**Chicken-and-egg on state:** the R2 bucket holding Terraform state cannot itself be
created by Terraform. Create that one bucket by hand, once, then let Terraform manage
everything else.

**Node and pnpm** must be installed locally. Nothing is to be installed on the user's
machine without asking first.

### M1.1 — Initialise monorepo skeleton
Set up the repository structure for a pnpm workspace plus a Go module.

- [ ] `git init`, `.gitignore` covering `node_modules`, Go build output, `.terraform`, `*.tfstate`
- [ ] pnpm workspace with `apps/api` (Worker) and `apps/web` (SPA, empty for now)
- [ ] `worker/` Go module with `go.mod`
- [ ] `infra/` for Terraform
- [ ] Root README stating what the project is and linking PRD and CONTEXT

### M1.2 — Terraform bootstrap with R2 state backend
State must not live in the repo — it contains secrets.

- [ ] R2 bucket for Terraform state, created manually once (chicken-and-egg)
- [ ] Terraform S3-compatible backend configured against R2
- [ ] Cloudflare provider configured, credentials from environment
- [ ] `terraform init` and `terraform plan` succeed against a clean checkout

### M1.3 — Provision D1 and R2
- [ ] D1 database declared in Terraform
- [ ] R2 bucket for frames declared in Terraform
- [ ] Bindings surfaced to `wrangler.toml`
- [ ] Destroying and re-applying reproduces both

### M1.4 — CI for both toolchains
- [ ] GitHub Actions workflow with path filters — Go changes must not redeploy the SPA
- [ ] TS job: typecheck, lint, test
- [ ] Go job: `go vet`, `go build`, `go test`
- [ ] Both green on an empty project

### M1.5 — Hello-world Worker deployed by CI
- [ ] Minimal Hono app with a health endpoint
- [ ] `wrangler deploy` from CI on merge to main
- [ ] Endpoint reachable and returning 200

---

## M2 — Observability spine

*Goal: the hardest plumbing in the project, proven against something trivial.*
*Depends on: M1.*
*Done when:* a span emitted by the hello-world Worker is visible in Tempo.

Sequenced second deliberately. Debugging gated OTLP export from a Workers runtime is
far easier against a health endpoint than against a fan-out pipeline, and everything
after this lands instrumented rather than retrofitted.

### M2.1 — OTLP hostname on the existing tunnel — **done 2026-08-02, not in Terraform**

Originally written as "declare a cloudflared tunnel in Terraform". That was wrong. The
monitoring stack is a separate project that predates this one, and this project's
Terraform is destroyed on purpose as part of M1.3's reproducibility check — owning a
shared tunnel would make that check take Grafana down for unrelated projects. Ownership
follows the blast radius. Reasoning and runbook: `CONTEXT.md` §6.

- [x] `otlp.mkcarl.com` added as a route on the pre-existing `ubuntu_grafana` tunnel
- [x] Ingress points at `otel-collector:4318` — the Docker service name. **Not
      `localhost`**: cloudflared is a container on the same compose network, so
      `localhost` is cloudflared itself
- [x] DNS record created by the tunnel route, not by Terraform
- [x] Collector still binds no public port

### M2.2 — Access application and service token — **done 2026-08-02, not in Terraform**

- [x] Access application covering `otlp.mkcarl.com`
- [x] Service token issued; policy action is **Service Auth**, not Allow — with Allow a
      valid token is still bounced to the login page, which reaches a Worker's `fetch`
      as a 302-followed-to-HTML-200 rather than an auth error
- [x] Policy includes the **named** token, not "any Access service token" — the account
      holds tokens belonging to unrelated projects
- [x] Unauthenticated request returns 403; the same request with both token headers
      returns 200 with an OTLP `partialSuccess` body. Both halves were checked: Access
      rejects before reaching the origin, so a 403 on its own is also what a completely
      misrouted ingress would produce

### M2.3 — Instrument the Worker
- [ ] OTLP **HTTP** exporter — gRPC will not run in the Workers runtime
- [ ] `CF-Access-Client-Id` / `CF-Access-Client-Secret` stored via `wrangler secret put`
- [ ] Hono middleware producing a span per route
- [ ] Endpoint configured from environment, not hardcoded

### M2.4 — Verify and document the path
- [ ] Span from the health endpoint appears in Tempo
- [ ] Span metrics appear in Prometheus via the metrics-generator
- [ ] Path documented in the README, including the gRPC-vs-HTTP gotcha

---

## M3 — Contract and queue

*Goal: a job can be submitted and claimed over a typed, generated contract.*
*Depends on: M1, M2.*
*Done when:* curl submits a URL, a job row appears, and curl can claim it.

### M3.1 — D1 schema and migrations
- [ ] Tables: `videos`, `jobs`, `chunks`, `images`
- [ ] `jobs` carries status, attempts, `heartbeat_at`, claimed-by, timestamps
- [ ] `images` carries R2 key, phash, source video and timestamp
- [ ] Migration tooling in place and runnable from CI

### M3.2 — zod-openapi routes and spec artifact
- [ ] Routes defined with `@hono/zod-openapi`
- [ ] OpenAPI spec emitted as a build artifact
- [ ] Runtime validation rejecting malformed input

### M3.3 — Generated Go types
- [ ] oapi-codegen generating Go structs from the spec
- [ ] Generation runs in CI
- [ ] CI fails when generated output differs from committed output

### M3.4 — Job lifecycle endpoints
- [ ] `POST /api/admin/videos` — submit a YouTube URL, create a job
- [ ] `POST /api/jobs/claim` — atomic claim via `UPDATE ... RETURNING`
- [ ] `POST /api/jobs/:id/heartbeat`
- [ ] `POST /api/jobs/:id/complete`

### M3.5 — Access on admin endpoints
- [ ] Access application covering `/api/admin/*`, in Terraform
- [ ] Worker verifies `Cf-Access-Jwt-Assertion` against Cloudflare's public keys
- [ ] Role check behind the Access check
- [ ] Verified: the endpoint is not reachable without both

---

## M4 — Worker skeleton

*Goal: a full round trip with no video work.*
*Depends on: M3.*
*Done when:* submitting a URL results in the home worker claiming and completing it.

**Met on 2026-08-02**, by the deployed container rather than a local build: a job in
production D1 went `pending` -> `claimed` -> `done`, claimed at 11:33:36 and reported
91ms later, with `claimed_by` cleared on the way out. The lease was checked separately
against a deliberately slow job: `heartbeat_at` advanced while `claimed_at` held still.
The job was seeded directly into D1 — submission through `/api/admin/videos` needs an
interactive Access login, so that half stays covered by M3.5's own verification.

### M4.1 — Go worker foundation
- [x] Config from environment
- [x] OTel SDK initialised, OTLP exporter, service name set
- [x] Structured logging with trace correlation
- [x] `context.Context` threaded through all pipeline function signatures from the
      first commit, even though no custom spans are emitted yet — retrofitting this
      later touches every function in the call chain

### M4.2 — Poll loop with adaptive backoff
- [x] 30s idle interval, doubling to a 120s cap on repeated empty polls
- [x] Immediate re-poll after finding work
- [x] Graceful shutdown

### M4.3 — Claim, heartbeat, complete
- [x] Claim via the generated client
- [x] Heartbeat every 30s while a job is held
- [x] Complete on success
- [x] No extraction yet — mark done immediately

### M4.4 — Containerise and publish
- [x] Dockerfile with ffmpeg and yt-dlp
- [x] CI builds and pushes `linux/amd64` to GHCR
- [x] Image is public

### M4.5 — Deploy to the home box — **deployed 2026-08-02**
- [x] Compose service alongside the monitoring stack — its own project in `~/crowdmon`,
      not a service inside the shared stack's file
- [x] Timer-based image pull, no inbound access — a systemd **user** timer, four times a
      day; sudo on that box needs a password, and a deployment that cannot be installed
      non-interactively cannot be automated
- [x] Survives host reboot — **accepted on the mechanisms, not on a reboot.** Docker is
      enabled at boot, the container runs under an `unless-stopped` policy that has not
      been suppressed, lingering is on, and the timer is enabled and `Persistent`. The
      reboot itself needs a sudo password and was deliberately not performed; closing
      this was the owner's call, recorded here so nobody later reads it as tested.
      `docker kill` is *not* a substitute test: Docker suppresses the restart policy for
      anything stopped by hand, which is exactly the path a reboot does not take

### M4.6 — Close the ungated workers.dev hostname — **done 2026-08-02**

Not in the original plan. M3.5 left it as a named constraint: Cloudflare Access binds
to a route on a zone, `*.workers.dev` is not one, and so `/api/admin/*` was reachable
there behind the Worker's own JWT check alone. Closing it needed something else to point
at the custom domain first, which is what M4.3 delivered.

- [x] `workers_dev = false`, and the workers.dev entry dropped from the spec's `servers`
- [x] `API_BASE_URL` repointed at the custom domain — it is what the deploy's health
      check reads, so the two had to move together
- [x] A test asserting the setting stays off; it defaults to *on*, so deleting one line
      would reopen the hostname and nothing else would notice
- [x] Verified: five samples of `/health` and `/api/admin/videos` on workers.dev all 404,
      while the custom domain answers 200 / 302 — a single sample cannot tell a closed
      hostname from a rollout still serving two versions

---

## M5 — Admin dashboard

*Goal: an operator surface instead of curl.*
*Depends on: M4 — sequenced after the worker so status visibly moves on day one.*
*Done when:* a URL can be submitted from the browser and job status updates live.

Minimal by design. No threshold controls, no model promotion, no annotation views —
none of those have data yet.

### M5.1 — SPA shell on the API Worker — **amended from "on Pages"**

The original bullet said Pages. Pages would have put the SPA on a second
hostname, making every admin call cross-origin: CORS with credentials, a
cookie policy nobody had written down, and — worse — M5.4's documented expiry
symptom replaced by a CORS failure, so the milestone's hardest bullet would
have been verifying the wrong thing. Cloudflare also now steers new projects to
Workers static assets. Serving the SPA from the Worker that already answers
`/api/*` costs one `[assets]` table.

- [x] Vite + React, built by CI and uploaded by the same `wrangler deploy`
- [x] `run_worker_first` covers `/api/*`, `/health` and `/openapi.json` —
      `not_found_handling = "single-page-application"` answers every other path
      with `index.html`, which would have made the deploy's health check curl
      the SPA shell and pass over a dead API. The health check itself now
      asserts the JSON body rather than the status code alone, for the same
      reason
- [x] `preview_urls = false`, with a test. Version preview URLs are on
      `*.workers.dev`, which Access cannot cover; leaving them on would have
      republished `/api/admin/*` ungated — the M4.6 hole through a setting M4.6
      never touched
- [x] One hostname, `crowdmon.mkcarl.com`, and the Access application moved
      with it — **applied 2026-08-03, verified.** `crowdmon.mkcarl.com` serves
      the SPA and the API, `/api/admin/*` there answers 302 to Access, and
      `api.crowdmon.mkcarl.com/api/admin/*` answers 401 from the Worker's own
      check — the transition state `infra/README.md` predicted, and the reason
      the design insists on two independent gates rather than one.

      Two things the apply taught, both recorded in `infra/README.md`:
      Terraform did propose **destroying** `cloudflare_workers_custom_domain.api`
      rather than adopting it, so the `state mv` was necessary and not
      theoretical. But the Access application updated **in place** — its `id`
      survived and the `aud` did not regenerate, so the repaste-and-redeploy
      the runbook called mandatory was a no-op. That runbook asserted the
      replacement was unavoidable; on Cloudflare provider 5.x it is not.

      **Finished 2026-08-03.** The Go worker was repointed at the new hostname
      and verified by seeding a job and watching it claim and complete through
      it — restarting a container proves configuration, not that the queue still
      works. `legacy_api` was then destroyed and `api.crowdmon.mkcarl.com`
      confirmed gone over five consecutive samples, all of which failed to
      connect rather than returning a status
- [x] No Access application on the UI route. `CONTEXT.md` §Q19 gates the API,
      not the bundle — the original bullet's "Access application covering the
      admin route" contradicted it, and that bullet is dropped rather than kept

### M5.2 — Submit form
- [x] YouTube URL input with validation
- [x] Posts to `/api/admin/videos`
- [x] Surfaces errors rather than swallowing them

### M5.3 — Job and chunk status list — **required an endpoint that did not exist**

M5 was written as a frontend-only milestone. It was not one: nothing in M1–M4
returns the job list this screen needs, so `GET /api/admin/jobs` was built as
part of this milestone rather than assumed to already exist. It returns the
**server's clock** alongside the jobs (`now`, Unix epoch seconds) so heartbeat
age is computed against a clock that cannot be skewed by the browser — a laptop
with a wrong clock would otherwise render a healthy worker fleet as dead, or
the reverse.

- [x] Jobs with status, attempts, heartbeat age, timestamps
- [x] Chunks grouped under their parent job
- [x] Auto-refresh on an interval

### M5.4 — Handle Access session expiry — **the predicted symptom was wrong, and the first fix looped**

- [x] Detect the redirect to login. **Not as HTML/200.** Production redirects to
      `mkcarl.cloudflareaccess.com`, a different origin, so the followed redirect
      carries no CORS headers and `fetch` rejects with a `TypeError` before any
      status exists to read. The HTML-200 form this bullet predicted is what a
      *same-origin* login page produces. The client treats both as one event, so
      detection was right for a reason it did not know about
- [x] Force a full page navigation so the browser can complete the login flow —
      **to `/api/admin/login`, not to the current URL.** The first implementation
      navigated to `window.location.href`, which is `/admin`: a static asset that
      M5.1 deliberately leaves ungated, so the reload returned the SPA shell,
      which re-fetched, failed identically, and re-rendered the banner. A loop
      with no reachable login screen. The new route exists solely to sit under
      the Access-gated prefix so the navigation is intercepted, and redirects to
      `/admin` once an assertion exists
- [x] Verified against a genuinely expired session on 2026-08-03, and against a
      never-authenticated one. Both were found by *using* the dashboard, not by
      testing it: the unit test asserted `location.assign` was called, which the
      broken version also did. The lesson worth keeping is that ten task reviews
      and a whole-branch review all passed on a recovery path that could not
      reach a login screen, because each examined `/admin`'s gating and the
      banner's navigation separately and each was correct in isolation

---

## M6 — Failure semantics

*Goal: crashes are survivable and visible.*
*Depends on: M4.*
*Done when:* killing the worker mid-job produces a visible reap and retry.

**Built 2026-08-03, applied and verified against production 2026-08-04 (UTC).** The
reaper runs on a real Cron Trigger, and a worker was killed mid-job three times to prove
it. Timeline of the first kill, which is the milestone's "done when" in full:

| Time (UTC) | Event |
|---|---|
| 15:47:19 | job 13 claimed, `attempts=1` |
| 15:47:47 | `docker kill` — SIGKILL, 28s into a 5m lease |
| 15:49:19 | lease stale (120s unrenewed) |
| 15:50:00 | cron tick |
| 15:50:18 | `status=pending`, `attempts=1`, holder and heartbeat cleared |

2m31s from kill to re-queued, inside the ~7 minute worst case the README predicts.
Two further cycles spent attempts 2 and 3; the third retired the job as `failed`.

### M6.1 — Attempts and terminal failure
- [x] `attempts` incremented on each claim — already true since M3.4, on the claim
      rather than on a later failure so a worker that dies without reporting still
      counts
- [x] Terminal `failed` state above a threshold — `MAX_ATTEMPTS`, enforced in the
      reaper, **which covers crashes and not reported failures.** The reaper is the
      only place a job re-enters `pending`, so it is the only place a ceiling can bite;
      a second check at claim time would be dead code wearing the costume of defence in
      depth. A worker that *reports* a failure is still retired on the first report
      whatever `attempts` says — correct for the poison cases this milestone names
      (deleted, geo-blocked, malformed), where a retry cannot help, and wrong for a
      transient one. Sorting reported failures into retryable and terminal is M7.1's,
      which is where failures with a shape to classify first exist. Recorded rather
      than glossed: read carelessly, this bullet claims more than the code does
- [x] Failure reason persisted, and distinguishable: a job the reaper retires says it
      exhausted its attempts, not merely that it failed, so an operator can tell a
      poison job from a worker reporting a real error
- [x] Prevents a poison job retrying forever — asserted by running the loop
      (claim → crash → reap → claim) until it terminates, not by testing the
      statements one at a time. Nothing in a single statement's test shows the cycle
      ends

### M6.2 — Cron reaper — **the split with wrangler is the load-bearing part**
- [x] Workers Cron Trigger declared in Terraform (`infra/reaper.tf`), every 5 minutes
      — the cadence CONTEXT.md §Q20 had already budgeted as "288/day for the reaper"
- [x] Resets jobs with stale `heartbeat_at` back to `pending`, clearing `claimed_by`,
      `claimed_at` and `heartbeat_at` together. A row left naming a holder reads as
      claimed to everything that inspects it
- [x] Respects the attempts ceiling. The two `UPDATE`s are disjoint on `attempts` and
      run in one `batch()`: a row matched by both would be re-queued *and* retired in
      the same tick — `pending` in the table while Grafana counted a failure
- [x] **Terraform can own the schedule only because wrangler leaves it alone.**
      wrangler PUTs `/schedules` under `if (crons)` over
      `args.triggers ?? config.triggers?.crons`, so an absent `[triggers]` table means
      no request at all. An *empty* one is the trap: `crons = []` is truthy there, so
      adding the table with nothing in it silently deletes the Terraform-owned
      schedule. No deploy fails, and the only symptom is crashed jobs sitting
      `claimed` forever — M6's own failure mode, arriving quietly. A test asserts the
      table stays absent
- [x] `terraform apply` — run 2026-08-04, trigger created 15:31:25Z. Confirmed from
      both sides: `cloudflare_workers_cron_trigger.reaper` in state, and the account's
      `/schedules` returning `*/5 * * * *`. Checking only one side would not have been
      enough — a `wrangler deploy` can delete the schedule while state still claims it

### M6.3 — Reclaim visibility
- [x] Reclaim events emitted as spans. Not metrics, because there are none to emit:
      @microlabs/otel-cf-workers exports traces only. One span per job rather than one
      per tick carrying a count — Tempo's metrics-generator turns span *rate* into a
      series, and a count inside an attribute is not a rate and cannot be made into
      one here
- [x] Two span names, `job.reclaimed` and `job.retired`, rather than one name plus an
      `outcome` attribute. The metrics-generator keys on service, span name, kind and
      status; an arbitrary attribute is not among them, so the attribute version would
      be unsplittable in Grafana — the exact thing this bullet asks for
- [x] Reclaim rate visible in Grafana. The metrics-generator turns both span names into
      series: `traces_spanmetrics_calls_total{span_name="job.reclaimed"}` read 2 and
      `{span_name="job.retired"}` read 1 after the three crash cycles, which is exactly
      the split that happened. A *dashboard panel* is still M9.1's — what is closed here
      is that the query exists and returns the right numbers
- [x] Failed jobs visible in the admin list — already delivered by M5.3, which returns
      `status` and `failure_reason` and renders both

### M6.4 — Verify by killing it — **done 2026-08-04**
- [x] Document the recovery behaviour — README "Recovery from a crash", including the
      worst-case seven-minute pickup and why it is not tuned tighter
- [x] A way to have a job worth killing. Until M7 lands extraction a job closes in
      about 90ms, so there is no middle to interrupt: `CROWDMON_SIMULATED_WORK` holds
      a claimed job for a configured duration. Seeding a stale `claimed` row into D1
      was the alternative and was rejected — it tests the reaper's SQL, which the
      unit tests already do, while saying nothing about what a killed container
      actually leaves behind, which is the whole question
- [x] Kill the container mid-job; confirm reap and retry — the table above, then a
      second cycle re-queueing at `attempts=2`. **The first two attempts at this test
      proved nothing, and the reasons are worth keeping.** The first ran without
      `CROWDMON_SIMULATED_WORK` reaching the process: `env_file` is read when the
      container is *created*, so a restart kept the old environment and jobs closed in
      0s. The second killed the worker while it was **idle** — the job had been
      submitted a minute earlier and the poll backoff had not reached it, so no lease
      existed and the reaper correctly had nothing to do. Both looked identical from
      the dashboard: "nothing got claimed"
- [x] Confirm a permanently failing job reaches `failed` and stops. Third cycle
      retired job 13 at `attempts=3` with `exhausted its attempts without reporting an
      outcome`, and a restarted worker then polled without claiming it — "stops being
      handed out" checked by observation, not inferred from the status column
- [x] Reclaim spans confirmed end to end in Tempo, which no test could show:
      `job.reclaimed` and `job.retired` both arrived as children of
      `scheduledHandler */5 * * * *`, carrying `crowdmon.job.id=13` and the right
      `attempts`, with `crowdmon.reaper.requeued`/`retired` on the tick

**A trap worth recording:** `docker kill` leaves the container stopped. Docker
suppresses `unless-stopped` for anything halted by hand, so the worker does not come
back on its own — which is what M4.5 already warned about from the other direction.
During this verification that meant a killed worker stayed dead, and the next submitted
job sat `pending` indefinitely looking like a reaper failure. `docker compose up -d`
is the way back.

**Found while building this, and fixed here rather than filed:** a graceful shutdown
retired the job it was holding. Work interrupted by SIGTERM returns `context.Canceled`,
the runner passed that to `complete` as a cause, and `complete` with a cause writes
`status='failed'` — which is terminal. An ordinary `docker restart` would have
permanently killed whatever was in flight, and burned a video that had nothing wrong
with it. The worker now leaves the row `claimed` and lets the reaper hand it back: that
costs one lease window and spends an attempt, which is the same deal a crash gets. It
was invisible before M6 because `Runner.Work` was nil and no job could be interrupted.

---

## M7 — Download and fan-out

*Goal: one video becomes N chunk jobs.*
*Depends on: M4, M6.*
*Done when:* submitting a URL produces chunk rows covering the whole video.

**Built, applied and verified against production 2026-08-07.** All four sub-milestones landed as one
branch: the fan-out endpoint and the worker pipeline are one mechanism split across two
runtimes, and shipping the halves separately would have meant a worker calling an endpoint
that did not exist, or an endpoint nothing called.

Two videos went through the whole path. The first is the milestone's "done when" in full —
trace `08737b124f04d6642570c4be1b81166c`:

| Time (UTC) | Event |
|---|---|
| 12:23:33 | download job 14 claimed, `attempts=1` |
| 12:24:59 | source ready — 441,397,007 bytes in 86,639ms |
| 12:25:00 | probed 1475s at 1920x1080; fanned out **25 segments, 25 created** |
| 12:25:03–08 | all 25 chunk jobs claimed, source present, done |

1475s divides into 24 full segments and a 35s tail, which is the rounding-up decision
arriving in production. The second video was 11 seconds — one segment, `0-11` — which is
the same decision at the other end: a video shorter than one segment still gets one, and
its chunk stops at the duration rather than at 60. A third, 69 minutes and 1.26GB, fanned
out to 70 segments: 141 statements in one batch, committed in 383ms.

**ffprobe read that third video as 4153s where yt-dlp's metadata said 4152.** It changed
nothing here — both round to 70 segments — but it is the reason M7.2 measures the file
rather than trusting what YouTube said about it. One second in the wrong place at a
60-second boundary is a segment that does or does not exist.

All three of M7.1's span attributes reached Tempo (`crowdmon.download.bytes`,
`crowdmon.download.duration_ms`, `crowdmon.download.skipped=false`), as did the probe's
three and the fan-out's two.

**The deployment order is load-bearing and is not obvious.** `docker compose pull` must
run *before* the new compose file is in place, because Docker seeds a fresh named volume
with the ownership of the directory it covers in the image. Bring the volume up against
the old image — which has no `/home/worker/videos` — and it is created root-owned, after
which the unprivileged process fails every download with permission denied on a box where
the directory visibly exists. Verified the right way round: the volume came up
`drwxr-xr-x worker worker` and writable.

### M7.1 — yt-dlp download
- [x] Download to local disk with a TTL — `video.Store` owns the directory and the
      expiry, and source video never touches R2. Pruning runs at the start of each
      download rather than on a timer: downloads are what fill the disk, so downloads pay
      for the cleanup, and a worker that has stopped downloading is one whose disk is not
      growing. The TTL (6h) is deliberately far longer than a video takes to drain its
      chunk jobs — a file pruned out from under a pending chunk produces M7.4's failure
      on a box that did nothing wrong
- [x] **A video already on disk is not re-fetched.** Not an optimisation: a download job
      reaped mid-fan-out is claimed again, and re-fetching gigabytes to arrive at the file
      already there would make a reap during phase one cost more than the work it
      interrupted
- [x] Handle unavailable, private and geo-blocked videos as terminal failures — plus
      members-only and age-gated, matched against yt-dlp's own stderr. **The list is short
      on purpose and the default is retryable:** an unlisted failure costs a lease window
      and an attempt, a wrongly listed one burns a video permanently. `Sign in to confirm
      you're not a bot` is the pattern kept off it — it reads exactly like the age gate
      and is about this box's address, not about the video
- [x] The other half of that sorting lives in the runner, and it inverts what M6 shipped:
      only a terminal failure is reported through `complete`, because `complete` with a
      cause retires the row on the first report. Everything else is left `claimed` for the
      reaper, which is the same deal a crash gets
- [x] Download duration and file size recorded as span attributes — `crowdmon.download.bytes`
      and `crowdmon.download.duration_ms` on `video.download`, plus
      `crowdmon.download.skipped` so a re-run reads as a skipped download rather than a
      suspiciously fast one. Size is read from the file on disk, not from anything yt-dlp
      said about it

### M7.2 — Probe and enqueue chunks
- [x] ffprobe for duration and resolution, measured on the file that landed rather than
      taken from YouTube's metadata — the format selection decides what actually arrives,
      and the segments have to tile that. Duration is rounded **up**: rounding down would
      leave the tail of the video in no chunk at all
- [x] Enqueue one chunk job per 60s segment, with the last segment short rather than
      running past the end of the file
- [x] **The enqueue is an API endpoint, not the worker writing rows.**
      `POST /api/jobs/{id}/fanout` does the whole fan-out in one D1 `batch()`, which is
      what M3.4 required of it: the claim handler retires a chunk job whose `chunks` row is
      missing as corruption, and that is only correct if the pair cannot be observed
      half-written. A worker making one call per segment could not have been transactional
- [x] Video metadata persisted on the `videos` row, with the title left alone when the
      download was skipped and had none to report — `COALESCE`, so a re-run cannot
      overwrite a title with nothing
- [x] **Video length has a ceiling, and it is a schema bound.** Segments are statements, so
      six hours is 721 of them in one batch; `FanOutRequest` rejects longer with a 400
      naming the limit rather than letting a batch fail halfway. A test fans out four
      hours for real

### M7.3 — Idempotency
- [x] Re-running phase one does not duplicate chunk jobs, and the API says so: the
      response separates `segments` (what the video has) from `created` (what this call
      inserted), so a re-run is observable from outside rather than inferred from row
      counts. **What it does not do is re-tile a video whose duration came back
      different** — segments are keyed on `(video_id, segment_index)` alone, so existing
      rows keep their boundaries. The source file is reused rather than re-fetched, so a
      second probe measures the same file and cannot disagree unless somebody deleted it
      between attempts
- [x] Deterministic chunk identity from `(video_id, segment_index)` — `idx_chunks_identity`
      was already unique; what M7 adds is a fan-out that collides with it deliberately
- [x] **Both statements of a pair carry the same `NOT EXISTS` guard, and that is the
      subtle part.** `ON CONFLICT DO NOTHING` on the chunk insert would leave its job row
      already inserted — an orphan, which is the corruption above. And the guards must be
      *identical*: `last_insert_rowid()` returns the previous insert's id when a statement
      inserted nothing, so a chunk insert running while its job insert was skipped would
      attach itself to another segment's job
- [x] Verified by forcing a reap mid-fan-out — **done 2026-08-07, and the two failed
      attempts are the more useful half of the record.** A stale lease was written onto
      the finished download job for a 69-minute video and the real Cron reaper took it:

      | Time (UTC) | Event |
      |---|---|
      | 14:28:39 | `heartbeat_at` set 600s stale, `attempts=1` |
      | 14:32:36.191 | reaper re-queued it; claimed at `attempts=2` |
      | 14:32:36.192 | source ready, `download_ms=0` — **1ms after the claim** |
      | 14:32:36.579 | fanned out: `segments:70`, **`created:0`** |

      Afterwards: 70 chunk rows, 70 chunk jobs, zero orphans, job `done` at `attempts=2`,
      and `crowdmon.download.skipped=true` on the span. The whole re-run took 388ms
      against a video that had originally taken 235 seconds to fetch, which is the
      argument for not re-downloading, in one number.

- [x] **Two attempts to catch this from outside failed, and they failed structurally
      rather than unluckily.** Both watched the container's log and paused it. Phase one's
      real timing is `source video ready`, then `fanned out` ~302-383ms later, then
      `job done` ~171ms after that. The first attempt watched for `fanned out` and missed
      by 171ms. The second watched for `source video ready` and froze the process *during*
      the completion call — the API had already committed `done`, and the worker surfaced
      `context deadline exceeded` when it thawed. **Every log line is written after its
      API call has already committed server-side**, so by the time `fanned out` is
      visible, `complete` is already in flight. The window a reap has to land in contains
      no externally observable event, on a video of any length. Hand-writing the
      timestamps is not a shortcut around that — it is the only way in, and it fakes
      strictly less than M6.4's rejected alternative did: there a seeded row would have
      stood in for the reaper's *input*, proving nothing about a crash, whereas here the
      reaper and the re-run are both real and only the thing that made the lease go stale
      is synthetic

- [x] **Found by the second failed attempt, and worth more than the attempt was:** the
      "server committed, the client never heard" case happened for real. The API recorded
      job 42 `done` while the frozen worker's 5s report timeout expired, so the worker
      believed the call had failed. It logged a retryable poll error, backed off,
      recovered and drained the 70 chunk jobs — no crash, no double report, no orphaned
      lease. That path had never been exercised outside a unit test

### M7.4 — Affinity guard
- [x] Chunk jobs assert the source file is present locally — after claiming, not before:
      a worker cannot inspect a job it has not been given, and the claim endpoint has no
      idea which box holds which file. What the guard buys is that the check happens once,
      up front, instead of ffmpeg discovering it partway through
- [x] Missing file fails cleanly rather than half-processing, and fails *terminally*: no
      amount of retrying puts a file on a disk that does not have it. Half a chunk's frames
      are worse than none, because the rows they produce look like a complete segment
- [x] A disk that answered with an error is not a disk that answered "no" — only
      `ErrNotDownloaded` is the affinity failure; an unreadable directory stays retryable
- [x] Constraint documented — README "Phase one: download and fan-out", CONTEXT.md §Q13's
      M7 amendment, and the failure message itself, which names the constraint rather than
      saying "not found". An operator reading "not found" would go looking for a bug rather
      than for the second worker that should not exist

---

## M8 — Chunk extraction

*Goal: v1 core. Deduplicated images land in R2.*
*Depends on: M7.*
*Done when:* images are in R2 and rows are in D1, visibly deduplicated.

### M8.1 — ffmpeg extraction
- [x] Extract at 1fps for the chunk's segment only
- [x] Frames written to a temporary working directory
- [x] Extraction duration and frame count recorded

### M8.2 — Perceptual-hash dedup
- [x] pHash each frame; drop frames within the Hamming threshold of the last kept frame
- [x] Threshold configurable, not hardcoded
- [x] Frames extracted, frames kept and dedup ratio emitted as metrics

### M8.3 — R2 upload
- [x] Deterministic keys from `(video_id, timestamp)` — overwrite rather than duplicate
- [x] Upload concurrency bounded
- [x] Verified: re-running a chunk does not inflate the dataset

      Proven in production on 2026-08-07, not merely by test. A chunk job was
      forced back to `pending` in D1, re-claimed and re-run against the real
      bucket; `images` held at exactly 674 rows and the objects were overwritten
      at their existing keys. `attempts` went to 2, so the re-run genuinely
      happened rather than being skipped.

      Scope, stated because the acceptance criterion does not state it: this
      covers a re-run under the *same* settings, which is the case the reaper
      actually produces. A re-run whose dedup keeps a different set of
      timestamps is a different question and is not what this box claims.

### M8.4 — Image rows and threshold provenance
- [x] `images` rows carrying R2 key, phash, source video, timestamp
- [x] **The dedup threshold in force is stamped onto the rows it produced.** Changing
      the threshold later does not re-deduplicate old videos, so without this the
      dataset becomes an unrecorded mixture of regimes
- [x] Config version recorded on the job

---

## M9 — Close v1

*Goal: the v1 sentence is demonstrably true.*
*Depends on: M8.*

### M9.1 — Grafana dashboard
- [x] Queue depth, job duration, dedup ratio, reclaim rate, failure rate — six panels,
      because "job duration" is two job kinds and chunk duration alone would have
      answered for the phase that is *not* most of a video's wall time
- [x] Dashboard JSON committed to the repo, with `${DS_PROMETHEUS}` as an import input
      rather than a datasource UID this repo does not own and cannot predict
- [x] Reachable from the admin dashboard by link, not rebuilt inside it

      **Two panels had no data source and had to grow one.** Queue depth exists only in
      D1, Prometheus cannot scrape a Worker, and adding a scrape target would mean
      editing a monitoring stack shared with unrelated projects — so `/api/jobs/stats`
      returns all eight status×kind counts and the Go worker republishes them as a
      gauge. Zero-filled by the API, because `GROUP BY` omits empty buckets and a
      drained queue would otherwise be indistinguishable from a worker that stopped
      reporting, which is the one thing the panel exists to show.

      Failure rate counted only reaper retirements, because `complete` wrote
      `status='failed'` to D1 without touching its span — so at the span-metrics layer a
      *reported* terminal failure looked exactly like a success. `job.failed` closes
      that, in the same one-span-per-job, distinct-name idiom §Q14's M6 amendment
      argues for.

### M9.2 — End-to-end trace
- [x] Single trace spanning submit → claim → download → fan-out → chunk completion
- [x] `traceparent` propagated across the Workers-to-Go boundary
- [x] Captured for the writeup — as the trace's own span census rather than a
      screenshot, which is the thing a reader can check against Tempo themselves:
      3,961 spans under one trace id, one `POST /api/admin/videos` at the root

      **The join could not be a header.** A submit and the claim that runs it are
      minutes or hours apart with no synchronous call between them, so the job row is
      the only thing that survives the gap — migration 0002 adds a nullable
      `traceparent`, submit stamps it, fan-out forwards the incoming one so every chunk
      inherits the same trace id, and the worker extracts it with the propagator it
      already installs. Null or malformed falls back to a root span: telemetry never
      fails a job.

      **Honest about one edge.** `job.claimed` is a marker inside the adopted trace, not
      the claim request wearing a new parent. The response has to arrive before anything
      knows which trace to join, so there is no request left to re-parent by then.

### M9.3 — Deadman check — ~~not planned~~
- [x] **Cancelled on 2026-08-08, not deferred.** Issue #48 closed as not planned, and
      `CONTEXT.md` §9.5 moved from open item to accepted risk with the reasoning. A dead
      collector costs visibility, not data; the alert it would buy is a push
      notification about a system with no users, against a third-party account, a secret
      and a systemd unit of new surface. The dangerous half — a dead collector looking
      identical to a healthy idle one — is already closed by `queue_depth` reporting
      explicit zeros when drained and going absent when nothing exports, which M9.1's
      zero-fill built for exactly this reason

### M9.4 — Acceptance run and writeup
- [x] Full run from a clean queue against a real video — "Archon quest chapter 4 Act 2
      (part 2)", 5,812s, 97 segments, submitted through the dashboard on 2026-08-08
- [x] All eight success criteria in `PRD.md` §5 verified — the table is in the README so
      it sits next to the claim it proves
- [x] README updated with architecture summary and the v1 demo path

      5,812 frames extracted, 2,685 kept, 2,685 `images` rows against 2,685 distinct R2
      keys. The dedup ratio agrees between two independent paths — 0.540 from
      Prometheus, 0.538 computed from the rows — which is the check worth having, since
      a metric and a table disagreeing is exactly how a dashboard starts lying.

      **What the run cost that the plan did not predict:** `kill -9` on the container's
      PID 1 does nothing at all, silently. The kernel will not deliver a signal to
      namespace-PID-1 from inside that namespace unless the process has a handler
      registered, and SIGKILL can never have one. SIGTERM works because the Go runtime
      catches it. Written up in `deploy/homebox/README.md` where the next person will
      be standing.

---

## What v1 deferred, and where it went

Recorded here as it stood when v1 closed, so the split is auditable rather than
retold.

| Deferred from v1 | Where it landed |
|---|---|
| Annotation UI | M13 (admin), M14 (public) |
| Gated pre-label pool | M11 |
| Presigned image serving | M13.4 (batched, admin), M14.2 (one per request, public) |
| Dataset snapshots with split manifests | M15 |
| Semantic flywheel spans | M11.4 — the promotion trigger `CONTEXT.md` §9.3 wanted |
| Weighted active-learning selection | **Split.** The `selection_reason` flag is M10.2; the 70/20/10 weighting is v4 |
| Google OAuth and sessions | **Dropped.** v2 has two tiers, admin behind Access and anonymous, so there is nothing for OAuth to authenticate — `CONTEXT.md` §Q7 |
| Grounding DINO bootstrap | **Replaced.** Zero-shot detection runs on the home box behind a one-method interface (M11.2), so the model is a swap rather than a commitment |
| YOLO training, model registry | v4. Training moves onto the box rather than Kaggle — `CONTEXT.md` §Q21 |
| Public landing and demo pages | **Reshaped.** The public surface is the verification page (M14), not a detector demo; the detector leaves with the training |
| Leaderboards | Still out. `CONTEXT.md` §Q10 |

---

# v2 — Labelling platform

**Done-claim:** a submitted video becomes pre-labelled frames with no human trigger,
verified through this platform's own UI — public to anyone, authoritative for an admin —
and exported as a dataset snapshot with a split manifest.

Six milestones. Scope in `PRD.md` §9, design and rejected alternatives in `CONTEXT.md`
§12. v2 has no separate success-criteria list: the sentence is the completion test, and
`PRD.md` §9 tabulates the observation that falsifies each clause.

**Two ordering decisions worth stating before the milestones, because both look wrong at
a glance.**

*Schema lands whole and first,* against §Q26's warning about infra-first phases. Every
later milestone writes to these tables, and a migration reversed after three UIs read from
it is the expensive version of this ordering. What does **not** land up front is the
endpoint surface: each milestone brings the routes it needs, so the vertical-slice
discipline holds everywhere it costs something. This refines `CONTEXT.md` §12's milestone
1, which read as though the whole contract landed at once.

*Pre-labelling precedes the class-management UI,* which reads like a dependency error
since the detector needs prompts. It is not: `classes` is a table from M10, so M11 reads
prompts that were seeded by hand. M12 is the *management* of classes — adding, validating
and activating one without a deploy — which is worth having only once there is something
that consumes them.

---

## M10 — Schema and prediction contract

*Goal: everything v2 writes to exists, on both sides of the contract.*
*Depends on: v1.*
*Done when:* a migration applied to D1 creates the five new tables, and the committed
spec declares the prediction-write endpoint with the Go client regenerated from it.

### M10.1 — Migration: classes, predictions, verdicts, missing_reports, snapshots
- [ ] `classes` — name, appearance prompt, prompt version, active flag
- [ ] `predictions` — image, class, box, **confidence**, prompt version, model identifier.
      Confidence is persisted because a later uncertainty-band selector needs it and
      cannot reconstruct it from coordinates (`CONTEXT.md` §Q16)
- [ ] `verdicts` — prediction reference, `accept`/`adjust`/`reject`, adjusted coordinates,
      source, annotator identity or opaque session id. **Append-only, and several verdicts
      on one prediction is a legal state** — the schema must not carry a uniqueness
      constraint that forbids it
- [ ] `missing_reports` — image, optional class, reporter
- [ ] `snapshots` — id, R2 key, counts, the inclusion policy in force
- [ ] **Nothing overwrites a prediction.** An `adjust` writes coordinates onto the verdict
      row. A schema that let it mutate the prediction would make excluding an annotator
      later unrecoverable rather than a `WHERE` clause

### M10.2 — images gains public_sample and selection_reason
- [ ] `public_sample` — hand-curated, set from `/admin`, never by an ingestion run
- [ ] `selection_reason` — written at selection time. **This is the half of §Q16 that
      cannot be added later:** every image labelled before the flag exists was chosen by
      some biased rule and can never be retro-declared an unbiased sample
- [ ] Both nullable and backfilled as null, so v1's 2,685 rows stay valid

### M10.3 — Prediction-write contract
- [ ] zod schemas for a prediction batch, declared with `@hono/zod-openapi`
- [ ] The endpoint the worker posts predictions to, in the shape `/api/jobs/{id}/images`
      already established — one call per job, not one per box
- [ ] Committed spec regenerated, Go client regenerated, drift test green

---

## M11 — Pre-labelling

*Goal: frames get boxes without anybody starting anything.*
*Depends on: M10.*
*Done when:* submitting a video results in `predictions` rows, with no manual step
between the URL and the boxes.

### M11.1 — `prelabel` as a fourth job kind
- [ ] `jobs.kind` accepts `prelabel`; the claim query, reaper and stats endpoint need no
      special-casing to see it
- [ ] One job per video, enqueued when its chunks are complete. **Not one per chunk** —
      the sample is drawn across the whole timeline and a chunk job cannot see outside
      its own sixty seconds
- [ ] Go pipeline dispatches a third branch; terminal-versus-retryable classification
      follows `worker.Terminal`'s existing rule, defaulting to retryable
- [ ] A missing image object is terminal, in the same spirit as M7.4's affinity guard —
      re-queueing it hands the same broken row out on every poll

### M11.2 — Detector behind a one-method interface
- [ ] Interface takes an image path plus prompts, returns boxes with confidences
- [ ] ONNX open-vocabulary model running on the box's CPU as the production implementation
- [ ] Tests substitute a table of known boxes — **no test may require a model file, an
      ONNX runtime or a GPU.** Same seam as `frames.Deduper`'s injectable hash
- [ ] Model identifier recorded on every prediction, so swapping the model is visible in
      the data rather than inferred from dates

### M11.3 — Bounded timeline sampling
- [ ] Default 200 images per video, configurable through worker environment
- [ ] Drawn across the timeline, not the first N — the test asserts the **spread** of
      selected timestamps, not the count
- [ ] Budget in force stamped on the rows produced, in `images.dedup_threshold`'s idiom
- [ ] Unsampled frames keep their rows and objects, available to a later pass

### M11.4 — Semantic spans
- [ ] Spans for sample selection, detection per class, and the prediction write —
      the first work in this project with a middle worth naming, which is the concrete
      promotion trigger `CONTEXT.md` §9.3 asked for and never got
- [ ] Sampling posture decided before any global sampler is configured (§9.4): flywheel
      spans are low-rate and high-value, HTTP spans are the opposite, so a global head
      sampler set now would discard the only data worth having
- [ ] Pre-label duration, throughput and failure rate on the existing Grafana dashboard;
      `queue_depth` picks up the new kind through the stats endpoint's zero-fill

---

## M12 — Classes as data

*Goal: a prompt can be tried before it counts, and changed without a deploy.*
*Depends on: M11.*
*Done when:* a class can be added, validated against a sample of frames and activated
from `/admin`, with no code change.

### M12.1 — Class management behind Access
- [ ] Create, edit, activate and deactivate — never delete, so the predictions a retired
      prompt produced keep their referent
- [ ] Editing a prompt bumps its version rather than overwriting it. **Rewording in place
      would silently create two regimes inside one class**, which is the same failure
      `images.dedup_threshold` exists to prevent

### M12.2 — Prompt dry-run
- [ ] Run a candidate prompt against ~50 frames and show the boxes, writing nothing
- [ ] Available before activation, because the alternative is discovering a bad prompt
      after it has pre-labelled a video

### M12.3 — Five active classes
- [ ] Paimon plus four, chosen on visual separability and on appearing in footage that
      can actually be obtained
- [ ] Prompts written as **appearance descriptions, not names** — an open-vocabulary
      detector has no concept of a proper noun
- [ ] Per-class pre-label precision will vary widely and that is expected: the characters
      the zero-shot model fumbles are the ones that justify a verification platform

---

## M13 — Admin verification

*Goal: verdicts exist, and they are human judgements on model predictions.*
*Depends on: M11.*
*Done when:* an admin can accept, adjust or reject a proposed box and the verdict is a
row in D1.

### M13.1 — The verification component
- [x] One image, its proposed boxes, and accept / adjust / reject — an adjustment is
      drawn by dragging a corrected box over the frame, in the same normalized [0, 1]
      coordinates the schema stores
- [x] Reject-whole-image in one action — menus, loading screens and black frames are the
      common case and must not cost several. It stages a reject for every box, so the
      whole frame costs two clicks and one request whatever the box count

      **Rulings are staged, not written as they are clicked**, and that came out of using
      it: a frame with five boxes of one class had every ruling remove its own row and
      renumber the rest, under a cursor already moving toward the next one. Nothing
      leaves the component until Submit, so the frame holds still while it is judged.
      The endpoint follows the interaction rather than the other way round — one call
      per frame, one D1 batch, all of it or none.
- [x] Built as one component with two mounts from the start, because M14 renders the same
      thing against different endpoints

      **The seam is that `VerificationCard` knows no endpoint.** Every action is a
      callback the mount supplies, and the admin-only controls are *absent* rather than
      disabled when their callback is not passed — a disabled control is a promise that
      signing in would help, and M14's visitor has nothing to sign into. Its test file
      renders it with plain props and no query client, which is the check that the split
      still holds: the day that test needs a `QueryClientProvider` is the day the
      component learned an endpoint.

### M13.2 — Verdict endpoints
- [x] Append-only writes; an `adjust` carries coordinates on the verdict row and leaves
      the prediction byte-for-byte unchanged — asserted against the row rather than the
      response, because a handler that mutated `predictions` could still echo the
      original coordinates back. One endpoint, `POST /api/admin/images/{id}/verdicts`,
      taking a whole frame's rulings: the per-prediction and reject-whole-frame routes
      that shipped first were replaced by it rather than kept beside it, because two
      ways to write a verdict is two places for the append-only rule to be got wrong
- [x] Verdicts carry `source` and identity from the Access assertion. A body that names
      its own `source` is ignored, and that is tested: a caller who could set it could
      write an admin verdict from the public page M14 mounts the same component on
- [x] Under `/api/admin`, so the existing gate and the Worker's own allowlist both apply
      with no new auth code

### M13.3 — Missing-object reports
- [x] Admin-only, stored as their own row type rather than as a verdict on a prediction
      that does not exist
- [x] **This is the escape hatch for the one thing verify-only cannot see.** A frame the
      detector missed produces no pre-label, is never shown, and in the table is
      indistinguishable from a frame where the character was absent

      **Half of it is reachable from the screen, and the honest bound is worth stating.**
      A frame the detector *partly* missed — one character boxed, another not — is in the
      session pool and the report is one click. A frame it missed *entirely* has no box
      to rule on, so it is not in the pool at all: the endpoint takes its image id
      happily, but nothing walks an operator to it. Putting those frames in the pool
      needs a row type this schema does not have — "a human looked and there is nothing
      here" — because with no prediction to verdict there is no way for the frame to
      leave the pool again. Deferred rather than half-built, and the route description
      says so rather than implying coverage it does not have.
- [x] Report rate per class surfaced in `/admin` — the number that says whether a prompt
      is good enough

      Rendered as a fraction over `pool.images_verified`, not as a percentage and not
      over the class's own box count. A prompt that grounds on nothing has no boxes to
      divide by, and it is exactly the prompt whose miss rate matters; "3 / 40" also
      carries how much evidence is behind it, which "7.5%" does not.

### M13.4 — Image serving for a labelling session
- [x] Batched short-lived presigned URLs, per `CONTEXT.md` §Q25 — N images and their
      signed URLs in one call, bytes fetched from R2 directly

      **Two modes, because the credential is the one thing this repo cannot create.**
      Signing needs an R2 S3 access key that only a human at the Cloudflare dashboard can
      mint, so a deployment without one falls back to the Access-gated `/api/admin/image`
      proxy and says so as `url_mode`. Both modes keep §Q25's posture whole — private
      bucket, no enumeration, same allowlist — and setting `FRAMES_S3_BASE_URL` plus the
      two secrets switches the mode with no code change. Both are tested; the fallback is
      not a degraded path to be discovered in production, it is the mode every deployment
      is in until the key is set.

      **No third token.** The key to set is the detector's existing read-only one, not a
      newly minted one and not the Go worker's read-and-write one — presigning a GET
      needs Object Read on one bucket and nothing else. The cost of sharing it is that a
      rotation moves two systems at once, so it is written down at both ends rather than
      discovered during one (`apps/api/wrangler.toml`, `deploy/homebox/.env.example`,
      `CONTEXT.md` §Q25).
- [x] The UI re-requests the batch on a 403 rather than treating expiry as an error — an
      `<img>` reports only that it failed, so the refresh is driven by the load failure,
      once per batch. A second failure on freshly-signed URLs is a missing R2 object, not
      an expiry, and is said so on screen rather than retried forever
- [x] Verdict counts, class coverage and pool size in `/admin`. **Business data here,
      system data in Grafana** — §7's "do not rebuild Grafana inside /admin"

---

## M14 — Public verification

*Goal: a stranger can try the interface without an account, and cannot touch the dataset.*
*Depends on: M13.*
*Done when:* an unauthenticated visitor verifies a frame and the verdict is recorded with
`source = 'anon'`.

### M14.1 — Curating the public pool
- [x] Flag an image into `public_sample` from `/admin`

      `PATCH /api/admin/images/{id}/public-sample` — the only writer of the column, never
      touching `selection_reason`.
- [x] **Kept separate from the frozen evaluation pool.** The two have opposite selection
      criteria: the eval pool must be *random*, so it is full of menus and black frames;
      the public pool must be *legible*, or a visitor's first impression is a black
      rectangle. An image qualifying for both is excluded from `public_sample`

      No DB constraint ties the two flags — v2 writes `selection_reason = 'random'` on
      every selected image (§Q16: the weighting lands in v4), so a hard exclusion would
      make the feature unusable today. The separation is structural instead:
      `public_sample` has exactly one writer, an admin's deliberate PATCH, and nothing
      about extraction or pre-labelling ever sets it — so "which frames are legible
      enough to show a stranger" stays a curatorial judgement an admin makes one image at
      a time, not a query over the pool.

### M14.2 — The public route
- [x] Outside the `/api/admin` prefix, authenticating nobody
- [x] **One short-lived signed URL per request, no enumeration.** The batched form stays
      on the authenticated path where throughput matters

      Signed only — never `frameUrls`' proxy fallback, which is the Access-gated
      `/api/admin/image` route a visitor with no Access session cannot reach. A
      deployment with no R2 credential configured answers `503` on `/api/public/frame`
      rather than handing out a URL that would 401 in the browser.
- [x] Adjust and missing-object reporting hidden on this mount

      Enforced twice: `VerificationCard`'s `allowAdjust={false}` keeps the button off
      screen, and `PublicStagedVerdict` has no adjusted-coordinate fields at all, so the
      kind is refused at the schema layer even for a caller that bypasses the UI.

### M14.3 — Bounding it
- [x] Rate limiting on the public endpoints — "not at scale" enforced by a mechanism
      rather than asserted in a document

      A `[[ratelimits]]` binding (wrangler.toml), 20 requests per 60 seconds per
      `(bucket, ip)` — one bucket per route rather than per prefix, so the frame read and
      the verdict write each get their own budget.
- [x] `noindex` on the public pages

      One `<meta name="robots" content="noindex">` in `index.html`, which covers every
      route the single-origin SPA serves.
- [x] Copy that says the visitor is trying the interface, not labelling the live dataset.
      The page must not be lying to them about what their click did

### M14.4 — Anonymous verdicts recorded, never promoted
- [x] `source = 'anon'` plus an opaque session id, so excluding one bad actor does not
      mean discarding every anonymous contribution

      Client-generated (`crypto.randomUUID()`, persisted in `localStorage`) and written
      verbatim as `annotator_id` — it carries no trust, only a way to tell one visitor's
      contributions apart from another's later.
- [x] Shown back to the visitor immediately, so the page is not theatre
- [ ] Excluded at snapshot time by the recorded inclusion policy. **Admitting them as
      labels is the single decision that would force consensus resolution, agreement
      scoring and trust weighting** — the three subsystems §Q10 refuses

      Nothing to exclude *from* yet — M15's snapshot does not exist. What M14 owes this
      bullet is already true (`source = 'anon'` is unambiguous on every row it writes);
      the exclusion itself is M15's to build and check off.
- [x] Accept/adjust/reject rates computed **per source**. Pooled, a troll rejecting
      everything is indistinguishable from a model that got worse

      `LabellingStats` now reports `anon_accepted` / `anon_adjusted` / `anon_rejected`
      beside the admin triple, not a single lumped `anon_verdicts` count.

---

## M15 — Snapshot and split manifest

*Goal: the dataset leaves the system as one artifact.*
*Depends on: M13, M14.*
*Done when:* a snapshot with a split manifest is in R2, and the done-claim is true end
to end.

### M15.1 — Snapshot builder
- [ ] Admin-triggered, runs as a job rather than in a request — building one must not
      depend on a browser tab staying open
- [ ] Images, labels and manifest written to R2 under a stable snapshot id
- [ ] Listable with counts and dates, so the dataset visibly grows

### M15.2 — Split manifest
- [ ] Holds `selection_reason = 'random'` images out of train
- [ ] **Matters more now than it did on Kaggle.** A training script on the same box as the
      images can glob the directory and never read the manifest, and that mistake looks
      like nothing going wrong — §Q21

### M15.3 — Inclusion policy recorded
- [ ] Each snapshot records the policy it was built under, so two snapshots built under
      different rules are distinguishable rather than mysteriously different
- [ ] Default policy excludes anonymous verdicts

### M15.4 — Close v2
- [ ] Every clause of the done-claim checked against a real run, using `PRD.md` §9's
      falsification table
- [ ] README updated with the v2 path, beside the v1 acceptance run
- [ ] Verified internally. **There is no stranger-checkable claim in v2** — a public
      statistics surface would have closed that gap and was deliberately not taken

---

## Deferred past v2

Training on any machine · model registry · distilled detector · in-browser inference ·
public detector demo · Google OAuth and sessions · consensus resolution, agreement
scoring, trust weighting · leaderboards · 70/20/10 weighted selection · a public
statistics surface · any measurement of detector accuracy.

Training and the flywheel proper are v4 or v5, on the home box, CPU-only and slow by
choice — `CONTEXT.md` §Q21 records the trap that will eat a multi-day run and the two
ways out. The operational debt in `CONTEXT.md` §9 stays debt, including yt-dlp
freshness, which was considered for v2 and left out to keep the sentence honest.

---

# v3 — Admin dashboard proper

A restructuring milestone, not a capability one. Everything `/admin` could do at the
close of v2 it still can — this is one milestone, not six, because nothing in it needed
a schema change or a worker release to earn its own number.

One requested feature is named here because it is deliberately absent: re-running the
detector over more frames of a video to seed the verification pool. It looks like a
page and is not — `idx_jobs_one_prelabel_per_video` (migrations 0005, 0007, 0008) is a
UNIQUE index, one `prelabel` job per video ever, and a re-run needs a migration, an
admin enqueue route, a worker change that samples only frames not already sampled, and
an answer to CONTEXT.md §Q19's provenance rule — thresholds get stamped onto the rows
they produced, or the dataset becomes an unrecorded mixture of regimes. `/admin/detection`
ships the read half of that page instead: prelabel coverage per video, so the page that
will eventually grow a button already tells the truth without one.

Tracked as [issue #134](https://github.com/mkcarlclaude/crowdmon-revamp/issues/134),
design in `CONTEXT.md` §Q19.

## M16 — Admin dashboard proper

*Goal: `/admin` stops being one scrolling page and becomes a shell with a sidebar,
routed sub-pages, and a login screen a browser can land on.*
*Depends on: M15.*
*Done when:* an unauthenticated browser at `/admin` lands on a gate screen; an
authenticated one lands on a sidebar shell whose pages cover everything the single page
did, plus a verdict history and a per-video frame grid.

### [M16.1 — Component layer and a light theme that stays in its lane](https://github.com/mkcarlclaude/crowdmon-revamp/issues/135)
- [ ] shadcn/ui scaffolding: the `@/*` alias, `components.json`, the CLI's runtime
      deps, and the base components landing in `src/components/ui/`
- [ ] A light theme scoped to the admin shell by overriding the existing `--color-*`
      variable names on a subtree, not by flipping them globally
- [ ] `/` and `/verify` render identically before and after — the public surface is
      unmoved by any of it

### [M16.2 — The shell, and a login screen for an auth scheme with no login form](https://github.com/mkcarlclaude/crowdmon-revamp/issues/136)
- [ ] `GET /api/admin/session` returns `{ email }` behind `requireAccess`, 401
      otherwise — reaching the handler is the whole answer
- [ ] `/admin/login`: a gate screen with one button that navigates to
      `/api/admin/login`, never a credential form
- [ ] `AdminLayout`: persistent sidebar, a session probe on mount, and a redirect to
      the gate screen on failure — cosmetics, not the boundary; every `/api/admin/*`
      route still verifies the caller independently
- [ ] `/admin` redirects to `/admin/dashboard`; the dashboard page renders the word
      "Dashboard" and nothing else, on purpose

### [M16.3 — The existing surface, split into pages](https://github.com/mkcarlclaude/crowdmon-revamp/issues/137)
- [ ] `Admin.tsx` deleted; its six sections become `/admin/videos`, `/admin/verify`,
      `/admin/classes` and `/admin/snapshots` — the components each one mounts are
      unchanged past their own restyle
- [ ] Every moved component restyled onto shadcn primitives, one at a time, with its
      test kept green
- [ ] `routes.test.tsx`'s heading assertion at `/admin` becomes a redirect assertion

### [M16.4 — Reading back what was labelled](https://github.com/mkcarlclaude/crowdmon-revamp/issues/138)
- [ ] `GET /api/admin/verdicts?limit&offset&source` — verdict rows joined to
      prediction, image and class, newest first
- [ ] `/admin/annotations`: `LabellingStats` (moved) above a paginated list of the
      admin's own verdicts

### [M16.5 — Frames per video, browsable](https://github.com/mkcarlclaude/crowdmon-revamp/issues/139)
- [ ] `GET /api/admin/videos/{id}/images?limit&offset` — a new route, not a reuse of
      the worker-facing `listVideoImages`, which requires a held job lease no browser
      holds
- [ ] `/admin/videos/:id`: frame grid — image, timestamp, prediction count, verdict
      state, public-sample toggle

### [M16.6 — Detection coverage, read-only on purpose](https://github.com/mkcarlclaude/crowdmon-revamp/issues/140)
- [ ] `/admin/detection`: prelabel coverage per video — frames extracted, frames
      sampled, under which model, when
- [ ] No re-run button. What one would cost is recorded instead: a migration, an admin
      enqueue route, a worker change to sample only unsampled frames, and a provenance
      rule for the mixed-regime dataset a re-run would otherwise produce silently

*Amended by M19.2: the coverage table folded into `/admin/videos`, and `/admin/detection`
now redirects there. The read-only-on-purpose reasoning above is unchanged and moved with
it — only the route name in it is stale.*

## M17, M18 — shipped without a section here

M17.A (single-frame dry-run, [#148](https://github.com/mkcarlclaude/crowdmon-revamp/pull/148))
and M18 (annotation filters, verdict preview, public frame variety,
[#145](https://github.com/mkcarlclaude/crowdmon-revamp/pull/145)) landed against their
plans in `docs/superpowers/plans/` rather than against a checklist here. Recorded so the
gap between M16 and M19 reads as a bookkeeping omission rather than as milestones that
were skipped.

M17 §B — on-demand supplementary prelabel — landed the same way while M19 was in review
([#149](https://github.com/mkcarlclaude/crowdmon-revamp/pull/149)): an admin enqueue
route, a worker that samples an explicit list, and two actions on `/admin/videos/:id`
(hand-picked frames, or a randomised draw over un-sampled ones). The automatic first pass
is untouched, so PRD §9's *"with no human trigger"* clause and its recorded acceptance
evidence still hold — that was the constraint the M17 plan was built around.

## M19 — Video summary, one video list, and a queue that names the kind

*Goal: `/admin` tells the truth about a single video on that video's own page, and about
the queue on a page of its own.*
*Depends on: M16.*
*Done when:* a video's page opens with its own YouTube metadata and its own counts above
the frame grid; `/admin/videos` is the list of videos; and `/admin/queue` shows every job
of every kind, each labelled with the kind it is.

No migration, no worker release. Everything shown is already in D1 or already on the
wire — what was missing was somewhere to read it. Plan:
`docs/superpowers/plans/2026-08-14-video-summary-and-queue-page.md`.

### [M19.1 — Video summary above the frame grid](https://github.com/mkcarlclaude/crowdmon-revamp/issues/150)
- [ ] `GET /api/admin/videos/{id}` — the `videos` row's own `title`, `duration_seconds`,
      `width`, `height` and `url`, none of which any endpoint exposes today, plus frames
      extracted/sampled/public, predictions, verified vs unverified frames, model and
      last prelabel, and a chunk-progress summary
- [ ] 404 on an unknown id, unlike `listAdminVideoImages` — an empty *page of frames* is
      a true answer about a video that exists; a summary of a video never submitted is
      every field being a null pretending to be a fact
- [ ] The prediction rollup drives off `predictions` joined to `images`, never a
      correlated subquery per frame — the read-amplification shape `listVideosHandler`'s
      own comment documents at length
- [ ] `source = 'admin'` in the verdict join condition, so an anon verdict does not make
      a frame count as ruled — the same definition the grid below the header displays

### [M19.2 — The video list, and `/admin/detection` folded into it](https://github.com/mkcarlclaude/crowdmon-revamp/issues/151)
- [ ] `/admin/videos`: submit form, then the coverage table `/admin/detection` had —
      `useVideos()` already returns every field, so no API change
- [ ] `Detection.tsx` deleted; `/admin/detection` redirects rather than 404s; its M16.6
      scope line moves verbatim into `Videos.tsx`
- [ ] `SessionExpiredBanner` moves to `/admin/queue`, where the polling now is: a page
      whose only query never refetches cannot detect a session that expires mid-visit

### [M19.3 — A queue page that names the job kind](https://github.com/mkcarlclaude/crowdmon-revamp/issues/152)
- [ ] `/admin/queue`: one flat table, newest first, every kind labelled — including
      `snapshot`, which the grouped list drops entirely for having no video, and
      `prelabel`/`dryrun`, which it renders as nameless rows
- [ ] Status filter chips through the `?status=` `JobListQuery` already accepts; no
      summary counts, which off a 50-row page would count the page rather than the queue
- [ ] `JobList` deleted. Its group-by-video tree answered "how far along is this video",
      which M19.1 moves to the page that video owns

## The adjust tool, fixed twice

Found by working `/admin/verify` by hand rather than by a milestone. Recorded because
both bugs had shipped green and the second is the reason the first one's verification
was not worth what it claimed.

**Adjusting was invisible before it was permanent**
([#154](https://github.com/mkcarlclaude/crowdmon-revamp/pull/154)). `overlayBoxes`
always drew `frame.predictions`, so saving an adjustment put the box it *replaces* back
on the frame — `cancelAdjustment` clears the dashed drag rectangle, leaving the word
"adjust" in the row badge as the only trace of the correction. A mis-drag looked exactly
like a good one until Submit wrote it, and `verdicts` is append-only, so no later screen
would have caught it. A staged `adjust` now draws where the operator put it; a
correction replaced by a later accept or reject hands the rectangle back to the model.

**The browser's own gestures cancelled the draw**
([#155](https://github.com/mkcarlclaude/crowdmon-revamp/pull/155)). An `<img>` is
natively draggable, so a real press-and-move started an HTML5 drag-and-drop: the frame
tore loose as a ghost and the browser fired `pointercancel`, which `onPointerCancel`
correctly treats as the end of the drag. `draggable={false}` on the image, and
`touch-none` on the surface while an adjustment is armed for the touch-side equivalent.

The pair is the whole lesson, now in [`CLAUDE.md`](CLAUDE.md) under "Synthetic pointers
cannot reproduce a browser's own gestures": #154 was verified by driving the real
production screen, which proved the write path and nothing about the gesture, because
CDP mouse events do not start native drag-and-drop and neither does jsdom. Both fixes'
tests assert the attributes that keep the browser out of the way rather than replaying a
drag — a replay passes on the broken code.
