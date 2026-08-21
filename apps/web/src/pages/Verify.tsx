import { PublicVerify } from "../components/PublicVerify";
import { useNoindex } from "../hooks/use-noindex";

/**
 * The public surface, reshaped (M14, CONTEXT.md §12 amending §Q11).
 *
 * Not a detector demo over bundled samples — that left with the training that
 * would produce a model to run. What a stranger gets instead is the thing
 * this project is actually about: one real frame, a proposed box, and a
 * verdict that is recorded and shown back immediately.
 *
 * The copy below exists because ROADMAP M14.3 requires it, in words rather
 * than only in behaviour: "the page must not be lying to them about what
 * their click did." Nothing typed here becomes a label — `source = 'anon'`
 * verdicts are excluded at snapshot time by design (CONTEXT.md §12) — and a
 * visitor who thinks they are building the dataset has been misled by the
 * absence of this sentence, not just by a missing feature.
 */
export function Verify() {
  // CONTEXT.md §Q25: frame bytes served here should not end up in a search
  // index. The real control is `public/_headers`' `X-Robots-Tag`, which a
  // non-JS crawler sees too; this hook is defense in depth for the ones
  // that execute JavaScript. See `use-noindex.ts` for why both exist.
  useNoindex();
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold">Try it</h1>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          Here's a real frame from the dataset and what the detector thinks is in it. Accept it,
          reject it, or move on — you're trying the interface, not labelling the live dataset. Your
          verdicts are recorded but never used to train anything.
        </p>
      </div>
      <PublicVerify />
    </main>
  );
}
