import { describe, expect, it } from "vitest";
import { render } from "../src/entry-server";

/**
 * `src/entry-server.tsx` is only ever run by `scripts/prerender.mjs`, during a
 * build, with its output going into a file nobody opens. That is a good place
 * for a regression to sit unnoticed: the client bundle mounts over whatever
 * the document contained, so a `/` that stopped prerendering — or prerendered
 * an error boundary — looks perfect in a browser and is empty again for the
 * crawler the work was for.
 *
 * The build does fail on all of that (see `prerender.mjs`'s own comment). This
 * file exists so it fails in `pnpm test` first, where the message points at
 * the render rather than at the script, and so the assertions that actually
 * matter are written down as a contract rather than living only as an `if` in
 * a build script.
 */
describe("entry-server", () => {
  it("renders the landing page's own copy, not a shell or a fallback", () => {
    const markup = render("/");

    // The string `scripts/prerender.mjs` keys its sentinel check off. M20's
    // plan pins this number — "never replace it with a cleaner, more
    // confident-looking number" — so if it ever does change, changing it in
    // both places is the deliberate act it should be.
    expect(markup).toContain("The model is 16% sure.");

    // A crawler's whole read of this page is the text in it. Asserting on a
    // length rather than on more copy keeps this from becoming a second copy
    // of the page that has to be edited in step with the first, while still
    // failing on a render that produced a heading and nothing else.
    expect(markup.length).toBeGreaterThan(5000);
  });

  it("emits the hero frame, so the markup is not text-only", () => {
    const markup = render("/");

    // Not the *hashed* `/assets/hero-frame-<hash>.jpg` URL: that only exists
    // in a real build, and under vitest the same import resolves to Vite's
    // dev path. Whether the built URL matches the one the client build emitted
    // is `prerender.mjs`'s check, made against `dist/` where the answer
    // exists. This asserts only that the image survives into the markup at
    // all — the mismatch that check guards is invisible in a browser, because
    // hydration replaces a broken `src` immediately.
    expect(markup).toMatch(/<img src="[^"]*hero-frame[^"]*\.jpg"/);

    // React 19 hoists a preload for an image referenced this way. Free, and
    // worth noticing if it ever stops: the hero frame is 138 kB and is the
    // largest paint on the page.
    expect(markup).toMatch(/<link rel="preload" as="image" href="[^"]*hero-frame/);
  });

  it("renders /demo's pending state, which is the only state a build has", () => {
    const markup = render("/demo");

    // `scripts/prerender.mjs`'s sentinel for this route. `PublicVerify` returns
    // this line and nothing else until `/api/public/frame` resolves, and a
    // build cannot resolve it — so this *is* `/demo`'s prerendered document,
    // and it is prerendered to stop the SPA fallback serving `/`'s markup at
    // an indexable URL, not for what it says. See that script's comment.
    expect(markup).toContain("Loading a frame");
    expect(markup).not.toContain("The model is 16% sure.");
  });
});
