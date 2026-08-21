import { useEffect } from "react";

/**
 * Injects `<meta name="robots" content="noindex">` for as long as the
 * calling component is mounted, and removes it on unmount.
 *
 * **This is defense in depth, not the control.** The real one is
 * `apps/web/public/_headers`, which sets `X-Robots-Tag: noindex` on the
 * same routes at the HTTP layer — a header a non-JS crawler sees on the raw
 * response, before any bundle loads. This hook only exists after React has
 * mounted, so a crawler that never executes JavaScript never sees it. That
 * distinction matters here specifically: `/verify`'s `noindex` is one of
 * three bounds (CONTEXT.md §Q25) that keep the public verification page
 * distinct from the "public browsable gallery" §Q11 rejected on licensing
 * grounds, and a non-JS crawler is exactly the gap a JS-only tag would
 * leave open. See `_headers`' own comment for what is and is not confirmed
 * about how it applies under this app's SPA fallback routing.
 *
 * One `index.html` serves every route (M5.1's single-origin SPA), so before
 * M20 plan §A there was no per-route *document* to carry a static tag — the
 * whole shell carried one blanket `noindex`, covering `/verify` and
 * `/admin` along with `/`. Plan §A4 makes `/` indexable (the real
 * distribution channel is a pasted link, and a search index finding the
 * landing page is fine) while `/verify` keeps `noindex` for the reason
 * above and `/admin` keeps it because it was never meant to be crawled
 * either — reasons that have nothing to do with `/` and don't move just
 * because `/` stopped needing the same tag.
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
