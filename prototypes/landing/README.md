# Landing page prototypes

**Throwaway. Nothing here is wired into the app or the deploy.** Open the files
directly, or serve the directory (`python3 -m http.server`) so the `.jpg`s resolve.

Current pick: **`landing-hero.html`** — approved as a prototype on 2026-08-10, to be
enhanced in a later pass.

| File | Direction | State |
|---|---|---|
| `landing-hero.html` | Full-bleed frame as hero "world", floating pill nav, diegetic pipeline chips, hard seam into a warm off-white document | **current** |
| `landing-product.html` | Conventional dark SaaS page — hero product shot, bento, stats, FAQ | rejected: "looks very AI made" |
| `landing-prototype.html` | Three concepts behind `?variant=A\|B\|C` (queue / datasheet / transcript) | superseded |
| `landing.html` | Light editorial, claim + evidence side by side | superseded |

Reference for the current direction: <https://cofounder.co>. What was taken from it —
the hero as a self-contained environment rather than a section, product state floating
inside that environment, and a hard cut into a calm document below.

## The frames are real

`f-3683` (00226), `f-3693` (00250) and `f-3659` (00143) came from
`GET /api/public/frame`, and every box and confidence drawn on them is the detector's
actual output. `hero.jpg` is a resize of `f-3693`.

Do not swap in a clean, confident-looking detection. The model is a zero-shot bootstrap
that has never seen these characters — real confidences sit at 0.10–0.20 and most boxes
are wrong. That is the argument the page makes, so a faked box would undercut it.

Hero framing is computed for landscape, not eyeballed: Paimon's box spans `y 0.012→1.0`,
so its top edge is always at the image edge and no scale clears the nav — the label sits
inside the box instead. **Portrait needs its own framing; it has not been done.**

## The stats band is design facts, not live counts

A `GET /api/public/stats` endpoint was built, tested and then reverted on 2026-08-10.
`PRD.md` §9 and `CONTEXT.md` §12 both exclude a public statistics surface, and the PRD's
§"Consequence: checks are internal" *reasons from its absence* — so shipping it would have
falsified an argument, not just outgrown a list. The four numbers in the band (200 /
~2,700 / 5 / 0) are properties of the design and stay true at any corpus size.

Do not re-add live counters without amending both documents first.

## Before any of this ships

- **`landing-product.html` contains invented numbers** in the product shot (class counts,
  queue depth, manifest split). Wire them to real queries or drop them. `landing-hero.html`
  has none.
- No OG image exists yet.
- The blanket `noindex` in `apps/web/index.html` must become a per-path `X-Robots-Tag`
  before `/` can be indexed, and `/verify` is to be renamed `/demo`.
