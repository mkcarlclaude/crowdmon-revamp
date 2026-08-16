# The landing page, and contributors with accounts

**Status:** planned 2026-08-16 · **Milestone:** M20–M22 (v4) · **Design record:**
`CONTEXT.md` §Q7 (why Access is not user auth), §Q10 + §12 (annotator tiers), §Q11
(public surface), §Q25 (frame bytes) · **Amends** `CONTEXT.md` §7 "Who annotates",
§Q11, `PRD.md` §9 and its falsification table, `ROADMAP.md` "Deferred past v2"

Three changes that together turn a thin public surface into a product a stranger can
land on, understand, and contribute to with their name attached.

- **A — The landing page.** Port the settled design at `design/landing-prototypes`
  (`landing-hero.html`) to React at `/`. No new API.
- **B — Contributor accounts.** Google OAuth in the Worker, sessions in D1, Turnstile
  on the signup path. A third `verdicts.source` value, `'user'`.
- **C — Contributed verdicts become labels.** The snapshot's inclusion policy stops
  being admin-only. Admin verdicts win; a trusted contributor's verdict fills a gap no
  admin has ruled on.

Order: **B, then C, then A** — despite A being the headline. A's nav has a "Sign in"
control and its hero copy makes a promise about contributing; building it first means
building it twice. C is a one-constant, one-subquery change once B exists.

**Decided before planning** (Carl, 2026-08-16):

| Question | Decision |
|---|---|
| Do contributor verdicts enter snapshots? | **Yes** — they are labels, not just counts |
| Conflicts | Admin wins outright; users fill gaps only; latest user wins among users |
| Bad actors | Admin approves an **account** once (one boolean), not each verdict |
| Auth | Google OAuth in the Worker + D1 sessions; no managed provider |
| Anonymous `/verify` | Unchanged — keeps writing `source='anon'`, still excluded |
| Landing design | Port the prototype faithfully; do not reopen the direction |

---

## The decision this plan reverses, stated plainly

`CONTEXT.md` §7 and its §12 amendment say **two tiers, admin and anonymous, with
nothing in between**, and name the exact reason: admitting untrusted labels is the
single decision that forces consensus resolution, agreement scoring, trust weighting
and inter-rater reliability into scope. A third tier whose verdicts become labels is
that decision.

What keeps the four refused subsystems out is that **nothing here resolves a
disagreement between equals.** The ordering is total and static — admin, then trusted
user by recency — so there is never a tie to arbitrate. Trust is one boolean an admin
sets on a person, not a score derived from how often they agree with anyone. If a
future milestone wants two contributors' rulings weighed against each other, that is
where those subsystems come back, and this plan does not smuggle them in early.

The two properties §7 relies on to make the tier reversible are untouched: verdicts
stay **append-only rows referencing an immutable prediction**, and accept/adjust/reject
rates stay **computed per source**. Excluding a contributor later remains a `WHERE`
clause. `'user'` is a third value in the per-source split, not a merge into `'admin'`.

**Docs this falsifies, which §C4 rewrites rather than quietly leaves standing:**
`PRD.md` §9's *"authoritative for an admin"* clause and the falsification-table row
under it; the v2 acceptance run in `README.md`, whose evidence is *"`label_count` is
exactly 21 (19 + 2), so neither the anon verdicts nor a single admin reject leaked
in"* — still true of that snapshot, and no longer a description of the rule.

---

## What already exists, and is therefore not new capability

- `verdicts` (migration 0003) has `source TEXT NOT NULL CHECK (source IN ('admin',
  'anon'))` and `annotator_id TEXT NOT NULL`. The CHECK is the only obstacle to a third
  tier; the identity column already exists and already holds two different kinds of
  string (an Access email, an opaque session id).
- `VerificationCard` was built as one component with two mounts and has no endpoint
  knowledge (M13.1). A third mount is a props object, not a fork. `allowAdjust` already
  exists as the capability flag M14 used to deny anonymous visitors the adjust tool.
