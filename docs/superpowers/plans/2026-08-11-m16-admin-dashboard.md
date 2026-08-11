# M16 — Admin dashboard proper

**Status:** planned 2026-08-11 · **Milestone:** M16 (v3) · **Design record:** `CONTEXT.md` §Q19

A restructuring milestone, not a capability one. Everything `/admin` can do today it
still does afterwards; what changes is that it stops being one scrolling page of six
stacked sections and becomes a shell with a sidebar, routed sub-pages, and a login
screen that a browser can actually land on.

Two capabilities are genuinely new, and both are **reads**: a list of the verdicts an
admin has submitted, and a browsable frame grid per video. Neither needs a migration.

## The scope line, and where it is drawn

The one requested feature deliberately left out: **re-running the detector over more
frames of a video to seed the verification pool.** It looks like a page and is not.

- `idx_jobs_one_prelabel_per_video` (migrations 0005, 0007, 0008) is a UNIQUE index —
  one `prelabel` job per video, ever.
- `completeJobHandler` (`apps/api/src/routes/jobs.ts`) enqueues that job automatically
  when the last `chunk` for a video finishes, guarded by its own `NOT EXISTS`.
- Sample size is worker-side (M11.3, default 200). The job row carries no sample
  parameter; the worker draws its own sample and stamps `images.selection_reason`
  at report time, not at selection time.

A re-run therefore needs a migration, an admin enqueue route, a Go worker change that
samples only frames not already sampled, and an answer to the provenance rule §Q19
states in its own words — thresholds get stamped onto the rows they produced, or the
dataset becomes an unrecorded mixture of regimes. That is a milestone with a worker
release in it, and the new-job-kind rollout order applies (a job queued before the box
updates fails terminally; it does not wait).

M16 ships the **read** half: `/admin/detection` shows prelabel coverage per video —
how many frames exist, how many were sampled, under which model, when — so the page
that will grow a button already tells the truth without one.

## Auth: a login screen for an auth scheme with no login form

Auth is Cloudflare Access (§Q19). There is no password to collect and no session this
app mints. Login is a top-level navigation to `/api/admin/login`, which Access
intercepts; `fetch` cannot do it, because the redirect chain crosses to
`mkcarl.cloudflareaccess.com` and dies on CORS before a status is observable.

So `/admin/login` is a **gate screen**: product name, one line of copy, one button that
does `location.assign("/api/admin/login")`. It is honest about what it is.

Knowing *whether* to show it needs one new endpoint. Nothing today returns identity —
`requireAccess` sets `adminEmail` in context and only `admin-verdicts` and
`admin-dryruns` read it. `GET /api/admin/session` returns `{ email }` behind the same
middleware, 401 otherwise; the layout route probes it once and redirects on failure.

**This is cosmetics and must be described as cosmetics.** §Q19's "gate the API, not the
UI route" is unchanged: every `/api/admin/*` endpoint still verifies independently, the
admin bundle is still assumed public, and a client-side redirect protects nothing. What
it buys is that an unauthenticated browser lands somewhere with a button instead of on
a shell full of failed requests — which is what `SessionExpiredBanner` was doing the
long way round.

## Information architecture

`/admin` redirects to `/admin/dashboard`. Sidebar is persistent, light-themed.

| Route | Content | New? |
|---|---|---|
| `/admin/login` | Access gate screen | new |
| `/admin/dashboard` | placeholder — the word, nothing more | new, deliberately empty |
| `/admin/videos` | `SubmitForm` + `JobList` | moved |
| `/admin/videos/:id` | frame grid: image, timestamp, prediction count, verdict state, public-sample toggle | new |
| `/admin/verify` | `LabellingSession`, full width | moved |
| `/admin/annotations` | `LabellingStats` block + the admin's own verdicts, paginated | new + moved |
| `/admin/detection` | prelabel coverage per video (read-only) | new |
| `/admin/classes` | `AddClassForm` + `ClassRoster` (dry-run panel stays nested per class) | moved |
| `/admin/snapshots` | `SnapshotPanel` | moved |

