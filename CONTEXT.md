# Crowdmon 2026 — Design Context

**Status:** building — M1–M5 merged. `crowdmon.mkcarl.com` serves the SPA and the
API as of 2026-08-03; `api.crowdmon.mkcarl.com` still answers as `legacy_api`
because the Go worker has not been repointed off it yet, so the migration is
applied but not finished (`infra/README.md` "Migrating to a single hostname (M5)",
steps 4 and 5). M5.4's expired-session handling remains **unverified** — it needs a
genuinely revoked Access session in a browser, and which of its two symptoms
production produces is deliberately unrecorded until someone has seen it.
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
| Training | Kaggle free GPU (30h/wk, T4/P100 16GB) primary, Colab fallback. **Amended for v2 (§12):** training moves onto the home box in v4/v5 — CPU-only, days per run, and acceptable because nothing waits on it |
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
  session cookie, sessions in D1. **Amended in v2 (§12): not built.** v2 has two tiers —
  admin behind the Cloudflare Access gate that already exists, and anonymous. There is no
  annotator tier in between, so there is nothing for OAuth to authenticate. This decision
  was made when the public surface became a verification page anyone may try: open
  sign-up is now the *anonymous* path by design, which retires Q7's objection to Access
  for user auth rather than answering it. `annotator_id` stays on every verdict row
  regardless, so swapping the identity source later touches no annotation data.

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

  Applied 2026-08-03. `api.crowdmon.mkcarl.com` was retired the same day, once the Go
  worker had been repointed off it and verified claiming through the new hostname.
  Moving the application's `domain` turned out to update it **in place** rather than
  replacing it, so the `aud` survived and the `ACCESS_AUD` repaste this section used to
  call mandatory was a no-op — see `infra/README.md` "Migrating to a single hostname
  (M5)", which records that and the one prediction it got right.
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

**Amended in M8, which is where the above stopped being a sketch.** Five decisions
locked while building extraction, each with what it rules out:

*The hash is a DCT pHash, written by hand, no dependency.* 32x32 greyscale, DCT-II, the
top-left 8x8 block with the DC term dropped, each of the remaining 63 coefficients
against their median. Dropping DC is the load-bearing part: it carries overall
brightness, so keeping it would make every hash track exposure and a scene that merely
got darker would read as a new frame. An average hash was the cheaper option and loses
for the same reason — gameplay footage is a static HUD over a moving scene, and the HUD
dominates the mean.

*The threshold is stamped on every row, not just configured.* 10 of 64 bits by default,
`CROWDMON_DEDUP_THRESHOLD` to change it. Changing it does not re-deduplicate old videos,
so a dataset that recorded only the current value would be an unrecorded mixture of
regimes and no dedup ratio drawn from it would mean anything. The job additionally
carries a `config_version` naming every setting that shaped its output — stated in
words rather than hashed, because the operator reading it a year from now wants to know
what the settings *were*, not that they differed from another opaque digest.

*Extraction is 1 fps and that is not configurable.* It is baked into the timestamps, the
R2 key format and the dedup's assumption that consecutive frames are a second apart. A
second rate would make the dataset a mixture in a way `dedup_threshold` alone could not
record, so if it ever changes it changes as a schema question, not a setting.

*Frames go to a temp directory; only source videos get the volume.* The volume exists
specifically so a video survives a container recreate (M7.1). Frames must not have that
property — they are worthless the moment they are in R2 — and a leaked directory per
chunk would fill the disk downloads need, surfacing several jobs later as a download
failure with nothing pointing back here.

*Metrics are real OTLP metrics on the Go side, unlike M6's answer on the Worker side.*
That decision — "spans, not metrics" — was about `@microlabs/otel-cf-workers`, which
exports traces only, so a counter had nowhere to go. The Go worker runs the full SDK and
the home collector already had an OTLP metrics pipeline feeding Prometheus, so
`frames.extracted`, `frames.kept`, `frames.dedup.ratio` and `chunk.duration` are
instruments. None of them carries a video id: unbounded cardinality would add a
Prometheus series per video, forever.

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

**Amended in M7, which is where the fan-out stopped being a sketch.** Four decisions, each
with what it rules out:

*The enqueue is an API endpoint, not the worker writing rows.* `POST /api/jobs/{id}/fanout`
takes what ffprobe measured and inserts every segment's `jobs` row and `chunks` row in one
D1 `batch()`. A worker making one call per segment could not be transactional, and the
claim handler (M3.4) retires a chunk job whose `chunks` row is missing as corruption — a
half-written pair would destroy a segment permanently, because `idx_chunks_identity` then
stops the re-run from recreating it.

*Idempotency is a `NOT EXISTS` guard repeated on both statements of a pair, not an
`ON CONFLICT`.* `ON CONFLICT DO NOTHING` on the chunk insert would leave the job row it was
paired with already inserted — an orphan, which is the corruption above. The guards must be
identical because `last_insert_rowid()` returns the *previous* insert's id when a statement
inserted nothing: a chunk insert running while its job insert was skipped would attach
itself to another segment's job.

