# Flows

How crowdmon's components talk to each other, step by step, as the code stands
today. Design *reasoning* lives in [`CONTEXT.md`](../CONTEXT.md); delivery state
in [`ROADMAP.md`](../ROADMAP.md). This file is the *mechanical* view: who calls
whom, with what, in what order.

---

## 1. Components

| Component | Runs on | Language / stack | Talks to |
|---|---|---|---|
| **Web SPA** (`apps/web`) | Cloudflare edge, served as static assets by the API Worker | React 19 + Vite + TanStack Query + shadcn/ui | API Worker (relative paths), R2 (presigned GETs) |
| **API Worker** (`apps/api`) | Cloudflare Workers | Hono + `@hono/zod-openapi` on workerd | D1, R2, Rate Limiter, Access JWKS, OTLP collector |
| **D1** | Cloudflare | SQLite | — |
| **R2** (`crowdmon-frames`) | Cloudflare | object store | — |
| **Go worker** (`worker/`) | home box, Docker | Go, `yt-dlp` + `ffmpeg` | API Worker (HTTP), R2 (S3 API, direct), detector sidecar, OTLP collector |
| **Detector sidecar** (`deploy/detector`) | home box, Docker | FastAPI + ONNX Runtime, OWL-ViT `owlvit-base-patch32` | R2 (S3 API, read-only), the Go worker calls *it* |
| **Monitoring stack** | home box, `~/monitoring-stack` — **not owned by this repo** | otel-collector, Tempo, Loki, Prometheus, Grafana | receives OTLP from both sides |

Two trust boundaries matter:

- **Frame bytes never transit the API Worker's CPU on the write path.** The Go
  worker PUTs straight to R2 with its own read+write token; the API only ever
  learns keys.
- **Three separate R2 credentials.** Worker = Object Read+Write. Detector =
  Object Read. API Worker's presigner reuses the *detector's* read-only pair
  (`wrangler.toml` documents why). Rotating that pair moves two systems.

### 1.1 Architecture

```mermaid
flowchart TB
    subgraph browser["Browser"]
        SPA["Web SPA<br/>/, /verify, /admin/*"]
    end

    subgraph cf["Cloudflare"]
        ACCESS["Cloudflare Access<br/>(zero-trust, on /api/admin/*)"]
        API["API Worker (Hono)<br/>crowdmon.mkcarl.com<br/>+ static assets + Cron"]
        D1[("D1 — crowdmon")]
        R2[("R2 — crowdmon-frames")]
        RL["Rate Limiter binding<br/>20 req / 60s per ip+route"]
    end

    subgraph box["Home box (carls-ubuntu, Docker)"]
        GOW["Go worker<br/>yt-dlp + ffmpeg + pHash"]
        DET["Detector sidecar<br/>FastAPI + ONNX OWL-ViT"]
        VOL[["named volume<br/>source-videos"]]
    end

    subgraph obs["~/monitoring-stack (read-only to this repo)"]
        COLL["otel-collector<br/>otlp.mkcarl.com"]
        TEMPO[("Tempo")]
        LOKI[("Loki")]
        PROM[("Prometheus")]
        GRAF["Grafana"]
    end

    YT["YouTube"]

    SPA -->|"relative fetch, same-origin cookie"| ACCESS
    ACCESS -->|"Cf-Access-Jwt-Assertion"| API
    SPA -->|"public routes, no Access"| API
    SPA -.->|"presigned GET (signed mode)"| R2
    API --> RL
    API <--> D1
    API -->|"proxy mode reads"| R2
    API -->|"presign S3 URLs (aws4fetch)"| R2

    GOW -->|"claim / heartbeat / complete<br/>fanout / images / predictions"| API
    GOW -->|"PUT frames, GET+PUT snapshots (S3)"| R2
    GOW -->|"POST /detect"| DET
    DET -->|"GET frame bytes (S3, read-only)"| R2
    GOW --> YT
    GOW --- VOL

    API -->|"OTLP HTTP traces + service token"| COLL
    GOW -->|"OTLP traces, logs, metrics"| COLL
    COLL --> TEMPO
    COLL --> LOKI
    COLL --> PROM
    TEMPO --> GRAF
    LOKI --> GRAF
    PROM --> GRAF
```

### 1.2 The job queue is the only coupling

The Go worker never receives a push. Everything is one shape:

```
POST /api/jobs/claim          -> a job, or 204/null
POST /api/jobs/{id}/heartbeat -> renew the lease, every 30s
POST /api/jobs/{id}/<report>  -> write results while still holding the lease
POST /api/jobs/{id}/complete  -> done | failed (terminal)
```

Five job kinds share one `jobs` table and one claim endpoint (kind-agnostic —
`ORDER BY id LIMIT 1` across all pending rows):

