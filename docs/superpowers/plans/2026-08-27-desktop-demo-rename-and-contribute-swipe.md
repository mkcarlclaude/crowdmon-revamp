# Desktop, `/demo`, and the swipe on `/contribute`

**Status:** planned 2026-08-27, desktop layout validated against a mockup ·
**Milestone:** M24 · **Design record:** `CONTEXT.md` §Q11 (public surface), §Q25 (frame
bytes and its bounds), §Q10 (annotator tiers) · **Amends** `CONTEXT.md` §Q25 (the
licensing bound stops resting on a blanket `noindex`) and the M20 plan §B4 (contributors
lose the adjust tool)

Three changes, all in `apps/web/` except one documentation edit. **No API change, no
schema change, no migration.**

- **A — the desktop layout.** `/verify` today is unbounded on a wide screen: the frame is
  `w-full` with no `max-width` and no breakpoint above `sm:`, so a 1920px monitor renders
  a ~1850px frame, about 1040px tall, taller than the viewport.
- **B — `/verify` becomes `/demo`, and it gets indexed.** With `noimageindex` rather than
  `noindex`, which is the part that keeps §Q25 honest.
- **C — `/contribute` gets the same swipe interface, without adjust.**

Order: **A, then B, then C.** A changes the component C reuses; B is a rename that would
otherwise collide with both.

**Decided before planning** (Carl, 2026-08-27):

| Question | Decision |
|---|---|
| Desktop shape | Option B — two columns at `lg:`, frame capped, keyboard-led |
| `/demo` indexing | Index it. The blanket `noindex` was doing less than it looked |
| Adjust on `/contribute` | **Dropped.** Admin keeps it on `/admin/verify` |

---

## A — The desktop layout

Below `lg:` **nothing changes.** The mobile layout is validated and approved; this is
purely additive at width.

Desktop is not mobile-but-bigger. On a phone the constraint is thumb reach, so the swipe
leads. On a desktop there is a keyboard, two hands and a wide screen, and verification is
a throughput task — so the keyboard leads and the layout uses the horizontal axis rather
than fighting it.

### A1. Cap the frame by width, never by height

`max-width: 720px` on the frame's wrapper.

**Do not cap it with `max-height` plus `object-contain`.** The box overlay is absolutely
positioned in percentages *of its container*, so letterboxing the image inside a
taller container silently desyncs every rectangle from the image it describes — boxes
that look plausible and are wrong, which is the worst failure this screen can have.
Cap the width; 16:9 decides the height.

### A2. Two columns

Frame left, decision panel right, the pair centred with a page max-width.

The panel carries the claim readout at real size (class name ~26px, confidence in mono
beside it), the progress ticks, the buttons, and one line of context that has nowhere to
live on a phone. On mobile the claim rides on the box because there is no room; on
desktop it does both — the tag stays on the rectangle, and the panel repeats it.

### A3. Buttons become a control group with their keys printed

Stacked, full width, left-aligned, each showing its binding: `←` No, `→` Yes, `⌫` Undo.

**Those bindings already work and are completely invisible.** Printing them is the
largest available desktop throughput win and it costs nothing but markup.

The sticky action bar is dropped at this breakpoint — a thumb zone on a desktop is a bar
with nothing to stick past. Drag still works for trackpad users; it is simply no longer
the advertised path.

---

## B — `/verify` becomes `/demo`, and it gets indexed

### B1. The rename is not just a route

`/verify` appears in more places than the router, and **one of them is a security-ish
control that fails silently**:

- `apps/web/public/_headers` matches `X-Robots-Tag` **on the literal path `/verify`**.
  Rename the route and leave this alone and the rule applies to a path that no longer
  exists, with nothing to say so.
- `useNoindex()` in the page component.
- The landing page's link to the demo, and its "demo" labelling.
- `routes.tsx`.

Keep `/verify` working as a **redirect to `/demo`**. It is linked from the landing page,
from the repo's own docs, and from anywhere a stranger has already pasted it.

### B2. Index the page, not the frames

The blanket `noindex` was doing less work than it appeared to. Frames are served as
short-lived signed R2 URLs, one random frame per request, behind a rate limit — there is
no crawlable set of image URLs to harvest, and §Q25's other two bounds carry the weight.

**But one real mechanism remains:** Googlebot executes JavaScript, so it can fetch a
frame and cache the bytes, and that cached copy outlives the signed URL's expiry. That is
the actual path by which frames from copyrighted game footage reach image search — the
licensing exposure §Q11 rejected the public gallery over.

