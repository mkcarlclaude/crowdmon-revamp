# One box, one swipe: rebuilding `/verify` for a thumb

**Status:** planned 2026-08-26, **interaction validated against a prototype on a real phone 2026-08-26** · **Milestone:** M23 · **Design record:** `CONTEXT.md`
§Q10 + §12 (annotator tiers), §Q11 (public surface), §Q25 (frame bytes, rate limits) ·
**Amends** nothing — no locked decision changes

`/verify` today is the desktop component with a phone-sized problem: one frame, every
box at once, three buttons per box, and a submit. On a 390px screen a frame with three
proposals is nine controls and a scroll. This replaces it with one decision at a time,
driven by a swipe.

**Frontend only. Zero API changes, zero schema changes.** `PublicVerdictKind` is already
`["accept", "reject"]` and `PublicStagedVerdict` already carries nothing but
`prediction_id` and `verdict`. Everything below is `apps/web/`.

**Decided before planning** (Carl, 2026-08-26):

| Question | Decision |
|---|---|
| Which surface | `/verify` — the anonymous one |
| Adjust | **No.** Swipe left = reject, right = accept, nothing else |
| `/contribute` | Untouched this milestone |

**The reference implementation is a prototype**, four rounds of hand-testing, on branch
`design/swipe-prototype`:

```sh
git show design/swipe-prototype:prototypes/verify/swipe-verify-prototype.html > /tmp/p.html
```

It is throwaway HTML, not code to port — but the gesture constants, the tag behaviour and
the layout in it are the validated ones, and where this plan and the prototype disagree,
the prototype was tested and the plan was not.

---

## What this deliberately does not do

**No adjust on this surface, and that is §Q10, not an omission.** A stranger correcting
box geometry is the single action the public verdict endpoint refuses at the schema
layer, because admitting it is what would force consensus resolution, agreement scoring
and trust weighting into scope. Long-press-to-adjust was considered for this plan and
dropped for that reason. If adjust-by-thumb is ever wanted, it belongs on `/contribute`,
where the capability already exists and the account is known.

The consequence to keep honest on screen: a visitor who can see a box is *nearly* right
has only "no" available. That is the same limitation `/verify` has today, not a new one.

---

## A — One decision at a time

### A1. The claim rides on the box

**"One at a time" means one decision, not one visible rectangle** — draw every box,
active one bright, resolved ones marked, undecided ones dim.

