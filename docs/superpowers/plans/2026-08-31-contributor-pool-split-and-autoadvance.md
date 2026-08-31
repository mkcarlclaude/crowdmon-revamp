# A labelling seat that only ever hands out training frames, and never asks for a click

**Status:** planned 2026-08-31 · **Milestone:** M26.6 (v5) · **Design record:**
`CONTEXT.md` §Q16 (the frozen pool, and why it can never be retro-declared) · **Builds on**
M25.1 (the `shuffle_key` keyset cursor this pool already has server-side) and M24 §C
(`SwipeCard`, the batch walk) · **Unblocks** `2026-08-30-first-trained-model.md`, whose
training set is the thing this milestone stops starving.

---

## The finding

`routes/contribute.ts` never reads `selection_reason`. `CONTRIBUTOR_UNRULED_BOX` filters
on verdicts alone, so the contributor pool serves frozen-pool (`random`) frames and
training (`diverse`) frames interleaved, with nothing to tell them apart.

Measured against production on 2026-08-31, over the winning-verdict label set:

| split | labels | what they feed |
|---|---|---|
| `random` (eval) | **602** | nothing — §Q16 freezes them out of training forever |
| `diverse` (train) | **311** | M27's entire training set |

Two labelling sessions in three produced nothing any model will ever see. They are not
wasted for *scoring* either: the eval instrument reads `ground_truth` (migration 0014),
drawn by hand on `/admin/annotate`, not verdicts. A verdict on a frozen-pool frame is
consumed by neither side of the project.

Filtering the pool to the train split takes it from 331 frames to **203**. That is the
honest cost and it is the right trade: `diverse` frames are replaceable (2,100 sampled,
1,173 of them never prelabelled, out of 23,758 extracted) and frozen-pool frames are not.

---

## A — The pool learns the split rule it is already governed by

`contributeBatchHandler` runs three queries that select from `images`, and **all three**
need the predicate: the forward page, the `remaining` count, and the wrap page. The wrap
is the one that is easy to miss and silently reintroduces the whole bug for any session
that reaches the top of the key space.

The predicate is not a new rule. It is `splitFor()`'s rule
(`worker/internal/snapshot/builder.go`) written a second time: **`random` is eval,
everything else — `NULL`, `diverse`, `manual` — is train.** Name it as a constant beside
`CONTRIBUTOR_UNRULED_BOX` and say in the comment that it is a second copy of a rule that
lives in Go, so whoever changes one is told where the other is. §Q16's M17 amendment is
explicit that `manual` routes to train, and this predicate must not quietly disagree with
that by enumerating an allow-list instead of excluding `random`.

**Not a query parameter.** The contributor tier has no business choosing which split it
feeds, and a parameter is a way to aim verification at the frozen pool on purpose — the
exact act §Q16 calls non-negotiable.

**The admin pool does not change.** `admin-labelling.ts`'s `UNRULED_BOX` must keep
serving `random` frames: the admin is the tier that overrides and must be able to re-rule
anything (M20 plan §C3), and `/admin/annotate`'s ground-truth work lives entirely on that
pool. A filter there would break M26's instrument.

**On the index — measured 2026-08-31, and the answer is no index.** The rule was: add one
only if the number moves. It moved, and then it stopped moving under a better measurement,
which is why this paragraph now records a negative result instead of a migration.

Against production, `/api/contribute/batch`'s forward page, before and after the predicate:

| | rows_read | sql_duration |
|---|---|---|
| before | 39,911 | ~11 ms |
| after | 27,926 | ~31 ms |

Fewer rows read and three times slower — `memory/measure-cost-not-just-win` exactly. The
first diagnosis was that `idx_images_shuffle_key` had stopped covering the query, and it
was **wrong**: it came from an `EXPLAIN QUERY PLAN` run over `SELECT i.id` rather than the
handler's real five-column list. With the real list the plan is `SCAN i USING INDEX` both
before and after, identically — this query was never covered, and no index on `images` can
cover it while it selects `video_id`, `r2_key` and `timestamp_seconds`.

Replaying the production shape locally (23,758 images, a residual pool of 331 frames /
203 after the filter — the production numbers reproduced exactly) puts the filtered query
at 7.23 ms against 7.06 ms unfiltered, inside the noise, and a composite
`(shuffle_key, selection_reason)` index at 7.26 ms — **not chosen by the planner at all**.
An index the planner declines to use is weight with no lift.

So: no migration. The residual ~20 ms on production is real and unexplained by query shape;
it is paid once per twenty judgements on an authenticated route, which is not worth an
index that measurably does nothing. If it ever is worth chasing, the thing to look at is
where the surviving 203 frames sit in the key space, not the index list.

---

## B — The cursor the client has never sent

