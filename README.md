# Crowdmon 2026

A self-improving object-detector platform, operated as a live demonstration of cheap,
healthy, observable infrastructure.

**Infrastructure is the deliverable.** The ML flywheel — bootstrap labels with a
zero-shot model, have humans verify the long tail, distil a real-time detector that runs
in the browser — is the workload that generates signal worth observing.

**Status:** v1–v4 have shipped. v1's eight success criteria and v2's one-sentence
done-claim are the two things written to be falsifiable, and both were verified against
production — the tables are [below](#acceptance-run-2026-08-08). v3 made `/admin` a real
dashboard; v4 made the rest of the site a product. Neither has a done-claim of its own.

**Now: v5, training** — the half of the flywheel that has never run. The platform
produces labelled data and nothing yet consumes it.

## Documents

| Document | What it is |
|---|---|
| [`PRD.md`](PRD.md) | Scope, the done-claims, falsifiable success criteria, known risks |
| [`CONTEXT.md`](CONTEXT.md) | Design record — every locked decision, the options rejected, and why |
| [`ROADMAP.md`](ROADMAP.md) | What shipped, milestone by milestone, including what broke |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | How it runs: the contract, the queue, each job kind, crash recovery, observability, admin access |
| [`CLAUDE.md`](CLAUDE.md) | Working notes for agents — the operational facts not derivable from the code |
| [`docs/superpowers/plans/`](docs/superpowers/plans/) | One plan per milestone, written before the work |

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

**Note, added at v4 (M20–M22, plan §C4):** the *authoritative for an admin* row's
evidence — `label_count` is exactly 21 (19 + 2), so neither the anon verdicts nor a
single admin reject leaked in — describes the inclusion rule as it stood on
2026-08-10, when `source = 'admin'` was the whole rule. It is still an accurate
account of that run: no `users` table existed yet for a trusted contributor's verdict
to leak in from. The rule itself changed at M20 (`CONTEXT.md` §7's v4 amendment,
`PRD.md` §9's own note beside the falsification table) — a trusted user's verdict now
also becomes a label when no admin has ruled — so this evidence should be read as a
historical result under the rule then in force, not as a description of what
`label_count` would total against the same data today.

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
