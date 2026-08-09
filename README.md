# Crowdmon 2026

A self-improving object-detector platform, operated as a live demonstration of cheap,
healthy, observable infrastructure.

**Infrastructure is the deliverable.** The ML flywheel — bootstrap labels with a
zero-shot model, have humans verify the long tail, distil a real-time detector that runs
in the browser — is the workload that generates signal worth observing.

> **Status: v1 and v2 are closed.** v1's eight success criteria were verified on
> 2026-08-08 — the table is [below](#acceptance-run-2026-08-08). v2's one-sentence
> done-claim (`PRD.md` §9) was verified on 2026-08-10 against one real video, end to
> end: a submitted video is pre-labelled with no human trigger, a stranger can verify a
> frame with no account, an admin's verdicts alone decide what a dataset snapshot
> admits, and the snapshot ships with a split manifest — the table is
> [below](#v2-acceptance-run-2026-08-10).
>
> Two things are deliberately left open rather than glossed over. The deadman check
> (M9.3) was **cancelled, not deferred** — a dead collector costs visibility, not data,
> and `queue_depth`'s explicit zeros already distinguish "idle" from "nothing is
> exporting"; the reasoning is in `CONTEXT.md` §9.5. And M4.5's "survives host reboot"
> was accepted on its mechanisms rather than on an actual reboot, which `ROADMAP.md`
> records as such.
>
> Next is v2: the ML flywheel — annotation, bootstrap, training, the in-browser demo —
> which v1 excluded on purpose. Nothing in v1's decisions blocks it.

## Documents

| Document | What it is |
|---|---|
| [`PRD.md`](PRD.md) | v1 scope, the done-claim, eight falsifiable success criteria, non-functional requirements, known risks |
| [`CONTEXT.md`](CONTEXT.md) | Design record — every locked decision with rationale, the options rejected and why, open items, notes on the 2023 codebase |
| [`ROADMAP.md`](ROADMAP.md) | Nine milestones, 39 issues with acceptance criteria |

Work is tracked in [issues](https://github.com/mkcarlclaude/crowdmon-revamp/issues):
[#1](https://github.com/mkcarlclaude/crowdmon-revamp/issues/1) is the PRD epic, and each
milestone below is a tracking issue whose sub-issues are its tasks.

## The v1 done-claim

> A YouTube URL goes in, extraction is visibly running, OTel has data, and images land in R2.

Falsifiable. Everything in v1 serves this sentence; everything that does not is v2. The
entire ML side is deliberately excluded from v1.

## Architecture

Pull topology. The home worker claims jobs from a D1-backed queue over an HTTP endpoint,
runs them, uploads to R2 and posts metadata back. No inbound ports, no dependency on the
house being up — jobs queue harmlessly while home is offline.

```
YouTube ──► Go worker (home Ubuntu)          Cloudflare (free tier)
              │  yt-dlp ─► ffmpeg ─► pHash    ┌──────────────────────────────┐
              │                               │ Worker: crowdmon.mkcarl.com  │
              ├── long-poll claim ────────────┤   Hono API + React SPA       │
              ├── heartbeat ──────────────────┤ D1  (queue+metadata)         │
              └── upload + complete ──────────┤ R2  (frames)                 │
                                              └──────────────────────────────┘
              └── OTLP/HTTP ─► collector ─► Tempo / Prometheus / Grafana
                               (via cloudflared tunnel, gated by Access)
```

One Worker serves both the SPA and the API from a single hostname. The admin
dashboard (M5) was originally planned as a separate Pages deployment; it was
moved onto the API Worker's static assets instead, because a second hostname
would have made every admin call cross-origin — see `CONTEXT.md` §Q6 for the
full reasoning. Cloudflare Access gates `/api/admin`, not the `/admin` route
itself, per `CONTEXT.md` §Q19.

| Concern | Choice | Why |
|---|---|---|
| Frame extraction | Home Ubuntu box | A household IP dodges YouTube's datacenter block |
| Web runtime | Workers + Hono, React SPA served by the same Worker | Free tier, edge, survives home downtime; one origin means no CORS between the SPA and the admin API |
| Metadata + queue | D1 | Free tier rules out Cloudflare Queues; the queue is a table with heartbeat leases |
| Object storage | R2 | Free tier, no egress fees |
| API contract | `@hono/zod-openapi` → OpenAPI → oapi-codegen | Two runtimes must agree; hand-written types on both sides is what broke the 2023 code |
| Infrastructure | Terraform (account resources), wrangler (code + secrets) | The account must be reconstructible from nothing |
| Observability | OpenTelemetry → self-hosted Tempo/Prometheus/Grafana | With no user-facing frontend in v1, Grafana *is* the UI |
| Training | Manual, batch, on Kaggle | No GPU worth training on at home — auto-retrain is ruled out by physics, not preference |

## The v1 demo path

Five minutes, no credentials beyond an Access login, and it exercises every claim above.

1. **Submit.** [`crowdmon.mkcarl.com/admin`](https://crowdmon.mkcarl.com/admin) → paste a
   YouTube URL. Access challenges the *API* call, not the page. A `download` job appears
   in the queue table below the form within a second.
2. **Watch it get claimed.** The home worker is long-polling with adaptive backoff, so
   pickup takes anywhere from a moment to the idle interval. The row moves to `claimed`
   and starts showing a heartbeat age that resets every 30s.
3. **Watch it fan out.** When the download and ffprobe finish, one chunk job appears per
   60s segment — 97 of them for a 97-minute video — all `pending`, and the worker starts
   draining them one at a time.
4. **Watch the system, not the rows.** "System health (Grafana) ↗" in the top right of
   `/admin` opens the dashboard in `infra/grafana/`: queue depth draining, chunk and
   download duration, dedup ratio, reclaim rate, failure rate. `/admin` deliberately
   shows none of this itself — `CONTEXT.md` §7.
5. **Follow one video through one trace.** In Grafana → Explore → Tempo, search
   `{name="job.download"}` and open the trace. It starts at the `POST /api/admin/videos`
   your browser made and ends at the last chunk's upload, across both runtimes.
6. **Break it on purpose.** `docker exec crowdmon-worker sh -c 'kill -TERM 1'` on the box
   abandons whatever chunk was in flight. Within ~7 minutes the reaper takes the lease
   back, the restarted worker re-claims it, and `attempts` on that row reads 2. See
   `deploy/homebox/README.md` for why `kill -9` there does nothing at all.

### Acceptance run, 2026-08-08

All eight success criteria in [`PRD.md`](PRD.md) §5, verified against one real run —
"Archon quest chapter 4 Act 2 (part 2)", 5,812s, submitted through the dashboard.

| | Criterion | Evidence |
|---|---|---|
| 1 | `terraform apply` reconstructs the account | `terraform plan` reports no changes across D1, R2, the Worker custom domain, the Access application and the reaper's cron trigger. Destroy-then-apply was exercised for real in M1.3 |
| 2 | CI deploys the Worker and publishes the image on merge | Both workflows green on the M9 merge; the box pulled the new digest and restarted |
| 3 | Submitting a URL through the dashboard creates a job | Job 24, `kind=download`, `pending` |
| 4 | The worker claims, downloads, fans out, extracts, dedupes, uploads | 2,237MB in 268s, ffprobe measured 5,812s, 97 segments enqueued in one D1 batch, all 97 drained |
| 5 | Images in R2, rows in D1, deduplicated | 5,812 frames extracted, 2,685 kept, 2,685 `images` rows against 2,685 distinct R2 keys — no key written twice. `dedup_threshold=10` stamped on every row |
| 6 | A single trace spans submit → claim → download → fan-out → chunk completion | Trace `bf4c7b4a…`, **3,961 spans**: one `POST /api/admin/videos`, 99 `job.claimed`, 98 `job.chunk`, 97 `POST /api/jobs/:id/images` |
| 7 | Grafana shows queue depth, dedup ratio, job duration, reclaim rate | All four return data. Dedup agrees with D1 to within rounding — 0.540 from Prometheus, 0.538 computed from the rows |
| 8 | Killing the worker mid-job produces a visible reap and retry | SIGTERM mid-chunk; the worker logged `shutting down mid-job, leaving it for the reaper`; the cron tick's span carries `crowdmon.reaper.requeued=1` with a child `job.reclaimed` naming job 65; the row came back at `attempts=2` |

Two numbers worth reading together. 98 `job.chunk` spans against 97 segments is the
reaped job running twice, which is what a correct retry looks like from the outside. And
the failure-rate panel is empty rather than zero-valued, because nothing failed and
nothing was retired — the one panel whose emptiness is the good outcome.

### v2 acceptance run, 2026-08-10

v2 has no separate criteria list — `PRD.md` §9's one sentence is the whole completion
test, and its own falsification table names the observation that kills each clause. All
six checked against one real video already in the system (`F1snt1pXqQc`) and one fresh
dataset snapshot built after M15 deployed.

| Clause | Falsified by | What was observed instead |
|---|---|---|
| *with no human trigger* | A video whose frames are extracted but not pre-labelled until something is run by hand | Job 146 (`kind=prelabel`) was enqueued by `completeJobHandler`'s own last-chunk check, timestamped seconds after the video's last `chunk` job finished — no admin action between them |
| *pre-labelled frames* | A sample producing no predictions, or predictions from an unrecorded prompt | `predictions` rows for the video carry `prompt_version=2026-08-08-a` and `model_id=owlvit-base-patch32@cbc355f`, stamped by job 146's own report |
| *public to anyone* | The public page loading with no image, no verify action, or demanding a login | `curl https://crowdmon.mkcarl.com/api/public/frame` with no credential returns a real frame, a signed R2 URL and its proposed boxes |
| *authoritative for an admin* | An anonymous verdict appearing inside a snapshot | The video carries 12 `anon`/`reject` verdicts and 64 `admin`/`reject` verdicts alongside 19 `admin`/`accept` and 2 `admin`/`adjust` — the built snapshot's `label_count` is exactly 21 (19 + 2), so neither the anon verdicts nor a single admin reject leaked in |
| *dataset snapshot* | A snapshot that cannot be listed, or one whose inclusion policy is not recorded | `snapshots` row `id=1`: `r2_key=snapshots/job-329`, `image_count=17`, `label_count=21`, `inclusion_policy` stating the admin-only, latest-verdict, accept-or-adjust rule verbatim |
| *with a split manifest* | A manifest missing, or a frozen-evaluation-pool image in the train split | `snapshots/job-329/manifest.json` in R2, 17 images each carrying their labels and a `split`; every entry reads `eval`, because every image an admin has verified so far was drawn by the sampler with `selection_reason=random` — v2 has no other selector yet, so there is nothing to mistake for a train set |

One rollout wrinkle worth recording rather than hiding: the first attempt at this run
(job 328) was queued through the admin UI before the box had pulled the image M15
shipped, and the worker still running the previous binary retired it immediately with
`"this worker does not know how to run a \"snapshot\" job"` — a new job kind is only
safe to queue once every worker polling the queue understands it, and a job queued too
early fails loud and terminal rather than waiting. Once `crowdmon-update.service` pulled
the new image, the retry (job 329) ran clean.

## Observability

A span leaves the Worker on every request, crosses the public internet to a Cloudflare
POP, and comes back down a cloudflared tunnel to a collector on the home box that binds
no public port.

```
Worker ──► otlp.mkcarl.com ──► Cloudflare Access ──► cloudflared ──► otel-collector:4318
   │            (public)          (service token)      (outbound)          │
   └── CF-Access-Client-Id/Secret from wrangler secrets                    ▼
                                                        Tempo ─► metrics-generator ─► Prometheus ─► Grafana
```

**OTLP over HTTP, not gRPC.** This is the single most expensive thing to discover late.
The Workers runtime provides `fetch` and no raw sockets, so `@opentelemetry/exporter-trace-otlp-grpc`
cannot run there at all — the collector's 4317 receiver is unreachable from the edge no
matter how it is configured. Everything downstream follows from that: the tunnel fronts
4318, and `@opentelemetry/sdk-node` is equally unusable, which is why
`@microlabs/otel-cf-workers` does the bootstrapping.

**The endpoint is not this project's to manage.** The monitoring stack is a separate
project with its own repository. This one consumes a hostname and owns nothing else —
see [`CONTEXT.md`](CONTEXT.md) §6 for the reasoning and the runbook that gated it.

**Spans are named after routing, not before.** The instrumentation opens its span before
Hono has looked at the URL. Left alone, every request would share one span name with the
raw path as the only discriminator — unbounded cardinality as soon as a route takes a
path parameter, and useless RED metrics. `src/middleware/trace-route.ts` renames the span
to `GET /health` once the match is known. Unmatched requests deliberately record no
`http.route`, because Hono's `/*` non-match sentinel is not a real route template.

**A missing service token looks exactly like working software.** The Worker keeps serving
traffic and every export is rejected at the edge with a 403. Spans are dropped on failure
by design — no buffer, no replay — so the only way to notice is that Tempo is empty.

Verified end to end on 2026-08-02: `GET /health` appears in Tempo as a `SPAN_KIND_SERVER`
span carrying `http.route=/health`, and `traces_spanmetrics_calls_total{service="crowdmon-api",
span_name="GET /health"}` appears in Prometheus via Tempo's metrics-generator.

## Layout

```
apps/api/     Cloudflare Worker — Hono API, OpenAPI contract, D1 job queue, OTel
apps/web/     React SPA — admin dashboard, built by Vite and served by the API Worker's [assets] (M5.1)
worker/       Go module — the home-side worker: config, telemetry, poll loop, queue client, and the download/extract/dedup/upload pipeline
deploy/       How the worker gets onto the home box: compose project and a systemd user timer. See deploy/homebox/README.md
infra/        Terraform — D1, R2, the Worker's custom domain and the Access app. See infra/README.md
```

Inside `apps/api/src`, `app.ts` holds the routes and `index.ts` is the instrumented entry
point. They are separate because `instrument()` imports `cloudflare:workers`, which only
workerd can resolve — tests import `app.ts` rather than shimming the module loader.

Tests are split by what they need. `test/workers` runs inside workerd against a real D1,
because the queue's guarantees are SQL ones a fake would not reproduce. `test/node` holds
the two that cannot: the spec drift check reads the committed file with `node:fs`, and
@opentelemetry/api's ESM build does not resolve under workerd's module loader.

## The contract

`apps/api/src/schemas.ts` is the single definition of what goes over the wire. The zod
schemas there validate every request at the edge, and the same schemas generate
`apps/api/openapi.json`, from which oapi-codegen generates `worker/internal/api`. One
definition, so the two runtimes cannot disagree — hand-written types on both sides is
what produced the `storage_url` / `url` mismatch in the old code.

Both generated artefacts are committed, not built on demand. That way a contract change
is a reviewable diff in the PR that causes it, and each side can be regenerated without
the other's toolchain.

```sh
pnpm --filter @crowdmon/api run openapi   # after any route or schema change
cd worker && go generate ./...            # then this, from the new spec
```

Forgetting either is not a silent failure. A vitest case compares the committed spec
against what the routes declare; CI re-runs `go generate` and fails on any diff, and
the Go path filter includes `openapi.json` so a contract-only change still triggers it.
The deployed Worker serves the same document at `/openapi.json`.

The generator version is pinned in the `go:generate` directive rather than added to
`go.mod`. `go run pkg@version` builds in its own module, so a code-generation tool never
becomes a dependency of the binary that ships to the home box.

## The queue

Cloudflare Queues needs the Workers Paid plan, so the queue is a `jobs` table in D1 and
the endpoints in `apps/api/src/routes/jobs.ts` are the whole of it.

Claiming is one `UPDATE ... WHERE status='pending' ... RETURNING`. SQLite serialises
writers, so two workers polling at once cannot take the same row; a `SELECT` followed by
an `UPDATE` would hand the same job out twice under exactly the polling pattern the
worker is built around. `attempts` increments on the claim rather than on a later
failure, so a worker that dies without reporting still counts against the ceiling M6.1
enforces.

Heartbeat and complete carry their ownership check in the `WHERE` clause —
`id = ? AND status = 'claimed' AND claimed_by = ?` — rather than reading the row first.
A read-then-write would let the reaper take the job back in between, and the worker
would go on writing to a lease it no longer holds. Both answer 404 when nothing changed,
without distinguishing "no such job" from "not yours any more": the worker's response is
to stop, either way.

Claiming a job whose video or chunk row is missing retires it as `failed` and answers
204. A chunk job with no `chunks` row would be corruption; the fan-out below is what
guarantees it cannot be produced, and re-queueing such a job would hand the same broken
row out on every subsequent poll.

## Phase one: download and fan-out

A video is two phases (CONTEXT.md §Q13). The download job fetches the source with
yt-dlp, measures the file with ffprobe, and posts what it found to
`POST /api/jobs/{id}/fanout`, which enqueues one chunk job per 60s segment. The last
segment stops at the duration rather than running past the end of the file, and the
duration is rounded *up* from ffprobe's float — rounding down would leave the tail of
the video in no chunk at all.

**The enqueue is the API's, not the worker's, because it has to be one transaction.**
Each segment is a `jobs` insert and a `chunks` insert guarded by the same
`NOT EXISTS (video_id, segment_index)`, run in one D1 `batch()`. Two consequences worth
keeping in view:

- **The guards must match.** `last_insert_rowid()` returns the *previous* insert's id
  when a statement inserted nothing, so a chunk insert that ran while its job insert was
  skipped would attach itself to another segment's job.
- **Segments are statements, so video length has a ceiling.** Six hours, enforced by the
  request schema, which is where the answer is a 400 naming the limit rather than a
  batch that fails halfway through.

Re-running is free. A download reaped anywhere in phase one — before the fan-out, or
after it but before the job was reported — comes back, finds its video already on disk,
and re-fans-out to `created: 0`. The response separates `segments` (what the video has)
from `created` (what this call inserted), so that is visible rather than inferred. The
per-segment guards make a genuinely partial fan-out survivable too, though the single
batch means production should never produce one; the test that seeds one exists because
"should never" is not a mechanism.

One thing the guards deliberately do *not* do: re-tile a video whose duration came back
different. Segments are keyed on `(video_id, segment_index)` alone, so existing rows keep
their boundaries. The source file is reused rather than re-fetched, so a second probe
measures the same file and cannot disagree — the case only arises if somebody deletes the
file between attempts, and the honest repair for that is to delete the video's rows.

**Chunk jobs read the file from local disk, so they must run on the box that downloaded
it.** That is free with one worker and not free with two. A chunk job checks the source
is present before doing anything else, and fails terminally if it is missing, naming
the constraint — the check is cheap and everything after it is not. Half a
chunk's frames are worse than none, because the rows they produce look like a complete
segment. The check happens after the claim, not before it: a worker cannot inspect a job
it has not been given, and the claim endpoint has no idea which box holds which file. The
cost is one spent attempt per misplaced chunk, paid only in a two-worker world that does
not exist yet. Source videos live in `CROWDMON_WORK_DIR` behind a named volume, and are
pruned past `CROWDMON_SOURCE_TTL` (6h) at the start of each download: the thing that
fills the disk pays for the cleanup.

**Failures are sorted into terminal and retryable, and the default is retryable.**
`complete` with a cause retires a row on the first report, so only failures a retry
cannot fix are reported: deleted, private, geo-blocked, members-only and age-gated
videos, a fan-out the contract refuses, a chunk whose source is elsewhere. Everything
else — a timeout, a 500, a dropped fragment — is left `claimed` for the reaper, which
costs a lease window and the attempt already spent on the claim. A wrongly retryable
failure costs seven minutes; a wrongly terminal one burns a video permanently. One
pattern is deliberately kept off the terminal list: `Sign in to confirm you're not a
bot` reads exactly like the age gate and is about the box's address, not the video.

## Phase two: extraction, dedup and upload

A chunk job is ffmpeg at 1fps over its 60s window, a perceptual hash of every frame,
and an upload of the survivors. 5,812 frames in, 2,685 kept, on the acceptance run.

**Dedup compares against the last *kept* frame, not the previous one.** A slow camera
pan changes the picture only slightly frame to frame, so an adjacent-pair comparison
would fall under the threshold every time and drop nothing after the first frame. The
same pan drifts arbitrarily far from where the last kept frame left off, which is what
makes it a new frame worth having. The threshold is a Hamming distance of 10 of 64
bits: gameplay holds a near-static HUD over a moving scene, so distances cluster low.

Hashing runs concurrently, bounded to `NumCPU`, and writes into a preallocated slice at
each frame's own index — so the sequential keep/drop walk stays in timestamp order
without the goroutines agreeing on anything. A frame that cannot be hashed fails the
whole chunk naming the file, rather than being skipped: "dropped as a duplicate" and
"could not be read" must not look the same downstream.

**Keys are deterministic — `frames/{video_id}/{timestamp}.jpg`** — so a re-run
overwrites rather than duplicating. Proven in production, not just in test: a chunk was
forced back to `pending` in D1 and re-run against the real bucket; `images` held at
exactly 674 rows and `attempts` went to 2, so the re-run genuinely happened. That
claim covers a re-run under the *same* settings, which is what the reaper produces. A
re-run whose dedup keeps a different set of timestamps is a different question, and
leaves orphaned rows and objects behind.

**The threshold in force is stamped onto every row it produced.** Changing it later
does not re-deduplicate old videos, so without the stamp the dataset silently becomes
an unrecorded mixture of regimes — and the mAP chart v2 is built to produce gains a
confounder nobody can name. `CONTEXT.md` §7 treats thresholds as dataset provenance,
not settings, for that reason.

## Recovery from a crash

A worker that dies says nothing. There is no signal to catch and no connection to drop —
the row simply stops being renewed — which is why recovery runs on a schedule rather than
in response to anything.

Every five minutes a Cron Trigger runs `apps/api/src/reaper.ts`. Any job still `claimed`
whose `heartbeat_at` is older than `LEASE_STALE_SECONDS` (120s, four missed heartbeats)
is taken back: below `MAX_ATTEMPTS` (3) it returns to `pending` with its holder cleared,
and at or above it becomes terminally `failed` with a reason saying so. Without that
ceiling a poison job — deleted video, geo-blocked, malformed — is claimed, kills the
worker, is reaped, and comes back forever.

Worst-case pickup after a crash is `LEASE_STALE_SECONDS` plus up to one cron period, so
about seven minutes. That is deliberate: the cron period is a request-budget decision
(CONTEXT.md §Q20 budgets 288 reaper runs a day), and the staleness threshold is set
against the worker's 30s heartbeat rather than against the cron. Tightening the threshold
would not speed up detection much and would start reaping workers that merely hit a
transient API error, which `runner.go` deliberately keeps beating through.

Three details are easy to get wrong and are pinned by tests:

- **`attempts` counts claims, not reaps.** The reaper never increments it. If it did,
  one crash would spend two attempts and the ceiling would mean half what it says.
- **A graceful shutdown is not a failure, and neither is a timeout.** Reporting either
  through `complete` would write `status='failed'` — which is terminal, so an ordinary
  restart would permanently kill whatever was in flight. The worker reports only
  outcomes: a job that finished, and a job that can never finish (M7.1). Everything else
  is left `claimed` for the reaper to hand back.
- **The schedule is Terraform's, the handler is wrangler's.** `infra/reaper.tf` owns the
  cron because it outlives a deploy. That is only safe while `[triggers]` is absent from
  `wrangler.toml`: wrangler skips the schedules API entirely when the table is missing,
  but an *empty* `crons = []` is truthy in its check and would silently delete the
  schedule. `test/node/wrangler-config.test.ts` asserts the table stays absent.

Re-queued and retired jobs each emit a span — `job.reclaimed` and `job.retired`, one per
job, parented to the tick that produced them. Two names rather than one with an attribute
because Tempo's metrics-generator keys on span name, so this is what makes reclaim rate a
Grafana panel at all. The tick's own span carries the totals, so a healthy tick with no
children still says it ran.

**Verified against production on 2026-08-04.** A worker was killed 28s into a held lease;
the job returned to `pending` 2m31s later with `attempts` unchanged at 1. Two more cycles
spent attempts 2 and 3, and the third retired it as `failed`. Both span names reached
Tempo and both appear in Prometheus as `traces_spanmetrics_calls_total{span_name=...}`.

**Repeating it by hand.** Submit a video and kill the worker while the download is
running — since M7 that is a real job with a real middle, so `CROWDMON_SIMULATED_WORK`
is gone. Two things will waste your afternoon if you skip them:

- **Wait for the claim before killing.** The poll backoff reaches 120s when idle, so a
  job submitted a minute before the kill will not have been claimed — and a kill with no
  lease held leaves nothing for the reaper to find. Watch for `claimed a job` in the
  container log.
- **`docker kill` leaves it stopped.** Docker suppresses `unless-stopped` for anything
  halted by hand, so the worker will not come back and the next job will sit `pending`
  forever, which looks exactly like a broken reaper.

Then expect: the row sits `claimed` with its heartbeat age climbing, returns to `pending`
within about seven minutes with `attempts` one higher, and past `MAX_ATTEMPTS` lands on
`failed` and stops being handed out.

## The worker

`worker/` is a Go binary that polls the queue and runs jobs. `worker.Pipeline` is both
phases: a download job fetches, probes and fans out; a chunk job checks its source is on
this box, then extracts, hashes, dedupes, uploads and reports the rows.

Polling is 30s idle, doubling to a 120s cap on repeated empty polls, immediate re-poll
after finding work — CONTEXT.md §Q20. That is ~1,000 requests a day against a
100,000/day free tier, where a 5s interval would burn 17,280 returning nothing, and up
to two minutes of pickup latency is invisible against a 10–20 minute job.

While a job is held, a goroutine renews the lease every 30s. A 404 from the heartbeat
means the reaper took the job back: the work's context is cancelled and nothing is
reported, because the row is already `pending` again and may be running elsewhere. A
500 means the API is briefly unwell and is deliberately *not* treated the same way —
giving up there would abandon a job the worker still holds, and the reaper would then
wait out the whole lease window before anyone picked it up.

`internal/queue` wraps the client oapi-codegen generates from the same spec the Worker
serves, so a renamed field breaks the Go build rather than a production request. What it
adds is the part a generator cannot know: which status code means what.

The binary ships as a container carrying ffmpeg and yt-dlp, built and pushed to GHCR on
every merge that touches `worker/`. The home box pulls it on a timer and builds nothing.
See `deploy/homebox/README.md`.

## Admin access

`/api/admin/*` is gated twice, and the second gate is not decoration.

Cloudflare Access sits in front of `crowdmon.mkcarl.com/api/admin` — path-scoped,
because the Go worker polls `/api/jobs/*` constantly with no Access identity and
covering the whole hostname would break the queue rather than secure it. The
application and its policy are in `infra/access.tf`.

`crowdmon.mkcarl.com` is a single hostname serving both the SPA and the API (M5.1).
It replaced `api.crowdmon.mkcarl.com` on 2026-08-03, which was retired once the Go
worker had been repointed off it. A second hostname would have split the SPA and the
admin API across origins, and — because an Access application binds to host *and*
path — would have republished `/api/admin` with the outer gate missing. See
`infra/README.md` "Migrating to a single hostname (M5)" for the sequencing and for the
two things that runbook predicted wrongly, and `CONTEXT.md` §Q6 and §3.

Behind it, `src/middleware/access.ts` verifies the `Cf-Access-Jwt-Assertion` header
itself against the team's JWKS, then checks the identity against its own allowlist.
Reaching the Worker still does not imply passing Access. Access binds to a route on a
zone, so any hostname the Worker is served on that the application does not cover
arrives here with no assertion attached — and re-enabling one is a single line of
config that would not look like a security decision at the time. The two gates also
fail independently: the policy is Terraform, the allowlist is a Worker secret.

The `aud` check is the load-bearing one. Every application in an Access organisation is
signed by the same keys, so a token minted for `otlp.mkcarl.com` verifies perfectly well
unless the audience is pinned to this application.

A deployment missing `ACCESS_AUD` or `ADMIN_EMAILS` answers 503 on admin routes. Failing
closed is the only safe direction: a deploy that forgets a variable must not be a deploy
that publishes the admin API. That is not hypothetical — it is what M3.5 shipped on its
first deploy, when both vars were appended below a table header in `wrangler.toml` and
TOML quietly filed them under the R2 binding. The outage was the correct failure.

Verified in production on 2026-08-02: on the custom domain an unauthenticated
`POST /api/admin/videos` is answered by Cloudflare Access with a 302 to
`mkcarl.cloudflareaccess.com`, never reaching the Worker. On the workers.dev hostname —
which still existed that morning — the same request got `401 missing Access assertion`,
and one carrying a junk token got `401 invalid Access assertion`, repeated five and
three times respectively, since a single sample cannot tell a working gate from a
rollout still serving two versions. `/health`, `/openapi.json` and
`POST /api/jobs/claim` answered normally on both hostnames throughout.

**That second hostname is now closed.** `workers_dev = false` in `wrangler.toml`, since
M4.3 pointed the Go worker at the custom domain and nothing else needed it. Access
cannot cover a `*.workers.dev` name, so while it was up, `/api/admin/*` had the Worker's
JWT check and nothing else in front of it — one layer where the design calls for two.
The setting defaults to *on*, so `test/node/wrangler-config.test.ts` asserts it stays
off; deleting the line would otherwise reopen the hostname silently. The deploy
workflow's `API_BASE_URL` variable was repointed at the custom domain in the same
change, because it is what the post-deploy health check reads.

## Working on it

Requires Node 22, pnpm 10 and Go 1.25 — the module declares 1.25 since the OTel SDK
raised it, and oapi-codegen needs it too. Nothing needs cloud credentials.

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test    # TypeScript
cd worker && go vet ./... && go test ./...  # Go
```

CI runs exactly these, split into two path-filtered jobs so a Go change does not
rebuild the SPA.

Running the SPA against a real API locally is two processes: `wrangler dev` in
`apps/api` for the Worker (port 8787), and `vite` in `apps/web` for the SPA with hot
reload. `apps/web/vite.config.ts` proxies `/api`, `/health` and `/openapi.json` to
`localhost:8787`, so the dev-time contract is the deployed one — including Access's
fail-closed paths — rather than a mocked API.

```sh
pnpm --filter @crowdmon/api run dev    # wrangler dev, :8787
pnpm --filter @crowdmon/web run dev    # vite, proxies /api to :8787
```

Deploying is done by CI on merge to main, using `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` on the `production` environment, plus an `API_BASE_URL`
environment *variable* for the post-deploy health check. That one has to be a variable
rather than a secret — the workflow reads it from the `vars` context, which cannot see
secrets, and the check would silently skip.

The Access service token is not a CI concern. It lives in wrangler secrets, set once
against the Worker:

```sh
pnpm --filter @crowdmon/api exec wrangler secret put CF_ACCESS_CLIENT_ID
pnpm --filter @crowdmon/api exec wrangler secret put CF_ACCESS_CLIENT_SECRET
```

## Milestones

Each is independently shippable and a valid stopping point. The project is open-ended by
choice, so no milestone depends on finishing the next one to be worth having. All nine
are complete.

| | Milestone | Done when |
|---|---|---|
| [M1](https://github.com/mkcarlclaude/crowdmon-revamp/issues/2) | Foundations | `terraform apply` provisions D1 and R2 from an empty account, and a hello-world Worker is live via CI |
| [M2](https://github.com/mkcarlclaude/crowdmon-revamp/issues/3) | Observability spine | A span emitted by the hello-world Worker is visible in Tempo |
| [M3](https://github.com/mkcarlclaude/crowdmon-revamp/issues/4) | Contract and queue | curl submits a URL, a job row appears, and curl can claim it |
| [M4](https://github.com/mkcarlclaude/crowdmon-revamp/issues/5) | Worker skeleton | Submitting a URL results in the home worker claiming and completing it |
| [M5](https://github.com/mkcarlclaude/crowdmon-revamp/issues/6) | Admin dashboard | A URL can be submitted from the browser and job status updates live |
| [M6](https://github.com/mkcarlclaude/crowdmon-revamp/issues/7) | Failure semantics | Killing the worker mid-job produces a visible reap and retry |
| [M7](https://github.com/mkcarlclaude/crowdmon-revamp/issues/8) | Download and fan-out | Submitting a URL produces chunk rows covering the whole video |
| [M8](https://github.com/mkcarlclaude/crowdmon-revamp/issues/9) | Chunk extraction | Images are in R2 and rows are in D1, visibly deduplicated |
| [M9](https://github.com/mkcarlclaude/crowdmon-revamp/issues/10) | Close v1 | All eight success criteria in `PRD.md` §5 verified against a real run |

Observability is milestone 2, before there is anything complex to instrument — deferring
instrumentation until it never lands is a named risk.

## Constraints

- **Free tier only.** Any decision requiring a paid plan is out of scope by definition.
- **Cloud survives home downtime.** Home is never a synchronous dependency.
- **Idle polling stays inside the 100,000/day Workers free tier.** Adaptive backoff,
  ~1,000 requests/day idle.
- **Every `/api/admin/*` endpoint independently verifies the caller.** The admin bundle
  is assumed public.

## History

Crowdmon (2023) was a crowdsourced annotation platform for building a labelled image
dataset of Genshin Impact characters. It reached a working vertical slice and stalled:
three loosely-coupled repos, no tests, no CI, no IaC, and an ingestion orchestrator that
never existed in code.

The original premise is now obsolete — open-vocabulary detectors can box a named
character from a text prompt with no training, so "humans must draw every box" no longer
holds. The modern framing that makes the ML side defensible: zero-shot bootstraps the
labels, humans verify and handle the long tail, and the shipped artifact is a distilled
real-time model the foundation model cannot be.

## License

Code is [MIT](LICENSE) licensed.

The licence covers this repository's source only. It grants no rights over Genshin
Impact assets or any third-party video content. No extracted frames are stored here —
images live in R2 — and republishing frames at scale is deliberately out of scope.
