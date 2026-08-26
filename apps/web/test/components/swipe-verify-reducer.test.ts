import { describe, expect, it } from "vitest";
import {
  activeId,
  initSwipeState,
  isComplete,
  stagedRulings,
  swipeReducer,
} from "../../src/components/swipe-verify-reducer";

/**
 * The staging area behind `/verify`'s swipe (M23, plan §A2).
 *
 * This is the one part of the plan's load-bearing decision — "swipes are
 * buffered, never one write per gesture" — that a harness can actually
 * verify. `PublicVerify.test.tsx` covers the network side (exactly one
 * request, carrying every ruling); this file covers what the buffer itself
 * does with a sequence of rulings, undo, and a tap on a resolved box.
 */

describe("swipeReducer", () => {
  it("stages a completed swipe on the active box and advances to the next one", () => {
    const state = initSwipeState([10, 20]);

    const next = swipeReducer(state, { type: "rule", verdict: "accept" });

    expect(activeId(next)).toBe(20);
    expect(stagedRulings(next)).toEqual([{ prediction_id: 10, verdict: "accept" }]);
    expect(isComplete(next)).toBe(false);
  });

  it("is complete once every box has a ruling, in the frame's own order regardless of ruling order", () => {
    let state = initSwipeState([10, 20]);
    state = swipeReducer(state, { type: "rule", verdict: "reject" });
    state = swipeReducer(state, { type: "rule", verdict: "accept" });

    expect(isComplete(state)).toBe(true);
    expect(activeId(state)).toBeNull();
    expect(stagedRulings(state)).toEqual([
      { prediction_id: 10, verdict: "reject" },
      { prediction_id: 20, verdict: "accept" },
    ]);
  });

  it("a frame with no boxes is complete from the start, with nothing staged", () => {
    const state = initSwipeState([]);

    expect(isComplete(state)).toBe(true);
    expect(stagedRulings(state)).toEqual([]);
  });

  it("ignores a rule action once nothing is active — a stray keypress after completion is a no-op", () => {
    let state = initSwipeState([10]);
    state = swipeReducer(state, { type: "rule", verdict: "accept" });

    const again = swipeReducer(state, { type: "rule", verdict: "reject" });

    expect(again).toBe(state);
    expect(stagedRulings(again)).toEqual([{ prediction_id: 10, verdict: "accept" }]);
  });

  it("undo un-stages the most recent ruling only, single-level", () => {
    let state = initSwipeState([10, 20]);
    state = swipeReducer(state, { type: "rule", verdict: "accept" }); // rules 10
    state = swipeReducer(state, { type: "rule", verdict: "reject" }); // rules 20

    const undone = swipeReducer(state, { type: "undo" });
    expect(activeId(undone)).toBe(20);
    expect(stagedRulings(undone)).toEqual([{ prediction_id: 10, verdict: "accept" }]);

    // A second Undo press does not cascade back to box 10 — the prototype's
    // own behaviour, and the plan's "single-level, matching the validated
    // prototype."
    const undoneAgain = swipeReducer(undone, { type: "undo" });
    expect(undoneAgain).toBe(undone);
    expect(stagedRulings(undoneAgain)).toEqual([{ prediction_id: 10, verdict: "accept" }]);
  });

  it("undo with nothing decided yet is a no-op", () => {
    const state = initSwipeState([10]);

    const undone = swipeReducer(state, { type: "undo" });

    expect(undone).toBe(state);
  });

  it("unstage lets a resolved box be tapped directly, the plan's secondary path to undo", () => {
    let state = initSwipeState([10, 20]);
    state = swipeReducer(state, { type: "rule", verdict: "accept" }); // rules 10
    state = swipeReducer(state, { type: "rule", verdict: "reject" }); // rules 20

    const unstaged = swipeReducer(state, { type: "unstage", id: 10 });

    expect(stagedRulings(unstaged)).toEqual([{ prediction_id: 20, verdict: "reject" }]);
    // Undo becomes a no-op after a tap-to-unstage, on purpose: reaching for a
    // specific box makes "undo the most recent ruling" ambiguous, so the
    // reducer drops it rather than guessing which one that still means.
    expect(swipeReducer(unstaged, { type: "undo" })).toBe(unstaged);
  });

  it("unstaging a box with no ruling is a no-op", () => {
    const state = initSwipeState([10, 20]);

    const unchanged = swipeReducer(state, { type: "unstage", id: 10 });

    expect(unchanged).toBe(state);
  });
});
