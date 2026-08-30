import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Injects build-time markup into `dist/index.html`, run by `pnpm build` after
 * both Vite passes. See `src/entry-server.tsx` for why the site needs this at
 * all and why `/` is the only route in the list.
 *
 * **This script is the artifact check, not the build's exit code.** Both Vite
 * passes exit 0 on a document this script would have to reject — an empty
 * render, a `#root` that is no longer an empty div, an `/assets/` URL that
 * exists in the SSR pass's idea of the build and not the client pass's. Each
 * of those ships a page that looks fine in a browser (the bundle mounts and
 * repaints over whatever was there) and is broken for the only reader this
 * work is for. So every one of them exits non-zero here. Cf. CLAUDE.md's
 * detector-export note: exit code 0 is not verification when the artifact has
 * a shape.
 *
 * The asset check is the one worth explaining. Vite runs the SSR pass as a
 * separate build, so it derives `/assets/hero-frame-<hash>.jpg` from the same
 * file contents but through its own bundle graph. Matching hashes is a
 * property of Vite's content hashing, not a guarantee it makes to us — and a
 * mismatch is invisible, because the hydrated client render immediately
 * replaces the broken `src` with the right one. Only a crawler that does not
 * run the bundle would ever see the 404, which is precisely the reader this
 * script exists to serve.
 *
 * **`/demo` is here for a reason that is not its own content.** `dist/index.html`
 * is both `/` and, via `not_found_handling = "single-page-application"`, the
 * document served for every path with no file of its own. Putting the landing
 * page's markup into it therefore puts the landing page's *text* at every one
 * of those paths for a crawler that does not run the bundle. `/contribute` and
 * `/admin/*` carry `X-Robots-Tag: noindex` and are unaffected; `/demo` does
 * not, and would have started reading as a near-duplicate of `/` — a
 * regression this work would have caused, not one it found. Giving it its own
 * `demo.html` is the fix, and the per-route `head` rules below stop it
 * shipping `/`'s `<title>` and description along with it.
 *
 * CONFIRMED LOCALLY 2026-08-30 (`wrangler dev`, `curl -D-`): the `[assets]`
 * binding resolves `GET /demo` to `dist/demo.html` before SPA fallback, and
 * `public/_headers` still applies its `X-Robots-Tag: noimageindex` to that
 * response. `/contribute` and `/admin/dashboard` still fall back to
 * `index.html` and still carry `noindex`.
 */

const here = dirname(new URL(import.meta.url).pathname);
const dist = join(here, "..", "dist");
const shell = join(dist, "index.html");
const entry = join(here, "..", "dist-ssr", "entry-server.js");

/**
 * `sentinel` is a string that must appear in that route's rendered markup —
 * copy specific enough that a render which silently produced a fallback, an
 * error boundary or an empty shell fails instead of shipping. `/`'s is the
 * landing page's headline, which M20's plan pins ("never replace it with a
 * cleaner, more confident-looking number"), so it is a line that will not
 * drift by accident. `/demo`'s is its pending state, because pending is the
 * only state a build can render — see `src/entry-server.tsx`.
 *
 * `head` rewrites the shared shell's tags for a route that is no longer served
 * out of `index.html`. Each `[pattern, replacement]` must match exactly once;
 * a pattern that stops matching would silently ship `/`'s metadata, which is
 * the whole thing these rules exist to prevent.
 */
const ROUTES = [
  { route: "/", output: "index.html", sentinel: "The model is 16% sure.", head: [] },
  {
    route: "/demo",
    output: "demo.html",
    sentinel: "Loading a frame",
    head: [
      [/<title>[^<]*<\/title>/, "<title>Try the detector — crowdmon</title>"],
      [
        /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/,
        '<meta name="description" content="One real frame from the dataset, the detector\u2019s real guess at what is in it, and three buttons. No account, and nothing you decide here trains anything." />',
      ],
      [
        /<meta property="og:title" content="[^"]*" \/>/,
        '<meta property="og:title" content="Try the detector — crowdmon" />',
      ],
      [
        /<meta property="og:description" content="[^"]*" \/>/,
        '<meta property="og:description" content="One real frame, the detector\u2019s real guess, three buttons. About ten seconds, no account." />',
      ],
      [
        /<meta property="og:url" content="[^"]*" \/>/,
        '<meta property="og:url" content="https://crowdmon.mkcarl.com/demo" />',
      ],
    ],
  },
];

function die(message) {
  console.error(`prerender: ${message}`);
  process.exit(1);
}

if (!existsSync(shell)) die(`${shell} is missing — run \`vite build\` first`);
if (!existsSync(entry)) die(`${entry} is missing — run the \`--ssr\` build first`);

const { render } = await import(pathToFileURL(entry).href);

const template = readFileSync(shell, "utf8");

// Exactly one, and empty. `main.tsx` branches on `root.firstChild` to decide
// between hydrate and create, so a `#root` that already had children would
// make that branch lie; and two of them would make the replacement below pick
// one arbitrarily.
const MOUNT = '<div id="root"></div>';
const mounts = template.split(MOUNT).length - 1;
if (mounts !== 1) die(`expected exactly one \`${MOUNT}\` in index.html, found ${mounts}`);

for (const { route, output: outputFile, sentinel, head } of ROUTES) {
  let markup;
  try {
    markup = render(route);
  } catch (error) {
    die(`rendering ${route} threw: ${error?.stack ?? error}`);
  }

  if (!markup.includes(sentinel)) {
    die(
      `${route} rendered ${markup.length} bytes without its sentinel ${JSON.stringify(sentinel)}`,
    );
  }

  // Every build-time asset URL must resolve against the *client* build's
  // output, which is the one actually deployed.
  for (const url of new Set(markup.match(/\/assets\/[A-Za-z0-9._-]+/g) ?? [])) {
    if (!existsSync(join(dist, url))) {
      die(`${route} references ${url}, which the client build did not emit`);
    }
  }

  let document = template.replace(MOUNT, `<div id="root">${markup}</div>`);

  for (const [pattern, replacement] of head) {
    const matches = document.match(new RegExp(pattern.source, `${pattern.flags}g`)) ?? [];
    if (matches.length !== 1) {
      die(`${route}: head rule ${pattern} matched ${matches.length} times, expected 1`);
    }
    document = document.replace(pattern, replacement);
  }

  const out = join(dist, outputFile);
  writeFileSync(out, document);

  // Re-read rather than trust the string we just built: this is the byte
  // sequence a crawler gets, and the whole point of the exercise is that
  // nobody looks at it again.
  if (!readFileSync(out, "utf8").includes(sentinel)) {
    die(`${outputFile} does not contain ${route}'s markup after writing`);
  }

  console.log(`prerender: ${route} → dist/${outputFile} (+${markup.length} bytes)`);
}
