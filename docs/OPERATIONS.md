# Operations

How the system actually runs: the contract between the Worker and the box, what each job
kind does, what happens when something dies, and how to watch any of it.

Split out of `README.md` on 2026-08-28. Everything here was written as that file grew
alongside the system, and none of it is a summary — the reproduction steps, the
production verifications and the traps are the only copy. What stayed behind in the
README is what somebody needs before they decide to care; this is what they need once
they do.

Design *decisions* live in [`CONTEXT.md`](../CONTEXT.md); delivery state lives in
[`ROADMAP.md`](../ROADMAP.md); the facts an agent needs to drive the box are in
[`CLAUDE.md`](../CLAUDE.md).

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
see [`CONTEXT.md`](../CONTEXT.md) §6 for the reasoning and the runbook that gated it.

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
