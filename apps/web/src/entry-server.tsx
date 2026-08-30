import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router";
import { App } from "./routes";
import "./styles.css";

/**
 * The build-time half of the SPA. `main.tsx` is the runtime half, and the two
 * must render the same first frame — see that file's hydrate branch, and
 * `test/hydrate.test.tsx` for what notices when they stop agreeing.
 *
 * **Why this exists.** Before it, `curl https://crowdmon.mkcarl.com/` returned
 * 3417 bytes whose entire body was `<div id="root"></div>`. Every word on the
 * landing page — the whole argument for the project, the FAQ, the copy a
 * search engine would have to match a query against — lived behind the module
 * bundle. Google *can* render JavaScript, but it does so on a second pass out
 * of a queue that a zero-authority domain sits at the back of, and until that
 * pass lands the only indexable strings on the site are `<title>` and
 * `<meta name="description">`. That is the same reason M20 put the Open Graph
 * tags in the static shell rather than injecting them from React, one layer
 * further in: the crawler that matters does not run the bundle.
 *
 * **The prerendered routes are the sitemap's two, and no others**
 * (`scripts/prerender.mjs` owns the list; this function renders whatever route
 * it is handed). `/contribute` and `/admin/*` carry `X-Robots-Tag: noindex`
 * and have nothing to gain — prerendering them would ship the admin shell's
 * markup to every crawler for no benefit, which cuts against CONTEXT.md
 * §Q19's "assumed public, gated at the API" rather than relying on it.
 *
 * **`/demo` is prerendered for a defensive reason, not for its content.**
 * `PublicVerify` returns `<p>Loading a frame…</p>` and nothing else while its
 * `/api/public/frame` query is pending, and pending is the only state a build
 * can render — its header and disclosure copy, the part worth indexing, sits
 * below that early return. So `/demo`'s prerender is 74 bytes and buys no
 * keywords. What it buys is that `/demo` stops being served `/`'s markup out
 * of the SPA fallback; `prerender.mjs`'s own comment has the full argument.
 * Moving that header above the pending branch is what would make this route's
 * prerender worth something on its own, and is deliberately not done here.
 *
 * There is deliberately no baked-in frame for any route. A signed R2 URL
 * expires and these documents are cached — the same reason M20 §A4 committed
 * the hero frame as a static asset instead of fetching it.
 *
 * A fresh `QueryClient` per call, never a module-level one: a client shared
 * across two renders would leak the first route's cache into the second, and
 * a client shared across *builds* would be a cache that outlives the process
 * that filled it.
 */
export function render(url: string): string {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Matches `main.tsx`. A retry here could only fire against a network
        // that does not exist during a build, and `renderToString` would not
        // wait for it either way.
        retry: false,
      },
    },
  });

  return renderToString(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <StaticRouter location={url}>
          <App />
        </StaticRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}
