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
4. Import. The dashboard lands at `/d/crowdmon-v1/...` — the fixed `uid` in
   the file, which is what `/admin`'s link targets, so re-importing after an
   edit keeps the same URL rather than minting a new one.

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
