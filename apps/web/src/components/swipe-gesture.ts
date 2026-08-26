/**
 * The pure math behind `/verify`'s swipe (M23, plan §B).
 *
 * Kept apart from `PublicVerify.tsx`'s pointer handlers because everything
 * here is a number in, a number out — no DOM, no React — which is what lets
 * the one bug this plan calls out by name (`CLAUDE.md`'s "gestures the
 * browser owns") stay testable at all. A harness cannot start a real touch
 * gesture, but it can call `lockAxis(10, 13, 0.7)` and check the answer.
 */

/** 72px of horizontal travel commits a ruling (plan §B3, hand-tested). */
export const SWIPE_THRESHOLD_PX = 72;

/**
 * The axis lock's bias toward horizontal (plan §B2), roughly a 55° cone.
 *
 * A plain `|dx| > |dy|` test — the same formula with `ARC_BIAS = 1` — is a
 * 45° cutoff. A thumb swipe is an arc: axis is decided once, 10px into the
 * gesture, and a pivoting thumb's first few pixels routinely run steeper
 * than its eventual, mostly-horizontal trajectory. At that early sample a
 * 45° cutoff reads the gesture as vertical — handed to the page as a
 * scroll — and the lock never revisits the decision, so the rest of an
 * otherwise-clean horizontal swipe is silently dropped. 0.7 widens the
 * cone enough to survive that early steepness without giving up the
 * horizontal/vertical distinction entirely.
 */
export const ARC_BIAS = 0.7;

/** How many pixels of combined travel must pass before the axis is decided. */
export const AXIS_LOCK_DISTANCE_PX = 10;

export type Axis = "x" | "y";

/**
 * Which axis a gesture belongs to, given its displacement since the pointer
 * went down — or `null` if it has not moved far enough to decide yet.
 *
 * Horizontal gets the benefit of the doubt on purpose (plan §B2): a missed
 * swipe is a dead control, a missed scroll is a page that moves a moment
 * later. Called once per gesture, at the first move past
 * `AXIS_LOCK_DISTANCE_PX`, and never again for that gesture — the caller
 * owns not re-calling this once an axis is set.
 */
export function lockAxis(dx: number, dy: number, arcBias: number = ARC_BIAS): Axis | null {
  if (Math.abs(dx) < AXIS_LOCK_DISTANCE_PX && Math.abs(dy) < AXIS_LOCK_DISTANCE_PX) return null;
  return Math.abs(dx) > Math.abs(dy) * arcBias ? "x" : "y";
}

/**
 * Whether a released horizontal drag committed, and which way.
 *
 * Horizontal displacement only (plan §B3) — an arc that travels far enough
 * sideways counts regardless of how much it also rose, so the same arc that
 * `lockAxis` had to tolerate doesn't then get penalized on release for the
 * vertical component it never stopped having.
 */
export function resolveSwipe(
  axis: Axis | null,
  dx: number,
  threshold: number = SWIPE_THRESHOLD_PX,
): "accept" | "reject" | null {
  if (axis !== "x" || Math.abs(dx) < threshold) return null;
  return dx > 0 ? "accept" : "reject";
}
