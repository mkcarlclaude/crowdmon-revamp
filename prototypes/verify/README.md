# Swipe-to-verify prototype

Throwaway. Wired to nothing, served by no route, and **not code to port** — open
`swipe-verify-prototype.html` directly, ideally on a phone.

It exists because the design question was a feel question. Swipe threshold, how the
card tracks a thumb, whether undo is discoverable: none of it is decidable on paper,
and four rounds of hand-testing changed four things that had seemed fine in prose.

What it settled, and what the M23 plan therefore specifies:

- **72px** of horizontal travel commits a ruling.
- **`|dx| > |dy| * 0.7`** for the axis lock, roughly a 55-degree cone. A thumb swipe is
  an arc running 30-40 degrees off horizontal; the obvious `|dx| > |dy|` test is a
  45-degree cutoff and was dropping real swipes as scrolls.
- **The whole stage is the swipe surface**, not the frame. A one-handed thumb lives in
  the lower third of the screen, and the frame is a band in the middle.
- **The claim rides on the active rectangle.** Two proposals here often share identical
  geometry, so dimming a sibling underneath conveys nothing.
- **Undo is a button** beside Yes and No. Tapping a resolved box was not discoverable.
- **`min-height: 100dvh` with a sticky action bar.** Locking to the viewport left the
  buttons unreachable on a short screen.

The frames and every rectangle are real output from `/api/public/frame`, carried over
from `design/landing-prototypes`. Confidences are the detector's own 0.11-0.20 and most
of these boxes are wrong — frame 1's first two proposals are the same rectangle claimed
by both Paimon and Raiden Shogun, and its third is the Traveler labelled Paimon. Do not
swap in a cleaner-looking detection; being wrong is the point the interface is built
around.

Still untested: iOS Safari's edge-swipe back gesture, and Chrome Android's
overscroll-to-refresh.

## `desktop-mockup-optionB.html`

The desktop half, approved 2026-08-27. Responsive — narrow the window past 1024px and
the validated mobile layout is unchanged underneath.

What it settles:

- **The frame caps at 720px, by width.** `/verify` shipped with `w-full` and no
  breakpoint above `sm:`, so a 1920px monitor rendered a ~1850px frame about 1040px
  tall. Never cap it with `max-height` + `object-contain`: the box overlay is positioned
  in percentages of its container, and letterboxing silently desyncs every rectangle
  from the image it describes.
- **Two columns** — frame left, decision panel right, pair centred.
- **Buttons become a stacked control group with their keys printed** (arrows and
  backspace). Those bindings already worked and were invisible; showing them is the
  biggest desktop throughput win available and costs only markup.
- **No sticky bar at this width.** A thumb zone on a desktop is a bar with nothing to
  stick past.
