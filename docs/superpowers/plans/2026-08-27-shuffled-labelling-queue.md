# A shuffled queue that stops scanning the corpus

**Status:** planned 2026-08-27 · **Milestone:** M25.1 (v5) · **Design record:**
`CONTEXT.md` §Q16 (why labelling order cannot affect the split), §Q10 (why the admin and
contributor tiers are kept apart) · **Amends** the ordering rationale in
`admin-labelling.ts` and `contribute.ts`, which both currently argue *for* sequential
order

Two changes to the verification queue, one wanted and one owed.

**Wanted:** each frame served should come from a random video at a random point, rather
than walking `images.id` in extraction order.

**Owed:** every batch request already reads the entire `images` table twice over to
produce a progress counter. That is the row-read cost the shuffle was feared to
introduce, and it is already being paid.

---

## The finding

`labellingBatchHandler` (`apps/api/src/routes/admin-labelling.ts:119`) issues two
statements per request. The page query is cheap — `ORDER BY i.id` matches the primary
key, so SQLite walks the index and early-exits after `LIMIT` matches. The one beside it
is not:

```sql
SELECT COUNT(*) AS remaining FROM images i WHERE EXISTS (UNRULED_BOX)
```

No `LIMIT`. That visits every row in `images` — 18,952 today — and runs a correlated
`EXISTS` probe into `predictions` on each one.

Four sites do this:

| site | pool | reached by |
|---|---|---|
| `admin-labelling.ts:127` | admin | every batch request |
| `admin-labelling.ts:255` | admin | every stats poll |
| `admin-labelling.ts:249` | `images_with_predictions` | every stats poll |
| `contribute.ts:170` | contributor | every batch request, **unauthenticated public traffic** |

Rough per-batch arithmetic at today's sizes, with a pool of ~1,300 unruled images out of
18,952:

| | rows read |
|---|---|
| page query | ~280 image rows + probes |
| count query | 18,952 image rows + 18,952 probes |
| **per batch** | **~40,000** |

A 400-frame session at `LABELLING_BATCH_SIZE = 20` is 20 batches, so roughly **800,000
rows read to rule on 400 frames** — and it grows with the corpus, not with the pool.
Every video submitted from here makes the counter more expensive while the thing it
counts stays the same size.

**So the premise the sequential ordering rests on is worth re-reading.** The comment at
`admin-labelling.ts:111` gives a UX reason, not a performance one:

> *"Deliberately not random: an operator verifying consecutive frames of one scene is
> reading context they already have, and a shuffled pool makes every frame a cold
> start."*

That argument is real and this plan overrides it deliberately, because the operator has
asked for the opposite: with M25's `diverse` frames now entering the same pool as
`random` ones, seeing a varied cross-section per session is worth more than scene
context. `CONTEXT.md` §Q16 is why this is safe to change at all — the train/eval split is
fixed at *selection* time by `selection_reason`, so no labelling order can move a frame
across it.

---

## A — `images.shuffle_key`

### A1. The column

A random 64-bit integer per image, written once at insert and never updated. Keyset
pagination over it gives a stable random order across videos and selection reasons, using
an index, with no `ORDER BY RANDOM()` anywhere.

`ORDER BY RANDOM()` is what this exists to avoid: it defeats every index, forces the
`EXISTS` probe on every row in the table, sorts the lot, and returns `LIMIT`. It is the
naive fix and it is strictly worse than what is already there.

### A2. Two SQLite traps in the migration, both of which produce silently broken data

**`ALTER TABLE ... ADD COLUMN` rejects a non-constant `DEFAULT`.** `DEFAULT (random())`
is legal in `CREATE TABLE` and illegal in `ADD COLUMN`, so the obvious one-liner fails.
The column lands nullable, backfilled by a separate `UPDATE`.

**Do not reach for the table-rebuild recipe to make it `NOT NULL`.** D1 enforces foreign
keys unconditionally with no pragma to turn them off, so the standard
drop-and-rename dance cascades child rows away — migrations 0005/0007/0008 document this
and migration 0011 documents *not* needing it. `images` is the parent of `predictions`,
`prelabel_images` and `dryruns`. A rebuild here would delete the dataset.