- `/api/public/frame` and `/api/public/images/{id}/verdicts` (`public.ts`) already serve
  a curated pool with signed URLs and rate limiting. The contributor endpoints are these
  two with an identity and a wider frame pool, not a new subsystem.
- `jose` is already a dependency (it verifies the Access JWT). Google's OIDC `id_token`
  is verified with the same library against a different JWKS.
- `PUBLIC_RATE_LIMITER` (wrangler.toml) already exists and is keyed per `(ip, route)`.
- The landing design is settled and prototyped. `design/landing-prototypes` commit
  `e3bf8cc`, file `landing-hero.html`.

---

## A — The landing page

### A1. Bring the prototype into the app

Port `landing-hero.html` from `design/landing-prototypes` to `apps/web/src/pages/Home.tsx`
(27 lines today, a placeholder). Faithfully — the direction survived four rejected
alternatives and the reasoning is recorded in the design memory, not re-derivable from
the markup.

Load-bearing properties, each of which was a deliberate choice:

- **Hero is a world, not a section.** Full-bleed real frame at `100svh`, floating pill
  nav over it, pipeline state as chips *inside* the scene (`frame 00226 extracted`,
  `awaiting a human verdict`), then a **hard seam** into a calm warm off-white document
  body. Reference: <https://cofounder.co>.
- **Magenta `#e5326f` is reserved** for detection boxes, chips and one CTA. It was
  chosen because the frames are pastel anime blues and greens and magenta is the one hue
  that does not collide. Do not spend it on anything else.
- **Mono means a machine produced it; sans means a person wrote it.** Hold that rule.
- **Cabinet Grotesk + Satoshi, self-hosted from Fontshare.** Not Google Fonts. Swapping
  the typeface did more to kill the generated look than any layout change. Self-hosting
  is required anyway — the Worker serves the SPA and there is no CDN allowance in this
  design.
- **Show the real predictions, including the wrong ones.** Confidences really are
  0.10–0.20 and most boxes really are wrong. A reader seeing the machine be wrong before
  reading a word *is* the argument for the human step. Never render a fake confident
  detection; this is the obvious way for the page to rot.

**The blocking feedback that produced this design was "looks very AI made."** The tells,
stacked: near-black background, one saturated accent, radial glow behind the hero,
white-to-grey gradient-clipped headline, badge pill above the headline, bento grid,
Google geometric sans, evenly spaced cards with hover lift. Any one is survivable;
together they read as machine-assembled. Reintroducing any of them undoes the milestone.

### A2. Audience, and therefore copy

`/` is read by a friend, by HR, or by a recruiter with no data literacy. It cannot lead
with "labelled dataset built by a data flywheel." The hook is the effort story from
`PRD.md` §9 — *hour ten cost exactly what hour one cost* — and the page's job is to make
verify-not-draw legible as the answer to it.

### A3. What the nav gains

One "Sign in" control, and a primary CTA that points at contributing rather than at the
anonymous demo. The anonymous demo stays reachable and stays honestly labelled as a
demo: a visitor should not discover only after signing up that the thing they already
did did not count.

### A4. Frames on a public page

The hero frame is a static asset committed with the page, not a live
`/api/public/frame` call. Three reasons: the hero must render before any fetch resolves
or the seam flashes; a signed URL expires and this page is cached; and §Q11's rejected
"public gallery of labelled crops" stays rejected by there being exactly one curated
frame here rather than an endpoint the page pulls from. The prototype's frames are
already real output — reuse those bytes.

`noindex` is **not** set on `/`. It is set on `/verify` today for §Q25's reasons, and
those reasons are about frame bytes, not about the landing page. `/` should carry Open
Graph tags instead: §Q11's honest read is that the distribution channel is a link pasted
into Discord or Reddit, which cares about the preview card and not about crawler rank.

### A5. Tests

- The page renders without a query client (it fetches nothing).
- Open Graph and `<title>` tags are present; `/` is not `noindex`.
- Fonts resolve from a self-hosted path, not from `fonts.googleapis.com` — a network
  reference here would be a CSP violation in production and a silent fallback locally.

---

## B — Contributor accounts

### B1. Migration 0012 — `users`, `sessions`, and a third source