*Video length has a ceiling, and it is a schema bound.* Segments are statements, so a
six-hour video is 721 of them in one batch. The limit is enforced by `FanOutRequest`, where
the answer is a 400 naming it, rather than discovered as a batch that fails halfway. A test
runs a four-hour fan-out for real, because the ceiling is worth knowing before production
finds it.

*Failures are sorted at the worker, and the default is retryable.* This is the taxonomy §Q14
deferred from M6. `worker.Terminal` marks what a retry cannot fix — deleted, private,
geo-blocked, members-only and age-gated videos, a fan-out the contract refuses, a chunk
whose source is on another box — and only those are reported through `complete`, which
retires the row on the first report. Everything else is left `claimed` for the reaper: it
costs a lease window plus a cron tick and the attempt already spent on the claim, against a
wrongly terminal classification burning a video permanently. `Sign in to confirm you're not
a bot` is deliberately not on the list — it reads exactly like the age gate and is about the
box's address, not the video.

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

**Amended in M6, which is where the above stopped being a sketch.** Four decisions locked
while building the reaper, each with the option that lost:

*Thresholds.* `LEASE_STALE_SECONDS` is 120 — four missed 30s heartbeats — and
`MAX_ATTEMPTS` is 3. Vars in `wrangler.toml`, not constants, because they are the two
numbers an operator would want to change without a code review; `reaper.ts` throws on a
malformed one rather than defaulting, since these are pinned by a test and the only way
to reach a bad value is a hand edit that should not appear to have worked. The staleness
threshold is set against the *heartbeat*, not against the cron period: detection latency
is 0–5 minutes whatever it is, so tightening it buys nothing and starts reaping workers
that merely hit a transient API error — which `runner.go` deliberately keeps beating
through. Worst-case pickup is therefore ~7 minutes, invisible against a 10–20 minute job.

*Spans, not metrics, and one per job.* @microlabs/otel-cf-workers exports traces only, so
a counter has nowhere to go — the choice was never open. One span per reclaimed job
rather than one per tick carrying a count, because Tempo's metrics-generator turns span
*rate* into a series and a count inside an attribute is not a rate. Two span names,
`job.reclaimed` and `job.retired`, rather than one name plus an `outcome` attribute: the
generator keys on service, span name, kind and status, so the attribute version would be
unsplittable in Grafana, which is the one thing the panel needs.

*The ceiling covers crashes, not reported failures.* The reaper is the only place a job
re-enters `pending`, so it is the only place the ceiling is enforced. A worker that
*reports* a failure is retired on the first report, whatever `attempts` says — right for
the poison cases this milestone names (deleted, geo-blocked, malformed), where a retry
cannot help. Classifying reported failures into retryable and terminal belongs to M7.1,
which is where failures with a shape to classify first exist. Building the mechanism
sooner would be a taxonomy with nothing in it. **M7.1 built it, and inverted the default:
a failure is reported only if something marked it terminal — see the §Q13 amendment.**

*Terraform owns the cron schedule; wrangler owns the handler.* The §3 split, applied to a
resource that sits on the script — and it holds only because wrangler PUTs `/schedules`
under `if (crons)` over `args.triggers ?? config.triggers?.crons`. An absent `[triggers]`
table means no request at all, so Terraform's schedule survives every deploy. An **empty**
one does not: `crons = []` is truthy in that check, so adding the table with nothing in it
PUTs an empty array and deletes the schedule. No deploy fails; the only symptom is
crashed jobs sitting `claimed` forever, which is M6's own failure mode arriving silently.
`apps/api/test/node/wrangler-config.test.ts` asserts the table stays absent, and that test
is the whole reason the split is safe rather than merely tidy.

**D1 read replication stays disabled** (`infra/main.tf`), and that follows from the
paragraph above rather than from cost. Replicas are eventually consistent, and the claim
is only atomic against a single primary — a worker whose read landed on a replica could
see a job as pending seconds after another worker had taken it. Terraform states it
explicitly instead of inheriting the default, because the provider otherwise plans the
attribute to null on every run and the API rejects that, which turns any unrelated apply
into a failed one.

**Fan-out must be transactional, which is a constraint M3.4 imposes on M7.2, and which
M7.2 discharged** — see the M7 amendment under §Q13 for how. The claim
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

**Amended in v2 (M12.2): the admin dry-run grid is proxied, not signed.** Fifty frames,
Access-gated, rendered once per dry-run — `GET /api/admin/image?key=…` reads the Worker's
existing `FRAMES` binding and streams the bytes. This does not reopen the decision above,
because the decision above is a posture argument: the bucket stays private, nothing is
enumerable, and the gate is the same allowlist every other admin route sits behind. What
proxying avoids is minting an R2 S3 credential by hand and implementing SigV4 in a Worker
to serve one operator fifty images. Presigned batches stay where their argument actually
bites — M13.4's labelling session, a couple of hundred images per sitting, where keeping
bytes off Worker CPU is worth the infrastructure.

