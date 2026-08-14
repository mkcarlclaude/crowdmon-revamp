# Video summary page, and a queue page that names the job kind

**Status:** planned 2026-08-14 · **Milestone:** M19 (v3) · **Design record:** `CONTEXT.md`
§Q19 (admin surface), §Q25 (frame bytes) · **Amends** `ROADMAP.md` M16.6 and
`docs/superpowers/plans/2026-08-11-m16-admin-dashboard.md`

Three changes to the admin information architecture, no schema change and no worker
release. Everything shown here is already in D1 or already on the wire; what is missing
is a place to read it.

- **A — `/admin/videos/:id` grows a summary header.** One new admin read route
  (`GET /api/admin/videos/{id}`) carrying the `videos` row's own YouTube-derived
  metadata plus the per-video aggregates, above the existing frame grid.
- **B — `/admin/videos` becomes the video list, and `/admin/detection` folds into it.**
  Today `/admin/videos` is a submit form and a queue, with no list of videos on it at
  all; the only path to a video's own page is the detection table. One list, one place.
- **C — `/admin/queue`, flat.** Every job kind visible and labelled, including the two
  kinds the current grouped list renders as if they were chunks and the one it drops
  entirely.

Order: **A, then B, then C.** A is the only one with an API change and is what makes B's
fold defensible (the per-video detail is where "how far along is this video" now lives).
C touches no file A or B touches except the nav table and `queries.ts`.

**Decided before planning** (Carl, 2026-08-14): no migration — YouTube metadata is
whatever the `videos` row already holds; detection folds into the video list; queue is
flat, not grouped.

---

## What already exists, and what is therefore not a new capability

`videos` (migration 0001) already carries `title`, `duration_seconds`, `width`, `height`,
`url` and `created_at`. The Go worker writes all four of the first at fan-out
(`worker/internal/queue`, asserted in `queue_test.go:306`), from yt-dlp and ffprobe. None
of `duration_seconds`, `width`, `height` or `url` is on any API response today. That is
the whole of "stats from YouTube" available without a migration — no view count, no
channel, no upload date, no description. Adding any of those is a migration plus a
fan-out payload change plus a worker release, and every already-downloaded video would
read null until re-downloaded. Explicitly out of scope.

`GET /api/admin/jobs` already returns `kind`, `status`, `attempts`, `claimed_by`,
`heartbeat_at`, `created_at`, `failure_reason` and the chunk's `segment_index` for every
job, and already accepts `?status=` and `?limit=`. `JobList.tsx` discards two things
from that: it never renders `kind` (it infers download-vs-chunk from the grouping, so a
`prelabel` or `dryrun` job renders as a nameless row under its video), and it filters
out every job with a null `video_id`, which is every `snapshot` job. C is mostly
un-hiding what the poll already fetches.

---

## A — Video summary

### A1. `GET /api/admin/videos/{id}` — new route

`apps/api/src/routes/admin-video-detail.ts`, registered in `app.ts` behind
`requireAccess` like every other `/api/admin/*` route.

Not an extension of `listVideos`. That route computes one row per video for a picker and
a table, and M16's `AdminVideo` is already carrying three fields it grew for a second
screen; the aggregates below are per-video-only work (`predictions`, `verdicts` and a
per-frame rollup) that no list of fifty videos should be paying for on every dry-run
form mount. Separate route, separate cost.

**404 or empty?** 404 for an unknown id, unlike `listAdminVideoImages`, which returns an
empty page on purpose. The distinction is real: an empty *page of frames* is a true
answer about a video that exists and has none, but there is no honest summary of a video
that was never submitted — every field would be a null pretending to be a fact. Route
declares `404: errorResponse(...)` and the page renders it.

**Response** — `AdminVideoDetail` in `schemas.ts`:

| field | source | notes |
|---|---|---|
| `id`, `url`, `title`, `created_at` | `videos` | `title` nullable — null until the download job reports it |
| `duration_seconds`, `width`, `height` | `videos` | all nullable; null before the download job completes |
| `image_count` | `COUNT(images)` | |
| `frames_sampled` | `images.selection_reason IS NOT NULL` | same definition `listVideos` uses, and for the reason `AdminVideo`'s comment gives — not "frames carrying a prediction" |
| `public_samples` | `images.public_sample = 1` | |
| `predictions` | `COUNT(predictions)` via `images` | |
| `frames_with_predictions` | rollup | the denominator of the verification pool |
| `frames_verified` / `frames_unverified` | rollup | same `verdict_state` definition `admin-video-images.ts` already encodes; see A2 |
| `model_id`, `prelabelled_at` | newest prediction | argmax, same shape `listVideosHandler` uses — `ROW_NUMBER() … ORDER BY created_at DESC, id DESC`, not `MAX(model_id)` |
| `jobs` | `jobs` for this video | `{ download: status \| null, chunks_total, chunks_done, chunks_failed, prelabel: status \| null }` |

`jobs` is a summary, not rows — the rows are what C's page is for, and a second full job
list on this page would be a second thing to keep consistent with it. What the summary
answers is "is extraction finished", which is `chunks_done` against `chunks_total`.

### A2. The SQL, and what it must not cost

One `DB.batch` of four statements, one round trip:

1. `SELECT id, url, title, duration_seconds, width, height, created_at FROM videos WHERE id = ?`
2. images rollup — one pass over this video's frames:
   ```sql
   SELECT COUNT(*) AS image_count,
          SUM(CASE WHEN selection_reason IS NOT NULL THEN 1 ELSE 0 END) AS frames_sampled,
          SUM(CASE WHEN public_sample = 1 THEN 1 ELSE 0 END) AS public_samples
     FROM images WHERE video_id = ?
   ```
3. predictions + verdict rollup, driven off `predictions` joined to `images` by primary
   key, **not** off `images` with a correlated subquery per frame. This is the exact trap
   `listVideosHandler`'s comment documents at length: a per-image probe into
   `idx_predictions_image` costs one lookup per *frame* (mostly misses) instead of one
   pass over the much smaller `predictions` table. `admin-video-images.ts` uses the
   correlated form legitimately — it is already limited to 24 rows — and that form must
   not be copied here, where the predicate is the whole video.
   ```sql
   SELECT COUNT(*) AS predictions,
          COUNT(DISTINCT p.image_id) AS frames_with_predictions,
          COUNT(DISTINCT CASE WHEN v.id IS NULL THEN p.image_id END) AS frames_unverified
     FROM predictions p
     JOIN images i ON i.id = p.image_id
     LEFT JOIN verdicts v ON v.prediction_id = p.id AND v.source = 'admin'
    WHERE i.video_id = ?
   ```
   `frames_verified = frames_with_predictions - frames_unverified`, computed in the
   handler rather than in a fourth aggregate.
   `source = 'admin'` in the join condition, not a `WHERE` — an anon verdict must not
   make a frame count as ruled, and must not drop the row either. This mirrors
   `verdictState()` in `admin-video-images.ts`, which is the definition the frame grid
   below the header already displays; if these two ever disagree the page contradicts
   itself in one screen.
4. jobs summary:
   ```sql
   SELECT kind, status, COUNT(*) AS n FROM jobs WHERE video_id = ? GROUP BY kind, status
   ```
   Folded into the `jobs` object in the handler. **There is no index on `jobs.video_id`**
   (migrations 0001/0005/0007/0008 index `(status, kind, id)` and `heartbeat_at` only),
   so this scans `jobs`. Acceptable — `jobs` is thousands of rows, not millions, and this
   is one scan on a page load, not per-row work — and deliberately *not* fixed here,
   because adding an index is a migration and this plan has none. Note it; revisit if
   `jobs` grows an order of magnitude.

`model_id`/`prelabelled_at` ride along on statement 3 as a fifth and sixth column? No —
an argmax does not compose with the aggregate above it. Take them from a fifth statement
in the same batch, or drop them from this route and let the header read them from the
list query the page already has cached. **Recommendation: fifth statement.** The page
must be correct on a hard refresh at `/admin/videos/:id`, where no list query has run.

### A3. `/admin/videos/:id` header

Above the existing grid, which is otherwise untouched.