**But dimming the siblings is not enough, and the prototype proved it.** Proposals in
this dataset routinely share *pixel-identical* geometry: the reference frame's `Paimon
0.20` and `Raiden Shogun 0.17` are the same rectangle, and production image 4051's
predictions 255 and 257 are too. When the active box renders exactly on top of a dimmed
one, opacity carries no information — the frame looks unchanged, and a swipe reads as a
no-op. Tested by hand, the verdict was "I don't know which box it's currently showing."

So the class name and confidence render **on the active rectangle**, as a tag — the same
idiom the landing page already uses for its hero detection. When the geometry cannot
change, the label is what does. A brief scale-in on the tag whenever the active claim
changes makes the transition visible even between two coincident boxes.

An earlier attempt added a `claim 1 of 2 on this box` counter. It was cut as
distracting: once the label changes, the counter is saying something the tag already
says.

Progress is a row of ticks, one per box. Not a score — navigation, because the visitor
can no longer see a list.

### A2. Buffer the swipes; do not write one per gesture

This is the load-bearing decision in the plan and it resolves two separate problems with
one mechanism.

**`verdicts` is append-only.** There is no UPDATE and no DELETE in `admin-verdicts.ts`
or `public.ts`, deliberately and permanently. Today nothing is written until Submit, so
a misclick costs a click. A swipe is far easier to trigger by accident than a button
press — a scroll that drifts sideways, a thumb that lands mid-flick — and one write per
swipe turns every one of those into a permanent row in the one table the design exists
to keep trustworthy.

**And one request per swipe hits the rate limiter almost immediately.** M14.3 sets 20
requests per 60 seconds per `(ip, route)`. Twenty swipes in twenty seconds is an
ordinary rate for this interaction. A visitor would wall themselves inside half a minute
of honest use and see a 429 they did nothing to deserve.

Both want the same thing: **hold decisions locally, show an undo, flush as one batch.**

- A swipe stages a ruling and advances. Nothing leaves the browser.
- Undo un-stages the last ruling. It never deletes, because there is nothing to delete
  yet — see A3 for why it is a button rather than a toast.
- The batch flushes when the frame's last box is decided. One request per frame, exactly
  as today, against the unchanged endpoint.
- A frame abandoned mid-way (tab closed, next frame requested) discards its staged
  rulings rather than flushing them. A partial frame is not wrong to submit — the
  endpoint accepts any subset — but a visitor who wandered off did not decide anything,
  and inventing verdicts from an abandoned session is exactly the untrusted-input
  problem this tier is bounded to avoid.

The staging area from M13.1 has not been removed. It stopped being a visible list and
became a short window of time.

### A3. Three buttons: No, Undo, Yes

Swipe is an *alternative* input, never the only one — `VerificationCard` already holds
this posture, and it is what keeps the surface usable by keyboard and assistive tech.

**Undo is a button in that row, not a gesture and not a toast.** Two earlier shapes were
tested and both failed on discoverability: tapping a resolved box (the prototype's first
attempt — "nope, didn't know it exists") and a persistent banner above the buttons. A
peer control beside Yes and No is the version a thumb finds without being told.

Narrower than its neighbours, because it is recovery rather than a choice. **Disabled
rather than hidden** when there is nothing to undo, so the row never reflows and the
control is visible before it is needed. Tapping a resolved box and `Backspace` stay as
secondary paths.

Arrow keys map to No and Yes.

## B — The gestures, measured

**Build this after A works with buttons alone.** `/admin/verify` was broken twice in one
week by browser-owned gestures: an `<img>` is natively draggable, so press-and-move tore
the frame loose and fired `pointercancel`; and a finger drag is a scroll until told
otherwise, which cancels the pointer stream the same way. `draggable={false}` and
`touch-none` are already in `BoxOverlay` and `VerificationCard`. This adds a third
gesture to the same surface and must not undo either.

The numbers below are not guesses. They came out of a prototype driven by hand on a
phone, and each one replaced something that measurably did not work.

### B1. The swipe surface is the whole stage, not the frame

A one-handed thumb pivots from a bottom corner: it lives in the **lower third** of the
screen. The first prototype listened on the image alone — a band in the vertical middle —
so the gesture had to be performed somewhere the thumb does not naturally reach.
Reaching up to a small target to make a large gesture is the worst available combination.

Everything between the header and the button row is the swipe surface. The frame is
still what animates, because it is what is being decided.

### B2. The axis lock must tolerate an arc

A thumb swipe is an arc, not a line, and routinely runs 30–40° off horizontal. A plain
`|dx| > |dy|` test is a 45° cutoff, so real swipes were being classified as vertical,
handed to the page as scrolls, and silently doing nothing. That reads as "the swipe is
flaky", with no visible cause — and it is invisible to code review and to every harness
in this repo.

Lock to horizontal when `|dx| > |dy| × 0.7`, a cone of roughly 55°. **Horizontal gets
the benefit of the doubt deliberately:** a missed swipe is a dead control, a missed
scroll is a page that moves a moment later. If vertical scrolling feels sticky in real
use, 0.85 is the more conservative setting — tune it against a thumb, not a mouse.

Axis is decided once per gesture, after 10px of travel, and does not change mid-drag.

### B3. Threshold and tracking

**72px of horizontal travel commits.** Confirmed by hand as neither twitchy nor
laborious. Measure horizontal displacement only, so an arc that travels far enough
sideways counts regardless of how much it also rose.

Track the frame 1:1 during the drag with a slight rotation, and ramp a directional wash
toward `--color-done` or `--color-failed` as travel approaches the threshold. The card
following the thumb is what lets the gesture be aimed; without it there is nothing to
aim with. Anything short of the threshold snaps back with no ruling.

Under `prefers-reduced-motion`, drop the tracking and the tag animation.

### B4. Layout: the document must be able to scroll

The prototype's first layout locked the app to the viewport (`height: 100%` on a flex
column). Nothing could scroll — and on a short screen the button row would have gone
under the fold **unreachable**, which is a shipping bug, not a polish item.

`min-height: 100dvh` so the document can grow past the viewport, `dvh` rather than `vh`
because mobile browser chrome resizes the viewport as you scroll, and the action bar
`position: sticky; bottom: 0` so it stays in the thumb zone without leaving the flow.
`touch-action: pan-y` on the swipe surface, never `none`.

### B5. What no harness here can check

Neither jsdom nor CDP starts the gestures the browser owns — `CLAUDE.md` says so and
this repo has the scar. Tests can and should cover the reducer: what a completed swipe
stages, what undo un-stages, when a flush fires, that an abandoned frame discards. They
cannot tell you whether it feels right.

**Two things remain genuinely untested and must not be written up as settled:**

- **iOS Safari's edge-swipe back gesture.** No iOS device was available. A swipe starting
  near the left edge is navigation and the page cannot override it. The fix, if it bites,
  is insetting the swipe surface from the left edge — which changes the layout, so it is
  worth confirming before rather than after.
- **Chrome Android's overscroll-to-refresh** on vertical drags near the top.

## C — Frame supply

`/api/public/frame` returns one frame and is rate-limited at 20 per 60 seconds on its
own bucket. At roughly three boxes a frame, a fast visitor needs a new frame every three
swipes — which approaches that ceiling from the other side.

Prefetch the next frame while the current one is being decided. It hides the latency
that would otherwise show up as a stall at exactly the moment the interaction feels
fastest, and it does not increase the request count: the same frames are fetched, just
earlier.

Do **not** raise either rate limit to make this work. They are M14.3's mechanism for
"not at scale" and §Q25 counts them among the three bounds separating this surface from
the public gallery §Q11 rejected on licensing grounds. If the design needs more than 20
frames a minute, the design is wrong, not the limit.

---

## Deliberately not in this plan

- **Adjust, in any form, on `/verify`.** §Q10. See above.
- **Touching `/contribute` or `/admin/verify`.** Both keep the desktop component. The
  contributor surface is a candidate for the same treatment later; it is not this
  milestone, and doing both at once means neither gets a real device test.
- **Deleting `VerificationCard`.** Two other mounts use it.
- **A card-stack framing.** The Tinder deck is the default answer for any swipe UI and
  it is wrong here: a stack says the *frame* is the unit being judged, when the unit is a
  claim about the frame. The frame is evidence and stays put; the box resolves.
- **A `claim N of M` counter on a shared rectangle.** Tried, cut as distracting.
- **Streaks, counters, scores, "you have verified N frames".** A public statistics
  surface was built and reverted once already and `PRD.md` reasons from its absence.
  Per-frame progress is navigation; a running total is a scoreboard.
- **Raising the rate limits.**

---

## Verification

1. `pnpm --filter @crowdmon/web run test`, `typecheck`, `biome` — the reducer, the undo
   window, the flush trigger, the abandoned-frame discard.
2. A test that a completed frame produces **exactly one** request carrying every ruling,
   not one request per swipe. That is the rate-limit guarantee, and it is the assertion
   that fails if someone later "simplifies" the buffer away.
3. Keyboard path: arrows, the three buttons and `Backspace` produce identical staging to
   swipes.
4. A swipe arcing 40° off horizontal still rules — the regression guard for B2, and the
   one bug that would otherwise come back as "flaky" with no cause.
5. **On a real phone, by hand** — Chrome Android confirmed, iOS Safari still outstanding:
   - the page still scrolls vertically past the frame
   - a left-edge swipe does whatever it does, and it is the decided behaviour
   - a hesitant or diagonal drag snaps back without staging anything
   - undo actually catches a deliberate mis-swipe
   - nothing tears the image loose (the `draggable={false}` regression guard, by thumb)
