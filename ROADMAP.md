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

### M4.1 — Go worker foundation
- [ ] Config from environment
- [ ] OTel SDK initialised, OTLP exporter, service name set
- [ ] Structured logging with trace correlation
- [ ] `context.Context` threaded through all pipeline function signatures from the
      first commit, even though no custom spans are emitted yet — retrofitting this
      later touches every function in the call chain

### M4.2 — Poll loop with adaptive backoff
- [ ] 30s idle interval, doubling to a 120s cap on repeated empty polls
- [ ] Immediate re-poll after finding work
- [ ] Graceful shutdown

### M4.3 — Claim, heartbeat, complete
- [ ] Claim via the generated client
- [ ] Heartbeat every 30s while a job is held
- [ ] Complete on success
- [ ] No extraction yet — mark done immediately

### M4.4 — Containerise and publish
- [ ] Dockerfile with ffmpeg and yt-dlp
- [ ] CI builds and pushes `linux/amd64` to GHCR
- [ ] Image is public

### M4.5 — Deploy to the home box
- [ ] Compose service alongside the monitoring stack
- [ ] Timer-based image pull, no inbound access
- [ ] Survives host reboot

---

## M5 — Admin dashboard

*Goal: an operator surface instead of curl.*
*Depends on: M4 — sequenced after the worker so status visibly moves on day one.*
*Done when:* a URL can be submitted from the browser and job status updates live.

Minimal by design. No threshold controls, no model promotion, no annotation views —
none of those have data yet.

### M5.1 — SPA shell on Pages
- [ ] Vite + React, deployed to Pages by CI
- [ ] Access application covering the admin route, in Terraform
- [ ] Nothing user-facing beyond admin

### M5.2 — Submit form
- [ ] YouTube URL input with validation
- [ ] Posts to `/api/admin/videos`
- [ ] Surfaces errors rather than swallowing them

### M5.3 — Job and chunk status list
- [ ] Jobs with status, attempts, heartbeat age, timestamps
- [ ] Chunks grouped under their parent job
- [ ] Auto-refresh on an interval

### M5.4 — Handle Access session expiry
- [ ] Detect the 302-to-login that `fetch` silently follows and returns as HTML/200
- [ ] Force a full page navigation so the browser can complete the login flow
- [ ] Verified against a genuinely expired session, not a simulated one

---

## M6 — Failure semantics

*Goal: crashes are survivable and visible.*
*Depends on: M4.*
*Done when:* killing the worker mid-job produces a visible reap and retry.

### M6.1 — Attempts and terminal failure
- [ ] `attempts` incremented on each claim
- [ ] Terminal `failed` state above a threshold
- [ ] Failure reason persisted
- [ ] Prevents a poison job — deleted video, geo-blocked, malformed — retrying forever

### M6.2 — Cron reaper
- [ ] Workers Cron Trigger declared in Terraform
- [ ] Resets jobs with stale `heartbeat_at` back to `pending`
- [ ] Respects the attempts ceiling

### M6.3 — Reclaim visibility
- [ ] Reclaim events emitted as spans or metrics
- [ ] Reclaim rate visible in Grafana
- [ ] Failed jobs visible in the admin list

### M6.4 — Verify by killing it
- [ ] Kill the container mid-job; confirm reap and retry
- [ ] Confirm a permanently failing job reaches `failed` and stops
- [ ] Document the recovery behaviour

---

## M7 — Download and fan-out

*Goal: one video becomes N chunk jobs.*
*Depends on: M4, M6.*
*Done when:* submitting a URL produces chunk rows covering the whole video.

### M7.1 — yt-dlp download
- [ ] Download to local disk with a TTL — source video is never uploaded to R2
- [ ] Handle unavailable, private and geo-blocked videos as terminal failures
- [ ] Download duration and file size recorded as span attributes

### M7.2 — Probe and enqueue chunks
- [ ] ffprobe for duration and resolution
- [ ] Enqueue one chunk job per 60s segment
- [ ] Video metadata persisted

### M7.3 — Idempotency
- [ ] Re-running phase one does not duplicate chunk jobs
- [ ] Deterministic chunk identity from `(video_id, segment_index)`
- [ ] Verified by forcing a reap mid-fan-out

### M7.4 — Affinity guard
- [ ] Chunk jobs assert the source file is present locally before claiming
- [ ] Missing file fails cleanly rather than half-processing
- [ ] Constraint documented — chunks must run on the box that downloaded

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