The dashboard is a placeholder on purpose. A metrics page that guesses at which numbers
matter is worse than an empty one, and §Q19 already forbids the obvious filling —
system metrics belong to Grafana, and two dashboards that disagree will disagree at the
worst moment. The Grafana link moves into the sidebar footer.

`LabellingStats` lands on `/admin/annotations` rather than the dashboard because "what
did I label" and "how much is labelled" are one question asked twice.

## API additions

Three routes, all `GET`, all behind `requireAccess`, none touching the schema.

1. **`GET /api/admin/session`** → `{ email }`. Reaching the handler is the answer.
2. **`GET /api/admin/verdicts?limit&offset&source`** → the verdict rows joined to
   prediction, image and class, newest first. `verdicts` is append-only and carries
   `source` and `annotator_id` already; the route filters on `source` rather than on
   the caller's email, because "what did I submit" and "what did anonymous visitors
   submit" are the same page with a filter, and §Q10's two-tier split is the only
   distinction the schema makes.
3. **`GET /api/admin/videos/{id}/images?limit&offset`** → frames for one video with
   prediction counts and verdict state. `listVideoImages` already exists and is **not
   reusable**: it is a worker route that requires `worker_id` and proves a held lease
   (`idx_jobs_one_prelabel_per_video`) before it answers. A browser has neither.

Frame bytes keep going through `GET /api/admin/image` — the Access-gated proxy §Q25's
amendment in `admin-images.ts` already argues for. A grid of frames per video is the
same request shape as the dry-run grid that route was built for.

Pagination is `limit`/`offset` rather than a cursor. The tables are small, the caller is
one operator, and D1's bound-parameter ceiling (100 per statement) is nowhere near.

## Components: shadcn/ui

Radix primitives, copied in, styled with the Tailwind 4 already here. Not Radix Themes:
it ships its own token system and would fight `styles.css` and the landing design
language for control of the palette.

Needs, in `apps/web`: the `@/*` path alias in both `tsconfig.json` and `vite.config.ts`,
`components.json`, and the CLI's runtime deps (`class-variance-authority`, `clsx`,
`tailwind-merge`, `lucide-react`, `radix-ui`). Generated components land in
`src/components/ui/` and are ours to edit.

Expected set: `button`, `card`, `table`, `dialog`, `dropdown-menu`, `input`, `label`,
`select`, `badge`, `separator`, `skeleton`, `sonner`, `tabs`, `tooltip`, `sidebar`.

## Light theme without repainting the public pages

`styles.css`'s `@theme` block is dark (`--color-surface` at 21% lightness) and `/` and
`/verify` are public pages built on it. Flipping the tokens globally would repaint them
as a side effect of an admin change.

Tailwind 4 utilities compile to `var(--color-surface)`, so **overriding the same
variable names on a subtree re-colours everything under it**. The admin shell carries a
class that redefines the token values in light, and defines shadcn's own token set
(`--background`, `--foreground`, `--card`, …) alongside them. The public pages are
untouched, and no existing component needs its class names changed to move.

## Order of work

1. shadcn scaffolding — aliases, deps, `components.json`, base components. Nothing
   visible changes.
2. The scoped light theme.
3. The three API routes, with tests.
4. `AdminLayout` — sidebar, session probe, redirect, `<Outlet />` — plus `/admin/login`
   and the route table.
5. Move the six existing sections into their pages. `Admin.tsx` is deleted; the
   components it mounted are unchanged.
6. The three new pages.
7. Restyle the moved components onto shadcn primitives, one at a time, with their tests
   kept green.
8. `ROADMAP.md` M16, `CONTEXT.md` §Q19 amendment, README if the route list appears there.

## What this must not break

- `routes.test.tsx` asserts a heading at `/admin`. It becomes a redirect assertion.
- Every existing component test keeps passing. If restyling a component needs its test
  rewritten, the test was asserting on markup rather than behaviour and the rewrite is
  the point — but the assertion must not get weaker.
- `/` and `/verify` render identically before and after. They are the public surface.
- The bundle-size tripwire in `vite.config.ts` is 600 kB against a current ~552 kB. A
  component library plus five new pages will cross it. Raise it deliberately, in the
  same commit that crosses it, or split the admin bundle — not by discovering the
  warning later and silencing it.
