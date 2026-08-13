# Annotations filters, verdict preview, and public-frame variety

**Status:** planned 2026-08-12 · **Milestone:** M18 (v3) · **Design record:** `CONTEXT.md`
§Q10, §Q19, §Q25

Three UX changes, all reads, no migration required (two optional indexes). Independent of
`2026-08-12-on-demand-prelabel-and-single-frame-dryrun.md` — either can land first.

- **A — verdict filters.** `/admin/annotations` filters on `source` only. Add class,
  verdict, video, annotator and time range.
- **B — verdict preview.** Click a verdict row, see the frame with the boxes drawn.
- **C — public-frame variety.** The `/verify` page keeps serving near-identical frames.

---

## C first, because the premise is wrong

**The selection is already random.** `apps/api/src/routes/public.ts:94`:

```sql
SELECT i.id, i.r2_key FROM images i
 WHERE i.public_sample = 1
   AND EXISTS (SELECT 1 FROM predictions p WHERE p.image_id = i.id)
 ORDER BY RANDOM() LIMIT 1
```

So "serve the images randomly" is already what it does, and adding randomisation would
change nothing. The consecutive-looking frames come from somewhere else, and there are
three candidates. Diagnose before fixing — the right fix differs per cause.

```
! npx wrangler d1 execute crowdmon --remote --command "SELECT video_id, COUNT(*) AS n, MIN(timestamp_seconds) AS first, MAX(timestamp_seconds) AS last FROM images WHERE public_sample = 1 GROUP BY video_id ORDER BY n DESC"
```

**Cause 1 — the curated pool is temporally clustered.** Most likely. `public_sample` is set
one image at a time via `PATCH /api/admin/images/{id}/public-sample`, and an admin doing
that while scanning a video's frame grid naturally clicks a *contiguous run* — the frames
with good boxes cluster together. At 1fps in a cutscene, adjacent kept frames look
identical to a human even though pHash dedup legitimately kept both (`dedup_threshold` is
a perceptual-distance test, not a "looks different to a person" test). A uniform draw over
a clustered pool produces clustered-looking results. The randomness is fine; the pool is
the problem.

**Cause 2 — the pool is small, and the draw is with replacement.** With N frames flagged,
each load has a `1/N` chance of repeating the previous frame outright and no memory across
loads. At N=10 that is a repeat every ten views and a *near*-neighbour far more often.

**Cause 3 — client caching.** `usePublicFrame()` keys on `["public","frame"]`. If a stale
cache is being served, the frame would not change at all rather than advance, so this is
unlikely given the report — but worth ruling out by confirming the network tab shows a
request per reshuffle.

### Fixes, in order of value

1. **Curate with temporal spacing.** The root cause. When flagging a frame into
   `public_sample`, warn (or refuse) if another flagged frame from the same video is within
   N seconds — 30s is a reasonable floor at 1fps extraction. Enforce in
   `updatePublicSampleHandler`, so the rule holds regardless of which UI calls it. Also
   worth a one-off pass to thin the existing pool.
2. **Never serve the same frame twice in a row.** Accept `?exclude=<image_id>` on
   `GET /api/public/frame` and add `AND i.id != ?`. The client passes the frame it is
   currently showing. Cheap, and it removes the most irritating case outright. Guard the
   degenerate pool-of-one case so it still returns something rather than 404.
3. **Draw the video first, then the frame within it.** Two-step random prevents one
   over-curated video from dominating regardless of how the pool is shaped:
   pick a random `video_id` from the qualifying set, then a random qualifying frame inside
   it. Fixes cause 1 structurally rather than by curation discipline. Worth it only if the
   pool spans several videos — the diagnostic above says whether it does.

Note `ORDER BY RANDOM()` scans every matching row, but the qualifying set is a hand-curated
handful, so the cost is nothing. Don't extend this idiom to the labelling pool, which is
large.

**In-bounds check:** §Q10 keeps the public tier anonymous and non-authoritative, and §Q11's
"not at scale" is enforced by the rate limiter binding, not by pool size. Nothing here
touches either. The `exclude` parameter carries no trust — worst case a visitor sees a
frame twice.

---

## A — verdict filters

Today `listVerdictsHandler` (`admin-verdicts.ts`) takes `source`, `limit`, `offset` and
builds one optional `WHERE v.source = ?`.

### API

Every column needed is already joined — `verdicts` → `predictions` → `images` → `classes` —
so this is filter plumbing, not new reads.

| Filter | Predicate |
|---|---|
| source (existing) | `v.source = ?` |
| verdict | `v.verdict IN (…)` — `accept` \| `adjust` \| `reject`, multi-select |
| class | `p.class_id = ?` |
| video | `i.video_id = ?` |
| annotator | `v.annotator_id = ?` |
| time from / to | `v.created_at >= ?` / `v.created_at <= ?` (unix seconds) |

