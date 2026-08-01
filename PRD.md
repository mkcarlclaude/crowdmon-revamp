# Crowdmon 2026 — Product Requirements (v1)

**Status:** approved scope, not started
**Last updated:** 2026-08-01
**Design record:** [`CONTEXT.md`](CONTEXT.md) — 26 locked decisions, rejected options, rationale
**Delivery plan:** [`ROADMAP.md`](ROADMAP.md) — milestones and issues

---

## 1. Problem

Crowdmon (2023) was a crowdsourced annotation platform for building a labelled image
dataset of Genshin Impact characters, feeding a browser-deployable detector. It reached
a working vertical slice and then stalled: three loosely-coupled repos, no tests, no CI,
no IaC, and an ingestion orchestrator that never existed in code.

Two things changed since.

**The premise is obsolete.** Open-vocabulary detectors can box a named character from a
text prompt with no training. "Humans must draw every box because no model knows what
Paimon is" no longer holds.

**The author's skills moved.** The interesting problem is no longer the annotation UI —
it is running the whole thing cheaply, healthily and observably.

## 2. Goal

Rebuild as a **self-improving detector platform, operated as a live demonstration of
cheap, healthy, observable infrastructure.**

Infrastructure is the deliverable. The ML flywheel is the workload that generates real
signal worth observing. The résumé line is infra, not ML.

The modern framing that makes the ML side defensible: zero-shot bootstraps the labels,
humans verify and handle the long tail, and the shipped artifact is a distilled
real-time model the foundation model cannot be.

## 3. Constraints

| Constraint | Consequence |
|---|---|
| **Free tier only** | No Cloudflare Queues, no Workers Paid plan. Queue is a D1 table. |
| **Cloud survives home downtime** | Pull topology. Home is never a synchronous dependency. |
| **YouTube blocks datacenter IPs** | Extraction must run from the home connection. |
| **No GPU worth training on at home** | Training is manual and batch on Kaggle. Auto-retrain is ruled out by physics, not preference. |
| **Open-ended timeline, burnout is real** | Every milestone must be independently shippable and a valid stopping point. |

## 4. v1 scope

### Done-claim

> A YouTube URL goes in, extraction is visibly running, OTel has data, and images land in R2.

Falsifiable. Everything in v1 serves this sentence; everything that does not is v2.

### In scope

- Monorepo, Terraform-managed Cloudflare account, CI deploying both toolchains
- D1 job queue with heartbeat leases, cron reaper, terminal failure state
- Go extraction worker: containerised, pull-based, running at home
- yt-dlp download, two-phase fan-out, ffmpeg extraction at 1fps
- Perceptual-hash deduplication before upload
- Images in R2, metadata in D1
- OpenTelemetry across Workers and the Go worker, end-to-end trace propagation
- Grafana dashboards for queue depth, dedup ratio, job duration, reclaim rate
- Minimal admin dashboard: submit a URL, watch job and chunk status

### Explicitly out of scope for v1

Annotation UI · Google OAuth and user sessions · user-facing dashboards · landing page ·
public demo page · Grounding DINO bootstrap · YOLO training · model registry · dataset
snapshots · active-learning selection · leaderboards.

These are designed in `CONTEXT.md` §5 and §7 and deliberately deferred.

### Consequence: Grafana is the UI

With no user-facing frontend in v1, "visibly running" can only mean traces, dashboards,
D1 rows and R2 objects. The observability work is therefore load-bearing rather than
decorative — which is the correct outcome given the goal in §2, and prevents the common
failure of deferring instrumentation until it never lands.

## 5. Success criteria

v1 is done when all of the following are true:

1. `terraform apply` reconstructs the Cloudflare account from nothing.
2. CI deploys the Worker and publishes the Go worker image on merge to main.
3. Submitting a YouTube URL through the admin dashboard creates a job.
4. The home worker claims it, downloads, fans out, extracts, dedupes and uploads.
5. Images are in R2 and rows are in D1, deduplicated.
6. A single trace spans submit → claim → download → fan-out → chunk completion.
7. Grafana shows queue depth, dedup ratio, job duration and reclaim rate.
8. Killing the worker mid-job results in a visible reap and retry.

## 6. Non-functional requirements

- **Cost:** zero. Any decision that requires a paid plan is out of scope by definition.
- **Availability:** the Cloudflare control plane stays up independent of the home
  machine. Jobs queue harmlessly while home is offline.
- **Request budget:** idle polling must stay well inside the 100,000/day Workers free
  tier. Adaptive backoff, ~1,000/day idle.
- **Security:** every `/api/admin/*` endpoint independently verifies the caller. The
  admin bundle is assumed public. No standing credentials in ephemeral environments.
- **Reproducibility:** account resources in Terraform, runtime in a pinned container,
  API contract generated from a single spec.

## 7. Known risks

| Risk | Mitigation |
|---|---|
| **yt-dlp breaks when YouTube changes** — roughly weekly cadence | Update on container start or rebuild on schedule. Health check must distinguish "no jobs queued" from "every job failing at download". |
| **Scope is large; project stalls like 2023** | Nine milestones, each independently shippable and a valid stopping point. v1 explicitly excludes the entire ML side. |
| **Instrumentation deferred until it never lands** | Observability is milestone 2, before there is anything complex to instrument. |
| **Home machine is a single point of failure** | Accepted. Cloud survives; jobs queue. Error page rather than cached fallback is a deliberate choice. |
| **Nothing tells you the collector died** | Open item — needs an external deadman ping. |
| **Extraction pipeline has no prior art** | The 2023 repos contain no orchestrator at all. Milestones 7 and 8 are the highest-uncertainty work and are sequenced last for that reason. |

## 8. Out-of-band items

Tracked in `CONTEXT.md` §9 but worth surfacing here because they are pre-existing and
unrelated to v1 delivery:

- Grafana auth hardening — org allowlist not yet configured as defence in depth.
- The monitoring stack compose is not version-controlled.
