import { useEffect } from "react";

/**
 * Injects `<meta name="robots" content="noindex">` for as long as the
 * calling component is mounted, and removes it on unmount.
 *
 * One `index.html` serves every route (M5.1's single-origin SPA), so before
 * M20 plan §A there was no per-route document to carry a static tag — the
 * whole shell carried one blanket `noindex`, covering `/verify` and
 * `/admin` along with `/`. Plan §A4 makes `/` indexable (the real
 * distribution channel is a pasted link, and a search index finding the
 * landing page is fine) while `/verify` keeps `noindex` for CONTEXT.md
 * §Q25's frame-bytes reasons and `/admin` keeps it because it was never
 * meant to be crawled either — reasons that have nothing to do with `/` and
 * don't move just because `/` stopped needing the same tag.
 *
 * A route-scoped meta tag, not a second static HTML file: this app has no
 * server-side rendering, so a client-injected tag is the only per-route
 * mechanism available without also changing the Worker that serves the
 * shell (out of scope here — see the PR description). It is a best-effort
 * signal for crawlers that execute JavaScript, which is the same limitation
 * the single blanket tag already accepted for the whole app before this.
 */
export function useNoindex() {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex";
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);
}