**Therefore the column is nullable, and a NULL is invisible to the queue.** `shuffle_key
> ?` is NULL for a NULL key, which is not true, so a row that never got a key can never
be served — it silently leaves the pool forever with nothing failing. Three defences, all
required:

1. the migration backfills every existing row
2. `reportImagesHandler` (`jobs.ts:768`) writes a key on every insert, explicitly
3. a test asserts a freshly reported image has a non-NULL `shuffle_key`, and a
   reconciliation query (`SELECT COUNT(*) FROM images WHERE shuffle_key IS NULL`) belongs
   in the acceptance run

### A3. The cursor

The client carries the last `shuffle_key` it saw; the next batch asks for
`shuffle_key > ?`, wrapping to the minimum when a page comes back short. Wrapping is not
an edge case to defer — a session that rules its way to the top of the key space
otherwise gets an empty batch while the pool still has frames in it.

---

## B — The counter, which is the larger win

### B1. Why a partial index rather than a cache

The count and the page query have the same root problem: pool membership is a *join*, so
nothing about `images` alone can be indexed to answer it. Denormalise membership onto the
row and both queries become index walks.

```sql
ALTER TABLE images ADD COLUMN unruled_admin INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_images_admin_pool ON images (shuffle_key) WHERE unruled_admin > 0;
```

A constant `DEFAULT 0` *is* legal in `ADD COLUMN`, unlike A2's case. The partial index
holds one entry per pool image (~1,300) rather than one per image (18,952), and it
references only its own table, which is what makes it legal at all — a partial index
cannot carry a subquery.

Then:

- **page:** `WHERE unruled_admin > 0 AND shuffle_key > ? ORDER BY shuffle_key LIMIT ?` —
  an index walk over pool rows only, no `EXISTS` probe anywhere, O(limit)
- **count:** `SELECT COUNT(*) FROM images WHERE unruled_admin > 0` — scans the partial
  index, so it is O(pool), not O(corpus), and stops growing when the corpus does

The `WHERE` clause in the query must match the index's predicate for SQLite to use it.
That is not a detail to leave to the planner's judgement: **confirm it with `EXPLAIN
QUERY PLAN` and assert on the plan in a test**, because a query that silently stops using
the index is exactly the regression this plan exists to prevent, and it looks identical
from the outside.

### B2. Keeping it true

`unruled_admin` is "how many boxes on this image carry no admin verdict". Two writers:

- **`reportPredictionsHandler`** inserts predictions — increment by the number inserted
  per image, in the same batch as the inserts
- **`admin-verdicts.ts`** inserts an admin verdict — decrement by one, **only when it is
  the first admin verdict on that prediction**, in the same batch as the verdict

The second condition is the one to get right. Verdicts are append-only and an admin may
re-rule a box; a naive decrement-per-verdict drifts negative on the second ruling. The
guard is a conditional `UPDATE` predicated on no prior admin verdict existing for that
prediction, evaluated inside the same statement rather than read-then-write.

**A drifting counter is worse than a slow scan**, because it is invisible. The plan owes
a reconciliation query that recomputes the column from the source predicate, and it
belongs in the acceptance run rather than in a scheduled job nothing watches:

```sql
SELECT COUNT(*) FROM images i
 WHERE i.unruled_admin != (
   SELECT COUNT(*) FROM predictions p
    WHERE p.image_id = i.id
      AND NOT EXISTS (SELECT 1 FROM verdicts v
                       WHERE v.prediction_id = p.id AND v.source = 'admin'));
