# Crowdmon 2026

A self-improving object-detector platform, operated as a live demonstration of cheap,
healthy, observable infrastructure.

**Infrastructure is the deliverable.** The ML flywheel — bootstrap labels with a
zero-shot model, have humans verify the long tail, distil a real-time detector that runs
in the browser — is the workload that generates signal worth observing.

> **Status: M1 and M2 complete.** D1 and R2 are provisioned by Terraform, the Worker is
> deployed by CI at `crowdmon-api.mkcarl-dev.workers.dev`, and its spans are landing in
> Tempo through a gated OTLP endpoint. M3 — the D1 schema and the typed job contract —
> is next.

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
apps/api/     Cloudflare Worker — Hono API, OpenAPI contract, OTel. Job handlers land in M3.4
apps/web/     React SPA on Pages — admin dashboard. Empty until M5.1
worker/       Go module — config loader. Poll loop and extraction land in M4/M7/M8
infra/        Terraform — D1 and R2, applied. See infra/README.md
```

Inside `apps/api/src`, `app.ts` holds the routes and `index.ts` is the instrumented entry
point. They are separate because `instrument()` imports `cloudflare:workers`, which only
workerd can resolve — tests import `app.ts` and run on plain Node rather than shimming
the module loader.

## The contract

`apps/api/src/schemas.ts` is the single definition of what goes over the wire. The zod
schemas there validate every request at the edge, and the same schemas generate
`apps/api/openapi.json`, from which M3.3 generates the Go worker's types. One
definition, so the two runtimes cannot disagree — hand-written types on both sides is
what produced the `storage_url` / `url` mismatch in the old code.

The spec is committed, not built on demand. That way a contract change is a reviewable
diff in the PR that causes it, and Go generation needs no Node toolchain.

```sh
pnpm --filter @crowdmon/api run openapi   # after any route or schema change
```

Forgetting that is not a silent failure: a test compares the committed file against
what the routes currently declare, and CI fails on the difference. The deployed Worker
serves the same document at `/openapi.json`.

The job endpoints are defined but their handlers return 501 until M3.4. The 501s are in
the spec deliberately — it describes what the Worker does, not what it will do.

## Working on it

Requires Node 22, pnpm 10 and Go 1.24. Nothing needs cloud credentials.

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
