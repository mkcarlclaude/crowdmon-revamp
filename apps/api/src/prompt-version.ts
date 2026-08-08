/**
 * How a reworded prompt gets its new version tag (M12.1).
 *
 * Migration 0003 makes `classes.prompt_version` free text, stamped onto every
 * prediction the class produces, and ROADMAP.md M12.1 states the rule it
 * exists to enforce: **editing a prompt bumps its version rather than
 * overwriting it**, because rewording in place would silently create two
 * regimes inside one class — the same failure `images.dedup_threshold` exists
 * to prevent.
 *
 * The bump is computed here rather than typed by whoever is editing, and that
 * is the load-bearing choice. An operator supplying the tag can supply the one
 * already in use, and the collision is invisible: the boxes from before and
 * after the edit end up indistinguishable in `predictions`, which is precisely
 * the state the column was added to make impossible. A rule with no operator
 * in it cannot be talked out of.
 *
 * The format matches migration 0006's seeds (`2026-08-08-a`) so the tags a
 * human reads in `/admin` and the tags in the committed seed migration are one
 * scheme, not two.
 */

/** `YYYY-MM-DD` in UTC — see `nextPromptVersion` for why not local time. */
function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Spreadsheet-column increment: a→b, z→aa, az→ba, zz→aaa.
 *
 * Not a plain "next letter": 26 rewordings of one class in one day is absurd,
 * but a rule that ran out of letters would either throw in the middle of an
 * edit or reuse `z`, and reuse is the one outcome this whole mechanism exists
 * to prevent. Carrying costs four lines and has no failure case.
 */
function nextSuffix(suffix: string): string {
  const chars = [...suffix];

  for (let i = chars.length - 1; i >= 0; i--) {
    // `?? "a"` is unreachable — `i` is in range by construction — and is here
    // because `noUncheckedIndexedAccess` types the read as possibly undefined
    // and a non-null assertion would be the same claim with no fallback.
    const char = chars[i] ?? "a";
    if (char !== "z") {
      chars[i] = String.fromCharCode(char.charCodeAt(0) + 1);
      return chars.join("");
    }
    chars[i] = "a";
  }

  // Every position carried, so the series is one character longer.
  return `a${chars.join("")}`;
}

/**
 * The tag that replaces `current` when a class's prompt is reworded.
 *
 * `now` is a parameter rather than read from the clock inside, so the tests
 * above pin the boundaries (a carry, a day rollover) without stubbing time.
 *
 * The date is UTC. A Worker runs in whichever colo answered, so a tag derived
 * from a local clock would put two edits minutes apart on different dates
 * depending on where the request landed.
 *
 * A `current` in no recognised format — free text, so `v1` or an empty string
 * are legal rows — starts today's series rather than failing. This function
 * cannot be the reason an edit is refused: the state it would leave behind is
 * a class nobody can reword, and the value it would protect (a tidy series)
 * is worth nothing next to that.
 */
export function nextPromptVersion(current: string, now: Date): string {
  const today = utcDate(now);
  const suffix = new RegExp(`^${today}-([a-z]+)$`).exec(current)?.[1];

  return suffix ? `${today}-${nextSuffix(suffix)}` : `${today}-a`;
}
