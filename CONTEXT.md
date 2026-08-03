# Crowdmon 2026 — Design Context

**Status:** building — M1, M2 and M3 merged
**Last updated:** 2026-08-02
**Source:** grilling session (Q1–Q24 locked)

This document is the durable record of design decisions for the crowdmon rebuild.
It exists so a cold session — human or agent — can pick up without re-deriving anything.

---

## 1. What this is

A crowdsourced annotation platform that builds a labelled image dataset of Genshin
Impact characters (anchored on Paimon), feeding a detector that runs in the browser.

The 2023 version worked but is obsolete in premise: open-vocabulary detectors
(Grounding DINO, OWL-ViT, YOLO-World) can now box a named character from a text
prompt with no training. The naive framing — "humans must draw every box because no
model knows what Paimon is" — no longer holds.

**The 2026 framing:** zero-shot bootstraps the labels, humans verify and handle the
long tail, and the shipped artifact is a distilled real-time model the foundation
model cannot be. That trio answers the question any reviewer will ask, which is
"why not just use Grounding DINO?"

### Primary goal (Q1)

**Infrastructure is the showcase. The ML flywheel is the workload.**

The deliverable is a cheap, healthy, observable system. The flywheel exists to
generate real signal worth observing. The résumé line is infra, not ML.

Refined later in the session: the crowdmon website is the portfolio artifact, and
the OTel integration is one instrumented subsystem rather than the centrepiece.
This demotes OTel specifically, not infra generally — D1, Workers, the pull
topology, self-managed auth and the Go worker all remain primary.

### Constraints

- **Free tier only.** No paid plans. This rules out Cloudflare Queues and the
  Workers Paid plan.
- **Service health is a stated goal**, so the cloud control plane must survive the
  home machine being offline.
- Home IP is required for YouTube extraction — datacenter IPs are blocked.

---

## 2. Hardware and accounts

| Resource | Detail |
|---|---|
| Home server | `carls-ubuntu`, Ubuntu 26.04, i5-7200U (2c/4t), 12GB RAM, 413GB free, GeForce 940MX 2GB (unusable for training), always-on, AC powered |
| Tailnet | Tailscale mesh, `tailscaled` running (address kept out of this repo) |
| Laptop | MacBook Air M4, 16GB, arm64 — **dev/coding only**, explicitly not a training box |
| Training | Kaggle free GPU (30h/wk, T4/P100 16GB) primary, Colab fallback |
| Cloud | Cloudflare — Workers, Pages, D1, R2, Access, cloudflared |
| Domain | `mkcarl.com` (Grafana already at `grafana.mkcarl.com`) |

### Existing monitoring stack

Docker compose at `/home/carl/monitoring-stack` on the home server. Its own project,
with its own repository at `git@github.com:mkcarl/otel-monitoring-stack.git`. **Not
owned by this project and not managed by this project's Terraform** — see §6.

The running directory is not itself a checkout of that repo, so the box remains the
source of truth and can still drift from it. See open items.

- otel-collector 0.116.1 — three pipelines (traces→Tempo, logs→Loki, metrics
  exposed :8889 for scrape). Self-telemetry :8888.
- Tempo 2.8.2 (:3200), 7-day retention, metrics-generator enabled
  (local-blocks, service-graphs, span-metrics, remote_write to Prometheus)
- Loki 3.5 (:3100), derived field links `trace_id` to Tempo
- Prometheus 3.9 (:9090), remote-write-receiver and exemplar-storage enabled
- Grafana 12.3 (:3000), GitHub OAuth, public via cloudflared
- node_exporter, dcgm_exporter (:9400) — GPU metrics now low value, training moved off-box

Config filename gotchas: `tempo-config.yaml`, `otel-collector-config.yaml`.

---

## 3. Architecture

### Compute placement (Q2, Q3)

| Job | Where | Why |
|---|---|---|
| ffmpeg frame extraction | Home Ubuntu | Household IP dodges YouTube's datacenter block |
| Always-on services, OTel backend | Home Ubuntu | Always-on, 12GB RAM, already meshed |
| Zero-shot bootstrap, YOLO training | Kaggle free GPU | 940MX has 2GB VRAM; MBA excluded by choice |
| Detector inference | Browser (TF.js) | Already proven in the old code |
| Web app, storage, metadata | Cloudflare | Free tier, edge, survives home downtime |