**Amended again in v2 (M13.4): the batch endpoint signs when it can and proxies when it
cannot.** `/api/admin/labelling/batch` returns N frames, their boxes and a URL each, and
which kind of URL is decided by whether the deployment has an R2 S3 credential —
announced on the response as `url_mode`, because the two expire differently and the UI
has to tell an expired signature from an ended Access session. The credential is the
reason for the fallback rather than a hedge about the decision: it is dashboard-minted
material this repo cannot create (M8's bucket-scoped token sat behind the same gate),
and a verification UI that answered 503 until somebody set it would make the milestone
undeliverable by this repo alone. Both modes keep §7's posture whole — private bucket,
no enumeration, the same allowlist — so what the credential buys is bytes off Worker CPU,
which is exactly what §Q25 said it was for. Setting `FRAMES_S3_BASE_URL` plus the two
secrets switches the mode with no code change.

**And the credential is not a new one.** The Worker signs with the *detector's*
read-only token (`CROWDMON_DETECTOR_R2_*`, Object Read on `crowdmon-frames`), because
presigning a GET needs exactly that grant and a third bucket token would have been a
third thing to rotate for no narrower a bound. It is emphatically not the Go worker's
read-**and-write** token: a signing key never needs to write, and putting a writable
credential in a Worker to hand out read URLs would widen the blast radius for nothing.
That reuse does couple two systems — rotating the token stops the sidecar *and* makes
this Worker sign URLs R2 rejects, which surfaces as broken frames rather than as a
readable failure — and the coupling is written at both ends (`apps/api/wrangler.toml`,
`deploy/homebox/.env.example`) rather than left to be found during an incident. Clearing
the Worker's copy is the stopgap: it falls back to proxying, which is the mode it
shipped in.

**Amended in v2 (§12): the public path serves R2 images too, and is bounded to make that
safe.** The public surface is no longer a detector demo over bundled samples; it is the
verification UI, which needs real frames. Three bounds keep §7's "no republishing at
scale" literally true rather than rhetorically: images are drawn only from a hand-curated
`public_sample` flag rather than from the bucket, they are issued **one short-lived
signed URL per request with no enumeration** — the batched-N form stays on the
authenticated path where throughput matters — and the public endpoints are rate limited
with the pages carrying `noindex`. The difference between the sample and the dataset is
then a schema flag, not a paragraph explaining why this gallery is a different gallery.

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

**Amended in v2 (§12) in four ways, none of which change the gate itself.**

- **Bootstrap is not manual and not on Kaggle.** Pre-labelling is a fourth job kind on
  the existing queue, running on the home box behind extraction with no human trigger.
  The gap this section worried about — image exists, image is not yet verifiable — closes
  by itself, and the new work inherits claiming, leases, the reaper, the attempt ceiling
  and every Grafana panel rather than being a second mechanism.
- **A bounded sample, not every frame.** Default 200 images per video, drawn randomly
  across the timeline, budget stamped on the rows in the same idiom as
  `images.dedup_threshold`. Pool size is governed by what a human can verify, not by what
  ffmpeg can produce: pre-labelling every kept frame from five videos queues years of
  backlog and makes the dashboard look busy while the pool anyone actually works through
  is the first two hundred rows. Unsampled frames keep their rows and wait.
- **The gate's cost is now named.** Verify-only can never add a box the model did not
  propose, so a character the detector misses is never shown, never corrected, and in the
  table is indistinguishable from a character that was absent. False positives get
  rejected; false negatives are invisible. The escape hatch is an admin-only
  missing-object report, stored as its own row type rather than as a verdict on a
  prediction that does not exist, and it stays out of a snapshot until somebody draws the
  box. Its rate per class is the number that says whether a prompt is good enough.
- **The classes are data.** Name, appearance prompt, active flag — a table, because
  open-vocabulary detectors match described appearance rather than proper nouns, so
  "which five characters" is an empirical question answered by running a prompt against
  about fifty frames and looking. The prompt in force is stamped onto the predictions it
  produced, or rewording one silently creates two regimes inside a single class.

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

**Amended in v2 (§12): the column ships, the weighting does not.** Every image records a
`selection_reason`, and the random slice is excluded from training by the snapshot's split
manifest — but v2 selects randomly only, and the 70/20/10 mix lands in v4 with the
training it exists to serve. Uncertainty sampling has no job while a zero-shot model
pre-labels uniformly and nothing is being measured.

The asymmetry is what makes this the right cut. Skipping the *weighting* costs nothing
that cannot be added later. Skipping the *flag* is permanent: every image labelled before
a frozen pool exists was chosen by some biased rule, so it can never be retro-declared an
unbiased sample, and the comparison this section exists to protect becomes unavailable
for good. Confidence is persisted from the first prediction row for the same reason — it
is what a later band selector needs and cannot reconstruct.

**Amended again in M17 (plan §B): a fourth value, `manual`, outside this section's stated
`uncertain | random | diverse` vocabulary.** On-demand supplementary prelabel lets an admin
hand-pick specific frames to refill a drained verification pool — a biased sample by
construction, since a human chose them for a reason. Stamping that `random` would be
exactly the failure this section calls non-negotiable: it would pollute the permanent,
frozen evaluation pool with a selection that was never unbiased, and (per this section's
own sentence) the pollution could never be retro-declared away. `manual` is not a
weighted-mix leg like `uncertain`/`diverse` — it carries no weighting and no plan to ever
have one — so it is best read as a second axis (*how* a frame entered the pool: server
policy vs. a human's own judgement) rather than a fourth rung on the same 70/20/10 ladder.
`splitFor()` (`worker/internal/snapshot/builder.go`) needed no code change for it: the
rule was already "`random` → eval, everything else → train," and `manual` is simply the
first value other than `random` that rule has ever actually had to route.

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

**Not in v2 (§12).** Nothing trains, so there is no version to register. What v2 owes
this section is the thing it cannot supply retroactively: snapshots carry a stable
identifier and record the inclusion policy they were built under, so the `model_versions`
row that eventually points at one is referencing a dataset that can be reconstructed
rather than asserted.

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

**Amended in v2 (§12): the handoff is to the home box, not to Kaggle.** Training runs on
`carls-ubuntu` from v4, CPU-only and measured in days, which is affordable precisely
because nothing waits on it. Half of this section's reasoning retires with the notebook —
the box holds R2 credentials already, so "no standing credentials in an ephemeral
environment" no longer applies. The other half survives on its own merits and is what v2
builds: one snapshot artifact rather than thousands of GETs, a stable snapshot id so
recorded training-set size is verifiable, and the split manifest, which matters *more*
here than it did on Kaggle. A training script on a machine that also holds the images can
trivially glob the directory and never read the manifest at all, and that mistake would
look like nothing going wrong.

**The trap this creates, banked now because it will be discovered at hour forty.** A
training job on the box will be another job kind on the same queue, which is the point —
but the deploy timer pulls a new image and restarts the container, killing a multi-day run
silently and handing it to the reaper to burn attempts 2 and 3 against `MAX_ATTEMPTS`. The
fix is checkpoint-and-resume, or pausing the update timer while a training job is held.
Nothing to build before v4.

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

**Amended in v2 (§12): two tiers, admin and anonymous, with nothing in between.** The
public verification page means the median contributor is now a stranger, and this
section's refusal to build consensus resolution, agreement scoring and trust weighting
holds only while contributors are trusted. Rather than acquire all three, v2 keeps
untrusted input out of the dataset: an anonymous verdict is recorded with `source =
'anon'` and an opaque session id, shown back to the visitor immediately so the page is
not theatre, and excluded at snapshot time by the recorded inclusion policy. Admitting
those verdicts as labels is the single decision that would force every subsystem this
section rejects, which is why it was considered and dropped.

Two properties make that reversible rather than final. Verdicts are **append-only rows
referencing an immutable prediction** — an `adjust` writes new coordinates onto the
verdict, never over the model's output — so excluding any annotator later is a `WHERE`
clause instead of an unrecoverable loss. And accept/adjust/reject rates are computed
**per source**, or anonymous clicking pollutes the one metric a later flywheel claim
depends on: a troll rejecting everything is otherwise indistinguishable from a model that
got worse.

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

**Amended in v2 (§12): the public surface is the verification page, not the detector
demo.** The live in-browser detector moves out with the training that would produce a
model to run — v4 or later. What lands instead is the thing this project is actually
about: a stranger gets one frame with a proposed box and rules on it, without an account.

That is close enough to the rejected gallery that the distinction has to be structural,
and §Q25's three bounds are what make it so — a hand-curated `public_sample` pool rather
than the bucket, one short-lived signed URL per request with no enumeration, rate limiting
plus `noindex`. What is exposed is a sample somebody chose, and no ingestion run grows it.

The public pool is kept **separate from the frozen evaluation pool**, which is worth
stating because reusing one flag is tempting — eval-pool images are excluded from training
anyway, so untrusted clicks on them could contaminate nothing. The two have opposite
selection criteria and that is what decides it. The eval pool must be *random*, which
means it is full of menus, loading screens and black frames; the public pool must be
*legible*, or a visitor's first impression is a black rectangle and a broken product.
Reusing one pool gives one of them the wrong images, and it would attach untrusted
verdicts to the one set whose labels must stay unimpeachable.

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

**SPA gotcha — observed 2026-08-03, and it is not the symptom this section predicted.**
The written expectation was that `fetch` follows the 302 and returns the login page as
HTML with a 200. In production it does not: Access redirects to
`mkcarl.cloudflareaccess.com`, a *different origin*, so the followed redirect carries no
CORS headers and `fetch` rejects with a `TypeError` before any status is observable
(`No 'Access-Control-Allow-Origin' header is present`). The HTML-200 form is what
happens when the login page is same-origin; it is not what this deployment does.

`apps/web/src/api/client.ts` treats both as the same event, so detection was unaffected.
Default session is 24 hours.

**The recovery was broken, and the two decisions that broke it were each correct.**
Detection worked; the fix did not. `reauthenticate()` navigated to
`window.location.href`, on the reasoning that a top-level load completes the redirect
chain `fetch` cannot. It does — but only for a URL Access actually gates, and the
decision immediately above deliberately leaves `/admin` ungated. Navigating there
returned the SPA shell, which re-fetched, failed identically, and re-rendered the
banner: a loop with no reachable login screen. Nothing caught it, because the unit test
asserted `location.assign` was *called*, which was true of the broken code too.

Recovery now navigates to `/api/admin/login` — a Worker route that exists only to sit
*under* the gated prefix. Access intercepts the navigation, the browser completes the
login flow, and the handler redirects to `/admin` once an assertion exists. It hardcodes
that target rather than honouring a `redirect_url` parameter: the one endpoint
guaranteed to be reached with a freshly minted session is the worst possible open
redirect.

The general lesson is worth more than the fix. "Gate the API, not the UI route" and
"recover by reloading the page" are each defensible in isolation and contradict each
other in composition, and no test of either one alone can see it.

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

**A login screen for an auth scheme with no login form (M16).** Access mints a session
by redirecting the browser through an identity provider; there is no password field
this application ever collects and no `POST` it could submit one to. That made a login
*screen* look redundant right up until M16 built a sidebar shell with routed sub-pages,
at which point the question stopped being "does this app need a credential form" — it
never did — and became "where does an unauthenticated browser land." Before M16 the
answer was nowhere in particular: `SessionExpiredBanner` (M5.4) rendered inline wherever
a request happened to fail, which is a fine answer for a session that expires *mid-visit*
and no answer at all for a browser that never had one — there was nothing to render a
banner over. `/admin/login` is the destination: product name, one line of copy, one
button that calls the same `reauthenticate()` `SessionExpiredBanner` already called,
navigating to `/api/admin/login` because that is the path Access actually intercepts
(the amendment above, "The recovery was broken," is why nowhere else works). It is a
gate screen, not a credential form, because Access is still the entire auth scheme —
this page collects nothing Access does not already collect itself.

**The session probe is cosmetics, and saying so twice is the point.** `AdminLayout`
calls the new `GET /api/admin/session` once on mount and redirects to `/admin/login` on
anything but success. That redirect is a `<Navigate>` — client-side routing, the same
mechanism this section has always said proves nothing — and it decides only which
component tree renders in a browser that was never going to reach a real row of data
either way, because `requireAccess` gates every `/api/admin/*` call this shell makes
regardless of what the sidebar shows. **This does not amend "gate the API, not the UI
route."** It could not: the route table in `apps/web/src/routes.tsx` still says the
admin bundle is assumed public, in the same comment it has carried since M5.1, and
`GET /api/admin/session` is behind `requireAccess` like every other admin endpoint —
reaching its handler *is* the check, the response body is a courtesy. What changed is
only that an unauthenticated visitor now sees a button instead of a shell issuing failed
requests at a sidebar with nothing behind it; a stranger who skips straight to
`/admin/dashboard` by typing the URL gets exactly as far as they did before M16, which
is to say exactly as far as `requireAccess` lets them.

**The detector re-run was scoped out of M16, and the cost is worth naming rather than
leaving implicit.** `/admin/videos` (M19 folded the coverage table in from
`/admin/detection`, which now redirects there) shows prelabel coverage per video — how
many frames exist, how many were sampled, under which model, when — and stops there
deliberately. Re-running the detector over more of a video's frames to seed the
verification pool needs four things this milestone does not have: a migration, because
`idx_jobs_one_prelabel_per_video` (migrations 0005, 0007, 0008) permits exactly one
`prelabel` job per video and a second sampling pass is a new kind of row this schema
cannot currently represent; an admin enqueue route, since nothing today lets a browser
queue a `prelabel` job at all — `completeJobHandler` does it automatically, and only
once, when a video's last `chunk` job finishes; a Go worker change so `ImageSampler`
draws only frames not already sampled, rather than re-running the same 200-image budget
over a pool that has grown; and an explicit answer to this section's own provenance
rule — a second sampling pass under a different threshold or model version has to stamp
that regime onto the rows it produces, or the dataset silently becomes the "unrecorded
mixture of regimes" the paragraph above this one already warns against. That is a
milestone with a worker release inside it, not a button on an existing page, and the
new-job-kind rollout order applies to it exactly as it did to `snapshot` (README.md's
"v2 acceptance run" records job 328 failing terminally for this reason) — a re-run job
queued before every worker polling the queue understands it does not wait quietly, it
fails loud. M16 ships the read half so the page that eventually grows that button
already tells the truth without one.

**Amended, M17 (plan §B): the button shipped, and the third prerequisite above inverted
rather than landing as anticipated.** All four things this paragraph named turned out to
be needed — a migration (0011), an admin enqueue route (`createPrelabelHandler`), and an
explicit answer to the provenance rule (`jobs.selection_reason`, write-once) — except the
third. Rather than teaching `ImageSampler` to draw only frames not already sampled, M17
moves selection out of the Go worker entirely: the API decides which frames a supplementary
pass runs against (hand-picked or a random draw over `WHERE selection_reason IS NULL`) and
hands the worker an explicit list on the claim, the same shape `chunk`'s window and
(M17, plan §A) a single-frame dry-run's `r2_key` already arrive in. Two selection
mechanisms — one in Go for a re-sample, one in the API for a hand-pick — was the thing to
avoid, and "frames not already sampled" is a `WHERE` clause that belongs next to the data
it filters, not a second copy of that predicate re-implemented against R2 keys in Go. The
practical effect: `ImageSampler` still exists and still runs the automatic first pass
unchanged, but a re-run against an already-labelled video never calls it at all.

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
3. ~~**Promotion trigger for semantic spans.**~~ **Resolved by v2's shape (§12), and cashed
   in at M11.4.** "First verify pass on real data" was the concrete version of this, and
   v2 supplied the milestone; M11.4 is where the milestone stopped being a promise and
   became three actual spans. `sample.select` (drawing M11.3's bounded, timeline-spread
   subset), `image.detect` (one per sampled image, run against every configured class),
   and `predictions.report` (the write) nest under `job.prelabel`, following
   `worker/internal/worker/pipeline.go`'s existing chunk-branch shape — one collaborator
   call, one span, attributes set only once the call succeeds. This item stayed
   struck-through rather than deleted between the two milestones on purpose: "resolved by
   a milestone" and "resolved" are different claims, and the gap between them is exactly
   what a status line that only says "not yet discussed" (item 2, still true) would hide.
4. ~~**Sampling posture.**~~ **Resolved at M11.4, 2026-08-08: `sdktrace.AlwaysSample()`,
   spelled out explicitly rather than left as the SDK's default.** The question was never
   "sample or don't" — it was what to do about the day a global head sampler gets
   configured, and the answer is: not yet, and not uniformly when it is.

   M11.4 is what made the two kinds of span in this system impossible to ignore.
   `job.prelabel` and what nests under it — `sample.select`, `image.detect`,
   `predictions.report` — are low-rate (one prelabel job per video, bounded to M11.3's
   sample budget) and high-value: each one is evidence behind a promotion decision, the
   argument item 3 above just finished making concrete. Everything else this project
   emits — `job.claimed`, `video.download`, `frames.extract`, the API's
   `POST /api/jobs/claim` and its siblings — is comparatively cheap to lose and
   comparatively expensive to keep at scale. A single `TraceIdRatioBased` sampler
   configured today would not distinguish between the two: it would thin `job.prelabel`
   exactly as hard as it thins a poll that found nothing, discarding the only data this
   milestone exists to produce in exchange for a cost saving this project does not yet
   have a bill for. That is the mistake this decision exists to head off, not a sampler
   left unconfigured because nobody got to it.

   `AlwaysSample()`, not `ParentBased(AlwaysSample())` — the two look identical for a
   root span, but a prelabel job's `job.prelabel` span is not always a root: M9.2 chains
   it onto whatever traceparent the job row was stamped with, minted by `apps/api` rather
   than this worker (`withStoredTraceContext`, `pipeline.go`). `ParentBased` would honour
   that remote parent's sampled flag — a decision some other process made, for reasons
   that have nothing to do with this job — and a stray `sampled=0` upstream would drop
   the flywheel spans silently, with nothing in this worker ever deciding that should
   happen. `worker/internal/telemetry/tracing_test.go`'s
   `TestSetupSamplesAChildOfAnUnsampledRemoteParent` pins exactly this: a span parented
   on a remote, explicitly-unsampled context still reaches the collector, which is the
   one behaviour a reviewer skimming `sdktrace.WithSampler(sdktrace.AlwaysSample())` could
   mistake for the no-op the SDK's own default already provides.

   **The threshold for revisiting**, stated rather than left to be discovered: this stops
   being viable once job *throughput* — submissions, not the sample budget inside one
   prelabel job — is high enough that Tempo's 7-day retention (§2, a box shared with
   unrelated projects) becomes a real cost, or once this worker gains a genuinely
   high-rate, low-value span category of its own. It does not have one today by
   deliberate design — `queue.go`'s `tracingTransport` injects the `traceparent` header
   onto every outbound call without wrapping it in a client span, precisely so that the
   only spans this process emits are the ones a human already wants (its own comment
   explains why `otelhttp.NewTransport` was rejected for exactly this reason). When that
   day comes, the fix is a `Sampler` that inspects the span name — always-sample
   `job.prelabel`'s tree, ratio-sample the rest — not one ratio applied uniformly to
   everything this process exports.

   **Amendment, M17 (plan §B): the low-rate premise no longer holds by construction.**
   The argument above rests on "one prelabel job per video, bounded to M11.3's sample
   budget" — true only while `idx_jobs_one_prelabel_per_video` made a second pass
   unreachable. On-demand supplementary prelabel (migration 0011) drops that index on
   purpose, so a video can now have as many `prelabel` jobs as an admin queues refills for.
   The posture itself is not changed by this — `job.prelabel` is exactly as high-value per
   occurrence as it always was, an on-demand pass is still evidence behind the same kind of
   decision the automatic one is — but the rate is now something an *operator* controls
   rather than something the schema bounded, and this section's own "threshold for
   revisiting" (job throughput against Tempo's 7-day retention) is the thing to watch as
   that knob gets used. Nothing to do yet: a home box running one worker cannot generate
   enough concurrent `prelabel` jobs to approach that threshold on its own, and this note
   exists so the day it looks close, the premise that changed is on record rather than
   rediscovered.
5. ~~**Deadman check.**~~ **Not an open item — an accepted risk, decided 2026-08-08.**
   Nothing tells you the collector died, and nothing will. Issue #48 closed as not
   planned; M9.3 was dropped from v1 rather than deferred.

   The reasoning, recorded because "flagged since M2, still unfixed" reads as neglect
   and this is a decision. A dead collector costs *visibility*, not data: jobs still
   run, images still land in R2, D1 still records, and the pipeline does not have the
   collector on its critical path by design (§6). Against that, a deadman buys a push
   notification about a system with no users and no SLA, and costs a third-party
   account, a secret in `~/crowdmon/.env`, and a systemd unit — operational surface on
   a project whose case rests on being cheap and simple.

   **What made it safe to accept is a property M9.1 already shipped for another
   reason.** The dangerous failure is not the collector dying, it is a dead collector
   being indistinguishable from a healthy idle system — every panel empty either way,
   and the failure-rate panel is *supposed* to be empty when things are well.
   `queue_depth` breaks that tie: it reports twelve explicit zeros (four statuses times
   three kinds, since M11.1 added `prelabel`) when the queue is drained and healthy, and
   goes *absent* when nothing is exporting. The API's zero-fill
   was built for exactly this distinction one layer down. So the "is it dead or idle"
   question is answerable at a glance; only the unprompted alert is gone, and that is
   the half that was optional.

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

### v1 done-claim — met 2026-08-08

> A YouTube URL goes in, extraction is visibly running, OTel has data, and images land in R2.

v2's claim and build plan are §12.

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

---

## 12. v2 design

Scope statement in `PRD.md` §9; tracked as
[issue #89](https://github.com/mkcarlclaude/crowdmon-revamp/issues/89). Decisions here
amend the sections they touch, and each of those sections carries a back-reference.

### v2 done-claim

> A submitted video becomes pre-labelled frames with no human trigger, verified through
> this platform's own UI — public to anyone, authoritative for an admin — and exported as
> a dataset snapshot with a split manifest.

**One sentence, no criteria list.** v1 ran both, with the sentence cutting scope and eight
criteria doing the proving. v2 drops the list, which puts the whole completion test on the
sentence and is why it is worded as tightly as it is — `PRD.md` §9 tabulates the
observation that falsifies each clause.

### What the deliverable is (and is not)

**The platform is the product; detector accuracy is an afterthought.** No part of the
claim mentions model quality, and that is not modesty — it is the correct target. A
bootstrap model that pre-labels badly produces *more* work for the verification UI, which
is the thing being built. The characters the zero-shot model fumbles are the ones that
justify a human-verification platform existing at all.

**The word "flywheel" stays out of v2.** One lap demonstrates a loop that closes;
acceleration is only visible on a second lap, when verification of batch two is measurably
faster or higher-accept than batch one. The compounding quantity was never accuracy — it
is labelling throughput, with a better model as the mechanism rather than the payoff.
Claiming it on one lap would be claiming a trend from a single point. Two columns keep the
door open at no cost now: every verdict timestamped, and every verdict attributable to the
prompt and model version that produced the box it judged.

### Where the work runs (amends §Q15, §Q21)

**Pre-labelling is a fourth job kind, not a subsystem.** `jobs.kind` gains `prelabel`
beside `download` and `chunk`; the Go pipeline dispatches on kind in one place and gains a
third branch. Everything v1 built applies unchanged — claiming, heartbeat leases, the
reaper, the attempt ceiling, terminal-versus-retryable classification, span naming, every
Grafana panel. This is the load-bearing architectural decision of v2, and it is the
strongest argument for the home box over a notebook: Kaggle is a manual step outside every
mechanism this project has, and a queue job is inside all of them.

**One `prelabel` job per video, not per chunk.** The sample must be drawn across the whole
timeline, and a per-chunk job cannot see outside its own sixty seconds.

**Detection sits behind a one-method interface** — image path plus prompts in, boxes with
confidences out. Production talks to an ONNX open-vocabulary model over HTTP, in a Python
sidecar container rather than in-process in the Go worker (M11.2): an open-vocabulary
detector needs a CLIP-style tokenizer for the text prompts, and getting that right by hand
in Go is a worse bet than a well-exercised Python one. Tests substitute a table of known
boxes, so no test needs a model file, an ONNX runtime or a GPU. Same shape as
`frames.Deduper`'s injectable hash, and the same payoff: the model is a swap — today
OWL-ViT (`google/owlvit-base-patch32`), chosen over YOLO-World because YOLO-World's
standard ONNX export bakes the class vocabulary in as constants, which would mean a
redeploy every time a prompt changes and defeats the point of choosing an open-vocabulary
model at all — and the swap costs one image rebuild, not a change to this repo.

**The 940MX question is closed, not merely re-measured.** The card is Maxwell, compute
capability 5.0, and CUDA 13's release notes say plainly that Maxwell support is gone —
running anything on it now would mean pinning the whole detection stack to a dead CUDA 12.x
branch for a card with 2GB of VRAM, not a live option to keep open. Detection runs CPU-only,
on the same two cores as everything else on the box, and open-vocabulary inference at that
budget is seconds per image — 200 frames is minutes per video, while every kept frame from a
97-minute video would be most of a night, which is what makes bounded sampling non-optional
rather than a nicety. What makes this reversible if the hardware ever changes is not a note
to revisit it — it is the one-method interface above: a future GPU box implements the same
`Detector` and nothing upstream of it has to know.

### Data model

Five new tables and two columns, and one property runs through all of them: **nothing is
overwritten.**

- `classes` — name, appearance prompt, active flag, prompt version.
- `predictions` — image, class, box, confidence, prompt version, model identifier.
  Immutable after insert.
- `verdicts` — prediction reference, `accept` / `adjust` / `reject`, adjusted coordinates
  when adjusting, source, annotator identity or session id. Append-only; several verdicts
  on one prediction is a legal state.
- `missing_reports` — image, optional class, reporter. Admin-only.
- `snapshots` — id, R2 key, counts, the inclusion policy in force.
- `images` gains `public_sample` and `selection_reason`.

**An `adjust` that mutated the prediction would be the one irreversible act in the
system.** The model's original output is what makes "every annotation is a human verdict
on a model prediction" checkable rather than asserted, and it is what any later exclusion
of an annotator has to fall back to. Writing adjusted coordinates onto the verdict row
costs nothing and keeps that recoverable forever.

**Provenance is stamped, not inferred** — the sample budget, the dedup threshold, the
prompt version, the snapshot's inclusion policy. §7's "thresholds are dataset provenance,
not just settings" generalises: any setting that shaped a row and can change later must be
recorded on the rows it shaped, or the dataset becomes an unrecorded mixture of regimes
and every number computed over it gains a confounder nobody can name.

### Strategy

Same as §Q26 — thin vertical slice, each piece landing with its migration, its contract
change and its instrumentation. The one addition is that v2's slice is *narrower than it
looks*: five of the six milestones below are ordinary CRUD-and-UI work over the queue that
already exists, and only pre-labelling introduces genuinely new failure modes.

### What v2 excludes

Training on any machine · model registry · distilled detector · in-browser inference ·
public detector demo · Google OAuth, sessions, any annotator tier · consensus resolution,
agreement scoring, trust weighting · leaderboards · 70/20/10 weighted selection · a public
statistics surface · more than five active classes · any measurement of accuracy.

The operational debt in §9 stays debt, including yt-dlp freshness. It was considered for
inclusion — a starved ingest is the one failure that stops the flywheel rather than
degrading it — and left out to keep v2's sentence honest.

### Milestone order

1. **Schema and contract** — the five tables, the two columns, endpoints declared and
   generated, nothing rendering yet
2. **Pre-label job** — fourth job kind, detector interface, bounded sampling, semantic
   spans landing with the first work that has a middle worth naming
3. **Classes as data** — table, prompt validation against ~50 frames, activation
4. **Admin verification UI** — verify-only, missing-object reports, behind the existing
   Access gate
5. **Public verification** — same component, curated pool, signed URLs, rate limiting
6. **Snapshot and split manifest** — the export the claim ends at

Schema first, against §Q26's own warning about infra-first, because every later milestone
writes to these tables and a migration reversed after the UI exists is the expensive
version of this ordering. Pre-labelling second for the same reason observability was
second in v1: it is the highest-uncertainty work, and everything after it is easier to
debug against a pool that already has predictions in it.
