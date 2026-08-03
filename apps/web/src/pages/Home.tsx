/**
 * The public surface's slot, empty by design.
 *
 * CONTEXT.md §Q11 puts the landing page, about page and in-browser demo in v2.
 * This route exists now only so `/admin` is a route rather than the root — the
 * app's shape does not have to change when the public page arrives.
 */
export function Home() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold">crowdmon</h1>
      <p className="mt-2 text-[var(--color-text-muted)]">
        A labelled image dataset of Genshin Impact characters, built by a data flywheel.
      </p>
    </main>
  );
}
