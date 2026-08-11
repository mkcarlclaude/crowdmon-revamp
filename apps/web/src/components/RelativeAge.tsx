/**
 * Age against the server's clock.
 *
 * `now` is the value the API reported in the same response, never `Date.now()`.
 * A laptop whose clock is minutes off would otherwise render a healthy fleet as
 * uniformly stale, and the operator would be debugging the wrong machine.
 */
export function RelativeAge({ at, now }: { at: number | null; now: number }) {
  if (at === null) return <span className="text-muted-foreground">never</span>;

  const seconds = Math.max(0, now - at);
  if (seconds < 60) return <span>{seconds}s ago</span>;
  if (seconds < 3600) return <span>{Math.floor(seconds / 60)}m ago</span>;
  if (seconds < 86_400) return <span>{Math.floor(seconds / 3600)}h ago</span>;
  return <span>{Math.floor(seconds / 86_400)}d ago</span>;
}
