-- A shuffled verification order, and the counter that was already being paid
-- for on every batch request (M25.1, plan
-- `docs/superpowers/plans/2026-08-27-shuffled-labelling-queue.md`).
--
-- Two columns, landed in one migration because both hit the same SQLite
-- restriction the same way and both exist to turn a full scan of `images`
-- into an index walk.
--
-- §A: images.shuffle_key
-- -----------------------
-- `ALTER TABLE ... ADD COLUMN` rejects a non-constant `DEFAULT` — `DEFAULT
-- (random())` is legal in `CREATE TABLE` and illegal here — so the obvious
-- one-liner fails and the column lands nullable, backfilled by the `UPDATE`
-- below (plan §A2). That is not a detail to skip: `shuffle_key > ?` is NULL,
-- not true, for a NULL key, so a row that never got one would leave the
-- labelling pool forever with nothing failing loudly about it. Three
-- defences keep that from happening, and this backfill is only one of them —
-- `reportImagesHandler` (`routes/jobs.ts`) stamps a key on every future
-- insert explicitly, and a test asserts a freshly-reported image's key is
-- non-NULL.
--
-- The value is masked to the low 53 bits rather than left at whatever width
-- SQLite's own `random()` returns (a full signed 64). `d1.ts`'s
-- `SHUFFLE_KEY_MASK` and `randomShuffleKey` carry the long version of why:
-- D1 hands every `INTEGER` column back to the Worker as a JS `number`, exact
-- only below `Number.MAX_SAFE_INTEGER`, and this key has to round-trip
-- through JS twice — out to a batch response and back in as the next
-- request's cursor (plan §A3) — so a 64-bit value would come back already
-- rounded and drift from what is actually stored, which is a worse failure
-- than the NULL hazard above because nothing would fail at all. `& 0x1fffffffffffff`
-- is the same mask `d1.ts` applies in JS, spelled out here in SQL because a
-- migration cannot import a TypeScript module; the two writers have to agree
-- on the bound without either one referencing the other.
ALTER TABLE images ADD COLUMN shuffle_key INTEGER;

UPDATE images SET shuffle_key = (random() & 0x1fffffffffffff) WHERE shuffle_key IS NULL;

-- A plain index, not the partial one below: keyset pagination over
-- `shuffle_key` is shared by both tiers (plan §A3, §C), but only the admin
-- pool gets a denormalised membership column to build a partial index from
-- below. The contributor pool's membership predicate reads `users.trusted`
-- (`CONTRIBUTOR_UNRULED_BOX`, `routes/contribute.ts`), which this table
-- cannot see and does not get a column for (plan §C's whole point) — so its
-- page query orders by `shuffle_key` with nothing else to filter the index
-- on, and this is what keeps that an index walk to the cursor's position
-- rather than a sort of all 19,352 rows on every request.
CREATE INDEX idx_images_shuffle_key ON images (shuffle_key);

-- §B: images.unruled_admin + the partial index built from it
-- ------------------------------------------------------------
-- Pool membership — "does this image carry a box the admin tier has not
-- ruled on" — is a join against `predictions` and `verdicts`, and nothing
-- about `images` alone can be indexed to answer a join. Denormalising the
-- membership count onto the row is what makes both the count and the page
-- query into index walks (plan §B1).
--
-- A constant `DEFAULT 0` is legal in `ADD COLUMN`, unlike §A's non-constant
-- one — but it is only correct for a row inserted from here on. Every image
-- already in the table just landed at 0 regardless of how many unruled
-- predictions it actually carries, which is indistinguishable from "nothing
-- to rule on" and would make an already-unverified frame invisible to the
-- very query this column exists to speed up. The `UPDATE` below recomputes
-- the true count once, reading the identical predicate `UNRULED_BOX`
-- (`routes/admin-labelling.ts`) reads and the plan's own §B2 reconciliation
-- query re-derives it from — the only three places this predicate may ever
-- be spelled out, so a change to what "unruled" means can never update one
-- and miss the others.
ALTER TABLE images ADD COLUMN unruled_admin INTEGER NOT NULL DEFAULT 0;

UPDATE images
   SET unruled_admin = (
     SELECT COUNT(*) FROM predictions p
      WHERE p.image_id = images.id
        AND NOT EXISTS (
              SELECT 1 FROM verdicts v
               WHERE v.prediction_id = p.id AND v.source = 'admin'));

-- One entry per pool image (~1,300 today) rather than one per image
-- (19,352), and a partial index is legal here at all only because its
-- predicate references no other table — a partial index's WHERE clause
-- cannot carry a subquery, which is exactly what `UNRULED_BOX`'s `EXISTS` is.
-- Denormalising the predicate onto the row is what makes indexing it legal
-- in the first place, not only faster.
--
-- The query's own `WHERE` has to spell `unruled_admin > 0` verbatim for
-- SQLite to recognise this index as satisfying it. That match is confirmed
-- with `EXPLAIN QUERY PLAN` in a test, not left to the planner's judgement,
-- because a query that silently stops matching a partial index's predicate
-- reads identically from the response — the regression this migration exists
-- to prevent is invisible from the outside (plan §B1).
CREATE INDEX idx_images_admin_pool ON images (shuffle_key) WHERE unruled_admin > 0;