- **Poster.** `https://i.ytimg.com/vi/<id>/hqdefault.jpg` — no API key, no migration.
  It is an external request from an admin page, so it tells Google which video an
  authenticated admin is looking at; that is the same video the admin submitted from
  YouTube, so the leak is nominal, but it is a leak and the alternative exists: the
  first frame this system extracted, which is already in R2 and already presignable by
  `frameUrls`. Ship the ytimg thumbnail (zero API work), and record the alternative in
  the component comment rather than leaving the choice invisible.
- **Title** as the heading, video id in mono beneath it, and an external link to `url`.
  Today the heading is the raw id; the id stays visible because it is the primary key
  everything else in the system names.
- **A stat row**, not a table: frames extracted · sampled · predictions · verified /
  unverified frames · public samples · duration · resolution · submitted.
  `RelativeAge` for submitted-at, consistent with the queue.
- **Extraction progress** — `chunks_done`/`chunks_total`, plus a failed count when
  non-zero, and the download job's status while it is still the only job. Suppressed
  entirely once `chunks_done === chunks_total && chunks_failed === 0`: a finished video
  does not need a progress bar reporting completeness forever.
- Nulls render as `—`, never as `0` or `unknown`. A video mid-download has no duration
  yet, and that is different from a duration of zero.

Reuses the `Card`/`Badge` primitives already in `components/ui/`. No new colour tokens:
`STATE_COLOR` in `VideoDetail.tsx` and `STATUS_COLOR` in the job list are the same three
hues, and a fourth palette for stat tiles is exactly what that file's existing comment
argues against.

### A4. Tests

- `apps/api/test/workers/admin-video-detail.test.ts` — seeded via `labelling-seed.ts`:
  a video with frames, some sampled, some predicted, some ruled by an admin and some
  ruled by an anon; assert `frames_verified`/`frames_unverified` treat the anon verdict
  as *not* ruling, which is the one thing this rollup can get quietly wrong.
- 404 for an unknown id. 401/403 through the standard `admin-identity.ts` helper.
- `apps/web/test/components/AdminVideoDetail.test.tsx` (exists) — extended for the
  header: title rendered, `—` for a null duration, progress hidden when chunks are done.

---

## B — `/admin/videos` becomes the list; `/admin/detection` folds in

### B1. The page

`Videos.tsx`: `SubmitForm`, then the video table currently living in `Detection.tsx`,
with `created_at` added as a "submitted" column and `image_count`/`frames_sampled`/
`model_id`/`prelabelled_at` unchanged. `useVideos()` already returns every one of these;
no API change.

`JobList` comes off this page (C replaces it). `SessionExpiredBanner` currently reads
`useJobs()`'s error *from this page* precisely because that query polls; with the poll
gone, the banner moves to `/admin/queue` and this page passes `useVideos().error`
instead. A page whose only query never refetches cannot detect a session that expires
mid-visit, and pretending otherwise is worse than not showing the banner — so the banner
lives where the polling does.

### B2. Deleting `/admin/detection`

- `Detection.tsx` and `AdminDetection.test.tsx` deleted; the nav item removed.
- `/admin/detection` becomes `<Navigate to="/admin/videos" replace />` rather than a
  404. Links to it exist in this repo's own docs and in issue #140.
- **The comment survives the file.** `Detection.tsx`'s header comment carries the M16.6
  scope line — *why there is no re-run button*: a migration, an admin enqueue route, a
  worker change that samples only unsampled frames, and CONTEXT.md §Q19's provenance
  rule. That reasoning is the reason the page exists and is not a fact about a file
  name. It moves verbatim into `Videos.tsx`'s header comment. Deleting it would leave
  the next person to rediscover the cost of a button that looks like an afternoon.
- M17's on-demand prelabel plan
  (`2026-08-12-on-demand-prelabel-and-single-frame-dryrun.md` §B) is the milestone that
  eventually *does* grow that button, and it assumes a coverage table to hang it on.
  This fold moves it to `/admin/videos`; that plan's §B references need the new location
  noted when it is picked up.

### B3. Docs

- `ROADMAP.md` M16.6's checklist keeps its history (it shipped) and gains an amendment
  line: the coverage table folded into `/admin/videos` in M19, `/admin/detection`
  redirects.
