import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./routes";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // An admin watching a queue wants the current answer, not a cached one.
      staleTime: 0,
      // Retrying a request that failed because the Access session expired just
      // delays the redirect the user actually needs. Task 6 makes that failure
      // a typed error; retry is disabled here so it surfaces immediately.
      retry: false,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

const app = (
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);

/**
 * Two mounts, chosen by whether the document arrived with markup already in
 * it — `src/entry-server.tsx` and `scripts/prerender.mjs` put it there for
 * `/` and `/demo`, `vite dev` and the SPA fallback for every other path do
 * not. `hydrateRoot` on an empty container renders nothing and warns;
 * `createRoot` on a prerendered one throws the markup away and repaints,
 * which works but wastes the only reason the markup was emitted. Branching
 * is what lets one bundle serve both, so dev keeps its plain client render
 * and no route needs to know which document it was served from.
 *
 * The two renders must agree on the first frame or React discards the
 * server markup and re-renders anyway (silently, in production). Nothing
 * routed here reads a browser-only value *during render* — `Home`'s
 * document-level styling is in a `useEffect`, which does not run on the
 * server, and `SwipeCard`'s `matchMedia` read is behind a `typeof window`
 * guard — so the agreement holds by construction rather than by luck.
 * `test/entry-server.test.tsx` is what notices when it stops.
 */
if (root.firstChild) {
  hydrateRoot(root, app);
} else {
  createRoot(root).render(app);
}