**Loop liveness is resolved by physics, not preference.** Free cloud GPU is manual
and ephemeral, so retraining is batch and human-triggered. Auto-threshold retraining
is off the table — there is no always-on GPU to fire it.

### Topology (Q4) — pull

The home Go worker long-polls a Workers HTTP endpoint backed by a D1 job table. It
claims a job, runs it, uploads to R2, and POSTs metadata back.

No inbound ports. Dynamic home IP is irrelevant. Jobs queue harmlessly when home is
down, so the cloud never depends on the house being up. Tailscale stays as the
private admin plane, not a data path.

### Stack (Q5, Q6, Q7)

- **Metadata:** Cloudflare D1. SQLite window functions cover every dashboard query at
  this scale. The "analytics won't scale" concern was raised and retracted — it only
  bites at millions-of-rows OLAP.
- **Web runtime:** Workers + Hono API + React SPA served by the same Worker —
  **amended in M5 from "on Pages".** Clean API boundary beats SSR sugar when
  infra is the story; Hono middleware gives span-per-route trivially. The SPA
  was moved onto the API Worker's `[assets]` rather than deployed to Pages
  for four reasons: one origin instead of two, so the Access session cookie
  needs no cross-origin policy; no CORS-with-credentials to configure and get
  wrong; §7's documented expiry symptom (a 302 `fetch` silently follows to an
  HTML 200) stays that symptom instead of becoming a CORS `TypeError` on a
  second origin, which would have meant M5.4 verifying the wrong failure
  mode; and Cloudflare now steers new projects toward Workers static assets,
  with Pages effectively in maintenance. This is a single Vite app only
  because §Q11 keeps the public surface thin — landing, about and the demo
  are v2. If the public surface ever grows into real content, the answer is a
  second app in the monorepo sharing components with the admin panel, not a
  framework migration of the admin panel itself.
- **Auth:** Google OAuth implemented on Workers (`arctic` + `oslo/jose`), HttpOnly
  session cookie, sessions in D1.

### Repo and delivery (Q18, Q22, Q23)

- **Monorepo.** pnpm workspaces for edge and SPA, Go module in a subdirectory. The
  decisive argument is the job contract: two runtimes must agree, and the old
  three-repo layout is what produced the `storage_url` / `url` mismatch still present
  in `/api/randomImage`.
- **Contract source of truth (Q24):** routes defined with `@hono/zod-openapi`, the spec
  emitted as a build artifact, Go structs generated with oapi-codegen, CI failing when
  the two sides disagree. Zod schemas are needed at the edge for runtime validation of
  untrusted input regardless, so OpenAPI costs no extra authoring. Hand-written types
  on both sides is what produced the `storage_url` / `url` mismatch in the old code.
- **SPA type sharing (M5), no codegen:** the Go worker gets generated types
  from the OpenAPI spec because it crosses a language boundary — Q24's
  argument. The SPA does not: it imports the zod schemas from
  `@crowdmon/api/schemas` directly, because TypeScript-to-TypeScript inside one
  pnpm workspace has no boundary for codegen to cross. Importing the schema
  rather than a generated type means a contract change fails `pnpm typecheck`
  immediately in the SPA, not just in CI's drift check, and `schema.parse()` at
  the client boundary doubles as the tripwire that catches an Access login
  page arriving where JSON was expected — the same 302-to-HTML-200 shape §7
  documents, caught by validation failing rather than by a type system that
  would have believed the HTML was the expected object.
- **Admin authentication (M3.5, hostname updated in M5):** Cloudflare Access over
  `crowdmon.mkcarl.com/api/admin`, plus the Worker verifying the assertion itself. Both,
  not either: Access binds to a route on a zone, so any hostname the Worker is served on
  that the application does not cover reaches the code with no assertion attached. The
  workers.dev hostname was exactly that until M4.6 closed it, and re-opening one is a
  line of config rather than a decision anyone would notice. The allowlist deliberately
  exists twice — Terraform's decides who Cloudflare will issue an assertion to, the
  Worker's secret decides who it will act for. `allowed_idps` is enumerated rather than
  left empty, because empty means "every provider on the account" and an IdP added later
  would silently become a way in.

  **That hostname is the end state the `m5-admin-dashboard` branch delivers, not yet
  what is live.** The Terraform that moves the Access application off
  `api.crowdmon.mkcarl.com` onto `crowdmon.mkcarl.com` is committed but the apply has not
  been run — that is the owner's step — and moving it regenerates the application's
  `aud`, so `ACCESS_AUD` in `wrangler.toml` and a redeploy have to land in the same
  change as the apply. See `infra/README.md` "Migrating to a single hostname (M5)" for
  the sequencing.
