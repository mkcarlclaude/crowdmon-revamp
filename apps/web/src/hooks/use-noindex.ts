import { useEffect } from "react";

/**
 * Injects `<meta name="robots" content="noindex">` for as long as the
 * calling component is mounted, and removes it on unmount.
 *
 * **This is defense in depth, not the control.** The real one is
 * `apps/web/public/_headers`, which sets `X-Robots-Tag` on the same routes
 * at the HTTP layer — a header a non-JS crawler sees on the raw response,
 * before any bundle loads. This hook only exists after React has mounted,
 * so a crawler that never executes JavaScript never sees it.
 *
 * **`/demo` does not call this anymore (M24, plan §B2).** It used to be one
 * of three bounds (CONTEXT.md §Q25) keeping the public verification page
 * distinct from the "public browsable gallery" §Q11 rejected on licensing
 * grounds — but the page itself is now deliberately indexable; what stays
 * out of image search is the *frames*, via `_headers`' `X-Robots-Tag:
 * noimageindex` on that route, which this JS-only hook could never express
 * (there is no `content="noimageindex"` meta equivalent worth relying on
 * for a document-level tag). `/admin` and `/contribute` still call it: both
 * are signed-in personal surfaces never meant to be crawled at all, which
 * has nothing to do with `/demo`'s reasoning and didn't change with it.
 *
 * One `index.html` serves every route (M5.1's single-origin SPA), so before
 * M20 plan §A there was no per-route *document* to carry a static tag — the
 * whole shell carried one blanket `noindex`, covering every route including
 * `/`. Plan §A4 made `/` indexable; `/admin` and `/contribute` keep this
 * hook because they were never meant to be crawled, independent of whatever
 * `/demo` or `/` are doing.
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
