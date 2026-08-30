import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "../src/entry-server";
import { App } from "../src/routes";

/**
 * The one failure mode in the prerender work that is silent everywhere else.
 *
 * If the build-time render and the client's first render disagree on so much
 * as a whitespace node, React 19 throws the server markup away and re-renders
 * from scratch — in production, without a word. The page still looks right,
 * every other test still passes, `scripts/prerender.mjs` still writes its
 * bytes, and the only cost is that the work stops being worth anything on the
 * next `main.tsx` change nobody connected to it. That is exactly the shape
 * CLAUDE.md warns about: a green build whose artifact has quietly lost its
 * point.
 *
 * So this hydrates the *real* prerendered markup with the *real* client tree,
 * once per prerendered route, and asserts React had nothing to recover from. It duplicates `main.tsx`'s
 * provider stack rather than importing it, because that module mounts on
 * import — the duplication is the price of testing the mount at all, and a
 * provider added there and not here shows up as a mismatch caught right below.
 */

const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
afterEach(() => consoleError.mockClear());

// `/demo`'s client render starts a `/api/public/frame` request the moment it
// mounts. There is no server here, and an unhandled rejection mid-hydration
// would show up as noise in the assertions below rather than as the thing
// being tested — so the fetch simply never settles, which is also the state
// the prerendered markup was rendered in.
vi.stubGlobal("fetch", () => new Promise(() => {}));

describe.each([
  ["/", "The model is 16% sure."],
  ["/demo", "Loading a frame"],
])("hydration of %s", (route, sentinel) => {
  it("hydrates the prerendered markup without a mismatch", async () => {
    const container = document.createElement("div");
    container.innerHTML = render(route);
    document.body.appendChild(container);

    // `BrowserRouter` reads the jsdom location, so the client has to be at the
    // same route the markup was rendered for — otherwise this test would
    // measure a routing mismatch instead of a rendering one.
    window.history.replaceState(null, "", route);

    const recoverable: unknown[] = [];

    await act(async () => {
      hydrateRoot(
        container,
        <StrictMode>
          <QueryClientProvider
            client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
          >
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </QueryClientProvider>
        </StrictMode>,
        // React reports a hydration mismatch here before it silently repairs
        // the tree. Collecting rather than throwing keeps the assertion's
        // failure message the error itself.
        { onRecoverableError: (error) => recoverable.push(error) },
      );
    });

    expect(recoverable.map(String)).toEqual([]);
    // Belt and braces: some mismatch diagnostics reach `console.error` without
    // going through `onRecoverableError`.
    expect(consoleError.mock.calls.map((call) => String(call[0]))).toEqual([]);

    // And the markup survived rather than being replaced, which is the whole
    // reason to hydrate instead of `createRoot`.
    expect(container.textContent).toContain(sentinel);
  });
});