`useContributeBatch` (`apps/web/src/api/queries.ts`) requests `/api/contribute/batch` with
no `cursor`, and `nextBatch()` calls `refetchQueries` on the same key. Every "Next batch"
therefore re-runs the **first** page from the bottom of the key space. M25.1's keyset
pagination exists, is tested (`apps/api/test/workers/contribute.test.ts:137`), and is
consumed by nothing: `next_cursor` arrives and is dropped.

It appears to work, and only for one reason: a **trusted** contributor's verdicts remove
boxes from the pool, so the first page is genuinely different each time. For an
**untrusted** contributor it does not. `CONTRIBUTOR_UNRULED_BOX` excludes a box only on an
admin verdict or a *trusted* user's — that asymmetry is deliberate and documented in the
module comment — so an unpromoted account rules twenty frames, clicks Next batch, and is
handed the same twenty frames back.

Today a human notices on the second pass and stops. **§C removes the human.** Auto-advance
over a page that repeats is a silent infinite loop, so threading the cursor is a
prerequisite of the next section rather than a cleanup that can follow it.

---

## C — Auto-advance

`useInfiniteQuery` with `getNextPageParam: (last) => last.next_cursor`, keeping
`staleTime: Infinity` for the reason `useContributeBatch`'s comment already gives — a
background refetch landing mid-judgement replaces the frame under the cursor.
`ContributeVerify` walks the flattened pages; `frameIndex` still never decreases.

**Prefetch at a margin, not at the boundary.** Call `fetchNextPage()` once the walk is
within ~5 frames of the end. The component's existing comment says there is no prefetch to
write because advancing inside a batch is local state — true, and it stops being true
across pages. Fetching at the last frame puts a spinner in front of every twentieth
judgement, which is the click this milestone is removing wearing a different hat.

**Termination is the hard part, and it is the whole test.** The server *wraps* rather than
running dry (`contributeBatchHandler`'s own comment): once a cursor passes every key in the
pool it comes back around, so `next_cursor` stays non-null and "there is no next page"
never arrives on its own. Track the image ids seen this session; when a fetched page
contributes **zero unseen frames**, stop paging and render the terminal state. Filter
already-seen ids out of appended pages too — a wrapped page legitimately repeats frames the
session has walked.

That single guard covers both endings: a genuinely drained pool, and §B's untrusted
contributor whose pages repeat forever. Both must be tests.

The manual button survives only in the terminal state, where it means "start over" rather
than "advance" — it stops being a step in the normal flow.

---

## Deliberately not in this plan

- **Deleting the 602 frozen-pool verdicts.** They are harmless where they sit; §Q16 forbids
  *training* on that pool, not verdicts existing on it. Removing them is a production write
  that buys nothing.
- **Filtering the admin pool** (§A) or the public/anonymous pool — `anon` verdicts never
  win under `WINNING_VERDICT`, so no labelling effort is being lost there to lose.
- **Anything about `users.trusted`** or the promotion path.
- **Running prelabel on the 1,173 idle `diverse` frames.** An ops action, not a code change
  — but it is what makes this fix worth anything, because 203 frames is ten batches.

---

## Verification

1. `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `cd worker && go generate ./... &&
   go vet ./... && go test ./...`.
2. **A `random` frame never appears in a contributor batch**, on a fixture holding both
   splits — asserted against the forward page **and the wrap page** (§A).
3. **`remaining` counts train frames only**, so the pool counter agrees with what the pool
   will actually serve.
4. **The client sends `cursor`**: the second request carries the first response's
   `next_cursor`.
5. **The walk passes frame 20 with no click**, and the frame after 20 is the next page's
   first frame.
6. **A page that contributes no unseen frames terminates** rather than looping — driven
   with a repeating fixture, which is §B's untrusted contributor reproduced exactly.
7. `meta.rows_read` for `/api/contribute/batch` recorded before and after (§A). **Done, and
   it concluded no index** — see §A's own table and the two measurements that overturned the
   first diagnosis.

---

## Context for whoever picks this up cold

- The split rule is one sentence in two languages: `splitFor()` in
  `worker/internal/snapshot/builder.go`, and the new constant in `routes/contribute.ts`.
- Production reads need `CLOUDFLARE_API_TOKEN` from `infra/.env` (`set -a && . ./infra/.env
  && set +a`); production writes are Carl's to run with a `! ` prefix.
- The contributor surface has no adjust tool by design (M24 §C1, `ContributeVerify.tsx`);
  nothing here changes that.
- Synthetic pointer events cannot reproduce `SwipeCard`'s gestures — `CLAUDE.md` says why.
  The batch walk is testable; the swipe itself is not, and a passing test is not a report
  that the gesture works.