- **IaC:** Terraform owns the account-level resources *this project* creates — D1, R2,
  DNS, its own Access apps and policies; wrangler owns bundling, secrets and code
  deploys. Terraform state in R2 via its S3-compatible backend. The cloudflared tunnel
  and the OTLP endpoint are explicitly **out of scope** — they belong to the monitoring
  stack, which predates this project. See §6.
- **Go worker deploy:** CI builds a `linux/amd64` image to GHCR; the home box pulls on
  a timer and runs it as another docker compose service alongside the monitoring
  stack. Pull-based, so no credential in CI can reach the home network.

---

## 4. Data plane

### Frame selection (Q12)

Extract at 1 fps, then perceptual-hash dedup before upload — drop any frame within a
Hamming threshold of the last kept frame.

Naive 1 fps on a 20-minute video yields 1,200 near-identical frames. That inflates
contribution counts into a vanity metric, wastes labelling effort on duplicates, and
leaks near-duplicates across the train/val split so the reported mAP lies. Dedup
typically removes 40–70% of gameplay frames.

Secondary benefit: it makes the Go worker genuinely substantial (concurrent extract,
hash, compare, upload) and gives OTel its first non-trivial signal — frames extracted
vs kept, dedup ratio, hash-compare duration.

### Job granularity (Q13) — two-phase fan-out

Job 1 downloads and probes the video, then enqueues N chunk jobs, one per 60s segment.
Each chunk extracts, hashes, uploads and inserts rows for its slice.

A whole video is 10–20 minutes of work on this hardware. As a single job it retries
from zero, shows no progress, and renders in Tempo as one flat span with nothing
inside it.

**Honest caveat:** the parallelism argument is weak — 2 physical cores, and ffmpeg
already multithreads, so concurrent chunks contend rather than speed up. Fan-out was
chosen for retry granularity, resumability, and observability.

**Affinity constraint:** chunk jobs read the downloaded video from local disk, so they
must run on the box that downloaded it. Free with one worker; not free if a second
appears. Source video stays on home disk with a TTL — uploading it to R2 would cost
far more storage than the frames.

### Job claim and recovery (Q14) — heartbeat lease

Cloudflare Queues requires the Workers Paid plan, so the queue is a D1 table. Claiming
is atomic via `UPDATE ... WHERE status='pending' ... RETURNING` since SQLite serializes
writers.

Crash recovery uses a heartbeat: the worker writes `heartbeat_at` every 30s, and a
Workers Cron Trigger reaps jobs with stale heartbeats back to `pending`. One mechanism
for both job types rather than a visibility timeout for one and a heartbeat for the
other.

Required consequences:

- `attempts` counter and a terminal `failed` state, or a poison job (deleted video,
  geo-blocked, malformed) retries forever and burns the worker permanently.
- Chunk work must be idempotent on `(video_id, timestamp)` — deterministic R2 keys,
  overwrite rather than insert — because reaped chunks re-run.

Reclaim rate is a real health metric worth a Grafana panel.

**D1 read replication stays disabled** (`infra/main.tf`), and that follows from the
paragraph above rather than from cost. Replicas are eventually consistent, and the claim
is only atomic against a single primary — a worker whose read landed on a replica could
see a job as pending seconds after another worker had taken it. Terraform states it
explicitly instead of inheriting the default, because the provider otherwise plans the
attribute to null on every run and the API rejects that, which turns any unrelated apply
into a failed one.

**Fan-out must be transactional, which is a constraint M3.4 imposes on M7.2.** The claim
endpoint retires a chunk job whose `chunks` row is missing as terminally `failed`, on the
grounds that the row's absence is corruption. That is only true if the job and its chunk
row are inserted in one `batch()`. Insert them separately and a claim landing in the gap
retires a job that was about to be fine, after which `idx_chunks_identity` stops the
re-run from recreating it and the segment is lost for good.

### Polling budget (Q20) — adaptive backoff