Four statements. D1 allows one `ADD COLUMN` per `ALTER TABLE`.

```sql
CREATE TABLE users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub   TEXT NOT NULL UNIQUE,   -- the OIDC subject, stable per Google account
  email        TEXT NOT NULL,          -- display + admin recognition; NOT the identity
  display_name TEXT,
  trusted      INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,         -- opaque, 256 bits from crypto.getRandomValues
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
```

**`google_sub` is the identity, not `email`.** A Google account's email can change and
be reassigned within a Workspace domain; `sub` cannot. Matching on email is the standard
way to hand one person's contributions to another.

**`trusted` defaults to 0.** Anyone can sign up, verify immediately and watch their own
count rise; their verdicts enter snapshots only once an admin flips the boolean. That is
the bad-actor answer, and it is one column rather than the four subsystems §7 refuses.

Widening `verdicts.source` to `('admin', 'anon', 'user')` is a **table rebuild** — SQLite
cannot alter a CHECK constraint in place. Read
`memory/d1-ignores-foreign-keys-pragma.md` before writing it: **D1 ignores
`PRAGMA foreign_keys=OFF`,** so the standard twelve-step rebuild recipe silently cascades
child rows away. The fix is ordering, not the pragma. `verdicts` is the child of
`predictions` here and has no children of its own, which makes this the easy direction —
but the recipe must still be written deliberately, and the migration test must assert
row counts before and after, not just that the new value is accepted.

### B2. The OAuth flow

Three routes, all outside `/api/admin` so `requireAccess` does not see them:

| Route | Does |
|---|---|
| `GET /api/auth/google/start` | Mints `state` + PKCE verifier, stores them in a short-lived `HttpOnly` cookie, 302s to Google |
| `GET /api/auth/google/callback` | Verifies `state`, exchanges the code, verifies the `id_token` via `jose` against Google's JWKS, upserts `users` by `google_sub`, creates a `sessions` row, sets the session cookie, redirects to `/contribute` |
| `POST /api/auth/logout` | Deletes the `sessions` row and clears the cookie |

Non-negotiables, each of which is a known way this goes wrong:

- **Verify the `id_token`'s `iss`, `aud` and signature.** `aud` must equal this app's
  client id. The Access middleware's own comment already explains why an unchecked
  audience is the load-bearing failure: every application in one issuer's world is signed
  by the same keys.
- **`state` is mandatory** and single-use. PKCE too, even though this is a confidential
  client — it costs one hash and closes code interception.
- **Session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.** `Lax` rather than
  `Strict` so the post-OAuth redirect arrives authenticated.
- **The session id is opaque and random**, checked against `sessions` on every request.
  Not a JWT: logout must actually revoke, and a self-verifying token cannot be revoked
  without the lookup a session row already is.
- **The redirect target is hardcoded**, never read from a request parameter. §Q19
  records this exact bug class: the one endpoint guaranteed to be reached with a freshly
  minted session is the worst possible open redirect.
- **`CLIENT_SECRET` is a `wrangler secret`**, never in `wrangler.toml`. Note that file's
  own warning about TOML table scoping — a bare key appended below a table lands *inside*
  it, which is how `ACCESS_AUD` once made every admin request 503.

**Turnstile** on `/api/auth/google/start`. It stops scripted mass-signup, which is the
realistic threat; it does not stop a human who signs up to draw bad boxes, and `trusted`
is what handles that one.

**Expired sessions are deleted by the existing reaper cron**, not by a new schedule.
`idx_sessions_expires` is what makes that a cheap sweep.

### B3. `requireUser`, alongside `requireAccess`

A second middleware, in `apps/api/src/middleware/session.ts`. Reads the cookie, joins
`sessions` to `users`, rejects an expired row, and sets `c.set("user", ...)`.

It must **not** be composed with `requireAccess`. The two answer different questions and
`app.ts` registers `requireAccess` by path prefix — the contributor routes live under
`/api/contribute/*` precisely so that prefix does not catch them. An admin is not
automatically a contributor and does not need to be: the admin has `/admin/verify`.

