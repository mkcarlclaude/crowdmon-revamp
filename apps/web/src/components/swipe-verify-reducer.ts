/**
 * The staging area behind `/verify`'s swipe (M23, plan §A2).
 *
 * `verdicts` is append-only, and one write per swipe would turn every
 * accidental flick into a permanent row — see `PublicVerify.tsx`'s own
 * comment on why the batch only ever flushes once a frame is done. This
 * module is the part of that decision a harness can actually verify: given
 * a frame's box ids and a sequence of rulings, what does the buffer hold,
 * what does undo take back, and when is the buffer complete. It knows
 * nothing about `fetch`, React, or a pointer — a component owns turning a
 * completed buffer into one request and turning a discarded one into
 * nothing at all.
 */

export type SwipeVerdict = "accept" | "reject";

export interface StagedRuling {
  prediction_id: number;
  verdict: SwipeVerdict;
}

/**
 * One frame's staging area: the fixed order its boxes are judged in, what
 * has been decided so far, and which box a single-level undo can still take
 * back.
 *
 * `order` is the ids, not the boxes themselves — this module has no opinion
 * on a box's class or confidence, only on which prediction id is "the one
 * being decided" and which have been ruled on. Keeping a *fixed* order
 * (frame.predictions' own order, decided once at `init`) rather than
 * deriving "next undecided" some other way is what makes `stagedRulings`
 * below deterministic regardless of the order boxes were actually ruled in.
 */
export interface SwipeState {
  order: readonly number[];
  verdicts: Readonly<Record<number, SwipeVerdict>>;
  /**
   * The prediction id `undo` will act on, or `null` if there is nothing to
   * take back. Single-level, matching the validated prototype: undoing
   * clears this rather than walking further back, so a second Undo press
   * (or a tap on a different resolved box) is a no-op rather than a second
   * step backward. A visitor who mis-swiped twice in a row corrects each
   * mistake as it happens, not by pressing Undo twice at the end.
   */
  lastDecided: number | null;
}

export function initSwipeState(order: readonly number[]): SwipeState {
  return { order, verdicts: {}, lastDecided: null };
}

/** The prediction id currently being decided, or `null` once every box has a ruling. */
export function activeId(state: SwipeState): number | null {
  return state.order.find((id) => state.verdicts[id] === undefined) ?? null;
}

/** Whether every box in the frame has a ruling — the flush trigger (plan §A2). */
export function isComplete(state: SwipeState): boolean {
  return activeId(state) === null;
}

/**
 * The batch a flush sends: every decided box, in the frame's own order —
 * not the order boxes were ruled in, so the request is diffable against
 * what the screen showed regardless of which one a visitor swiped first.
 */
export function stagedRulings(state: SwipeState): StagedRuling[] {
  const rulings: StagedRuling[] = [];
  for (const id of state.order) {
    const verdict = state.verdicts[id];
    if (verdict !== undefined) rulings.push({ prediction_id: id, verdict });
  }
  return rulings;
}

export type SwipeAction =
  | { type: "rule"; verdict: SwipeVerdict }
  | { type: "undo" }
  | { type: "unstage"; id: number };

function withoutVerdict(verdicts: Readonly<Record<number, SwipeVerdict>>, id: number) {
  const next = { ...verdicts };
  delete next[id];
  return next;
}

/**
 * `rule` decides the *active* box, never a specific id — there is only ever
 * one box a swipe or a Yes/No press can mean, and it is whichever one
 * `activeId` names. A `rule` action with nothing left to decide (an already
 * complete frame — a stray keypress, a second gesture that lands before the
 * frame has advanced) is a no-op rather than an error, matching the
 * prototype: nothing here should ever throw on a race it can simply ignore.
 *
 * `unstage` is the secondary path (plan §A3): tapping a resolved box.
 * Clearing `lastDecided` regardless of whether the tapped box *was*
 * `lastDecided` matches the prototype exactly — once a visitor has reached
 * for a specific box instead of the Undo button, "undo the most recent
 * ruling" is no longer an unambiguous action, so it goes away instead of
 * guessing.
 */
export function swipeReducer(state: SwipeState, action: SwipeAction): SwipeState {
  switch (action.type) {
    case "rule": {
      const id = activeId(state);
      if (id === null) return state;
      return {
        ...state,
        verdicts: { ...state.verdicts, [id]: action.verdict },
        lastDecided: id,
      };
    }
    case "undo": {
      if (state.lastDecided === null) return state;
      return {
        ...state,
        verdicts: withoutVerdict(state.verdicts, state.lastDecided),
        lastDecided: null,
      };
    }
    case "unstage": {
      if (state.verdicts[action.id] === undefined) return state;
      return {
        ...state,
        verdicts: withoutVerdict(state.verdicts, action.id),
        lastDecided: null,
      };
    }
    default:
      return state;
  }
}