30s when idle, doubling to a 120s cap after repeated empty polls, immediate re-poll
after finding work. Roughly 1,000 requests/day idle.

Workers' free tier allows 100,000 requests/day and idle polling dominates everything
else: a 5s interval burns 17,280/day (17% of the quota) returning nothing, against
~60 heartbeats per video, 288/day for the reaper, and ~400 for a 200-image annotation
session. Up to 2 minutes of pickup latency is invisible against 10–20 minute jobs.

Long-polling was considered and rejected — Workers are not built around long-lived
request handlers.

### Image serving (Q25)

Private R2 bucket. A Worker issues **batched short-lived presigned URLs** — one call
returns the next N images plus their signed URLs — and the browser fetches bytes from
R2 directly. The UI detects a 403 on an expired URL and re-requests the batch.

The request budget does **not** decide this: a 200-image session costs 200 extra Worker
requests proxied, ~10 batched, 0 public — all noise against 100,000/day.

What decides it is posture. §7 rejects a public browsable gallery to avoid republishing
copyrighted game frames at scale; a public bucket does substantially the same thing
without an index page. Private-plus-signed keeps that consistent, keeps image bytes off
Worker CPU, and signed-URL issuance is real infra work rather than a checkbox.

The handful of sample images on the public demo page are a fixed small set — bundle
them with the SPA or serve from a separate public path.

---

## 5. The flywheel

### Pre-labelling (Q15) — gate the pool

An image is not annotatable until a pre-label exists.
State machine: `ingested → prelabeled → in_pool → annotated`.

Ingestion is continuous but bootstrap runs manually on Kaggle, so there is a gap
between "image exists" and "image is verifiable". Gating means the annotation UI has
exactly one mode — verify — and never falls back to drawing from scratch.

Rationale: the moment a from-scratch path exists it gets used on days the notebook is
stale, and the flywheel claim stops matching the data in the table. With N=1 the
pool-goes-empty objection is void, because the same person runs both batches.

Payoff: every annotation in the database is a human verdict on a model prediction, so
accept / adjust / reject rates per model version fall out of the schema for free.

### Image selection (Q16) — weighted mix

Every served image is tagged with `selection_reason`: `uncertain` | `random` | `diverse`.
Roughly 70 / 20 / 10.

- `uncertain` draws from a **band** (confidence ~0.3–0.6), not the bottom. The lowest-
  confidence frames on an open-vocab detector are overwhelmingly frames with no
  character present — menus, loading screens, inventory UI — so pure uncertainty
  sampling spends the entire session confirming absence.
- `random` images form a **permanent evaluation pool, excluded from training forever**.
- `diverse` uses pHash distance from already-labelled images, reusing Q12's work.

**Why the random slice is non-negotiable:** the headline artifact is "mAP improves per
model version". That comparison requires an unbiased evaluation set. If every labelled
image was chosen because the model found it hard, each version is measured against its
own different hard set and the improvement chart becomes unreadable. The random slice
is the measurement instrument, not a nicety.

Requires that the pre-label record persists **confidence**, not just box coordinates.

### Model registry (Q17)

Models land at versioned R2 paths (`models/v{n}/`). A `model_versions` table records
version, eval mAP on the frozen pool, training-set size at that point, accept/adjust/
reject counts that fed it, snapshot reference, and timestamp. A Worker endpoint serves
the `current` pointer; the browser fetches the pointer, then the weights.

Immutable paths make cache-busting automatic. Rollback is a flag update. Promotion is
manual — automatic promotion would imply an automated evaluator that nothing runs,
given training is manual and batch.

Recording dataset size beside mAP keeps the story honest: a reviewer can see whether
gains came from better labels or simply more of them.

R2 has zero egress fees, so serving 6–12MB of weights to every demo visitor is free.

### Kaggle handoff (Q21) — snapshot plus presigned URLs

An admin action builds a dataset snapshot (images, labels, split manifest), writes it
to R2, and issues a short-lived presigned GET. The notebook downloads one file. On
completion it uploads the model through a presigned PUT.

- **No standing credentials in an ephemeral notebook.** Kaggle notebooks are easy to
  make public accidentally and secrets end up in debug cells.
- One 1GB download beats 5,000 individual GETs, and a crashed session re-downloads one
  object.
- **Reproducibility:** `model_versions` references a snapshot ID, so the recorded
  training-set size is verifiable rather than asserted.

