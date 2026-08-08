# Crowdmon 2026 — Product Requirements

**Status:** v1 delivered 2026-08-08, all eight success criteria verified · v2 scope
approved (§9), not started
**Last updated:** 2026-08-08
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
| **No GPU worth training on at home** | Training is manual and batch. Auto-retrain is ruled out by physics, not preference. **Amended for v2:** training moves to the home box in v4/v5 rather than Kaggle — CPU-only and slow by choice, which is affordable because nothing waits on it. See §9. |
| **Open-ended timeline, burnout is real** | Every milestone must be independently shippable and a valid stopping point. |

## 4. v1 scope — delivered

### Done-claim

> A YouTube URL goes in, extraction is visibly running, OTel has data, and images land in R2.

Falsifiable. Everything in v1 serves this sentence; everything that does not is v2.

The v2 sentence, and the scope it cuts, is §9.

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

## 5. Success criteria — all met

Verified on 2026-08-08 against one real run: "Archon quest chapter 4 Act 2 (part 2)",
5,812s, 97 segments, submitted through the dashboard. The evidence for each criterion is
tabulated in [`README.md`](README.md#acceptance-run-2026-08-08), beside the claim it
proves rather than here.

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
| **Nothing tells you the collector died** | **Accepted, 2026-08-08.** A dead collector costs visibility, not data — the pipeline does not have it on its critical path. `queue_depth` is what distinguishes a dead collector from a healthy idle system, since it reports explicit zeros when drained and goes absent when nothing is exporting. See `CONTEXT.md` §9.5. |
| **Extraction pipeline has no prior art** | The 2023 repos contain no orchestrator at all. Milestones 7 and 8 are the highest-uncertainty work and are sequenced last for that reason. |

## 8. Out-of-band items

Tracked in `CONTEXT.md` §9 but worth surfacing here because they are pre-existing and
unrelated to v1 delivery:

- Grafana auth hardening — org allowlist not yet configured as defence in depth.
- The monitoring stack compose is not version-controlled.

---

## 9. v2 scope

**Status:** approved, not started. Tracked as
[issue #89](https://github.com/mkcarlclaude/crowdmon-revamp/issues/89). Design decisions
and their rejected alternatives are in `CONTEXT.md` §12.

### Problem

v1 ends with deduplicated frames in R2 and matching rows in D1, and nothing can be done
with them. There is no way to say what is in an image, no way to get labelled data out,
and therefore no reason to submit a second video — the pipeline produces an ever-growing
pile of unlabelled JPEGs.

2023 failed at this same point from the opposite direction: it had an annotation UI where
every box was drawn from scratch, so hour ten of labelling cost exactly what hour one
cost. Drawing does not scale to one person. What is missing is the step that makes
labelling cheap — a model proposing boxes and a human ruling on them.

### Done-claim

> A submitted video becomes pre-labelled frames with no human trigger, verified through
> this platform's own UI — public to anyone, authoritative for an admin — and exported as
> a dataset snapshot with a split manifest.

Falsifiable, and it is the whole of the completion test — v2 has no separate criteria
list. Each clause has an observation that kills it:

| Clause | Proven false by |
|---|---|
| *with no human trigger* | A submitted video whose frames are extracted but not pre-labelled until something is run by hand |
| *pre-labelled frames* | A video whose sample produces no predictions, or predictions from a prompt not recorded on the rows |
| *public to anyone* | The public page loading with no image, no verify action, or demanding a login |
| *authoritative for an admin* | An anonymous verdict appearing inside a snapshot |
| *dataset snapshot* | A snapshot that cannot be listed, or one whose inclusion policy is not recorded on it |
| *with a split manifest* | A manifest missing, or a frozen-evaluation-pool image appearing in the train split |

### In scope

- `prelabel` as a fourth job kind on the existing queue, enqueued behind extraction
- Zero-shot open-vocabulary detection on the home box, behind a one-method interface
- A bounded sample per video — default 200 frames, drawn randomly across the timeline
- Class list as a table of appearance prompts, five active, prompt stamped on its output
- Immutable prediction rows carrying box, class, confidence and prompt version
- Verify-only UI — accept, adjust, reject — mounted twice from one component
- Public unauthenticated verification over a hand-curated sample pool, rate limited
- Append-only verdicts tagged by source, anonymous ones recorded and never promoted
- Admin-only missing-object reports, so recall failures are recorded rather than invisible
- Dataset snapshots to R2 with a split manifest and a recorded inclusion policy
- `selection_reason` on images, so a frozen evaluation pool exists before it is needed

### Explicitly out of scope for v2

Training of any kind, on any machine · model registry · a distilled detector · in-browser
inference · public detector demo · Google OAuth, sessions, any annotator tier between
admin and anonymous · consensus resolution, agreement scoring, trust weighting ·
leaderboards · weighted 70/20/10 active-learning selection · a public statistics surface
· more than five active classes · any measurement of detector accuracy.

### Consequence: accuracy is not the deliverable

The platform is the product; the detector is an input to it. No criterion in v2 mentions
model quality, and none should — a bootstrap model that pre-labels badly produces more
work for the verification UI, which is the thing being built, not a failure of it.

This is also why the frozen evaluation pool ships as a flag with no weighting behind it.
It costs one column and one exclusion rule now, and it cannot be added later: every image
labelled before it exists was selected by a biased rule, so it can never be retro-declared
an unbiased sample.

### Consequence: checks are internal

v2 is verified by the operator, not by a stranger. A public statistics surface would have
closed that gap and was deliberately not taken — so the export half of the done-claim
rests on the repository's account of it, exactly as v1's did.

### Known risks

| Risk | Mitigation |
|---|---|
| **Verify-only cannot see a missed object** | Structural, not a bug: a frame with no pre-label never enters the pool, so false negatives are invisible and look identical to absence. Admin-only missing-object reports give them somewhere to go, and the report rate per class is the number that says whether a prompt works. |
| **A weak prompt starves its class** | Class list is a table, prompts validated against ~50 frames before activation, prompt version stamped on every prediction. A bad prompt is a row edit, not a deploy. |
| **CPU-only inference is too slow** | Bounded sampling is the mitigation: 200 frames per video, not the ~2,700 a full video yields. Detection sits behind a one-method interface so the model is a one-file swap, and the 940MX is worth re-measuring before being written off. |
| **Untrusted input contaminates the dataset** | Anonymous verdicts are recorded and never promoted. That is what keeps consensus resolution, agreement scoring and trust weighting out of scope — admitting untrusted labels is what would force all three. |
| **Public frame serving becomes the gallery §7 rejected** | Curated pool rather than the bucket, one short-lived signed URL per request with no enumeration, rate limiting, `noindex`. The distinction is a schema flag, not a paragraph. |
| **Pool grows faster than a human can consume it** | The per-video budget is the governor: pool size is bounded by verification throughput, not by extraction rate. Unsampled frames keep their rows and wait. |