### B4. The contributor surface

`/contribute`, a third mount of `VerificationCard` — the mount M13.1 predicted.

| | Admin `/admin/verify` | Contributor `/contribute` | Anonymous `/verify` |
|---|---|---|---|
| Frame pool | Everything unruled | Everything unruled | Curated `public_sample` |
| `allowAdjust` | yes | **yes** | no |
| Missing-object report | yes | no | no |
| Verdict source | `admin` | `user` | `anon` |

Contributors get the adjust tool because their verdicts are labels; a tier whose
corrections cannot be recorded would be a tier that can only say "wrong" — and §7's
`missing_reports` note explains why "wrong" with nowhere to go is the weakest signal in
the system. Missing-object reports stay admin-only: they name a class from the roster
and are an authoring act, not a verification one.

`/contribute` uses the whole unruled pool rather than the curated one. §Q25's three
bounds exist because *anonymous* frame serving is the thing that resembles the rejected
public gallery; a signed-in, rate-limited, named account is a different exposure, and
restricting contributors to the ~curated pool would cap contribution at the size of a
hand-curated list.

### B5. The contribution metric

`GET /api/contribute/me` → the signed-in user's own counts: verdicts by kind, frames
touched, and whether they are `trusted`.

**Personal only. No leaderboard, no cross-user comparison, no public statistics page.**
`ROADMAP.md`'s deferred list rejects leaderboards and a public statistics surface, and
`PRD.md`'s *"checks are internal"* section *reasons from* the absence of the latter —
see `memory/crowdmon-public-stats-rejected.md`, which records this exact surface being
built and reverted once already. A private count of your own work is not that surface.
A page ranking contributors is, and it must not appear in this milestone by accident.

The screen must be honest about `trusted`: someone whose verdicts are recorded but not
yet promoted should be told so, not shown a number that implies more than it means.

### B6. Tests

- `id_token` with a wrong `aud`, a wrong `iss`, an expired `exp`, or a bad signature →
  rejected, four separate cases.
- Missing or mismatched `state` → rejected.
- Two logins for one `google_sub` → one `users` row, session replaced.
- A `google_sub` whose email changed → same user row, email updated.
- Expired session → 401, and the row is swept.
- `/api/contribute/*` with no cookie → 401; with an admin Access JWT and no cookie →
  still 401 (they are different gates).
- Logout revokes: the same cookie replayed afterward → 401.
- Migration 0012: `verdicts` row count identical before and after the rebuild, and every
  pre-existing `source` value survives.

---

## C — Contributed verdicts become labels

### C1. The ordering

Replace `LATEST_ADMIN_VERDICT` (`jobs.ts:1390`) with a rule that is total and static:

1. If any `admin` verdict exists for the prediction, the **latest admin** one wins.
2. Otherwise, if any verdict exists from a **`trusted` user**, the latest of those wins.
3. Otherwise the prediction has no label.

`anon` never participates. An untrusted user's verdicts are recorded and counted and
never reach step 2.

Expressed as one ordered scalar subquery rather than two queries and a merge — a
`CASE` on source giving admin rank 0 and trusted-user rank 1, ordered by rank then
`v.id DESC`, `LIMIT 1`. It joins `verdicts` to `users` for `trusted`, so it is no longer
a subquery over one table; check the plan against the read-amplification shape
`listVideosHandler`'s comment documents, and index `verdicts(prediction_id, source)` if
the snapshot build regresses. **Benchmark the whole snapshot build, not the subquery** —
`memory/measure-cost-not-just-win.md` records a change that made one operation 62×
faster and the enclosing one 12× slower.

The same rule governs **both** statements in `snapshotSourceHandler` — the image
selection and the label projection (`jobs.ts:1464` and `jobs.ts:1471`). They already
share the constant; keep it that way, because two copies that disagree produce a
snapshot whose image list and label list describe different policies.

### C2. The recorded policy

`DEFAULT_INCLUSION_POLICY` (`schemas.ts:1313`) is currently:

```
source=admin; verdict=latest per prediction, accept or adjust; split: selection_reason='random' -> eval, else train
```