**The snapshot must carry the split manifest, and the notebook must obey it.** Every
Ultralytics tutorial does its own random train/val split; doing that here silently
mixes the frozen evaluation pool into training and replaces the honest metric with a
leaky one.

---

## 6. Observability

### Existing stack

See §2. Already running, already tunnelled, already has metrics-generator producing
RED metrics and service graphs the moment spans flow.

### Edge ingest (Q9)

`otlp.mkcarl.com` fronts the collector's OTLP **HTTP** receiver on 4318, gated by a
Cloudflare Access **service token** (`CF-Access-Client-Id` / `CF-Access-Client-Secret`,
stored via `wrangler secret put`).

gRPC 4317 is not usable from Workers — the runtime has `fetch` only.

The collector never binds a public port; only cloudflared's outbound tunnel exists.
Access rejects unauthenticated requests at the edge.

W3C `traceparent` propagation browser → edge → Go worker is the point of the exercise.

### Ownership: the endpoint is not this project's to manage

Decided 2026-08-02, reversing what the roadmap originally said.

The monitoring stack is pre-existing infrastructure with its own repository and its own
lifecycle. This project is a *consumer* of `otlp.mkcarl.com`, not its owner. Nothing
about the tunnel, its ingress, or the Access application in front of it is declared in
`infra/`.

Two reasons, and the second is the one that decides it:

- A hostname is a stable public string. Consuming it needs no shared Terraform state, no
  cross-repo data sources, no coordination — the cheapest possible coupling.
- **This project's Terraform gets destroyed on purpose.** M1.3 required proving that
  `terraform destroy` followed by `apply` reproduces the account, and that check is
  expected to be repeated. If this project's state owned the tunnel, a routine
  verification would take `grafana.mkcarl.com` offline for every unrelated project
  sharing that tunnel. Ownership has to follow the blast radius.

The cost, stated plainly so it is not rediscovered as an accident: the gating is
click-ops. It is not reproducible from this repo, and `terraform destroy` here will
never remove it. The runbook below is the mitigation — it is the only record.

### Runbook: gating the OTLP endpoint

Done once, by hand, on the pre-existing `ubuntu_grafana` tunnel. That tunnel is
remotely-managed (`config_src: cloudflare`), so adding a hostname needs no change on the
box at all — no compose edit, no second tunnel credential, no container restart.

1. Tunnel → published application route: `otlp.mkcarl.com` → `HTTP` →
   `otel-collector:4318`. The DNS record is created automatically.
2. Access → service auth → create a service token. Both values are shown once.
3. Access → applications → self-hosted, domain `otlp.mkcarl.com`.
4. Policy: action **Service Auth**, include that **named** token.
5. `wrangler secret put CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`.

**Use the service name, not `localhost`.** cloudflared runs as a container on
`monitoring-stack_monitoring` alongside the collector; inside that container `localhost`
is cloudflared itself. The pre-existing Grafana rule (`http://grafana:3000`) is the
model.

**The policy action must be Service Auth, not Allow.** With Allow, a request carrying a
valid service token is still redirected to the login page — and to a Worker's `fetch`
that arrives as a 302-followed-to-HTML-200, not an auth failure. Same class of bug as
M5.4.

**Include the named token, never "any Access service token".** The account holds tokens
belonging to unrelated projects; that option would let them push spans into this
collector.

Verified 2026-08-02: unauthenticated `POST /v1/traces` returns 403 carrying
`cf-access-domain` and `cf-access-aud` headers; the same request with both token headers
returns 200 and an OTLP `partialSuccess` body. Both halves matter — Access rejects
before the origin is reached, so a 403 alone would also be what a completely misrouted
ingress produced.

### Decisions made this session

- **All push emitters use the one gated path** — Workers, browser RUM, Kaggle, MBA,
  **and the home Go worker**. Chosen for consistency over a tailnet split or a
  loopback carve-out.

  Accepted tradeoff, recorded so it is not rediscovered as a bug: the home worker's
  spans leave the box, cross the WAN to a Cloudflare POP, and return down the tunnel to
  a collector on the same machine. Costs residential upstream on every span, and means
  the worker cannot trace itself during a network outage — the moment telemetry is most
  wanted. Bought deliberately in exchange for one endpoint, one auth mechanism, one
  runbook and one failure mode across every emitter.