| kind | video_id | enqueued by | side table | reports to |
|---|---|---|---|---|
| `download` | yes | `POST /api/admin/videos` | — | `/fanout` |
| `chunk` | yes | the download's fan-out | `chunks` | `/images` |
| `prelabel` | yes | automatically, by the *last* chunk's `complete` — **or** on demand, `POST /api/admin/videos/{id}/prelabel` (M17, plan §B) | `prelabel_images`, only for an on-demand pass | `/predictions` |
| `dryrun` | yes | `POST /api/admin/classes/{id}/dryrun` | `dryruns` | `/dryrun` |
| `snapshot` | **NULL** | `POST /api/admin/snapshots` | `snapshots` | `/snapshot` |

`prelabel` is the one kind that can be enqueued two ways, and migration 0011 is what makes that possible: before it, `idx_jobs_one_prelabel_per_video` allowed at most one `prelabel` job per video, ever. An on-demand pass carries its own frame list in `prelabel_images`, written atomically with the job (`createPrelabelHandler`); the automatic pass writes no `prelabel_images` rows at all, and a claim for it hydrates no `prelabel` field — see §3.4.

---

## 2. Job lifecycle (all kinds)

The generic envelope. Every sequence in §3 slots into the `work(job)` box.

```mermaid
sequenceDiagram
    autonumber
    participant L as Loop (Go)
    participant R as Runner (Go)
    participant API as API Worker
    participant D1 as D1

    loop until SIGTERM
        L->>R: PollOnce(ctx)
        R->>API: POST /api/jobs/claim {worker_id}
        API->>D1: UPDATE jobs SET status='claimed', attempts=attempts+1,<br/>claimed_by, claimed_at, heartbeat_at<br/>WHERE id = (SELECT id FROM jobs WHERE status='pending' ORDER BY id LIMIT 1)<br/>RETURNING *
        Note over API,D1: single UPDATE...RETURNING — no SELECT-then-UPDATE,<br/>so two workers cannot take the same row
        alt no pending row
            API-->>R: null
            R-->>L: found=false
            L->>L: backoff.Next(), sleep
        else claimed
            API->>D1: hydrate side table (chunks / dryruns) by kind
            API-->>R: Job{id, kind, video_id, video_url, chunk?, dryrun?, traceparent}
            R->>R: leaseCtx = WithCancel(ctx), then start the heartbeat goroutine
            par lease renewal
                loop every 30s
                    R->>API: POST /api/jobs/{id}/heartbeat {worker_id}
                    API->>D1: UPDATE jobs SET heartbeat_at=now WHERE id=? AND claimed_by=?
                    alt 404 — lease no longer held
                        API-->>R: 404
                        R->>R: cancel leaseCtx, mark leaseLost
                    end
                end
            and the work
                R->>R: work(job) — see §3
            end
            alt lease was lost
                R-->>L: drop silently (row is already back in 'pending')
            else terminal error
                R->>API: POST /api/jobs/{id}/complete {status:'failed', failure_reason}
            else success
                R->>API: POST /api/jobs/{id}/complete {status:'done'}
            else retryable error / SIGTERM mid-job
                Note over R,API: reports nothing — row stays 'claimed'<br/>for the reaper. `complete` is terminal, so a<br/>transient fetch failure must not use it.
            end
            R-->>L: found=true, backoff.Reset()
        end
    end
```

Key invariants:

- **`attempts` increments on claim, not on failure.** A job that crashes the
  worker before reporting still burns one, so `MAX_ATTEMPTS = 3` bites.
- **Reports go before `complete`**, always. A report on a lease you still hold
  makes a 404 mean something.
- **Only two things are ever reported: done, or can-never-finish.** Everything
  else is silence plus the reaper.

### 2.1 Reaper (Cron)

```mermaid
sequenceDiagram
    autonumber
    participant CRON as Cron Trigger (Terraform-owned schedule)
    participant SC as scheduled.ts
    participant RP as reaper.ts
    participant D1 as D1
    participant OT as otel-collector

    CRON->>SC: scheduled(controller, env)
    SC->>RP: reapOptions(env) → {staleAfterSeconds:120, maxAttempts:3}
    RP->>D1: UPDATE jobs SET status='pending', claimed_by=NULL …<br/>WHERE status='claimed' AND heartbeat_at < now-120 AND attempts < 3<br/>RETURNING id, kind, video_id, attempts
    RP->>D1: UPDATE jobs SET status='failed', failure_reason='exhausted its attempts…'<br/>WHERE status='claimed' AND heartbeat_at < now-120 AND attempts >= 3<br/>RETURNING …
    RP-->>SC: {requeued[], retired[]}
    SC->>OT: recordReclaims() — one span per moved job
```

`reapOptions` throws on a malformed var rather than defaulting: a hand-edited
value that silently did nothing is worse than a visibly failing invocation.

---

