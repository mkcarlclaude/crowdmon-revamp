import { describe, expect, it } from "vitest";
import { nextPromptVersion } from "../../src/prompt-version";

/**
 * The bump rule, tested as a pure function rather than through the endpoint
 * (M12.1): every interesting case here is about *what the next tag is*, and
 * routing a date and a string through Access, D1 and JSON to assert on one
 * string would test the plumbing five times over and the rule once.
 */
describe("nextPromptVersion", () => {
  const today = new Date("2026-08-08T12:00:00Z");

  it("starts today's series at -a when the current tag is from an earlier day", () => {
    expect(nextPromptVersion("2026-08-07-c", today)).toBe("2026-08-08-a");
  });

  it("advances the suffix when the current tag is already from today", () => {
    expect(nextPromptVersion("2026-08-08-a", today)).toBe("2026-08-08-b");
  });

  it("starts today's series at -a for a tag in no recognised format", () => {
    // `prompt_version` is free text (migration 0003), so a row seeded by hand
    // with "v1" or "" is a legal state this must not throw on.
    expect(nextPromptVersion("v1", today)).toBe("2026-08-08-a");
    expect(nextPromptVersion("", today)).toBe("2026-08-08-a");
  });

  it("carries past z rather than colliding or crashing", () => {
    // 26 rewordings of one class in one day is absurd, and a rule that
    // silently reused -z on the 27th would stamp two regimes with one tag —
    // the exact failure this whole mechanism exists to prevent.
    expect(nextPromptVersion("2026-08-08-z", today)).toBe("2026-08-08-aa");
    expect(nextPromptVersion("2026-08-08-aa", today)).toBe("2026-08-08-ab");
    expect(nextPromptVersion("2026-08-08-az", today)).toBe("2026-08-08-ba");
    expect(nextPromptVersion("2026-08-08-zz", today)).toBe("2026-08-08-aaa");
  });

  it("reads the date in UTC, not the runtime's local zone", () => {
    // A Worker runs wherever Cloudflare put it. A tag derived from a local
    // clock would put two edits minutes apart on different dates depending on
    // which colo answered.
    expect(nextPromptVersion("2026-08-07-a", new Date("2026-08-08T23:30:00Z"))).toBe(
      "2026-08-08-a",
    );
  });
});