- **Workers emit traces and logs only.** Metrics are derived from spans by Tempo's
  metrics-generator. No Worker metrics pipeline, no scrape.
- **Collector unreachable → the site shows an error page.** No cached fallback.
- **Span export fails → drop.** No buffer, no queue, no replay.
- **Span content, this stage: HTTP-level only** (`http.request`, `fetch`, `db.query`).
  Semantic flywheel spans deferred.

### Traps recorded for the deferred work

- **Thread `ctx` through bootstrap/verify/distill signatures from the first commit**,
  even while emitting no spans. Auto-instrumentation gives HTTP spans without touching
  the code, which means no tracer handle inside the flywheel functions; retrofitting
  `context.Context` through a Go call chain later touches everything.
- **Decide sampling per-source, not globally.** HTTP spans are high-rate and low-value;
  flywheel spans are low-rate and high-value. A global 10% head sampler set now would
  silently discard 90% of the only data worth having later.
- **Nothing distinguishes this stack yet.** HTTP-only spans are a competent tracing
  tutorial. The risk is that the plumbing feels finished, attention moves on, and the
  semantic spans never land. Needs a concrete promotion trigger.

---

## 7. Product scope

### Character scope

Multi-class schema from day one, anchored on Paimon, roughly 4–6 characters total.

Paimon is the best detection target in the game — she follows the player, so she is in
nearly every frame, and she is visually unmistakable. That makes her the fastest path
to a working model, but also the *weakest* justification for needing a crowd at all.
The long-tail characters are what makes the active-learning story defensible.

The old `crop` table already had a `subject` column with `'paimon'` hardcoded — multi-
class was latent in the original schema.

### Who annotates (Q10) — crowd-capable, N=1 realistic

The author seeds all data. The platform supports multiple annotators in schema and UI.

**Do not build:** consensus resolution, annotator agreement scoring, trust weighting,
inter-rater reliability. These are subsystems for a table with one contributor, and a
reviewer notices.

**Do keep:** `annotator_id` on every annotation, auth, contribution counts. Leaderboard
is plain counts, not rank-percentile theatre.

Sharing with friends is desired; traction is a bonus, not a current focus.

Verify-not-draw makes N=1 genuinely viable in a way it was not in 2023.

### Public surface (Q11) — thin

Public and unauthenticated: landing page, about, and the **live in-browser detector
demo**. Everything else behind login.

SEO reduces to a prerendered landing page plus Open Graph tags. This keeps Q6's SPA
choice intact — its original justification ("SEO irrelevant, behind login") was
retired when SEO came up, but a thin public surface restores it.

**Honest read on SEO:** a niche fan project will get roughly zero organic search
traffic regardless of optimization. The real distribution channel is pasting a link
into Discord or Reddit, which cares about the OG preview card, not crawler ranking.
Rearchitecting to SSR to rank for "paimon detector" would be expensive work aimed at
traffic that is not coming.

A public browsable gallery of labelled crops was considered and set aside — it would
mean republishing frames from copyrighted game footage at scale, which is a licensing
problem with no upside for a portfolio piece.

### Admin dashboard (Q19)

Served at `/admin` in the same app. Controls thresholds, views annotated data and
business metrics, triggers extraction by YouTube URL, promotes model versions, and
issues dataset snapshots.

**Auth: Cloudflare Access at the edge, plus a role check behind it.** The Worker
verifies the `Cf-Access-Jwt-Assertion` header against Cloudflare's public keys.

Access was rejected in Q7 for *user* auth because org/team gating cannot serve open
public sign-up. That objection does not apply to a one-person admin, where it is
exactly the right shape. It is clientless — browser redirect to an IdP, no WARP, no
agent. WARP is only needed for non-HTTP resources or when device posture checks are
enabled. Free Zero Trust covers 50 users.

**Security posture — gate the API, not the UI route.** `/admin` in a React SPA is
client-side routing; navigating there from an already-loaded page sends no request, so
nothing inspecting HTTP paths can see it. Hiding the admin bundle is cosmetic. Every
`/api/admin/*` endpoint must independently verify the caller. Assume the admin bundle
is public.

**SPA gotcha:** when the Access session expires, `fetch` to an admin endpoint follows
the 302 to the login page and returns HTML with a 200. Detect it and force a full page
navigation so the browser can complete the login flow. Default session is 24 hours.