So: **`noimageindex`, not `noindex`.** The page becomes discoverable and shareable; the
frames stay out of image search. Set it in `_headers` as `X-Robots-Tag: noimageindex` on
`/demo`, and drop the `useNoindex()` call from that page.

`/admin` and `/admin/*` keep full `noindex`. Unchanged.

### B3. While in that file

`apps/web/public/_headers` still carries a block headed `UNRESOLVED, DOCUMENTED RATHER
THAN GUESSED`, saying it is unconfirmed whether `_headers` matches the original request
path or the SPA-rewritten one. **It was confirmed against production on 2026-08-21** —
matching is on the original request path:

```
/verify          → x-robots-tag: noindex     (rule applied)
/admin/dashboard → x-robots-tag: noindex     (rule applied)
/                → absent                    (correctly not matched)
```

Replace that block with the result and the date. A comment that says a settled question
is open is the same failure as a comment that claims an open question is settled.

### B4. Documentation

`CONTEXT.md` §Q25 lists `noindex` among the three bounds separating this surface from the
rejected public gallery. Amend it: the bound now rests on the curated `public_sample`
pool, one short-lived signed URL per request with no enumeration, rate limiting, and
`noimageindex`. Say why the swap is not a weakening — and say what would make it one, so
a later reader can tell.

---

## C — `/contribute` gets the swipe, without adjust

### C1. Adjust is dropped, and this reverses something

M20 plan §B4 gave contributors the adjust tool, arguing their verdicts are labels so a
tier that can only say "wrong" is the weakest signal available. That is now reversed:
**every geometric correction comes from an admin on `/admin/verify`.**

The trade is deliberate — adjust is drawing a box, which is the hardest interaction in
the app and the worst fit for a thumb. Record it in `CONTEXT.md` §7's v4 amendment
alongside the tier description.

**UI-only.** `submitContributeVerdictsHandler` still accepts `adjust` and the schema
still carries the coordinates. This is the screen staying honest about what it offers,
not access control — the same posture `PublicVerify`'s `allowAdjust={false}` already
takes. Do **not** narrow the API to match; that would make this hard to reverse.

### C2. The data shape differs, and it is the easier one

`/api/public/frame` returns **one** frame. `/api/contribute/batch` returns
**`CONTRIBUTE_BATCH_SIZE` = 20**, with `remaining`.

That is a better fit, not a worse one: the batch is already a queue to walk, so no
prefetch is needed and one request covers twenty frames against a 10-per-60s limit. Walk
it client-side one frame at a time, submitting per frame to
`/api/contribute/images/{id}/verdicts` exactly as the public surface submits to its own.

The component must take its frames from a prop or hook rather than reaching for an
endpoint — `VerificationCard`'s original split (M13.1) is the precedent, and it is what
lets one interaction serve two mounts without a mode flag.

### C3. What `/contribute` keeps

The signed-in header, the contribution count from `/api/contribute/me`, and the honest
statement of whether the account is `trusted` — a contributor whose verdicts are recorded
but not yet promoted must be told so.

`ContributeVerify.tsx` is replaced. `VerificationCard` and `BoxOverlay` stay for
`/admin/verify`.

---

## Deliberately not in this plan

- **Touching `/admin/verify`.** It keeps the desktop component and the adjust tool.
- **Narrowing the contribute API to reject `adjust`.** §C1.
- **A sitemap, `meta description`, or canonical link.** Deferred separately.
- **Adjust-by-thumb in any form.**

---

## Verification

1. `pnpm --filter @crowdmon/web run test`, `typecheck`, `biome` clean.
2. A test that the frame wrapper carries a max-width — the regression guard for the
   unbounded-frame bug, which is invisible in jsdom and only shows on a real monitor.
3. Tests that `/verify` redirects to `/demo`, and that the swipe reducer behaves
   identically on both mounts.
4. A test asserting `_headers` carries `noimageindex` for `/demo` and `noindex` for
   `/admin` — the rename's silent-failure mode.
5. **After deploy, by curl**, because `_headers` is only truly testable against the
   deployed Worker:
   ```sh
   curl -sI https://crowdmon.mkcarl.com/demo   | grep -i x-robots-tag  # noimageindex
   curl -sI https://crowdmon.mkcarl.com/admin/dashboard | grep -i x-robots-tag  # noindex
   curl -sI https://crowdmon.mkcarl.com/       | grep -i x-robots-tag  # absent
   ```
6. **By hand, on a real monitor and a real phone.** Neither jsdom nor CDP can tell you
   whether 720px is the right cap or whether the two-column split reads correctly, and no
   harness here starts a browser-owned gesture.