## 3. The pipeline, kind by kind

### 3.1 Submit a video, then `download` → fan-out

```mermaid
sequenceDiagram
    autonumber
    actor A as Admin (browser)
    participant SPA as Web SPA
    participant ACC as Cloudflare Access
    participant API as API Worker
    participant D1 as D1
    participant W as Go worker
    participant YT as YouTube
    participant FS as source-videos volume

    A->>SPA: paste a YouTube URL (SubmitForm)
    SPA->>ACC: POST /api/admin/videos {url}
    ACC->>API: + Cf-Access-Jwt-Assertion
    API->>API: requireAccess: verify JWT (issuer + audience), check ADMIN_EMAILS
    API->>API: parse the id out of the URL (youtube.ts)
    API->>D1: INSERT INTO videos(id,url) ON CONFLICT DO NOTHING<br/>INSERT INTO jobs(kind='download', video_id, traceparent)
    Note over D1: idx_jobs_one_download_per_video makes a<br/>re-submit a no-op, not a duplicate
    API-->>SPA: {video_id, job_id}

    W->>API: POST /api/jobs/claim
    API-->>W: Job{kind:'download', video_id, video_url}
    W->>YT: yt-dlp download
    YT-->>FS: the source file (skipped if already present — a reaped download re-runs)
    W->>W: ffprobe → duration, width, height
    W->>API: POST /api/jobs/{id}/fanout {duration_seconds,width,height,title,worker_id}
    API->>D1: one batch: UPDATE videos SET metadata …<br/>then per 60s segment: INSERT jobs('chunk') + INSERT chunks<br/>each guarded by NOT EXISTS(video_id, segment_index)
    Note over API,D1: ceiling MAX_VIDEO_SECONDS = 6h. One batch for atomicity,<br/>not for the param limit: a chunks row must never be observed<br/>without its jobs row, since the claim handler retires that as corruption.<br/>last_insert_rowid() returns the PREVIOUS insert's id when a statement<br/>inserted nothing, so both guards must match exactly.
    API-->>W: {segments, created} — created = 0 on a re-run
    W->>API: POST /api/jobs/{id}/complete {status:'done'}
```

A download failure that `video.ErrUnavailable` classifies (deleted, private,
geo-blocked, members-only) is marked **terminal** — retrying spends the ceiling
to be told the same thing three times.

### 3.2 `chunk` — extract, hash, dedup, upload, record

```mermaid
sequenceDiagram
    autonumber
    participant W as Go worker
    participant FS as source-videos volume
    participant TMP as /tmp (per job)
    participant R2 as R2
    participant API as API Worker
    participant D1 as D1

    W->>API: POST /api/jobs/claim
    API-->>W: Job{kind:'chunk', video_id, chunk:{segment_index,start,end}}
    W->>FS: Store.Path(video_id)
    alt file not on this box
        W-->>API: complete{failed, "affinity"} — Terminal.<br/>No retry puts a file on a disk that lacks it.
    end
    W->>TMP: ffmpeg -ss start -to end, fps=1 → JPEGs
    W->>W: pHash (DCT-64) each frame
    W->>W: dedup within the chunk at CROWDMON_DEDUP_THRESHOLD
    W->>R2: PUT frames/{video_id}/{ttttt.ttt}.jpg  (deterministic keys)
    Note over W,R2: keys are deterministic, so a retried chunk<br/>overwrites rather than duplicating
    W->>API: POST /api/jobs/{id}/images {images:[{r2_key,timestamp_seconds,phash}],<br/>frames_extracted, frames_kept, config_version, worker_id}
    API->>D1: SELECT lease + chunk window (one statement)
    API->>D1: one batch: INSERT OR IGNORE INTO images ×N<br/>+ UPDATE chunks SET frames_extracted, frames_kept<br/>+ UPDATE jobs SET config_version<br/>each re-checking the lease
    API-->>W: 200 | 400 (Terminal: same refusal every attempt) | 404 (lease lost)
    W->>TMP: rm -rf (on every path out, including failures)
    W->>API: POST /api/jobs/{id}/complete {status:'done'}
```

`config_version` is `extract=ffmpeg-fps1;phash=dct64;threshold=N` — the regime
the rows were produced under, stamped on the job *and* on every `images` row
(`dedup_threshold`).

### 3.3 `prelabel` is enqueued automatically, or queued on demand

**Automatically**, the instant a video's last `chunk` job finishes — not a
separate call, it rides inside that chunk's `complete` batch, so it cannot be
lost to a crash between two round trips:

```sql
INSERT INTO jobs (kind, video_id, traceparent, selection_reason)
     SELECT 'prelabel', j.video_id, ?, 'random'
       FROM jobs j
      WHERE j.id = ?  AND j.kind = 'chunk' AND j.status = 'done'
        AND NOT EXISTS (SELECT 1 FROM jobs c
                         WHERE c.video_id = j.video_id AND c.kind='chunk' AND c.status != 'done')
        AND NOT EXISTS (SELECT 1 FROM jobs p
                         WHERE p.video_id = j.video_id AND p.kind='prelabel')
```

