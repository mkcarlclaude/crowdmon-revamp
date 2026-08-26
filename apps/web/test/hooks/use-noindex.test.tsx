import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useNoindex } from "../../src/hooks/use-noindex";

function Probe() {
  useNoindex();
  return <p>content</p>;
}

/**
 * M20 plan §A4: `/` stopped carrying a static `noindex` tag, so every other
 * route needed a per-route way to keep the one they had before. This is
 * that mechanism's own test — `index-html.test.ts` covers the static shell
 * it replaced for `/`. `/admin` and `/contribute` still call this hook;
 * `/demo` stopped in M24 (plan §B2) because the page itself is now
 * deliberately indexable — see `use-noindex.ts`'s own comment.
 */
describe("useNoindex", () => {
  it("adds a robots noindex meta tag while mounted", () => {
    render(<Probe />);
    const meta = document.head.querySelector('meta[name="robots"]');
    expect(meta).not.toBeNull();
    expect(meta?.getAttribute("content")).toBe("noindex");
  });

  it("removes the tag on unmount, so a later route does not inherit it", () => {
    const { unmount } = render(<Probe />);
    expect(document.head.querySelector('meta[name="robots"]')).not.toBeNull();
    unmount();
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
  });
});
