import { PublicVerify } from "../components/PublicVerify";
import { useNoindex } from "../hooks/use-noindex";

/**
 * The public surface, reshaped (M14, CONTEXT.md §12 amending §Q11; rebuilt
 * for a thumb in M23).
 *
 * Not a detector demo over bundled samples — that left with the training that
 * would produce a model to run. What a stranger gets instead is the thing
 * this project is actually about: one real frame, a proposed box, and a
 * verdict that is recorded and shown back immediately.
 *
 * **No wrapping layout here on purpose.** M23's swipe surface needs the
 * document's own flow — `min-height: 100dvh`, a sticky action bar reaching
 * the actual viewport edge — so `PublicVerify` owns the whole page body,
 * header and disclosure copy included, rather than being centered inside a
 * fixed-width column here. The ROADMAP M14.4 disclosure sentence ("the page
 * must not be lying to them about what their click did") still exists; it
 * moved into `PublicVerify`'s own header.
 */
export function Verify() {
  // CONTEXT.md §Q25: frame bytes served here should not end up in a search
  // index. The real control is `public/_headers`' `X-Robots-Tag`, which a
  // non-JS crawler sees too; this hook is defense in depth for the ones
  // that execute JavaScript. See `use-noindex.ts` for why both exist.
  useNoindex();
  return <PublicVerify />;
}
