# Crowdmon 2026 — v1 Roadmap

**Scope:** [`PRD.md`](PRD.md) · **Design record:** [`CONTEXT.md`](CONTEXT.md)

Nine milestones. Each is independently shippable and a valid stopping point — the
project is open-ended by choice, so no milestone may depend on finishing the next one
to be worth having.

Issue bodies below are written to be pasted directly into GitHub.

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
- [ ] Extract at 1fps for the chunk's segment only
- [ ] Frames written to a temporary working directory
- [ ] Extraction duration and frame count recorded

### M8.2 — Perceptual-hash dedup
- [ ] pHash each frame; drop frames within the Hamming threshold of the last kept frame
- [ ] Threshold configurable, not hardcoded
- [ ] Frames extracted, frames kept and dedup ratio emitted as metrics

### M8.3 — R2 upload
- [ ] Deterministic keys from `(video_id, timestamp)` — overwrite rather than duplicate
- [ ] Upload concurrency bounded
- [ ] Verified: re-running a chunk does not inflate the dataset

### M8.4 — Image rows and threshold provenance
- [ ] `images` rows carrying R2 key, phash, source video, timestamp
- [ ] **The dedup threshold in force is stamped onto the rows it produced.** Changing
      the threshold later does not re-deduplicate old videos, so without this the
      dataset becomes an unrecorded mixture of regimes
- [ ] Config version recorded on the job

---

## M9 — Close v1

*Goal: the v1 sentence is demonstrably true.*
*Depends on: M8.*

### M9.1 — Grafana dashboard
- [ ] Queue depth, job duration, dedup ratio, reclaim rate, failure rate
- [ ] Dashboard JSON committed to the repo
- [ ] Reachable from the admin dashboard by link, not rebuilt inside it

### M9.2 — End-to-end trace
- [ ] Single trace spanning submit → claim → download → fan-out → chunk completion
- [ ] `traceparent` propagated across the Workers-to-Go boundary
- [ ] Screenshot or recording captured for the writeup

### M9.3 — Deadman check
- [ ] External ping (e.g. healthchecks.io) alerting on collector silence
- [ ] Closes the open item — the collector is the thing that reports failures, so
      nothing currently reports its own death
- [ ] Alert verified by stopping the collector

### M9.4 — Acceptance run and writeup
- [ ] Full run from a clean queue against a real video
- [ ] All eight success criteria in `PRD.md` §5 verified
- [ ] README updated with architecture summary and the v1 demo path

---

## Deferred to v2

Tracked so they are not lost: annotation UI, Google OAuth and sessions, Grounding DINO
bootstrap, gated pre-label pool, weighted active-learning selection, YOLO training,
model registry, dataset snapshots with split manifests, presigned image serving,
public landing and demo pages, semantic flywheel spans.

All are designed in `CONTEXT.md` §5 and §7. None are blocked by v1 decisions.