It becomes a statement of the ordering above, naming the trusted-account condition. This
string is stamped onto every `snapshots` row and is the whole of M15.3's "inclusion
policy recorded" — a snapshot built under the new rule carrying the old string is a
falsified provenance record, which is worse than no record.

**Old snapshot rows keep their old string** and stay accurate about how they were built.
Do not backfill.

### C3. The pool endpoints

`/api/admin/labelling/batch`'s `UNRULED_BOX` predicate is `source = 'admin'` and **stays
that way**. A contributor's ruling must not remove a box from the admin's queue: the
admin is the tier that overrides, so they must be able to see and re-rule anything. The
contributor pool endpoint gets its own predicate — a box no admin *and* no trusted user
has ruled on — so contributors do not re-do each other's work.

That asymmetry is deliberate and is the kind of thing that reads as a bug in six months.
It belongs in a comment at both definitions.

### C4. Documentation

Not optional, and not a tidy-up at the end — these are the records the project is
verified against:

- **`CONTEXT.md` §7 "Who annotates"** — a v4 amendment beside the existing v2 one,
  stating the third tier, why the four refused subsystems stay refused (a total static
  ordering has no ties to arbitrate), and what would bring them back.
- **`CONTEXT.md` §Q11** — the public surface is no longer thin. Say what it is now.
- **`CONTEXT.md` §Q7** — a note that user auth was revisited in v4 and that Cloudflare
  still has no B2C product; the rejection was correct and remains correct, and the
  resolution is an OAuth client in the Worker. Record that Cloudflare's own IdP (default
  for new Zero Trust orgs since June 2026) was checked and requires each user to hold a
  Cloudflare account.
- **`PRD.md` §9** — the *"authoritative for an admin"* clause and its falsification row.
- **`README.md`** — the v2 acceptance table's label-count evidence gains a note that it
  describes the rule as it stood on 2026-08-10.
- **`ROADMAP.md`** — "Google OAuth and sessions" leaves the deferred list; leaderboards,
  consensus resolution, agreement scoring, trust weighting and a public statistics
  surface **stay on it**, and the entry should say why they survived a milestone that
  looked like it would take them.

---

## Deliberately not in this plan

- **Leaderboards, rankings, contributor comparison, public statistics.** See §B5.
- **Consensus resolution, agreement scoring, trust weighting, inter-rater reliability.**
  The static ordering is what avoids them. They return the day two trusted contributors'
  rulings need weighing against each other.
- **Email/password, magic links, GitHub OAuth.** One provider, one button, no
  account-linking problem. A second provider is a later, additive change.
- **Profile editing, avatars, notifications, per-contributor public pages.**
- **The in-browser detector demo.** Still blocked on there being a trained model — v5.
- **Retro-promoting existing `anon` verdicts.** They were collected under a policy that
  said they would not count, and promoting them would make that statement retroactively
  false.
- **Contributor access to missing-object reports.** §B4.

---

## Verification

Beyond `pnpm test` and `pnpm typecheck` (README "Working on it"):

1. **The OAuth round trip against real Google**, in a browser, once. The unit tests
   cover token rejection; they cannot cover a misconfigured redirect URI or consent
   screen, which is the failure that only appears in production.
2. **A snapshot built with a mixed pool.** One prediction ruled by an admin, one by a
   trusted user, one by an untrusted user, one by anon. Assert `label_count` is exactly
   2 and that the two are the right two. This is the test that would have caught the
   ordering being wrong, and it is the direct descendant of the v2 acceptance run's
   *"label_count is exactly 21"* evidence.
3. **A contributor's box drawn by hand, in a real browser.** `/contribute` mounts the
   same `VerificationCard` whose adjust tool shipped broken twice this week, and
   `CLAUDE.md` "Synthetic pointers cannot reproduce a browser's own gestures" is why
   neither jsdom nor CDP can stand in for this step.
4. **The landing page on a phone**, in both themes, with the hero at `100svh` — `svh`
   rather than `vh` is doing real work there and mobile browser chrome is what it is
   doing it against.
