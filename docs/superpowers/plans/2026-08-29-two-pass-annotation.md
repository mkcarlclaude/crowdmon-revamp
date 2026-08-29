# Drawing without a Save button

**Status:** planned 2026-08-29 · **Milestone:** M26.4 (v5) · **Design record:** the M26
plan (`2026-08-28-eval-harness.md` §A3), whose drawing surface this simplifies.

One change, asked for by the person who did the first 50-image sitting: drawing a box
should not need a button press to keep it.

A second change was asked for alongside it and **withdrawn on the same day** — a two-pass
workflow, drawing on the first pass and confirming exhaustiveness on the second. It is
recorded here rather than deleted, because the reason it was withdrawn is worth keeping:
it reads as a UI change and is not one.

---

## The box commits on release

### A1. What changes

`Draw a box` → drag → **`Save box`** is the flow today. The save button goes: lifting the
pointer posts the box. Drawing mode stays on afterwards, so several boxes on one frame are
several drags rather than several round trips through a button.

`Cancel` stays — it leaves drawing mode — and the class picker stays, because a box still
has to be a box *of something*.

### A2. The guard that has to arrive with it

`drawnIsUsable` (`GroundTruthCard.tsx:150`) is `x_max > x_min && y_max > y_min` — it
rejects a degenerate box and nothing else. That is sufficient while a human presses Save,
because a human does not press Save on a 2-pixel smudge. With the button gone it is not:
every twitch that moves one pixel between press and release becomes a `ground_truth` row.

So a minimum size lands in the same change. Normalized coordinates make this awkward to
pick by feel — 0.01 of a 1920-wide frame is 19px, of a 640-wide frame is 6px — and the
number matters less than that a release below it is **discarded silently**, exactly like a
click that was never a drag. It must not be an error the annotator has to dismiss.

The existing box list is the undo path, and it already has a delete. That is enough,
because a mistake is now visible in the list immediately rather than pending.

### A3. What this breaks that should be said out loud

The comment at `GroundTruthCard.tsx:131` reasons about pointer capture surviving a move
toward the Save button. It describes a button that no longer exists and must be rewritten,
not deleted — the capture is still load-bearing, just for a different reason.

`GroundTruthCard.tsx:237` calls the class picker and Save/Cancel "the keyboard path
through the same action". That was already generous — no keyboard path produces a *box*,
because geometry needs a drag — and removing Save makes it plainly untrue. Correct the
claim rather than preserve it.

---

## The two-pass workflow, and why it was withdrawn

The request was: pass one draws, pass two confirms every Paimon is boxed. The motivation
is sound — an annotator reviewing their own drawing in the same sitting is looking at it
with the eyes that just made it.

It cannot be built in the UI alone. **Pass one on a frame with no Paimon in it writes
nothing** — no boxes, no rows, no trace. So nothing in the database distinguishes "I
looked, she is not here" from "I have not reached this frame yet", which is the *same
failure* `ground_truth_exhaustive` was created to fix one level up, reappearing one level
down. Pass two would be sent to frames pass one never visited, with nothing to say so.

Building it honestly needs a third state — a nullable `verified_at` on
`ground_truth_exhaustive`, inserted by pass one and set by pass two, with
`GET /api/admin/eval-source`'s gate moving to `verified_at IS NOT NULL` so an image enters
the scored set only after the second look. That is a migration, a gate change, a worklist
filter, and a decision about the 50 rows already marked under the one-pass regime.

Carl withdrew it on hearing the cost. **`ground_truth_exhaustive` keeps meaning exactly
what it means today: one mark, one claim, made in one sitting.** If the two-pass idea
returns, it returns as its own milestone with the schema change costed up front — not as a
UI toggle, and not as a second regime grafted onto a table that has no room for one.

---

## Deliberately not in this plan

- **Two passes**, per the section above.
- **A second annotator.** Not asked for, and not the same thing as looking twice.
- **Any change to the scorer**, `ground_truth`, `ground_truth_exhaustive`, or
  `eval-source`'s gate.

---

## Verification

1. `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `cd worker && go generate ./... &&
   go vet ./... && go test ./...`.
2. **A release smaller than the minimum writes nothing** — no request, no row, no error.
3. **A release above it posts without any further interaction**, and drawing mode survives
   it so the next drag is another box.
4. **The gesture still survives a real mouse** — per `CLAUDE.md`, and per the fact that
   this change moves the code that runs on pointer-up. The synthetic tests cannot see a
   regression here; it needs a hand, and the report must say which it got.