**Thresholds are dataset provenance, not just settings.** Changing the pHash threshold
does not re-deduplicate old videos; changing the uncertainty band does not update
existing `selection_reason` values. Threshold values must be stamped onto the rows they
produced — config version on the job, band values on the selection — or the dataset
becomes an unrecorded mixture of regimes and the mAP chart gains an unexplained
confounder.

**Do not rebuild Grafana inside `/admin`.** D1 holds business data (annotations,
dataset counts, model versions, accept/adjust/reject rates); OTel holds system data
(latency, throughput, queue depth, error rates). Admin shows the first and links out
for the second. Two dashboards that disagree will disagree at the worst moment.

---

## 8. Rejected options

Recorded so they are not re-litigated.

| Option | Rejected because |
|---|---|
| Supabase as core | Free project auto-pauses after 7 days idle (contradicts the health goal); 1GB storage means R2 is still needed so no vendor consolidation; BaaS hides the infra being showcased |
| Home Postgres | Web app would depend on home uptime, breaking "cloud survives home down" |
| Next.js on Cloudflare | Adapter friction undercuts the clean-edge story |
| Go at the edge | V8 isolates run JS/WASM only; TinyGo means large binaries, GC pain, poor DX |
| Home-centric Go backend | Makes home a single point of failure, contradicting the primary goal |
| Cloudflare Queues | Requires the Workers Paid plan |
| Push via Cloudflare Tunnel for jobs | Makes home a synchronous dependency |
| Tailscale Funnel | Public exposure with weaker gating than cloudflared + Access |
| Logpush → R2 → batch ingest | No live traces, more plumbing |
| Haar cascade | Built for rigid frontal patterns; strictly worse than the existing YOLO |
| Simulated contributors | Fabricated data on a portfolio piece is an integrity problem |
| CI push to home over Tailscale | A compromised Actions token becomes a path into the house |
| Automatic model promotion | Implies an automated evaluator; training is manual and batch |

---

## 9. Open items

**Design questions still unanswered:**

1. ~~**Contract source of truth (Q24).**~~ **Resolved, M3.2–M3.3.** Generated, as
   recommended. `apps/api/src/schemas.ts` holds the zod schemas; they validate at the
   edge and emit `apps/api/openapi.json`, from which oapi-codegen generates
   `worker/internal/api`. Kept in place rather than deleted so the numbering of the
   items below does not shift under anything that cites them.
2. **v1 scope cut and build order.** Not yet discussed.
3. **Promotion trigger for semantic spans.** "First verify pass on real data" is
   concrete; "when I get to it" is how it dies.
4. **Sampling posture.** Must be decided before any global sampler is configured.
5. **Deadman check.** Nothing currently tells you the collector died — it is the thing
   that tells you when things die. Needs an external ping (e.g. healthchecks.io).
   Scheduled as roadmap issue M9.3.

**Operational debt:**

6. Grafana auth hardening — org allowlist not yet configured as defence in depth.
   Details deliberately kept out of this public repo. Flagged three times, still unfixed.
7. The monitoring stack compose at `/home/carl/monitoring-stack` now has a repository
   (`git@github.com:mkcarl/otel-monitoring-stack.git`), but the running directory is not
   a checkout of it — there is no `.git` anywhere under `/home/carl`. The repo is a copy,
   the box is still the source of truth, and the two can drift silently. Half-fixed.
8. **yt-dlp breaks often.** YouTube changes its player and yt-dlp ships fixes roughly
   weekly. Pinned in an image, extraction silently stops until rebuild. Needs either
   update-on-start or scheduled rebuilds, plus a health check that distinguishes "no
   jobs queued" from "every job failing at download".
9. The OTLP gating is click-ops by decision (§6), so it is reproducible only from the
   runbook. Nothing enforces that the runbook stays true — if the policy is edited in
   the dashboard, this repo will not notice.
10. **The Go worker's telemetry is wired but inert.** M4.1 set up the exporter and a log
    handler that stamps records with their span's ids, and M4 deliberately emits no
    custom spans — so in production nothing is exported and no log line carries a
    trace_id. The queue client also sends no `traceparent`, which leaves the Worker's
    spans for `/api/jobs/*` with no parent. Both are fixed by the same change and it is
    deliberately not M4's: creating a span to propagate *is* the custom span M4.1's
    criteria exclude. It belongs with the first real work, in M7.

