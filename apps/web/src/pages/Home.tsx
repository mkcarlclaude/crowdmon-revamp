import { Link } from "react-router";

/**
 * The public surface's landing slot.
 *
 * CONTEXT.md §Q11 originally put a detector demo behind this page; §12
 * reshaped the public surface into the verification page instead (M14). This
 * still exists mainly so `/admin` and `/verify` are routes rather than the
 * root, but it is also the one link a visitor pasted into Discord actually
 * needs — the way in to `/verify`.
 */
export function Home() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold">crowdmon</h1>
      <p className="mt-2 text-[var(--color-text-muted)]">
        A labelled image dataset of Genshin Impact characters, built by a data flywheel.
      </p>
      <Link
        to="/verify"
        className="mt-4 inline-block rounded border border-[var(--color-border)] px-3 py-1 text-sm"
      >
        Try verifying a frame
      </Link>
    </main>
  );
}