One automatic prelabel per video, not per chunk: the sample is drawn across
the whole timeline, which no single 60-second chunk could assemble. The
`NOT EXISTS (… p.kind='prelabel')` guard is what keeps a reaped-and-rerun last
chunk from enqueuing a second *automatic* pass — before migration 0011 (M17,
plan §B), `idx_jobs_one_prelabel_per_video` backstopped that guard with a
database constraint; that index is gone now (see below), so the guard is the
whole of the guarantee, resting on D1 serialising writers rather than on a
second, independent check.

**On demand**, an admin refilling a drained verification pool
(`labellingBatchHandler`'s `UNRULED_BOX` pool, §4.2) queues a *supplementary*
pass over an explicit set of not-yet-sampled frames:

```
POST /api/admin/videos/{id}/prelabel
  {image_ids:[…]}                    -> hand-picked, stamps 'manual'
  {count, strategy:'random'}         -> server-drawn random draw over the
                                         not-yet-sampled remainder, stamps 'random'
```

One batch: `INSERT INTO jobs (kind, video_id, traceparent, selection_reason)`
alongside one `INSERT INTO prelabel_images (job_id, image_id)` per selected
image, so the claim handler can never observe a `prelabel` job whose
selection is half-written. `idx_jobs_one_prelabel_per_video` (migration 0005)
is what made this route impossible before migration 0011 dropped it — that
index enforced *at most one* `prelabel` job per video, ever, which a
supplementary pass is definitionally a second one of. Dropping it does not
weaken the automatic pass's own exactly-once guarantee (the paragraph above
is why), and it does not touch migration 0008's `CHECK
((kind = 'snapshot') = (video_id IS NULL))` — a supplementary job still names
exactly one video, the same as every prelabel job always has.

`selection_reason` on `jobs` (migration 0011) is what makes the *value*
`reportPredictionsHandler` stamps onto `images.selection_reason` a fact about
which job ran, decided here at enqueue time, rather than a literal the report
handler used to hard-code. See §3.4.

### 3.4 `prelabel` — sample, detect, report

```mermaid
sequenceDiagram
    autonumber
    participant W as Go worker
    participant API as API Worker
    participant D1 as D1
    participant DET as Detector sidecar
    participant R2 as R2

    W->>API: POST /api/jobs/claim
    API-->>W: Job{kind:'prelabel', video_id, prelabel?}
    W->>API: GET /api/classes/active
    API->>D1: SELECT name, appearance_prompt, prompt_version FROM classes WHERE active=1
    API-->>W: [{name, appearance, version}]
    Note over W,API: fetched per job, never cached and never<br/>configured locally — a second copy of the wording<br/>is exactly the drift prompt_version exists to prevent
    alt zero active classes
        W-->>API: retryable failure (silence) — reporting zero boxes<br/>would be indistinguishable from "found nothing"
    end
    alt claim carried Job.prelabel (an on-demand pass, M17)
        Note over W,API: the frame list arrived on the claim itself —<br/>no fetch, no sampling, no sample.select span
    else automatic first pass, or a legacy job with no explicit list
        W->>API: GET /api/videos/{video_id}/images
        API->>D1: SELECT r2_key, timestamp_seconds FROM images WHERE video_id=? ORDER BY timestamp_seconds
        API-->>W: the candidate pool
        W->>W: sample across the timeline, budget CROWDMON_PRELABEL_SAMPLE_SIZE
    end
    loop each sampled or explicitly-listed frame
        W->>DET: POST /detect {key, prompts:[{name, text}]}
        DET->>R2: GET frames/… (its own read-only token)
        DET->>DET: OWL-ViT ONNX, confidence floor 0.1, ≤10 boxes/class
        DET-->>W: [{class_name, x_min..y_max, confidence}] (normalised 0..1)
        Note over W,DET: object gone from R2 → Terminal. The row has no bytes<br/>behind it, which is a repair rather than a retry.<br/>Anything else → retryable.
    end
    W->>API: POST /api/jobs/{id}/predictions {model_id, boxes[], sampled_keys[], worker_id}
    API->>D1: resolve r2_key→image_id and class name→class_id (chunked ≤100 params)
    API->>D1: SELECT selection_reason FROM jobs WHERE id=?
    API->>D1: one batch: INSERT INTO predictions ×N<br/>+ UPDATE images SET selection_reason=(job's own value)<br/>WHERE r2_key IN (…) AND selection_reason IS NULL
    API-->>W: 200 | 400 (Terminal) | 404 (lease lost)
    W->>API: POST /api/jobs/{id}/complete {status:'done'}
```

`sampled_keys` is collected *before* the first `Detect` call and reported
unconditionally — every frame the detector was asked about, boxed or not. A job
that dies partway never reaches this call, so it never stamps a sample it did
not finish looking at.

The stamp's value is no longer a literal (M17, plan §B): before migration
0011, `reportPredictionsHandler` wrote `selection_reason = 'random'`
unconditionally, which was safe only because `idx_jobs_one_prelabel_per_video`
made a second pass over any image unreachable. Now the value comes off the
job (`'random'` for the automatic pass and a randomised on-demand draw,
`'manual'` for a hand-picked one — §3.3), and the write is write-once
(`AND selection_reason IS NULL`) rather than unconditional — the backstop for
a hand-picked pass naming an image a caller failed to exclude, since
`createPrelabelHandler` already refuses that at request time.

### 3.5 `dryrun` — try a wording, write nothing to the dataset

Structurally prelabel with three removals, each load-bearing: no
`GET /api/classes/active` (the candidate wording arrives *on the job*, and
fetching would run the wrong prompt), no `selection_reason` stamp (these frames
are not a dataset decision), and the report lands in `dryruns` rather than
`predictions`.

```mermaid
sequenceDiagram
    autonumber
    actor A as Admin
    participant SPA as Web SPA (DryRunPanel)
    participant API as API Worker
    participant D1 as D1
    participant W as Go worker
    participant DET as Detector

    A->>SPA: /admin/videos — edit a candidate prompt, "try it"
    SPA->>API: POST /api/admin/classes/{id}/dryrun {video_id, appearance_prompt}
    API->>D1: INSERT jobs('dryrun', video_id) + INSERT dryruns(job_id, class_id,<br/>appearance_prompt, sample_size, requested_by=adminEmail)
    API-->>SPA: {job_id}
    W->>API: POST /api/jobs/claim
    API-->>W: Job{kind:'dryrun', dryrun:{class_name, appearance_prompt, sample_size}}
    W->>API: GET /api/videos/{video_id}/images
    W->>W: SampleN(video_id, sample_size)
    loop each sampled frame
        W->>DET: POST /detect {key, prompts:[the candidate wording]}
        DET-->>W: boxes
    end
    W->>API: POST /api/jobs/{id}/dryrun {model_id, boxes[], sampled_keys[], worker_id}
    API->>D1: UPDATE dryruns SET model_id, boxes(JSON), sampled_keys(JSON), reported_at
    W->>API: POST /api/jobs/{id}/complete {status:'done'}
    SPA->>API: GET /api/admin/classes/{id}/dryruns (polled)
    API-->>SPA: recent runs, newest first
    SPA->>API: GET /api/admin/image?key=… (grid proxies — ~50 frames, inside the noise)
```

Accepting the wording is a separate, explicit act:
`PATCH /api/admin/classes/{id}` writes the new `appearance_prompt` and a new
`prompt_version`.

### 3.6 `snapshot` — package the dataset

The only kind with `video_id IS NULL` (migration 0008's `CHECK` enforces the
biconditional).

```mermaid
sequenceDiagram
    autonumber
    actor A as Admin
    participant API as API Worker
    participant D1 as D1
    participant W as Go worker
    participant R2 as R2

    A->>API: POST /api/admin/snapshots   (no body — v2 has exactly one policy)
    API->>D1: INSERT INTO jobs(kind='snapshot', video_id=NULL)
    W->>API: POST /api/jobs/claim
    API-->>W: Job{kind:'snapshot', video_id:null}
    W->>API: GET /api/jobs/{id}/snapshot-source?worker_id=…
    API->>D1: images with ≥1 latest-admin-verdict in (accept, adjust)
    API->>D1: labels: class name + box, using the adjusted box when verdict='adjust'
    API-->>W: {images[], labels[]}
    loop each admitted image
        W->>R2: CopyObject frames/… → snapshots/{job_id}/images/…
    end
    W->>R2: PUT snapshots/{job_id}/manifest.json<br/>split: selection_reason='random' → eval, else train
    W->>API: POST /api/jobs/{id}/snapshot {r2_key, image_count, label_count, worker_id}
    API->>D1: INSERT INTO snapshots(r2_key, image_count, label_count,<br/>inclusion_policy = DEFAULT_INCLUSION_POLICY)
    W->>API: POST /api/jobs/{id}/complete {status:'done'}
```

`inclusion_policy` is copied as free text onto the row, not a foreign key: a
snapshot's dataset must be reconstructible from its own row a year later.
Current value:

```
source=admin; verdict=latest per prediction, accept or adjust;
split: selection_reason='random' -> eval, else train
```

---

## 4. Human flows

### 4.1 Admin auth

```mermaid
sequenceDiagram
    autonumber
    actor A as Admin
    participant SPA as Web SPA
    participant ACC as Cloudflare Access
    participant API as API Worker
    participant JWKS as team JWKS

    A->>SPA: open /admin/dashboard  (static asset — no Access in front of it)
    SPA->>API: GET /api/admin/session
    alt no session
        ACC-->>SPA: 302 to the IdP  (fetch cannot follow cross-origin → TypeError,<br/>or lands on an HTML 200)
        SPA->>SPA: apiFetch raises SessionExpiredError
        SPA->>A: SessionExpiredBanner
        A->>SPA: click sign in → window.location.assign('/api/admin/login')
        Note over SPA,ACC: full-page navigation, because /api/admin/* IS bound to<br/>the Access application. Reloading the current URL loops forever.
        ACC->>API: after login, GET /api/admin/login + assertion
        API-->>A: 302 → /admin
    end
    SPA->>ACC: GET /api/admin/session
    ACC->>API: + Cf-Access-Jwt-Assertion (httpOnly cookie on this origin)
    API->>JWKS: fetch keys (cached per isolate, refetched on unknown kid)
    API->>API: jwtVerify(issuer, audience) — audience is load-bearing:<br/>every app in the org is signed by the same keys
    API->>API: isAdmin(email, ADMIN_EMAILS) — case/whitespace-insensitive
    API-->>SPA: {email}
```

Two independent gates, deliberately: the Access policy lives in Terraform, the
email allowlist is a Worker secret. Widening one does not widen the other, and a
policy deleted in the dashboard does not take this check with it. Missing config
fails **closed** with 503.

### 4.2 Admin verification (the labelling loop)

```mermaid
sequenceDiagram
    autonumber
    actor A as Admin
    participant SPA as LabellingSession
    participant API as API Worker
    participant D1 as D1
    participant R2 as R2

    SPA->>API: GET /api/admin/labelling/batch?limit=N   (N ≤ 100)
    API->>D1: next N frames with predictions and no verdict yet, + their boxes
    alt R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY + FRAMES_S3_BASE_URL all set
        API->>API: aws4fetch presign GET, TTL 15 min, one AwsClient for the batch
        API-->>SPA: {images:[{…, url: "https://…r2.cloudflarestorage.com/…?X-Amz-…"}],<br/>url_mode:"signed", expires_at}
        SPA->>R2: GET the signed URL directly (bytes never touch the Worker)
    else any of the three missing
        API-->>SPA: {…, url:"/api/admin/image?key=…", url_mode:"proxy", expires_at}
        SPA->>API: GET /api/admin/image?key=… (Access-gated, Worker streams from R2)
    end
    loop each frame
        A->>SPA: accept / adjust (drag the box) / reject, per prediction
        A->>SPA: optionally: an object the detector missed
    end
    SPA->>API: POST /api/admin/images/{id}/verdicts {verdicts:[…]}  (all at once, ≤100)
    API->>D1: INSERT INTO verdicts(prediction_id, verdict, adjusted_*, source='admin',<br/>annotator_id=adminEmail)
    SPA->>API: POST /api/admin/images/{id}/missing {class_id?}
    API->>D1: INSERT INTO missing_reports
    SPA->>API: GET /api/admin/labelling/stats
    API-->>SPA: verdict counts, class coverage, pool size
```

`url_mode` is on the wire so the UI can tell an expiry apart from a lost
session. Both modes keep the bucket private and nothing enumerable; only *who
moves the bytes* differs.

### 4.3 Public (anonymous) verification

```mermaid
sequenceDiagram
    autonumber
    actor V as Visitor (no account)
    participant SPA as PublicVerify (/verify)
    participant RL as Rate Limiter binding
    participant API as API Worker
    participant D1 as D1
    participant R2 as R2

    SPA->>SPA: getAnonSessionId() — crypto.randomUUID() in localStorage,<br/>opaque, authenticates nothing
    SPA->>API: GET /api/public/frame
    API->>RL: bucket "frame", 20 / 60s per (ip, route)
    Note over API,RL: one mount per route with its own literal bucket —<br/>a shared /api/public/* mount would collapse both onto one counter
    API->>D1: SELECT one random image WHERE public_sample=1<br/>AND EXISTS(a prediction on it)
    API->>D1: its predictions + class names
    API->>R2: presign (or fall back to the proxy path)
    API-->>SPA: {image_id, url, boxes[]}
    V->>SPA: accept / reject each box
    SPA->>API: POST /api/public/images/{id}/verdicts {verdicts[], session_id}
    API->>RL: bucket "verdict"
    API->>D1: re-check the image IS public_sample=1 in the same query as its id
    API->>D1: verify every prediction_id belongs to that image (chunked ≤100 params)
    API->>D1: INSERT INTO verdicts(… source='anon', annotator_id=session_id)
```

Anonymous verdicts are drawn **only** from the hand-curated `public_sample` set,
never from the labelling pool, and `source='anon'` keeps them out of the
snapshot inclusion policy entirely. An admin curates that set with
`PATCH /api/admin/images/{id}/public-sample`.

---

## 5. Telemetry

```mermaid
flowchart LR
    API["API Worker<br/>@microlabs/otel-cf-workers"] -->|"OTLP/HTTP + CF-Access-Client-Id/Secret<br/>(service token)"| COLL["otel-collector<br/>otlp.mkcarl.com"]
    GOW["Go worker<br/>otlptracehttp + slog→OTLP + metrics"] --> COLL
    COLL --> TEMPO[("Tempo — traces")]
    COLL --> LOKI[("Loki — logs")]
    COLL --> PROM[("Prometheus — metrics")]
    TEMPO --> G["Grafana"]
    LOKI --> G
    PROM --> G
```

Trace context crosses the queue **through the database**: `jobs.traceparent`
(migration 0002) is written when the job is enqueued and handed back on claim,
so the Go worker's spans hang off the admin request that caused them, hours
later and in a different process. The worker's HTTP transport injects
`traceparent` on every outbound call, and the API's `nameSpanAfterRoute`
middleware names spans after the matched route so cardinality stays bounded.

Span names are flat and job-kind-specific by design — `sample.select` vs
`dryrun.select`, `predictions.report` vs `dryrun.report` — so a Tempo query for
one kind never returns the other's.

---

## 6. ERD

```mermaid
erDiagram
    videos ||--o{ jobs : "queues work for"
    videos ||--o{ chunks : "is segmented into"
    videos ||--o{ images : "yields frames"
    jobs ||--o| chunks : "one chunk job ↔ one segment"
    jobs ||--o| dryruns : "one dryrun job ↔ one candidate run"
    jobs ||--o{ prelabel_images : "an on-demand pass names"
    images ||--o{ prelabel_images : "is named by"
    images ||--o{ predictions : "detector proposed"
    classes ||--o{ predictions : "labelled as"
    classes ||--o{ dryruns : "candidate wording for"
    classes ||--o{ missing_reports : "was missed"
    predictions ||--o{ verdicts : "was ruled on"
    images ||--o{ missing_reports : "is missing an object"

    videos {
        TEXT id PK "the YouTube id, not a surrogate key"
        TEXT url
        TEXT title
        INTEGER duration_seconds
        INTEGER width
        INTEGER height
        INTEGER created_at
        INTEGER updated_at
    }

    jobs {
        INTEGER id PK
        TEXT kind "download|chunk|prelabel|dryrun|snapshot"
        TEXT video_id FK "NULL iff kind='snapshot' (CHECK)"
        TEXT status "pending|claimed|done|failed"
        INTEGER attempts "incremented on claim"
        TEXT claimed_by
        INTEGER claimed_at
        INTEGER heartbeat_at "the lease"
        TEXT failure_reason
        TEXT config_version "the regime this run produced rows under"
        TEXT traceparent "W3C context, carried across the queue"
        TEXT selection_reason "prelabel only (M17) - 'random'|'manual'|NULL, what the report should stamp"
        INTEGER created_at
        INTEGER updated_at
    }

    chunks {
        INTEGER id PK
        INTEGER job_id FK "UNIQUE, ON DELETE CASCADE"
        TEXT video_id FK
        INTEGER segment_index "UNIQUE with video_id"
        INTEGER start_seconds
        INTEGER end_seconds
        INTEGER frames_extracted
        INTEGER frames_kept
        INTEGER created_at
    }

    prelabel_images {
        INTEGER job_id PK, FK "ON DELETE CASCADE"
        INTEGER image_id PK, FK "ON DELETE CASCADE"
    }

    images {
        INTEGER id PK
        TEXT r2_key UK "frames/{video_id}/{sssss.mmm}.jpg"
        TEXT video_id FK
        REAL timestamp_seconds "UNIQUE with video_id"
        TEXT phash "DCT-64, hex"
        INTEGER dedup_threshold "the regime that kept this frame"
        INTEGER public_sample "0|1|NULL — curated anon-verification set"
        TEXT selection_reason "why prelabel sampled it - 'random' ⇒ eval split, 'manual' (M17) ⇒ train"
        INTEGER created_at
    }

    classes {
        INTEGER id PK
        TEXT name UK
        TEXT appearance_prompt "the open-vocabulary wording"
        TEXT prompt_version "changes whenever the wording does"
        INTEGER active "0|1 — what prelabel runs against"
        INTEGER created_at
        INTEGER updated_at
    }

    predictions {
        INTEGER id PK
        INTEGER image_id FK "ON DELETE CASCADE"
        INTEGER class_id FK
        REAL x_min "all four normalised 0..1, CHECKed"
        REAL y_min
        REAL x_max
        REAL y_max
        REAL confidence
        TEXT prompt_version "the wording that actually ran"
        TEXT model_id "e.g. owlvit-base-patch32@cbc355f"
        INTEGER created_at
    }

    verdicts {
        INTEGER id PK
        INTEGER prediction_id FK "ON DELETE CASCADE"
        TEXT verdict "accept|adjust|reject"
        REAL adjusted_x_min "non-null iff verdict='adjust' (CHECK)"
        REAL adjusted_y_min
        REAL adjusted_x_max
        REAL adjusted_y_max
        TEXT source "admin|anon"
        TEXT annotator_id "admin email, or the opaque anon session id"
        INTEGER created_at
    }

    missing_reports {
        INTEGER id PK
        INTEGER image_id FK "ON DELETE CASCADE"
        INTEGER class_id FK "nullable — 'something is here, no class fits'"
        TEXT reporter
        INTEGER created_at
    }

    dryruns {
        INTEGER id PK
        INTEGER job_id FK "UNIQUE, ON DELETE CASCADE"
        INTEGER class_id FK
        TEXT appearance_prompt "the candidate, deliberately not the class's current one"
        INTEGER sample_size
        TEXT model_id
        TEXT boxes "JSON — writes nothing to predictions"
        TEXT sampled_keys "JSON"
        TEXT requested_by
        INTEGER created_at
        INTEGER reported_at
    }

    snapshots {
        INTEGER id PK
        TEXT r2_key "snapshots/{job_id}/"
        INTEGER image_count
        INTEGER label_count
        TEXT inclusion_policy "free text, so the row is self-describing"
        INTEGER created_at
    }
```

`snapshots` deliberately has **no** foreign key to `jobs`: the artifact outlives
the job that built it, and its reconstructability must not depend on a row
somebody could prune.

`prelabel_images` (migration 0011, M17, plan §B) is the explicit frame list a
supplementary prelabel job runs against — populated only for an on-demand
pass, never for the automatic one, which is why it has no `selection_reason`
column of its own (that value is one fact per *job*, on `jobs`, not one per
`(job, image)` pair — §3.3). Both foreign keys carry `ON DELETE CASCADE`,
which D1 actually enforces (migration 0005's finding: no pragma turns
foreign-key checking off), so a `jobs` or `images` row this table still names
cannot be deleted out from under it.

### 6.1 Indexes that carry a rule

| Index | Enforces |
|---|---|
| `idx_jobs_one_download_per_video` (unique, partial) | re-submitting a URL is a no-op |
| `idx_chunks_identity` (unique) | fan-out is idempotent across a re-run |
| `idx_images_identity` (unique) | one frame per (video, timestamp) |
| `idx_jobs_claimable (status, kind, id)` | the claim's `ORDER BY id LIMIT 1` |
| `idx_jobs_stale (heartbeat_at) WHERE status='claimed'` | the reaper's scan |

`idx_jobs_one_prelabel_per_video` (unique, partial) lived here from migration
0005 until migration 0011 (M17, plan §B) dropped it — it enforced *at most
one* `prelabel` job per video, ever, which is exactly the constraint an
on-demand supplementary pass has to violate on purpose. The automatic pass's
own exactly-once guarantee no longer has that index as a backstop; it rests
entirely on `completeJobHandler`'s own `NOT EXISTS` guard now (§3.3), which
D1 serialising writers is what makes race-safe without it.

---

## 7. Deployment and update paths

```mermaid
flowchart LR
    PR["merge to main"] --> CI["ci.yml — biome, tsc, vitest, go test"]
    CI --> DA["deploy-api.yml → wrangler deploy<br/>(builds apps/web/dist first, then health-checks API_BASE_URL)"]
    CI --> PW["publish-worker.yml → ghcr.io/…/crowdmon-worker:latest"]
    CI --> PD["publish-detector.yml → ghcr.io/…/crowdmon-detector:latest"]
    PW --> T["crowdmon-update.timer (systemd user unit, 4×/day)"]
    PD --> T
    T --> C["docker compose pull && up -d in ~/crowdmon"]
    TF["infra/*.tf (Terraform)"] --> CFR["D1, R2, Access app, Cron schedule"]
```

Notes that bite:

- The **Cron schedule is Terraform's**, not `wrangler.toml`'s.
- `workers_dev = false` **and** `preview_urls = false`: Access binds to a route
  on a zone, and `*.workers.dev` is not one — either flag flipped back
  republishes `/api/admin/*` on an ungated hostname.
- New job kinds must reach the box **before** anything enqueues them: the claim
  endpoint is kind-agnostic, so an unknown kind fails terminally rather than
  waiting.
- `run_worker_first = ["/api/*", "/health", "/openapi.json"]` — without it, SPA
  fallback answers those paths with `index.html` and the Worker never runs.
