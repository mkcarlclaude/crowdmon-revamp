import { PublicVerify } from "../components/PublicVerify";

/**
 * The public surface, reshaped (M14, CONTEXT.md §12 amending §Q11; rebuilt
 * for a thumb in M23; renamed from `/verify` to `/demo` and indexed in M24,
 * plan §B).
 *
 * Not a detector demo over bundled samples — that left with the training that
 * would produce a model to run. What a stranger gets instead is the thing
 * this project is actually about: one real frame, a proposed box, and a
 * verdict that is recorded and shown back immediately.
 *
 * **No `useNoindex()` here, unlike `/admin` and `/contribute` (M24, plan
 * §B2).** The blanket `noindex` this page carried since M20 was doing less
 * work than it looked: frames are short-lived signed R2 URLs, one random
 * frame per request, behind a rate limit — there is no crawlable set of
 * image *URLs* to harvest by indexing this page. What a JS-executing
 * crawler like Googlebot *can* do is fetch and cache the frame's bytes
 * themselves, which is the actual path by which a copyrighted frame could
 * reach image search — so the control that matters is `X-Robots-Tag:
 * noimageindex` in `public/_headers`, not a page-level `noindex`. See
 * `CONTEXT.md` §Q25's amendment for the full argument and what would turn
 * this back into a weakening.
 *
 * **No wrapping layout here on purpose.** M23's swipe surface needs the
 * document's own flow — `min-height: 100dvh`, a sticky action bar reaching
 * the actual viewport edge — so `PublicVerify` owns the whole page body,
 * header and disclosure copy included, rather than being centered inside a
 * fixed-width column here. The ROADMAP M14.4 disclosure sentence ("the page
 * must not be lying to them about what their click did") still exists; it
 * lives in `PublicVerify`'s own header.
 */
export function Demo() {
  return <PublicVerify />;
}