---

## 10. Legacy code notes

Three separately-git'd repos in this directory, kept for reference:

- **`crowdmon-nextjs`** (Jun 2023 – May 2024) — Next.js 13 pages router, TypeScript,
  MUI, Tailwind, Vercel. Firebase auth, Postgres, R2 via `images.crowdmon.mkcarl.com`.
  `/crop` → `CroppingInterface.tsx` → `/api/cropv2`. YOLOv8-nano via TF.js loaded from
  GitHub Pages. ECharts dashboards driven by raw SQL in `lib/dashboardQueries.ts`.
- **`crowdmon-video-frame-extractor`** (May – Jun 2024) — Flask + OpenCV on Vercel.
  Takes a video URL and a single timestamp, extracts one frame, uploads to R2.
- **`crowdmon-extract-render`** (Jun 2024) — Flask + ffmpeg subprocess, returns base64.
  Five commits, abandoned mid-thought.

**The missing link:** nothing in any repo takes a YouTube URL, loops over timestamps,
or inserts into the `image` table. No `yt-dlp`, no per-second loop, no `INSERT INTO
image`. The orchestration was done by hand or by a script that never made it into
these folders. That is why the ingestion design in §4 has no prior art to lean on.

**Known debt in the old code**, useful as a list of things not to repeat: Mongo and
Postgres paths coexisting, `contributions` alongside `contributions_v1`, unused
`CropContext` and `FirebaseAuthContext`, `/api/crop.ts` with no auth at all, the
`storage_url` / `url` mismatch in `/api/randomImage`, no tests, no CI, no shared types,
hardcoded `Asia/Kuala_Lumpur` in SQL.

---

## 11. Build plan

Full breakdown in `ROADMAP.md`; scope statement in `PRD.md`.

### v1 done-claim

> A YouTube URL goes in, extraction is visibly running, OTel has data, and images land in R2.

### Strategy (Q26)

Thin vertical slice with infra discipline applied per component — **not** an infra
phase followed by a feature phase, and not features with infra retrofitted later.
Each piece lands with its Terraform resource, its CI step and its instrumentation.

Infra-first is the tempting trap given §1's goal, but it front-loads months of
scaffolding built against guesses with nothing to look at. Feature-first is the mirror
trap, and this project already has one documented instance of that pattern in the
deferred semantic spans.

Milestones are sized to be independently shippable and visibly working. That is the
burnout defence — the project is open-ended by choice, so every milestone has to be a
stopping point rather than a checkpoint.

### What v1 excludes

React annotation UI, Google OAuth and user sessions, user-facing dashboards, landing
page, public demo page, Grounding DINO bootstrap, YOLO training, model registry,
dataset snapshots, active-learning selection. Effectively all of §5 and most of §7.

**Consequence worth stating plainly: with no user-facing frontend, Grafana is the UI
for v1.** "Visibly running" means traces and dashboards, plus D1 rows and R2 objects.
This makes the observability work load-bearing rather than decorative, and forces it
to be real early instead of deferred.

### Milestone order

1. Foundations — repo, Terraform, CI, hello-world Worker
2. Observability spine — OTLP tunnel, Access service token, first span end to end
3. Contract and queue — D1 schema, zod-openapi, codegen, Access on submit
4. Worker skeleton — container, poll loop, claim, heartbeat, complete
5. Admin dashboard — minimal: submit URL, list jobs and chunks
6. Failure semantics — reaper, attempts, terminal failed state
7. Download and fan-out — yt-dlp, ffprobe, chunk enqueue
8. Chunk extraction — ffmpeg, pHash dedup, R2 upload. **v1 core**
9. Close — Grafana panels, end-to-end trace, v1 claim demonstrably true

Observability sits at position 2 deliberately. It is the hardest plumbing in the
project and is far easier to debug against a trivial Worker than against a fan-out
pipeline; everything after it lands instrumented rather than retrofitted.

Worker skeleton precedes the admin dashboard so the dashboard shows live status
changes on the day it is built, rather than listing rows that never move.

### Repository

Public. Contains no frames — images live in R2 — so the licensing posture in §7 is
unaffected. Secrets live in wrangler secrets and GitHub Actions secrets; Terraform
state is in R2, not the repo. Tunnel hostnames become public knowledge, which is
acceptable only because Access gates them — the policy has to be correct, not merely
present.