Replace the single `filter` string with a conditions array joined by `AND` and a parallel
bindings array pushed in the same order. Keep the existing comment's rule absolutely —
**bound, never interpolated** — and note that `verdict IN (…)` needs generated
placeholders, so it is the one clause where the SQL text varies with input length. Cap the
list at the three enum values so the placeholder count is bounded by the schema.

Two additions the filter UI needs and the endpoint does not yet provide:

- **A total count.** The response returns only `verdicts`, so the UI cannot show "142
  results" or how many pages exist. With six filters that becomes the difference between
  "no results" and "no results *for this combination*". Return a `COUNT(*)` over the same
  conditions, in one `batch()` with the page query — the idiom `labellingBatchHandler`
  already uses for `remaining`.
- **The annotator list.** `GET /api/admin/verdicts/annotators` →
  `SELECT annotator_id, source, COUNT(*) FROM verdicts GROUP BY annotator_id, source`.
  Needed to populate a dropdown, and it exposes a real asymmetry: admin annotators are
  email addresses, anonymous ones are opaque `crypto.randomUUID()` session ids. Render
  admin emails as themselves and anon ids truncated (`anon · 3f2c…`), because a dropdown of
  forty raw UUIDs is unusable. This is also the surface that makes ROADMAP M14.4's
  "excluding one bad actor does not mean discarding every anonymous contribution" actually
  operable, which is worth noting in the route's own summary.

### Indexes

`verdicts` currently has `idx_verdicts_prediction` and `idx_verdicts_source` only. Filtering
by `created_at` or `annotator_id`, plus `ORDER BY v.id DESC`, is a full scan of `verdicts`.
Fine at today's row count and a growing cost later — the same shape as the queue-depth gauge
problem. Add when the table justifies it, not pre-emptively:

```sql
CREATE INDEX idx_verdicts_created   ON verdicts (created_at DESC);
CREATE INDEX idx_verdicts_annotator ON verdicts (annotator_id);
```

### Web

`Annotations.tsx` holds `source` in a `Tabs` and resets `offset` on change, with a comment
explaining why: *"A filter change is a new question, not a continuation of the old one."*
That rule must extend to **every** new filter — a stale offset under a changed filter pages
into rows the number no longer describes. Worth a single `setFilters` helper that always
resets offset, so it cannot be forgotten per-control.

Keep `source` as tabs (it is §Q10's authority tier, not a mere attribute — the existing
comment makes that argument and it still holds). The rest belong in a filter bar: selects
for class, video, verdict, annotator; a date range for time. Show active filters as
removable chips with the result count, so an empty table is self-explaining.

---

## B — verdict preview

Click a row, get the frame with boxes drawn.

### API

Two gaps in the current response:

- It returns `v.adjusted_*` but **not** the prediction's original box. A preview that shows
  only the adjusted box cannot show what the detector proposed, which is the interesting
  comparison. Add `p.x_min, p.y_min, p.x_max, p.y_max` and `p.confidence` — same joins,
  no new reads.
- No image URL. Use the **proxy**: `GET /api/admin/image?key=…`, via the existing
  `proxyUrl()` helper. This is precisely §Q25's amendment reasoning — presigning earns its
  keep for M13.4's couple-hundred-image labelling session; one frame opened on demand is
  inside the noise, and the proxy needs no signing credential, so the preview works even in
  a deployment with no R2 S3 key configured. Do **not** add presigning here.

### Web

Render in a `Dialog` (already in `components/ui`). Draw two overlays on the frame: the
proposed box and, when `verdict = 'adjust'`, the adjusted box, visually distinct and
labelled. For `reject`, show the proposed box marked rejected.

`VerificationCard.tsx` already positions boxes as percentage-offset absolute divs
(`left: ${box.x_min * 100}%` etc.), but that rendering is entangled with drag state,
staging and adjustment handlers. **Extract a read-only `BoxOverlay`** taking a frame URL and
a list of `{box, label, variant}`, then have both `VerificationCard` and the new preview use
it. One box renderer, not two — otherwise the two drift and only one gets fixed when
coordinate handling changes.

**In-bounds check:** §Q19's "Do not rebuild Grafana inside `/admin`" draws the line at D1
business data versus OTel system data. Verdicts, classes and frames are business data, so
filters and previews over them sit on the correct side. Nothing here reads latency,
throughput or queue depth.

---

## Suggested order

1. **C's diagnostic**, then whichever fix it points at. Smallest, and it is the one actively
   annoying somebody.
2. **B**, including the `BoxOverlay` extraction. Self-contained, and the extraction makes A's
   filter work easier to review by keeping the diff off the rendering path.
3. **A**, filters last — the largest surface and the one that benefits from the count
   endpoint and annotator list existing as their own reviewable pieces.