```

---

## C — The contributor pool, and why it gets less

`CONTRIBUTOR_UNRULED_BOX` excludes a box once an admin **or a trusted user** has ruled
it. That predicate reads `users.trusted`, and flipping a user to trusted retroactively
removes boxes from the pool **with no write to `images` at all** — so a denormalised
counter drifts the moment anybody is promoted, through no bug in any write path.

`users.trusted` has no endpoint; it is set by hand in production D1. So:

- **the contributor pool gets `shuffle_key` ordering** (§A), which needs no denormalised
  column
- **it does not get a denormalised counter.** Its count query is bounded instead:
  `SELECT COUNT(*) FROM (SELECT 1 FROM images i WHERE EXISTS (...) LIMIT 501)`, rendered
  as "500+" past the cap. A public endpoint must not have an unbounded scan behind it,
  and a contributor does not need a precise number — `ContributeVerify.tsx:61` already
  decrements it client-side rather than refetching
- **promoting a user is documented as requiring the §B reconciliation**, in
  `CLAUDE.md` beside the other production-write notes

This asymmetry is deliberate and is the kind of thing that reads as an oversight later.
It gets a comment at both predicates, matching how the existing admin/contributor
asymmetry is already documented twice.

---

## D — Rollout order, which can break production

**The migration must be applied before the Worker that reads the new columns is
deployed**, and CI deploys on merge to `main`. A Worker querying `shuffle_key` against a
database without it fails every batch request — the labelling queue goes down entirely,
for both tiers.

So, in order:

1. merge nothing; apply `0013` to production first (`pnpm --filter @crowdmon/api run
   db:migrate`, run by Carl — production writes are his)
2. verify the backfill: no NULL `shuffle_key`, and §B2's reconciliation returns 0
3. then merge, and let CI deploy

The reverse order is recoverable only by rolling the Worker back, and the same hazard
in the opposite direction is why the new columns are additive: an *old* Worker running
against the *new* schema is fine, since it simply never mentions the new columns.

---

## Deliberately not in this plan

- **Moving off D1.** The corpus is 18,952 images and the pool is ~1,300. This is an
  indexing problem at a size SQLite does not notice; the two D1 constraints that have
  actually bitten this project are the 100-bound-param ceiling and the ignored
  `foreign_keys` pragma, and neither is about scale nor improves elsewhere.
- **KV for the queue.** Pool membership changes on every swipe — the highest-frequency
  write in the system — so a KV copy would be invalidated constantly, and its eventual
  consistency would hand out frames already ruled on. There is also no KV namespace bound
  today.
- **Keeping the sequential mode as a toggle.** Two orderings is two code paths and a
  setting nobody will revisit. If scene context turns out to matter more than variety,
  reverting is one query.
- **`admin-video-images.ts`'s per-row subqueries** (`:122`). Also scans, also worth
  fixing, bounded by one video rather than the corpus, and not what this plan is about.

---

## Verification

1. `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `cd worker && go generate ./... &&
   go vet ./... && go test ./...` — the Go client regenerates from `openapi.json` and CI
   diffs it.
2. **A test that a reported image lands with a non-NULL `shuffle_key`.** §A2's silent
   disappearance is the worst failure here and the only one nothing else would catch.
3. **A test that consecutive batches return disjoint frames and eventually wrap**, rather
   than re-serving the same page once the cursor passes the maximum key.
4. **A test asserting the query plan uses `idx_images_admin_pool`** — `EXPLAIN QUERY
   PLAN` in the workers project. A query that stops using the partial index is invisible
   from the response.
5. **A test that `unruled_admin` survives a re-ruling**: two admin verdicts on one
   prediction must decrement once, not twice.
6. Measured, not asserted: rows read per batch before and after, from the same seeded
   database. The claim is roughly 40,000 → under 1,500, and a plan that says so should
   show it.

---

## Context for whoever picks this up cold

- Migrations are numbered sequentially; `0012` is the highest today, so this is `0013`.
- Production reads: `npx wrangler d1 execute --remote` is **blocked** by the permission
  classifier for reads as well as writes. `npx wrangler d1 export crowdmon --remote
  --output <file>` works — load the dump into local sqlite and query there.
- Production writes and migrations must be run by Carl with a `! ` prefix.
- `.d1-backups/` is gitignored; dumps contain every annotator email.
- The local SQLite the tests run against does **not** enforce D1's 100-bound-param
  ceiling, so a test passing is not evidence a statement is within it.