- New `## M19` section under `# v3` with A/B/C as its checklist.
- `docs/FLOWS.md:354` names `/admin/detection` in the dry-run sequence diagram
  (`A->>SPA: /admin/detection — edit a candidate prompt, "try it"`) — retarget it.
  Parse the diagram with mermaid's own parser after editing, not by eye: a `;` in
  sequence-diagram message text is a statement separator and breaks the render silently.
- `CONTEXT.md:880` describes what `/admin/detection` shows, as part of a §Q19 argument
  about what the surface makes explicit. The argument survives the fold unchanged; only
  the route name in it moves.

### B4. Tests

`routes.test.tsx` gains the redirect assertion. `AdminDetection.test.tsx`'s table
assertions move into a new `AdminVideos.test.tsx` (today `Videos.tsx` has no test of
its own — it is covered incidentally by `JobList.test.tsx` and `SubmitForm.test.tsx`,
and after C removes the first of those it would have none).

---

## C — `/admin/queue`

### C1. The page

New nav item between Videos and Verify. New `components/JobTable.tsx`; `JobList.tsx` and
`JobList.test.tsx` deleted — its group-by-video tree answered "how far along is this
video", which is now A's extraction-progress line, on the page that video owns.

One flat table, newest first (`ORDER BY j.id DESC`, which the API already does), columns:

`status` badge · `kind` badge · `#id` · video (a `Link` to `/admin/videos/:id`, or `—`
for a snapshot job) · segment (chunk jobs only) · attempts · `claimed_by` · heartbeat age
· created age · failure reason.

- **`kind` gets a neutral badge, not a fifth colour.** Status already owns the palette
  (`--color-pending`/`claimed`/`done`/`failed`), and two colour scales in one row is a
  row nobody reads at a glance. `dryrun` renders as "dry-run"; every other kind renders
  as its own name.
- **No `video_id` filter and no grouping.** Snapshot jobs stop being invisible — the
  current filter drops them silently, which means the one job kind with no video is the
  one an operator cannot see running. `SnapshotPanel` on `/admin/snapshots` keeps its
  own view of snapshot *artifacts*; this page shows the job.
- **Status filter chips** — all / pending / claimed / done / failed — passed through to
  `?status=`, which `JobListQuery` already accepts and `listJobsHandler` already binds.
  Default: all. "Currently running" is `claimed`, one chip away, and claimed rows are
  the ones with a live heartbeat age, which reads as movement on a 5s poll.
- **No summary counts.** A "12 pending / 3 claimed" strip computed from the 50-row page
  would be a count of the page, not of the queue, and would silently lie the moment the
  queue is longer than the limit. Getting honest totals means a `COUNT(*) GROUP BY
  status` on the API, which is a route change this plan does not need.

### C2. `useJobs`

Takes an optional status: `useJobs(status?: JobStatus)`, key `["jobs", status ?? "all"]`,
`refetchInterval: 5_000` unchanged. Every existing caller passes nothing and keeps
today's behaviour. Note that switching chips changes the query key, so the first render
after a chip click is a fresh fetch — acceptable at this size, and TanStack keeps the
previous page's data unless `placeholderData` is set, which it should not be here (a
stale list under a new filter is a list that looks wrong for one tick).

### C3. Tests

`apps/web/test/components/JobTable.test.tsx` — replaces `JobList.test.tsx`. Assert what
the old component could not: a `snapshot` job appears at all, a `prelabel` and a `dryrun`
job each render their own kind label, and a status chip changes the fetched URL.
`routes.test.tsx` gains `/admin/queue`.

---

## Deliberately not in this plan

- **Any migration.** No new `videos` columns, no `idx_jobs_video`, no job-kind changes.
- **View counts, channel, upload date, description.** Migration + worker release; see
  the second section above.
- **A re-run/prelabel-more button.** Still M17 §B's, still costed there.
- **Honest queue totals.** Needs a `GROUP BY status` route; C1 says why the fake version
  is worse than none.
- **Anything on `/admin/dashboard`.** It is a deliberate placeholder and its own comment
  forbids filling it because it looked empty. A video summary is a per-video page; it is
  not an argument for a global one.

## Verification

`pnpm typecheck && pnpm lint && pnpm test` (CI's own commands, `README.md` §"Working on
it"). No Go change, no container build, so neither `go test` nor the detector image is
touched by this work.
