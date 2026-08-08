# Grafana dashboard

`crowdmon-v1.json` is the dashboard behind the "Grafana" link on `/admin` (M9.1,
issue #46). It is committed here, not provisioned — see "Why committed, not
provisioned" below for what that boundary means and why it holds.

## Importing

1. Grafana → Dashboards → New → Import.
2. Upload `crowdmon-v1.json` (or paste its contents).
3. Grafana prompts for the `DS_PROMETHEUS` input because the file's
   `__inputs` section declares it and every panel references
   `${DS_PROMETHEUS}` instead of a datasource UID (see below). Pick the
   `Prometheus` datasource already configured on `grafana.mkcarl.com`.
4. Put it in the **`crowdmon`** folder. That Grafana serves several unrelated
   projects — its Prometheus carries a `website` service alongside this one —
   so a folder is what keeps this dashboard findable among them.
5. Import. The dashboard lands at `/d/crowdmon-v1/...` — the fixed `uid` in
   the file, which is what `/admin`'s link targets, so re-importing after an
   edit keeps the same URL rather than minting a new one.

The folder is deliberately absent from the JSON. Grafana addresses a dashboard
by `uid` alone, so the folder never appears in the URL and moving it later
cannot break the link from `/admin` — which is the whole reason the link
targets a `uid` rather than a path someone can reorganise.

## What M11.4 added

Three panels for `prelabel` jobs, row 4 (y=24): **Pre-label duration**,
**Pre-label throughput** and **Pre-label failure rate**. All three read Tempo
spanmetrics off spans `worker/internal/worker/pipeline.go` already opens —
`job.prelabel` and, once per sampled image, `image.detect` — rather than a new
OTel instrument, for the reason each panel's own `description` gives: nothing
about M11 needed image or box counts as a *Prometheus* series the way M8.2
needed frame counts, since those numbers already live as span attributes
(`crowdmon.prelabel.sampled`, `crowdmon.prelabel.boxes`,
`crowdmon.prelabel.boxes_by_class`), and a duration/rate histogram alongside
them would only be a second source for a number the span already carries.

Pre-label failure rate does **not** fold into the Failure rate panel above it,
on purpose. `job.failed` and `job.retired` are API-side spans, and Tempo's
spanmetrics connector on this box only promotes `service`, `span_name` and
`status_code` as label dimensions — confirmed against the live collector
(`curl … /api/v1/label/__name__/values` from `CLAUDE.md`'s read-only probes),
no `job.kind` dimension exists to filter Failure rate down to prelabel
specifically. `job.prelabel`'s own span status is this signal's whole source
instead: `traces_spanmetrics_calls_total{service="crowdmon-worker",
span_name="job.prelabel", status_code="STATUS_CODE_ERROR"}`.

`queue_depth`'s three-kind zero-fill (`download`/`chunk`/`prelabel`) already
covers `prelabel` on the existing Queue depth panel without an edit here — see
`worker/cmd/worker/main.go`'s `queueDepthCounts`, which read `prelabel` off
the API's response but silently dropped it building the gauge's slice until
M11.4 fixed that; the panel's own PromQL (`sum by (status, kind) (...)`) was
never the part that needed to change.

## Why committed, not provisioned

`~/monitoring-stack/` on the home box — Loki, Tempo, Prometheus, the
otel-collector, and Grafana's own provisioning directory — is shared
infrastructure with its own repository and lifecycle, predating this project
(CONTEXT.md §2, §6). This project reads it to validate queries and consumes
`grafana.mkcarl.com` as a stable hostname, but does not own a byte of its
configuration. Dropping a dashboard-provisioning file into that directory
would mean this repo's changes could silently alter a box shared with
unrelated projects, and `terraform destroy` here would have no way to clean
it back up. A dashboard that lives in *this* repo, imported by hand into
Grafana, keeps the ownership boundary where CONTEXT.md §6 already drew it:
this project is a consumer of the monitoring stack, not a manager of it.

## Why `${DS_PROMETHEUS}` instead of a datasource UID

A datasource UID is assigned per Grafana instance at the moment the
datasource is created — it is not something this repo controls or can
predict. Hardcoding one would make the file work only on the exact Grafana
instance it was exported from, and importing it anywhere else (a rebuilt
box, a second environment) would silently point every panel at a
nonexistent datasource. `__inputs` plus `${DS_PROMETHEUS}` is Grafana's own
answer to this: the import dialog resolves the placeholder to whatever
datasource the importer picks, so the file stays portable without this repo
ever needing to know the UID.

## Re-exporting after editing in the UI

Editing panels directly in Grafana is fine — that is what the UI is for —
but Grafana's own "Export" writes back a *concrete* datasource UID, which
would silently reintroduce the exact coupling the section above avoids.

1. Dashboard → Settings (gear icon) → JSON Model, or Share → Export.
2. Use **"Export for sharing externally"** (the toggle in the export dialog),
   not a plain export. This is what regenerates `__inputs` and rewrites every
   `datasource` field back to `${DS_PROMETHEUS}` — a plain export leaves the
   concrete UID in place.
3. Confirm the `uid` at the bottom of the JSON is still `crowdmon-v1` before
   committing. Grafana does not change it on export, but a copy-paste through
   "New dashboard" rather than "Edit" can lose it, and a changed `uid` breaks
   the link from `/admin`.
4. Diff the result against what's in this file before committing — an export
   also bumps `version` and can reorder keys, which is noise worth confirming
   isn't hiding an unintended panel change.
