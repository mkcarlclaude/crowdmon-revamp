# Crowdmon 2026

A self-improving object-detector platform, operated as a live demonstration of cheap,
healthy, observable infrastructure.

**Infrastructure is the deliverable.** The ML flywheel — bootstrap labels with a
zero-shot model, have humans verify the long tail, distil a real-time detector that runs
in the browser — is the workload that generates signal worth observing.

> **Status: M1, M2 and M3 complete.** D1 and R2 are provisioned by Terraform, the Worker
> is deployed by CI at `crowdmon-api.mkcarl-dev.workers.dev`, and its spans are landing
> in Tempo through a gated OTLP endpoint. A URL can be submitted, a job claimed,
> heartbeated and completed over a contract both runtimes generate from, with Cloudflare
> Access in front of the admin endpoints. M4 is the Go worker that drives the queue for
> real.

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
              │  yt-dlp ─► ffmpeg ─► pHash    ┌──────────────────────┐
              │                               │ Workers + Hono API   │
              ├── long-poll claim ────────────┤ D1  (queue+metadata) │
              ├── heartbeat ──────────────────┤ R2  (frames)         │
              └── upload + complete ──────────┤ Pages (React admin)  │
                                              └──────────────────────┘
              └── OTLP/HTTP ─► collector ─► Tempo / Prometheus / Grafana
                               (via cloudflared tunnel, gated by Access)
```

| Concern | Choice | Why |
|---|---|---|
| Frame extraction | Home Ubuntu box | A household IP dodges YouTube's datacenter block |
| Web runtime | Workers + Hono, React SPA on Pages | Free tier, edge, survives home downtime |
| Metadata + queue | D1 | Free tier rules out Cloudflare Queues; the queue is a table with heartbeat leases |
| Object storage | R2 | Free tier, no egress fees |
| API contract | `@hono/zod-openapi` → OpenAPI → oapi-codegen | Two runtimes must agree; hand-written types on both sides is what broke the 2023 code |
| Infrastructure | Terraform (account resources), wrangler (code + secrets) | The account must be reconstructible from nothing |
| Observability | OpenTelemetry → self-hosted Tempo/Prometheus/Grafana | With no user-facing frontend in v1, Grafana *is* the UI |
| Training | Manual, batch, on Kaggle | No GPU worth training on at home — auto-retrain is ruled out by physics, not preference |

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
apps/web/     React SPA on Pages — admin dashboard. Empty until M5.1
worker/       Go module — config loader, generated API types. Poll loop and extraction land in M4/M7/M8
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
204. Fan-out is not transactional, so a chunk job with no `chunks` row is reachable in
production; re-queueing it would hand the same broken job out on every subsequent poll.

## Admin access

`/api/admin/*` is gated twice, and the second gate is not decoration.

Cloudflare Access sits in front of `api.crowdmon.mkcarl.com/api/admin` — path-scoped,
because the Go worker polls `/api/jobs/*` constantly with no Access identity and
covering the whole hostname would break the queue rather than secure it. The
application and its policy are in `infra/access.tf`.

Behind it, `src/middleware/access.ts` verifies the `Cf-Access-Jwt-Assertion` header
itself against the team's JWKS, then checks the identity against its own allowlist.
Reaching the Worker does not imply passing Access: the same code is served on
`crowdmon-api.mkcarl-dev.workers.dev`, where no Access application exists and never
will. Without the Worker's own check, knowing that hostname would be enough.

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
`mkcarl.cloudflareaccess.com`, never reaching the Worker. On the workers.dev hostname,
where no Access application exists, the same request gets `401 missing Access assertion`
and a request carrying a junk token gets `401 invalid Access assertion` — repeated five
and three times respectively, since a single sample cannot distinguish a working gate
from a rollout still serving two versions. `/health`, `/openapi.json` and
`POST /api/jobs/claim` answer normally on both hostnames throughout.

**One hostname is still ungated at the edge.** Access covers
`api.crowdmon.mkcarl.com/api/admin`; `crowdmon-api.mkcarl-dev.workers.dev` has no Access
application in front of it and the Worker's own verification is the only thing standing
there. Setting `workers_dev = false` would close it, at the cost of repointing the
deploy workflow's `API_BASE_URL` health check at the custom domain.

## Working on it

Requires Node 22, pnpm 10 and Go 1.25. The module itself declares 1.24 and compiles
under it; 1.25 is what oapi-codegen needs to run. Nothing needs cloud credentials.

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test    # TypeScript
cd worker && go vet ./... && go test ./...  # Go
```

CI runs exactly these, split into two path-filtered jobs so a Go change does not
rebuild the SPA.

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
choice, so no milestone depends on finishing the next one to be worth having.

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
