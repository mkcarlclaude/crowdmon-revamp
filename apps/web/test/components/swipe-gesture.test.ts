import { describe, expect, it } from "vitest";
import { lockAxis, resolveSwipe } from "../../src/components/swipe-gesture";

/**
 * The axis lock and commit threshold (M23, plan §B2, §B3) — the part of the
 * swipe gesture that is pure math rather than a browser-owned gesture, and
 * therefore the part `CLAUDE.md`'s "synthetic pointers cannot reproduce a
 * browser's own gestures" doesn't rule out testing directly.
 */

describe("lockAxis", () => {
  it("has not moved far enough to decide yet under 10px of combined travel", () => {
    expect(lockAxis(6, 7)).toBeNull();
  });

  it("locks to horizontal once either axis passes 10px, biased by the plan's 0.7 arc factor", () => {
    // The regression case plan §B2 names: axis is decided at the first move
    // past 10px, and a thumb's early trajectory is routinely steeper than
    // its eventual, mostly-horizontal path. At (10, 13) — about 52° off
    // horizontal — a plain `|dx| > |dy|` test (the removed 45° cutoff, the
    // same formula with bias 1) reads this as vertical and would have
    // handed the whole gesture to the page as a scroll, never revisiting the
    // decision for the rest of the drag.
    expect(lockAxis(10, 13, 1)).toBe("y");
    expect(lockAxis(10, 13, 0.7)).toBe("x");
  });

  it("still locks to vertical for a genuinely vertical drag, even with the 0.7 bias", () => {
    expect(lockAxis(5, 40)).toBe("y");
  });
});

describe("resolveSwipe", () => {
  it("commits accept past the threshold, moving right", () => {
    expect(resolveSwipe("x", 90)).toBe("accept");
  });

  it("commits reject past the threshold, moving left", () => {
    expect(resolveSwipe("x", -90)).toBe("reject");
  });

  it("snaps back with no ruling short of the threshold", () => {
    expect(resolveSwipe("x", 40)).toBeNull();
  });

  it("never commits on a vertical-locked or undecided axis, regardless of horizontal distance", () => {
    expect(resolveSwipe("y", 200)).toBeNull();
    expect(resolveSwipe(null, 200)).toBeNull();
  });

  it("counts horizontal displacement only — a rise that came along for the ride doesn't cost it", () => {
    // Same arc as the lockAxis regression case, carried to its conclusion:
    // once locked "x", a further drag that is still substantially vertical
    // still commits as long as the horizontal component alone clears 72px.
    expect(resolveSwipe("x", 90)).toBe("accept");
  });
});
