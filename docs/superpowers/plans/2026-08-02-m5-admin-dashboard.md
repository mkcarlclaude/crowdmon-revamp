# M5 — Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator can submit a YouTube URL from a browser and watch job status update live, on one Access-gated hostname, replacing curl.

**Architecture:** A Vite + React SPA in `apps/web` builds to `apps/web/dist`, which the **existing** `crowdmon-api` Worker serves as static assets. One Worker, one origin, one hostname (`crowdmon.mkcarl.com`) — so the browser's session cookie, the Access application and the API all agree without CORS. The SPA takes its types by importing the zod schemas out of `@crowdmon/api` directly; there is no TypeScript codegen, because both sides are TypeScript in one workspace.

**Tech Stack:** Vite 7, React 19, React Router 7 (declarative), TanStack Query 5, Tailwind CSS 4, Vitest + Testing Library, Cloudflare Workers static assets, Terraform (Cloudflare provider 5.x).

## Global Constraints

- **Node >= 22, pnpm 10.33.0.** Set in the root `package.json` `engines` / `packageManager`.
- **Biome is the formatter and linter.** 2-space indent, line width 100. `pnpm lint` must pass. Do not add ESLint or Prettier.
- **`tsconfig.base.json` is extended, never bypassed.** `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` and `isolatedModules` are on. `verbatimModuleSyntax` means type-only imports must be written `import type { X } from "..."`.
- **Every new package script name matches the existing convention:** `typecheck`, `test`, `dev`, `build`.
- **Hostname, after Task 4:** `crowdmon.mkcarl.com`. It serves the SPA, `/api/*`, `/health` and `/openapi.json`. `api.crowdmon.mkcarl.com` is retired.
- **Access covers `crowdmon.mkcarl.com/api/admin`** and nothing else. `/api/jobs/*` must stay uncovered — the Go worker polls it and holds no Access identity.
- **Both gates stay.** Terraform owns the Access application; `apps/api/src/middleware/access.ts` owns assertion verification behind it. Never remove one because the other exists.
- **No new ungated hostname may serve `/api/admin`.** `workers_dev = false` and `preview_urls = false` are both required, and both are asserted by tests.
- **Timestamps on the wire are unix epoch seconds** (integers), matching migration 0001. Never ISO strings.
- **Schema names must not be an `operationId` with `Response` appended** — oapi-codegen owns that namespace on the Go side and the module stops compiling. See the comment on `VideoSubmission` in `apps/api/src/schemas.ts`.
- **`apps/api/openapi.json` is a committed build artifact.** Regenerate with `pnpm --filter @crowdmon/api run openapi` after any schema or route change and commit it, or the Go drift check in CI fails.
- **Design scope: token layer only.** Colors, spacing and type scale are defined once in `apps/web/src/styles.css`. No component library, no visual identity work — that lands with the v2 public surface, against real content.

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `apps/web/package.json` | Package manifest, scripts, deps |
| `apps/web/tsconfig.json` | Extends the base, adds DOM lib and JSX |
| `apps/web/vite.config.ts` | Build config, dev proxy to `wrangler dev`, Vitest projects |
| `apps/web/index.html` | Document shell, OG tags |
| `apps/web/src/main.tsx` | Entry: providers + router mount |
| `apps/web/src/routes.tsx` | Route table (`/`, `/admin`) |
| `apps/web/src/styles.css` | Tailwind import + the design token layer |
| `apps/web/src/api/client.ts` | `apiFetch` — one chokepoint for JSON parsing, zod validation and Access-expiry detection |
| `apps/web/src/api/queries.ts` | `useJobs`, `useSubmitVideo` — TanStack Query hooks |
| `apps/web/src/api/session.ts` | `SessionExpiredError` and the forced-navigation recovery |
| `apps/web/src/pages/Home.tsx` | Public placeholder; the v2 landing page's slot |
| `apps/web/src/pages/Admin.tsx` | Admin composition |
| `apps/web/src/components/SubmitForm.tsx` | M5.2 |
| `apps/web/src/components/JobList.tsx` | M5.3 — grouping, ages |
| `apps/web/src/components/RelativeAge.tsx` | Server-clock-based age rendering |
| `apps/web/src/components/SessionExpiredBanner.tsx` | M5.4 |
| `apps/web/test/*` | Vitest suites, mirroring `apps/api/test` layout |
| `apps/api/src/routes/admin-jobs.ts` | `GET /api/admin/jobs` route + handler |
| `apps/api/test/workers/admin-jobs.test.ts` | Endpoint tests against real D1 |

**Modified**

| Path | Change |
|---|---|
| `apps/api/src/schemas.ts` | Add `AdminJob`, `JobList`, `JobStatus`, `JobListQuery` |
| `apps/api/src/app.ts` | Register the new route |
| `apps/api/package.json` | Add an `exports` map so `@crowdmon/api/schemas` is importable |
| `apps/api/wrangler.toml` | `[assets]`, `run_worker_first`, `preview_urls = false` |
| `apps/api/test/node/wrangler-config.test.ts` | Assert the new invariants |
| `infra/access.tf` | Hostname migration, Access application domain |
| `infra/outputs.tf` | `api_hostname` → `app_hostname` |
| `.github/workflows/ci.yml` | Web build in the TS job |
| `.github/workflows/deploy-api.yml` | Build the SPA before deploy; assert the health body |
| `ROADMAP.md` | Amend M5.1's Pages bullet; record the scope correction |
| `CONTEXT.md` | Record the five decisions from the design session |

---

## Task 1: Vite + React shell that builds

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/routes.tsx`, `apps/web/src/styles.css`, `apps/web/src/pages/Home.tsx`, `apps/web/src/pages/Admin.tsx`
- Create: `apps/web/test/setup.ts`, `apps/web/test/routes.test.tsx`
- Modify: `apps/web/package.json` (it currently exists as a stub with `echo` scripts — replace it wholesale)

**Interfaces:**
- Consumes: nothing.
- Produces: a `pnpm --filter @crowdmon/web run build` that emits `apps/web/dist/index.html` plus hashed assets under `apps/web/dist/assets/`. Task 2 depends on that exact output directory. Exports `App` from `apps/web/src/routes.tsx`.

- [ ] **Step 1: Install dependencies**

```bash
# `zod` is a direct dependency, not a transitive one. The client parses every
# response with it and `apps/web/src/api/client.ts` imports `ZodType` by name;
# relying on it arriving through `@hono/zod-openapi` makes the web build break
# the day the API changes its validation library.
pnpm --filter @crowdmon/web add react react-dom react-router @tanstack/react-query zod
pnpm --filter @crowdmon/web add -D @vitejs/plugin-react @tailwindcss/vite tailwindcss vite vitest jsdom \
  @testing-library/react @testing-library/user-event @testing-library/jest-dom \
  @types/react @types/react-dom typescript
```

- [ ] **Step 2: Replace `apps/web/package.json`**

```json
{
  "name": "@crowdmon/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

Leave the `dependencies` and `devDependencies` blocks exactly as `pnpm add` wrote them in Step 1.

- [ ] **Step 3: Write `apps/web/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client"]
  },
  "include": ["src", "test", "vite.config.ts"]
}
```

- [ ] **Step 4: Write `apps/web/vite.config.ts`**

```ts
/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The SPA is served by the API Worker, not by Pages (CONTEXT.md §Q6 amendment,
 * M5.1). `dist` is therefore not a deploy target of its own — it is an input to
 * `wrangler deploy`, declared as `[assets] directory` in apps/api/wrangler.toml.
 * Renaming it here breaks the deploy with no error in this package.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    // Fail loudly rather than shipping a bundle whose size nobody looked at.
    // The admin surface is three screens; anything past this is a mistake.
    chunkSizeWarningLimit: 600,
  },
  server: {
    // `wrangler dev` serves the real Worker, including the real Access
    // middleware's fail-closed paths. Proxying rather than mocking means the
    // dev-time contract is the deployed contract.
    proxy: {
      "/api": "http://localhost:8787",
      "/health": "http://localhost:8787",
      "/openapi.json": "http://localhost:8787",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
```

- [ ] **Step 5: Write `apps/web/test/setup.ts`**

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 6: Write `apps/web/src/styles.css` — the whole design investment**

```css
@import "tailwindcss";

/**
 * The token layer, and deliberately nothing more.
 *
 * M5's admin surface is a single-operator, data-dense tool; visual identity
 * work belongs with the v2 public landing page, against content that exists.
 * What is fixed here is the part that is expensive to change later: the scale
 * and the palette. A v2 design lands on top of these tokens rather than
 * repainting every component.
 */
@theme {
  --color-surface: oklch(21% 0.012 264);
  --color-surface-raised: oklch(26% 0.014 264);
  --color-border: oklch(35% 0.015 264);
  --color-text: oklch(95% 0.005 264);
  --color-text-muted: oklch(72% 0.012 264);

  /* Job status. One hue per terminal meaning, so a status column is readable
     without reading it. */
  --color-pending: oklch(72% 0.11 240);
  --color-claimed: oklch(78% 0.14 85);
  --color-done: oklch(72% 0.14 150);
  --color-failed: oklch(66% 0.18 25);

  --font-mono: ui-monospace, "SF Mono", Menlo, monospace;
}

body {
  background: var(--color-surface);
  color: var(--color-text);
}
```

- [ ] **Step 7: Write `apps/web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>crowdmon</title>
    <!-- The v2 public surface is a landing page plus an OG card (CONTEXT.md
         §Q11). The tags live here from the start so the shell that ships today
         is the shell that gets a preview card later. -->
    <meta property="og:title" content="crowdmon" />
    <meta property="og:description" content="A labelled image dataset of Genshin Impact characters, built by a data flywheel." />
    <meta property="og:type" content="website" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 8: Write `apps/web/src/pages/Home.tsx`**

```tsx
/**
 * The public surface's slot, empty by design.
 *
 * CONTEXT.md §Q11 puts the landing page, about page and in-browser demo in v2.
 * This route exists now only so `/admin` is a route rather than the root — the
 * app's shape does not have to change when the public page arrives.
 */
export function Home() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold">crowdmon</h1>
      <p className="mt-2 text-[var(--color-text-muted)]">
        A labelled image dataset of Genshin Impact characters, built by a data flywheel.
      </p>
    </main>
  );
}
```

- [ ] **Step 9: Write `apps/web/src/pages/Admin.tsx`** (placeholder for now; Tasks 7 and 8 fill it)

```tsx
export function Admin() {
  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold">Admin</h1>
    </main>
  );
}
```

- [ ] **Step 10: Write `apps/web/src/routes.tsx`**

```tsx
import { Route, Routes } from "react-router";
import { Admin } from "./pages/Admin";
import { Home } from "./pages/Home";

/**
 * Two routes, and `/admin` is not hidden.
 *
 * CONTEXT.md §Q19: the admin bundle is assumed public. Client-side routing
 * sends no request when navigating here from a loaded page, so nothing that
 * inspects HTTP paths can gate it. Every `/api/admin/*` endpoint verifies the
 * caller independently — that is the gate, not this table.
 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/admin" element={<Admin />} />
    </Routes>
  );
}
```

- [ ] **Step 11: Write `apps/web/src/main.tsx`**

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
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

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 12: Write the failing test — `apps/web/test/routes.test.tsx`**

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { App } from "../src/routes";

describe("routing", () => {
  it("renders the public page at /", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "crowdmon" })).toBeInTheDocument();
  });

  it("renders the admin page at /admin", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Admin" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 13: Run the test**

Run: `pnpm --filter @crowdmon/web test`
Expected: PASS, 2 tests. (The implementation was written first here because the scaffolding has no behaviour to drive out — from Task 5 onward, tests come first.)

- [ ] **Step 14: Verify build, typecheck and lint**

```bash
pnpm --filter @crowdmon/web run build
ls apps/web/dist/index.html
pnpm typecheck
pnpm lint
```

Expected: `dist/index.html` exists; typecheck and lint both clean.

- [ ] **Step 15: Add `apps/web/dist` to `.gitignore`**

Append to `.gitignore`:

```
apps/web/dist
```

- [ ] **Step 16: Commit**

```bash
git add apps/web .gitignore pnpm-lock.yaml
git commit -m "feat(web): Vite + React SPA shell with the design token layer"
```

---

## Task 2: The Worker serves the SPA

**Files:**
- Modify: `apps/api/wrangler.toml`
- Modify: `apps/api/test/node/wrangler-config.test.ts`

**Interfaces:**
- Consumes: `apps/web/dist` from Task 1.
- Produces: a Worker that serves `index.html` for unmatched paths and still routes `/api/*`, `/health` and `/openapi.json` to Hono.

**Why `run_worker_first` is not optional:** `not_found_handling = "single-page-application"` returns `index.html` for any path that does not match a static asset. `/health` and `/openapi.json` are Hono routes and are **not** under `/api/`, so without listing them the deploy workflow's `curl /health` would receive `200 text/html` from the SPA shell and report a healthy deploy over a broken API.

- [ ] **Step 1: Write the failing tests — append to `apps/api/test/node/wrangler-config.test.ts`**

```ts
  /**
   * Worker version preview URLs live on *.workers.dev, which is not a zone and
   * therefore cannot be covered by an Access application. Serving assets makes
   * per-PR previews attractive, and turning them on would republish
   * /api/admin/* on an ungated hostname — reopening exactly what M4.6 closed,
   * through a setting M4.6's own test does not mention.
   */
  it("keeps preview URLs off", () => {
    expect(config).toMatch(/^preview_urls\s*=\s*false\s*$/m);
  });

  /**
   * `not_found_handling = "single-page-application"` answers every unmatched
   * path with index.html. /health and /openapi.json are Hono routes and are not
   * under /api/, so omitting them here makes the deploy workflow's health check
   * curl the SPA shell and pass on a broken API.
   */
  it.each(["/api/*", "/health", "/openapi.json"])(
    "routes %s to the Worker before static assets",
    (pattern) => {
      const assets = config.slice(config.indexOf("[assets]"));
      expect(assets).toMatch(new RegExp(`run_worker_first[^\\]]*"${pattern.replace("*", "\\*")}"`));
    },
  );

  it("points [assets] at the web package's build output", () => {
    expect(config).toMatch(/^directory\s*=\s*"\.\.\/web\/dist"\s*$/m);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @crowdmon/api exec vitest run --project node`
Expected: FAIL — four failures, all "expected ... to match".

- [ ] **Step 3: Add the assets block to `apps/api/wrangler.toml`**

Insert immediately after the `workers_dev = false` line, **above** `[vars]` (a bare key placed after a table header binds to that table — the mistake the existing test guards):

```toml
# Version preview URLs are also on *.workers.dev, and are governed by their own
# setting rather than by workers_dev. Left at its default, adding static assets
# would have republished /api/admin/* on an ungated hostname — the M4.6 hole,
# reopened by a setting M4.6 never touched.
preview_urls = false
```

Then append at the **end of the file**, as its own table (this is a table header, not a bare key, so it is safe there):

```toml
# The SPA (M5.1). Served by this Worker rather than by Pages: one origin means
# the Access cookie, the Access application and the API cannot disagree, and it
# keeps M5.4's documented expiry symptom (a 302 followed to an HTML 200) intact
# instead of turning it into a CORS failure.
#
# `directory` is built by `pnpm --filter @crowdmon/web run build` and is
# gitignored — a deploy that skips that build publishes a Worker with no assets
# and no error.
[assets]
directory = "../web/dist"
not_found_handling = "single-page-application"

# Without this list, `single-page-application` answers every non-asset path with
# index.html and the Worker never runs. /health and /openapi.json are Hono
# routes outside /api/, so leaving them out makes the deploy workflow's health
# check curl the SPA shell and report success over a dead API.
run_worker_first = [ "/api/*", "/health", "/openapi.json" ]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @crowdmon/api test`
Expected: PASS, all suites — including the pre-existing `[vars]` placement guards.

- [ ] **Step 5: Verify locally end to end**

```bash
pnpm --filter @crowdmon/web run build
pnpm --filter @crowdmon/api exec wrangler dev
```

In a second shell:

```bash
curl -s localhost:8787/health                     # JSON, not HTML
curl -s localhost:8787/ | head -5                 # the SPA shell
curl -s localhost:8787/admin | head -5            # the SPA shell, not a 404 JSON body
curl -s -o /dev/null -w '%{http_code}\n' localhost:8787/api/jobs/claim -X POST -d '{}'  # 400, from Hono
```

Expected: `/health` returns `{"status":"ok",...}`; `/` and `/admin` both return the HTML shell; the API path returns a Hono JSON error rather than HTML.

- [ ] **Step 6: Commit**

```bash
git add apps/api/wrangler.toml apps/api/test/node/wrangler-config.test.ts
git commit -m "feat(api): serve the admin SPA as Worker static assets"
```

---

## Task 3: CI builds the SPA before deploying

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/deploy-api.yml`

**Interfaces:**
- Consumes: the `build` script from Task 1, the `[assets] directory` from Task 2.
- Produces: a deploy that cannot publish a Worker with a stale or missing asset directory.

- [ ] **Step 1: Add a build step to the TypeScript job in `.github/workflows/ci.yml`**

Insert after the `Typecheck` step and before `Lint`:

```yaml
      # The Worker's [assets] directory is this build's output. A break here is
      # a broken deploy, not a broken preview, so it fails CI rather than
      # waiting to fail on main.
      - name: Build web
        run: pnpm --filter @crowdmon/web run build
```

- [ ] **Step 2: Widen the deploy trigger in `.github/workflows/deploy-api.yml`**

Replace the `paths:` list under `on.push` with:

```yaml
    paths:
      - 'apps/api/**'
      # The SPA is deployed by the same `wrangler deploy` as the Worker — one
      # Worker, one artefact. A web-only change must therefore trigger this
      # workflow, which is the cost accepted in exchange for a single origin.
      - 'apps/web/**'
      - 'pnpm-lock.yaml'
      - '.github/workflows/deploy-api.yml'
```

- [ ] **Step 3: Build the SPA before `wrangler deploy`**

Insert between the `Install` and `Apply D1 migrations` steps:

```yaml
      # Before the migration step, so a build failure costs nothing. wrangler
      # uploads whatever is in apps/web/dist; if this is skipped the directory
      # does not exist and the deploy publishes a Worker with no assets.
      - name: Build web
        run: pnpm --filter @crowdmon/web run build
```

- [ ] **Step 4: Make the health check assert the body, not just the status**

Replace the loop inside the `Verify health endpoint` step with:

```bash
          for i in 1 2 3 4 5; do
            body=$(curl -fsS "$url/health") && break
            echo "attempt $i failed, retrying in $((i * 2))s"
            sleep $((i * 2))
          done
          echo "health endpoint returned: $body"
          # Status alone stopped being evidence when the Worker started serving
          # static assets: `not_found_handling = "single-page-application"`
          # answers unmatched paths with index.html and a 200, so a
          # misconfigured `run_worker_first` would pass a status-only check
          # while the API was unreachable.
          case "$body" in
            *'"service":"crowdmon-api"'*) echo "API is answering /health" ;;
            *) echo "::error::/health did not return the API's JSON body"; exit 1 ;;
          esac
```

- [ ] **Step 5: Verify the workflow files parse**

Run: `pnpm dlx yaml-lint .github/workflows/ci.yml .github/workflows/deploy-api.yml` (or open both and confirm indentation is 2-space and consistent with the surrounding steps)
Expected: no parse errors.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/deploy-api.yml
git commit -m "ci: build the SPA before deploy and verify the health body"
```

---

## Task 4: Migrate to a single hostname

**Files:**
- Modify: `infra/access.tf`
- Modify: `infra/outputs.tf`
- Modify: `apps/api/wrangler.toml` (the `ACCESS_AUD` value, after apply)
- Modify: `infra/README.md` (the runbook)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `crowdmon.mkcarl.com` serving the Worker, with Access on `crowdmon.mkcarl.com/api/admin`. Task 6's client assumes same-origin relative URLs, which only holds after this.

**Ordering is load-bearing.** The Go worker polls `/api/jobs/*` on the old hostname and has no Access identity. Destroy the old custom domain before repointing it and the queue stops. Changing `domain` on the Access application **replaces the resource**, which mints a **new `aud`** — and a stale `ACCESS_AUD` in `wrangler.toml` fails every admin request closed with a 503 that says nothing about hostnames.

- [ ] **Step 1: Add the new custom domain alongside the old one, in `infra/access.tf`**

Replace the `locals` block at the bottom of the file with:

```hcl
locals {
  # One hostname for everything: the SPA, /api/*, /health and /openapi.json.
  #
  # It was `api.crowdmon.mkcarl.com` until M5. Splitting the SPA onto a second
  # hostname would have made every admin call cross-origin — CORS with
  # credentials, a load-bearing cookie policy nobody wrote down, and M5.4's
  # documented expiry symptom replaced by a CORS failure. Two hostnames on one
  # Worker is worse still: an Access application binds to host *and* path, so a
  # second hostname republishes /api/admin with the outer gate missing.
  app_hostname = "${var.project_name}.${var.zone_name}"

  # Retired by M5. Kept for one apply so the Go worker can be repointed before
  # the hostname disappears underneath it, then deleted along with the
  # `legacy_api` resource below.
  legacy_api_hostname = "api.${var.project_name}.${var.zone_name}"
}
```

Rename the existing custom domain resource and add the legacy one:

```hcl
resource "cloudflare_workers_custom_domain" "app" {
  account_id = var.account_id
  zone_name  = var.zone_name
  hostname   = local.app_hostname
  service    = "${var.project_name}-api"
}

# Temporary, for the M5 hostname migration only. Delete this resource and
# `local.legacy_api_hostname` once the Go worker's CROWDMON_API_BASE_URL and the
# repository's API_BASE_URL variable both name `local.app_hostname`.
resource "cloudflare_workers_custom_domain" "legacy_api" {
  account_id = var.account_id
  zone_name  = var.zone_name
  hostname   = local.legacy_api_hostname
  service    = "${var.project_name}-api"
}
```

Point the Access application at the new hostname:

```hcl
  domain = "${local.app_hostname}/api/admin"
```

- [ ] **Step 2: Update `infra/outputs.tf`**

```hcl
output "app_hostname" {
  description = "The Worker's custom domain. It serves the SPA and the API; Access covers its /api/admin path."
  value       = local.app_hostname
}
```

Delete the old `api_hostname` output.

- [ ] **Step 3: Plan and read the diff before applying**

Run: `terraform -chdir=infra plan`
Expected: `cloudflare_workers_custom_domain.app` created (or renamed via a state move), `legacy_api` created or matched to the existing resource, and **`cloudflare_zero_trust_access_application.admin` replaced**. Confirm the replacement is present — that is what regenerates the `aud`.

If Terraform proposes destroying the existing `cloudflare_workers_custom_domain.api` rather than adopting it, move it in state instead of recreating it:

```bash
terraform -chdir=infra state mv cloudflare_workers_custom_domain.api cloudflare_workers_custom_domain.legacy_api
```

- [ ] **Step 4: Apply, then take the new aud**

```bash
terraform -chdir=infra apply
terraform -chdir=infra output access_aud
```

- [ ] **Step 5: Paste the new aud into `apps/api/wrangler.toml` and deploy**

Update `ACCESS_AUD` in the `[vars]` table (keep it inside that table — see the file's own warning), then:

```bash
pnpm --filter @crowdmon/web run build
pnpm --filter @crowdmon/api run deploy
```

- [ ] **Step 6: Verify both gates on the new hostname**

```bash
curl -s https://crowdmon.mkcarl.com/health
curl -s -o /dev/null -w '%{http_code}\n' https://crowdmon.mkcarl.com/api/admin/videos -X POST \
  -H 'content-type: application/json' -d '{"url":"https://youtu.be/dQw4w9WgXcQ"}'
```

Expected: `/health` returns the API's JSON; the admin POST returns **302** (Access intercepting, not 401) — a 401 would mean the request reached the Worker, i.e. Access is not covering the path. Also open `https://crowdmon.mkcarl.com/admin` in a browser and confirm the SPA loads.

- [ ] **Step 7: Repoint the Go worker and the deploy variable**

- Set the repository **variable** `API_BASE_URL` to `https://crowdmon.mkcarl.com` (Settings → Environments → production → Variables). It must stay a variable, not a secret — `deploy-api.yml` reads it from the `vars` context.
- On the home box, update the API base URL in `~/crowdmon/` (the compose environment for the `crowdmon-worker` service) to `https://crowdmon.mkcarl.com`, then `docker compose up -d`.
- Confirm the worker is claiming again: `docker logs --since 5m crowdmon-worker` should show poll cycles against the new host with no connection errors.

- [ ] **Step 8: Remove the legacy hostname**

Delete the `cloudflare_workers_custom_domain.legacy_api` resource and `local.legacy_api_hostname` from `infra/access.tf`, then:

```bash
terraform -chdir=infra apply
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w '%{http_code} ' https://api.crowdmon.mkcarl.com/health
done; echo
```

Expected: five non-200 responses. Sample five, not one — a single sample cannot distinguish a removed hostname from a rollout still serving two versions (the M4.6 lesson).

- [ ] **Step 9: Record the runbook in `infra/README.md`**

Add a section documenting: the Access application's `aud` is regenerated whenever its `domain` changes; `ACCESS_AUD` in `wrangler.toml` and a redeploy must follow in the same change, or every admin request answers 503; and the Go worker must be repointed before the old hostname is removed.

- [ ] **Step 10: Commit**

```bash
git add infra apps/api/wrangler.toml
git commit -m "feat(infra): serve everything from crowdmon.mkcarl.com"
```

---

## Task 5: `GET /api/admin/jobs`

**Files:**
- Modify: `apps/api/src/schemas.ts`
- Create: `apps/api/src/routes/admin-jobs.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/test/workers/admin-jobs.test.ts`
- Modify: `apps/api/openapi.json` (regenerated)

**Interfaces:**
- Consumes: the D1 schema from migration 0001.
- Produces:
  - `AdminJob` — zod schema, `z.infer` type `AdminJobRow`, fields: `id: number`, `kind: "download" | "chunk"`, `video_id: string`, `video_url: string`, `status: "pending" | "claimed" | "done" | "failed"`, `attempts: number`, `claimed_by: string | null`, `claimed_at: number | null`, `heartbeat_at: number | null`, `failure_reason: string | null`, `created_at: number`, `updated_at: number`, `chunk?: { segment_index: number; start_seconds: number; end_seconds: number }`.
  - `JobList` — `{ now: number; jobs: AdminJobRow[] }`.
  - `listJobsRoute`, `listJobsHandler` exported from `apps/api/src/routes/admin-jobs.ts`.

  Tasks 6 and 8 import `AdminJob` and `JobList` by those exact names.

**Why the response carries `now`:** M5.3 asks for heartbeat *age*. Computing it from the browser's clock makes a skewed laptop look like a dead worker. The server states its own clock and the UI subtracts.

- [ ] **Step 1: Write the failing test — `apps/api/test/workers/admin-jobs.test.ts`**

Read `apps/api/test/workers/claim.test.ts` first and copy its seeding and Access-header helpers verbatim; this suite must use the same fixtures rather than inventing a second style.

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { adminHeaders, seedVideo } from "./setup";

describe("GET /api/admin/jobs", () => {
  beforeEach(async () => {
    await seedVideo("dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("rejects an unauthenticated request", async () => {
    const res = await app.request("/api/admin/jobs", {}, env);
    expect(res.status).toBe(401);
  });

  it("returns the server clock alongside the jobs", async () => {
    const res = await app.request("/api/admin/jobs", { headers: await adminHeaders() }, env);
    expect(res.status).toBe(200);

    const body = await res.json<{ now: number; jobs: unknown[] }>();
    // Seconds, matching migration 0001 — not milliseconds. A UI subtracting
    // seconds from milliseconds shows every worker as decades stale.
    expect(body.now).toBeGreaterThan(1_700_000_000);
    expect(body.now).toBeLessThan(4_000_000_000);
  });

  it("reports lease state for a claimed job", async () => {
    await env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('download', ?)")
      .bind("dQw4w9WgXcQ")
      .run();
    await app.request(
      "/api/jobs/claim",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worker_id: "test-worker" }),
      },
      env,
    );

    const res = await app.request("/api/admin/jobs", { headers: await adminHeaders() }, env);
    const body = await res.json<{ jobs: Array<Record<string, unknown>> }>();

    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]).toMatchObject({
      kind: "download",
      video_id: "dQw4w9WgXcQ",
      status: "claimed",
      attempts: 1,
      claimed_by: "test-worker",
    });
    expect(body.jobs[0]?.heartbeat_at).toBeTypeOf("number");
  });

  it("returns nulls rather than omitting unset lease columns", async () => {
    await env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('download', ?)")
      .bind("dQw4w9WgXcQ")
      .run();

    const res = await app.request("/api/admin/jobs", { headers: await adminHeaders() }, env);
    const body = await res.json<{ jobs: Array<Record<string, unknown>> }>();

    // Explicit null, not absent: the UI distinguishes "never claimed" from
    // "the API did not say", and an optional field collapses the two.
    expect(body.jobs[0]).toHaveProperty("claimed_by", null);
    expect(body.jobs[0]).toHaveProperty("failure_reason", null);
  });

  it("includes chunk work definition on chunk jobs", async () => {
    const job = await env.DB.prepare(
      "INSERT INTO jobs (kind, video_id) VALUES ('chunk', ?) RETURNING id",
    )
      .bind("dQw4w9WgXcQ")
      .first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO chunks (job_id, video_id, segment_index, start_seconds, end_seconds) VALUES (?, ?, 0, 0, 60)",
    )
      .bind(job?.id, "dQw4w9WgXcQ")
      .run();

    const res = await app.request("/api/admin/jobs", { headers: await adminHeaders() }, env);
    const body = await res.json<{ jobs: Array<{ chunk?: { end_seconds: number } }> }>();

    expect(body.jobs[0]?.chunk).toMatchObject({ segment_index: 0, end_seconds: 60 });
  });

  it("orders newest first and honours the limit", async () => {
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('chunk', ?)")
        .bind("dQw4w9WgXcQ")
        .run();
    }

    const res = await app.request("/api/admin/jobs?limit=2", { headers: await adminHeaders() }, env);
    const body = await res.json<{ jobs: Array<{ id: number }> }>();

    expect(body.jobs).toHaveLength(2);
    expect(body.jobs[0]!.id).toBeGreaterThan(body.jobs[1]!.id);
  });

  it("rejects a limit outside the accepted range", async () => {
    const res = await app.request(
      "/api/admin/jobs?limit=99999",
      { headers: await adminHeaders() },
      env,
    );
    expect(res.status).toBe(400);
  });
});
```

If `apps/api/test/workers/setup.ts` does not already export `adminHeaders` and `seedVideo`, add them there rather than duplicating the logic — read `access.test.ts` for how a valid assertion is minted in tests and reuse exactly that.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @crowdmon/api exec vitest run --project workers admin-jobs`
Expected: FAIL — 404s from `app.notFound`, since the route does not exist.

- [ ] **Step 3: Add the schemas to `apps/api/src/schemas.ts`**

Append:

```ts
/** Mirrors the `status` CHECK constraint in migration 0001. */
export const JobStatus = z
  .enum(["pending", "claimed", "done", "failed"])
  .openapi("JobStatus");

/**
 * A job as the operator sees it — the lease and failure columns the worker's
 * own `Job` deliberately omits, because a worker has no use for them.
 *
 * Every nullable column is `.nullable()` rather than `.optional()`. An absent
 * key and a null both arrive as `undefined` in JavaScript, which would make
 * "never claimed" and "the API did not say" indistinguishable in the UI.
 */
export const AdminJob = z
  .object({
    id: z.int().positive().openapi({ example: 1 }),
    kind: JobKind,
    video_id: z.string().openapi({ example: "dQw4w9WgXcQ" }),
    video_url: z.url().openapi({ example: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    status: JobStatus,
    attempts: z.int().nonnegative().openapi({ example: 1 }),
    claimed_by: z.string().nullable().openapi({ example: "carls-ubuntu-1" }),
    claimed_at: z.int().nullable().openapi({ example: 1_754_100_000 }),
    heartbeat_at: z.int().nullable().openapi({ example: 1_754_100_030 }),
    failure_reason: z.string().nullable().openapi({ example: "video unavailable" }),
    created_at: z.int().openapi({ example: 1_754_099_000 }),
    updated_at: z.int().openapi({ example: 1_754_100_030 }),
    chunk: z
      .object({
        segment_index: z.int().nonnegative().openapi({ example: 0 }),
        start_seconds: z.int().nonnegative().openapi({ example: 0 }),
        end_seconds: z.int().positive().openapi({ example: 60 }),
      })
      .optional()
      .openapi("AdminChunkWork"),
  })
  .openapi("AdminJob");

export type AdminJobRow = z.infer<typeof AdminJob>;

/**
 * Named `JobList`, not `ListJobsResponse`: oapi-codegen owns the
 * `<OperationId>Response` namespace, and the operation is `listJobs`.
 *
 * `now` is the server's clock. M5.3 shows heartbeat *age*, and computing that
 * from the browser's clock would render a skewed laptop as a dead fleet.
 */
export const JobList = z
  .object({
    now: z.int().openapi({ example: 1_754_100_030 }),
    jobs: z.array(AdminJob),
  })
  .openapi("JobList");

/**
 * Query parameters for the job list. `limit` is bounded rather than free: this
 * endpoint reads D1 on an interval from an open browser tab, so an unbounded
 * limit is a self-inflicted load generator.
 */
export const JobListQuery = z.object({
  status: JobStatus.optional().openapi({ param: { name: "status", in: "query" } }),
  limit: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .refine((n) => n >= 1 && n <= 200)
    .optional()
    .openapi({ param: { name: "limit", in: "query" }, type: "integer", example: 50 }),
});
```

- [ ] **Step 4: Write `apps/api/src/routes/admin-jobs.ts`**

```ts
import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { Bindings } from "../bindings";
import { errorResponse, JobList, JobListQuery } from "../schemas";

export const listJobsRoute = createRoute({
  method: "get",
  path: "/api/admin/jobs",
  operationId: "listJobs",
  tags: ["admin"],
  summary: "List jobs with their lease and failure state",
  description:
    "The operator's view of the queue. Requires a Cloudflare Access assertion in " +
    "`Cf-Access-Jwt-Assertion` for an identity on the Worker's admin allowlist.",
  request: { query: JobListQuery },
  responses: {
    200: {
      description: "Jobs, newest first, with the server's clock",
      content: { "application/json": { schema: JobList } },
    },
    400: errorResponse("A malformed status or an out-of-range limit"),
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

/** The shape D1 returns. Flat, because SQLite has no nested rows. */
interface JobRow {
  id: number;
  kind: "download" | "chunk";
  video_id: string;
  video_url: string;
  status: "pending" | "claimed" | "done" | "failed";
  attempts: number;
  claimed_by: string | null;
  claimed_at: number | null;
  heartbeat_at: number | null;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
  segment_index: number | null;
  start_seconds: number | null;
  end_seconds: number | null;
}

const DEFAULT_LIMIT = 50;

export const listJobsHandler: RouteHandler<typeof listJobsRoute, { Bindings: Bindings }> = async (
  c,
) => {
  const { status, limit } = c.req.valid("query");

  // One query with two LEFT JOINs rather than a jobs query followed by a chunks
  // query: the second query would be a second D1 round trip on every poll from
  // every open tab, and `chunks` is 1:1 with a chunk job by unique index, so
  // the join cannot fan the result out.
  const statement = status
    ? c.env.DB.prepare(
        `SELECT j.*, v.url AS video_url,
                ch.segment_index, ch.start_seconds, ch.end_seconds
           FROM jobs j
           JOIN videos v ON v.id = j.video_id
           LEFT JOIN chunks ch ON ch.job_id = j.id
          WHERE j.status = ?
          ORDER BY j.id DESC
          LIMIT ?`,
      ).bind(status, limit ?? DEFAULT_LIMIT)
    : c.env.DB.prepare(
        `SELECT j.*, v.url AS video_url,
                ch.segment_index, ch.start_seconds, ch.end_seconds
           FROM jobs j
           JOIN videos v ON v.id = j.video_id
           LEFT JOIN chunks ch ON ch.job_id = j.id
          ORDER BY j.id DESC
          LIMIT ?`,
      ).bind(limit ?? DEFAULT_LIMIT);

  const { results } = await statement.all<JobRow>();

  return c.json(
    {
      // The server's clock, so the UI's ages do not inherit the browser's skew.
      now: Math.floor(Date.now() / 1000),
      jobs: results.map((row) => ({
        id: row.id,
        kind: row.kind,
        video_id: row.video_id,
        video_url: row.video_url,
        status: row.status,
        attempts: row.attempts,
        claimed_by: row.claimed_by,
        claimed_at: row.claimed_at,
        heartbeat_at: row.heartbeat_at,
        failure_reason: row.failure_reason,
        created_at: row.created_at,
        updated_at: row.updated_at,
        ...(row.segment_index === null
          ? {}
          : {
              chunk: {
                segment_index: row.segment_index,
                start_seconds: row.start_seconds ?? 0,
                end_seconds: row.end_seconds ?? 0,
              },
            }),
      })),
    },
    200,
  );
};
```

- [ ] **Step 5: Register the route in `apps/api/src/app.ts`**

Add the import alongside the others:

```ts
import { listJobsHandler, listJobsRoute } from "./routes/admin-jobs";
```

And register it next to the other admin route:

```ts
app.openapi(listJobsRoute, listJobsHandler);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @crowdmon/api test`
Expected: PASS, all suites.

- [ ] **Step 7: Regenerate and commit the spec artifact**

```bash
pnpm --filter @crowdmon/api run openapi
git diff --stat apps/api/openapi.json
```

Expected: `openapi.json` gains `AdminJob`, `AdminChunkWork`, `JobStatus`, `JobList` and the `listJobs` operation. Committing this is mandatory — CI's Go drift check regenerates `types.gen.go` from it.

- [ ] **Step 8: Regenerate the Go types**

```bash
cd worker && go generate ./... && go build ./... && cd ..
git status --short worker/
```

Expected: `worker/internal/api/types.gen.go` changes and still builds. It must be committed in the same change or CI fails on the drift check.

- [ ] **Step 9: Commit**

```bash
git add apps/api worker/internal/api/types.gen.go
git commit -m "feat(api): add GET /api/admin/jobs with lease and chunk state"
```

---

## Task 6: Typed API client with Access-expiry detection

**Files:**
- Modify: `apps/api/package.json` (add an `exports` map)
- Create: `apps/web/src/api/session.ts`, `apps/web/src/api/client.ts`, `apps/web/src/api/queries.ts`
- Create: `apps/web/test/api/client.test.ts`

**Interfaces:**
- Consumes: `AdminJob`, `JobList`, `SubmitVideoRequest`, `VideoSubmission`, `ErrorResponse` from `@crowdmon/api/schemas` (Task 5).
- Produces:
  - `SessionExpiredError` (class) and `ApiError` (class, with `status: number` and `issues?: Array<{ path: string; message: string }>`) from `apps/web/src/api/session.ts`.
  - `apiFetch<T>(path: string, schema: ZodType<T>, init?: RequestInit): Promise<T>` from `apps/web/src/api/client.ts`.
  - `useJobs()` and `useSubmitVideo()` from `apps/web/src/api/queries.ts`. Tasks 7 and 8 use those names.

**The two expiry symptoms.** CONTEXT.md §Q19 documents the expired-session failure as "`fetch` follows the 302 to the login page and returns HTML with a 200". On a single origin that is what happens when the login page is same-origin; when Access redirects to `mkcarl.cloudflareaccess.com`, the followed redirect is cross-origin without CORS headers and `fetch` rejects with a `TypeError` instead. **Both are the same event** and both must be treated as expiry. Task 9 observes which one production actually produces and records it.

- [ ] **Step 1: Add the exports map to `apps/api/package.json`**

Insert after `"type": "module",`:

```json
  "exports": {
    "./schemas": {
      "types": "./src/schemas.ts",
      "default": "./src/schemas.ts"
    }
  },
```

The target is TypeScript source, not a build output. Both sides are TypeScript in one workspace, so Vite transpiles it and `tsc` type-checks it directly — a schema change breaks `pnpm typecheck` in `apps/web` immediately, which is a stronger guarantee than a codegen drift check that only fires in CI.

- [ ] **Step 2: Add the workspace dependency**

```bash
pnpm --filter @crowdmon/web add '@crowdmon/api@workspace:*'
```

- [ ] **Step 3: Write the failing test — `apps/web/test/api/client.test.ts`**

```tsx
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../../src/api/client";
import { ApiError, SessionExpiredError } from "../../src/api/session";

const Body = z.object({ ok: z.boolean() });

function respond(body: string, init: ResponseInit & { type?: string }) {
  return new Response(body, {
    ...init,
    headers: { "content-type": init.type ?? "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("apiFetch", () => {
  it("returns the parsed body on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond('{"ok":true}', { status: 200 })));
    await expect(apiFetch("/api/admin/jobs", Body)).resolves.toEqual({ ok: true });
  });

  it("treats an HTML 200 as an expired Access session", async () => {
    // The symptom CONTEXT.md §Q19 documents: fetch silently follows the 302 to
    // the login page and hands back the login HTML with a 200.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(respond("<!doctype html><title>Sign in</title>", {
        status: 200,
        type: "text/html; charset=utf-8",
      })),
    );
    await expect(apiFetch("/api/admin/jobs", Body)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("treats a fetch TypeError as an expired Access session", async () => {
    // The other face of the same event: when the login page is cross-origin,
    // the followed redirect has no CORS headers and fetch rejects outright.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(apiFetch("/api/admin/jobs", Body)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("treats a 302 that was not followed as an expired Access session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond("", { status: 302 })));
    await expect(apiFetch("/api/admin/jobs", Body)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("surfaces the API's error message and validation issues", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        respond('{"error":"invalid request","issues":[{"path":"url","message":"Invalid URL"}]}', {
          status: 400,
        }),
      ),
    );

    const error = await apiFetch("/api/admin/videos", Body).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).message).toBe("invalid request");
    expect((error as ApiError).issues).toEqual([{ path: "url", message: "Invalid URL" }]);
  });

  it("rejects a 200 whose body does not match the schema", async () => {
    // The contract is the schema, not the status code. A response that parses
    // as JSON but disagrees with the shape is a bug worth a loud failure, not
    // an undefined three components deep.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond('{"ok":"yes"}', { status: 200 })));
    await expect(apiFetch("/api/admin/jobs", Body)).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @crowdmon/web test`
Expected: FAIL — "Cannot find module '../../src/api/client'".

- [ ] **Step 5: Write `apps/web/src/api/session.ts`**

```ts
/**
 * The Access session has expired, in whichever of its two disguises.
 *
 * Recovery is never a retry. The browser has to complete a redirect flow the
 * `fetch` API cannot, so the only fix is a full-page navigation — which is why
 * this is a distinct type rather than another failed request.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super("your Access session has expired");
    this.name = "SessionExpiredError";
  }
}

/** A response the API refused, carrying its own error contract. */
export class ApiError extends Error {
  readonly status: number;
  readonly issues?: Array<{ path: string; message: string }>;

  constructor(status: number, message: string, issues?: Array<{ path: string; message: string }>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.issues = issues;
  }
}

/**
 * Re-request the current URL as a top-level navigation so the browser can
 * follow Access's redirect chain and land back here logged in.
 *
 * `assign(href)` rather than `reload()`: a reload of a POST-derived history
 * entry re-prompts for resubmission, and the SPA's URL is what we want back.
 */
export function reauthenticate() {
  window.location.assign(window.location.href);
}
```

- [ ] **Step 6: Write `apps/web/src/api/client.ts`**

```ts
import type { ZodType } from "zod";
import { ApiError, SessionExpiredError } from "./session";

/**
 * Every call to the API goes through here.
 *
 * One chokepoint, for one reason: expired-Access detection has to happen on
 * every request and is easy to get subtly wrong, so it exists exactly once.
 *
 * Paths are relative. The SPA is served by the same Worker that serves the API
 * (M5.1), so there is no base URL to configure and no CORS to negotiate — and
 * if that ever stops being true, this is the single line that has to change.
 */
export async function apiFetch<T>(
  path: string,
  schema: ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, {
      ...init,
      // Access issues an httpOnly cookie on this origin. Stated rather than
      // relied upon: `same-origin` is the default today, and an explicit value
      // survives the day someone moves the API back to another hostname.
      credentials: "same-origin",
      headers: { accept: "application/json", ...init?.headers },
    });
  } catch (cause) {
    // A followed redirect to a cross-origin login page has no CORS headers, so
    // fetch rejects rather than resolving. Same event as the HTML 200 below.
    if (cause instanceof TypeError) throw new SessionExpiredError();
    throw cause;
  }

  // A 3xx that reached us un-followed can only be Access.
  if (response.status >= 300 && response.status < 400) throw new SessionExpiredError();

  // The documented symptom: fetch followed the 302 and this is the login page
  // wearing a 200. Content-type, not body sniffing — the API answers
  // application/json on every path including its errors, so anything else on an
  // API route is not the API answering.
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new SessionExpiredError();

  const body: unknown = await response.json();

  if (!response.ok) {
    const failure = body as { error?: string; issues?: Array<{ path: string; message: string }> };
    throw new ApiError(response.status, failure.error ?? "request failed", failure.issues);
  }

  // The contract is the schema. Parsing here means a drifted API surfaces at
  // the boundary with the field named, rather than as `undefined` inside a
  // component three levels down.
  return schema.parse(body);
}
```

- [ ] **Step 7: Write `apps/web/src/api/queries.ts`**

```ts
import { JobList, SubmitVideoRequest, VideoSubmission } from "@crowdmon/api/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import { apiFetch } from "./client";

export const jobsKey = ["jobs"] as const;

/**
 * The job list, refreshed on an interval (M5.3).
 *
 * Five seconds: the Go worker heartbeats every 30s and its poll floor is 30s,
 * so anything faster shows the same row repeatedly while adding D1 reads for
 * every open tab. `refetchIntervalInBackground` is left off — a hidden tab
 * polling a database is cost with nobody watching.
 */
export function useJobs() {
  return useQuery({
    queryKey: jobsKey,
    queryFn: () => apiFetch("/api/admin/jobs", JobList),
    refetchInterval: 5_000,
  });
}

export function useSubmitVideo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: z.infer<typeof SubmitVideoRequest>) =>
      apiFetch("/api/admin/videos", VideoSubmission, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    // The point of the form is watching the job appear. Waiting up to five
    // seconds for the next poll would read as the submission having failed.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: jobsKey }),
  });
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @crowdmon/web test`
Expected: PASS, 6 tests in `client.test.ts` plus the 2 routing tests.

- [ ] **Step 9: Verify the cross-package types resolve**

```bash
pnpm typecheck
```

Expected: clean. If `@crowdmon/api/schemas` fails to resolve, the `exports` map in Step 1 is wrong — check that the key is `"./schemas"` and the path is `"./src/schemas.ts"`, and that `apps/web/node_modules/@crowdmon/api` is a symlink into `apps/api`.

- [ ] **Step 10: Commit**

```bash
git add apps/api/package.json apps/web pnpm-lock.yaml
git commit -m "feat(web): typed API client with Access-expiry detection"
```

---

## Task 7: Submit form (M5.2)

**Files:**
- Create: `apps/web/src/components/SubmitForm.tsx`
- Create: `apps/web/test/components/SubmitForm.test.tsx`
- Modify: `apps/web/src/pages/Admin.tsx`

**Interfaces:**
- Consumes: `useSubmitVideo` from Task 6, `SubmitVideoRequest` from `@crowdmon/api/schemas`.
- Produces: `SubmitForm` (no props), rendered by `Admin`.

**M5.2's requirement is "surfaces errors rather than swallowing them."** The three failures that matter are a rejected URL (400), an already-submitted video (409), and a URL that is well-formed but names no YouTube video (400 with a different message). All three arrive as `ApiError` and all three must be readable on screen.

- [ ] **Step 1: Write the failing test — `apps/web/test/components/SubmitForm.test.tsx`**

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubmitForm } from "../../src/components/SubmitForm";

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("SubmitForm", () => {
  it("posts the URL and reports the created job", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ video_id: "dQw4w9WgXcQ", job_id: 7 }, 201));
    vi.stubGlobal("fetch", fetchMock);

    render(wrap(<SubmitForm />));
    await userEvent.type(
      screen.getByLabelText(/youtube url/i),
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(await screen.findByText(/job 7/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/videos",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows the API's message when the video was already submitted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ error: "this video has already been submitted" }, 409)),
    );

    render(wrap(<SubmitForm />));
    await userEvent.type(screen.getByLabelText(/youtube url/i), "https://youtu.be/dQw4w9WgXcQ");
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already been submitted/i);
  });

  it("shows per-field validation issues", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({ error: "invalid request", issues: [{ path: "url", message: "Invalid URL" }] }, 400),
      ),
    );

    render(wrap(<SubmitForm />));
    await userEvent.type(screen.getByLabelText(/youtube url/i), "not-a-url");
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/url: Invalid URL/i);
  });

  it("does not post an empty form", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(wrap(<SubmitForm />));
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @crowdmon/web test SubmitForm`
Expected: FAIL — "Cannot find module '../../src/components/SubmitForm'".

- [ ] **Step 3: Write `apps/web/src/components/SubmitForm.tsx`**

```tsx
import { type FormEvent, useId, useState } from "react";
import { useSubmitVideo } from "../api/queries";
import { ApiError } from "../api/session";

/**
 * Client-side validation is deliberately thin.
 *
 * The wire contract checks `z.url()` and the server alone decides what counts
 * as a YouTube URL (see the comment on `SubmitVideoRequest` — putting host
 * matching in the contract would make a change to it a breaking API change).
 * Duplicating that here would produce a second, drifting definition. The empty
 * check exists only to avoid a round trip that can only fail.
 */
export function SubmitForm() {
  const inputId = useId();
  const [url, setUrl] = useState("");
  const submit = useSubmitVideo();

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!url.trim()) return;
    submit.mutate({ url: url.trim() }, { onSuccess: () => setUrl("") });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <label htmlFor={inputId} className="text-sm text-[var(--color-text-muted)]">
        YouTube URL
      </label>
      <div className="flex gap-2">
        <input
          id={inputId}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://www.youtube.com/watch?v=..."
          className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 font-mono text-sm"
        />
        <button
          type="submit"
          disabled={submit.isPending}
          className="rounded border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-50"
        >
          {submit.isPending ? "Submitting…" : "Submit"}
        </button>
      </div>

      {submit.isSuccess && (
        <p className="text-sm text-[var(--color-done)]">
          Queued {submit.data.video_id} as job {submit.data.job_id}
        </p>
      )}

      {submit.isError && <SubmitError error={submit.error} />}
    </form>
  );
}

/**
 * Renders the API's own words. Nothing here rewrites a server message into a
 * friendlier one — M5.2's requirement is that failures surface, and a
 * translated message is a message that goes stale the first time the API's
 * wording changes.
 */
function SubmitError({ error }: { error: Error }) {
  const issues = error instanceof ApiError ? error.issues : undefined;

  return (
    <div role="alert" className="text-sm text-[var(--color-failed)]">
      <p>{error.message}</p>
      {issues && (
        <ul className="mt-1 list-disc pl-5">
          {issues.map((issue) => (
            <li key={`${issue.path}:${issue.message}`}>
              {issue.path}: {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @crowdmon/web test SubmitForm`
Expected: PASS, 4 tests.

- [ ] **Step 5: Render it from `apps/web/src/pages/Admin.tsx`**

```tsx
import { SubmitForm } from "../components/SubmitForm";

export function Admin() {
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 p-8">
      <h1 className="text-2xl font-semibold">Admin</h1>
      <section>
        <h2 className="mb-2 text-sm uppercase tracking-wide text-[var(--color-text-muted)]">
          Submit a video
        </h2>
        <SubmitForm />
      </section>
    </main>
  );
}
```

- [ ] **Step 6: Run the whole web suite and typecheck**

Run: `pnpm --filter @crowdmon/web test && pnpm typecheck && pnpm lint`
Expected: all pass. The routing test's `getByRole("heading", { name: "Admin" })` still matches, because `h2` carries different text.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): submit form that surfaces API errors"
```

---

## Task 8: Job and chunk list with auto-refresh (M5.3)

**Files:**
- Create: `apps/web/src/components/RelativeAge.tsx`, `apps/web/src/components/JobList.tsx`
- Create: `apps/web/test/components/JobList.test.tsx`
- Modify: `apps/web/src/pages/Admin.tsx`

**Interfaces:**
- Consumes: `useJobs` from Task 6, `AdminJobRow` from `@crowdmon/api/schemas`.
- Produces: `JobList` (no props) and `RelativeAge({ at, now }: { at: number | null; now: number })`.

**Grouping:** chunk jobs render nested under the download job for the same `video_id`. Chunk rows may exist before their download job in `id` order after a reap, so grouping is keyed on `video_id`, never on ordering.

- [ ] **Step 1: Write the failing test — `apps/web/test/components/JobList.test.tsx`**

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobList } from "../../src/components/JobList";

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

const NOW = 1_754_100_000;

function job(overrides: Record<string, unknown>) {
  return {
    id: 1,
    kind: "download",
    video_id: "dQw4w9WgXcQ",
    video_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    status: "pending",
    attempts: 0,
    claimed_by: null,
    claimed_at: null,
    heartbeat_at: null,
    failure_reason: null,
    created_at: NOW - 100,
    updated_at: NOW - 100,
    ...overrides,
  };
}

function stubJobs(jobs: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ now: NOW, jobs }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("JobList", () => {
  it("shows heartbeat age against the server clock, not the browser's", async () => {
    // The browser is deliberately an hour ahead. An age computed from
    // Date.now() would read 3630s and look like a dead worker.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date((NOW + 3600) * 1000));
    stubJobs([job({ status: "claimed", claimed_by: "carls-ubuntu-1", heartbeat_at: NOW - 30 })]);

    render(wrap(<JobList />));
    expect(await screen.findByText("30s ago")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("nests chunk jobs under the download job for the same video", async () => {
    stubJobs([
      job({ id: 5, kind: "chunk", chunk: { segment_index: 1, start_seconds: 60, end_seconds: 120 } }),
      job({ id: 1, kind: "download" }),
    ]);

    render(wrap(<JobList />));
    const group = await screen.findByRole("group", { name: /dQw4w9WgXcQ/ });
    expect(within(group).getByText(/segment 1/i)).toBeInTheDocument();
  });

  it("shows the failure reason on a failed job", async () => {
    stubJobs([job({ status: "failed", attempts: 3, failure_reason: "video unavailable" })]);

    render(wrap(<JobList />));
    expect(await screen.findByText("video unavailable")).toBeInTheDocument();
  });

  it("renders a never-claimed job without inventing an age", async () => {
    stubJobs([job({ status: "pending", heartbeat_at: null })]);

    render(wrap(<JobList />));
    expect(await screen.findByText("never")).toBeInTheDocument();
  });

  it("says so when the queue is empty", async () => {
    stubJobs([]);

    render(wrap(<JobList />));
    expect(await screen.findByText(/no jobs yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @crowdmon/web test JobList`
Expected: FAIL — "Cannot find module '../../src/components/JobList'".

- [ ] **Step 3: Write `apps/web/src/components/RelativeAge.tsx`**

```tsx
/**
 * Age against the server's clock.
 *
 * `now` is the value the API reported in the same response, never `Date.now()`.
 * A laptop whose clock is minutes off would otherwise render a healthy fleet as
 * uniformly stale, and the operator would be debugging the wrong machine.
 */
export function RelativeAge({ at, now }: { at: number | null; now: number }) {
  if (at === null) return <span className="text-[var(--color-text-muted)]">never</span>;

  const seconds = Math.max(0, now - at);
  if (seconds < 60) return <span>{seconds}s ago</span>;
  if (seconds < 3600) return <span>{Math.floor(seconds / 60)}m ago</span>;
  if (seconds < 86_400) return <span>{Math.floor(seconds / 3600)}h ago</span>;
  return <span>{Math.floor(seconds / 86_400)}d ago</span>;
}
```

- [ ] **Step 4: Write `apps/web/src/components/JobList.tsx`**

```tsx
import type { AdminJobRow } from "@crowdmon/api/schemas";
import { useJobs } from "../api/queries";
import { RelativeAge } from "./RelativeAge";

const STATUS_COLOR: Record<AdminJobRow["status"], string> = {
  pending: "var(--color-pending)",
  claimed: "var(--color-claimed)",
  done: "var(--color-done)",
  failed: "var(--color-failed)",
};

/**
 * Grouped by video, not by arrival order.
 *
 * A chunk job can carry a lower id than the download job it belongs to once a
 * reap has re-run fan-out (M7.3), so ordering is not a grouping key. Videos are
 * ordered by their newest job so a fresh submission appears at the top.
 */
function groupByVideo(jobs: AdminJobRow[]) {
  const groups = new Map<string, { download?: AdminJobRow; chunks: AdminJobRow[]; newest: number }>();

  for (const job of jobs) {
    const group = groups.get(job.video_id) ?? { chunks: [], newest: 0 };
    if (job.kind === "download") group.download = job;
    else group.chunks.push(job);
    group.newest = Math.max(group.newest, job.id);
    groups.set(job.video_id, group);
  }

  return [...groups.entries()].sort(([, a], [, b]) => b.newest - a.newest);
}

export function JobList() {
  const { data, isPending, error } = useJobs();

  if (isPending) return <p className="text-[var(--color-text-muted)]">Loading…</p>;
  if (error) return <p role="alert" className="text-[var(--color-failed)]">{error.message}</p>;
  if (data.jobs.length === 0)
    return <p className="text-[var(--color-text-muted)]">No jobs yet.</p>;

  return (
    <div className="flex flex-col gap-4">
      {groupByVideo(data.jobs).map(([videoId, group]) => (
        <section
          key={videoId}
          aria-label={videoId}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4"
        >
          <h3 className="font-mono text-sm">{videoId}</h3>
          {group.download && <JobRow job={group.download} now={data.now} />}
          {group.chunks.length > 0 && (
            <ul className="mt-2 border-l border-[var(--color-border)] pl-4">
              {group.chunks
                .sort((a, b) => (a.chunk?.segment_index ?? 0) - (b.chunk?.segment_index ?? 0))
                .map((chunk) => (
                  <li key={chunk.id}>
                    <JobRow job={chunk} now={data.now} />
                  </li>
                ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function JobRow({ job, now }: { job: AdminJobRow; now: number }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-1 text-sm">
      <span style={{ color: STATUS_COLOR[job.status] }}>{job.status}</span>
      <span className="font-mono text-[var(--color-text-muted)]">#{job.id}</span>
      {job.chunk && <span>segment {job.chunk.segment_index}</span>}
      {/* Attempts are shown always, not only when non-zero: the number
          approaching M6.1's ceiling is the signal, and a field that appears
          only sometimes is a field nobody learns to read. */}
      <span className="text-[var(--color-text-muted)]">attempts {job.attempts}</span>
      {job.claimed_by && <span className="font-mono">{job.claimed_by}</span>}
      <span className="text-[var(--color-text-muted)]">
        heartbeat <RelativeAge at={job.heartbeat_at} now={now} />
      </span>
      <span className="text-[var(--color-text-muted)]">
        created <RelativeAge at={job.created_at} now={now} />
      </span>
      {job.failure_reason && (
        <span className="text-[var(--color-failed)]">{job.failure_reason}</span>
      )}
    </div>
  );
}
```

Note for the implementer: `aria-label` on a `<section>` gives it the `group` role, which is what the test queries with `getByRole("group", ...)`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @crowdmon/web test JobList`
Expected: PASS, 5 tests.

- [ ] **Step 6: Render it from `apps/web/src/pages/Admin.tsx`**

Add below the submit section:

```tsx
      <section>
        <h2 className="mb-2 text-sm uppercase tracking-wide text-[var(--color-text-muted)]">
          Queue
        </h2>
        <JobList />
      </section>
```

with `import { JobList } from "../components/JobList";` at the top.

- [ ] **Step 7: Verify against the real API**

```bash
pnpm --filter @crowdmon/api exec wrangler dev &
pnpm --filter @crowdmon/web run dev
```

Open `http://localhost:5173/admin`, submit a URL, and confirm the job appears immediately (mutation invalidation) and that the heartbeat column advances on its own within ~5s.

- [ ] **Step 8: Commit**

```bash
git add apps/web
git commit -m "feat(web): job and chunk list with server-clock ages"
```

---

## Task 9: Access session expiry (M5.4)

**Files:**
- Create: `apps/web/src/components/SessionExpiredBanner.tsx`
- Create: `apps/web/test/components/SessionExpiredBanner.test.tsx`
- Modify: `apps/web/src/pages/Admin.tsx`
- Modify: `CONTEXT.md`

**Interfaces:**
- Consumes: `SessionExpiredError` and `reauthenticate` from Task 6.
- Produces: `SessionExpiredBanner({ error }: { error: unknown })`, which renders nothing unless `error` is a `SessionExpiredError`.

**Why a banner and not an automatic redirect.** An automatic `location.assign` on every expiry turns a transient network failure into a navigation that discards whatever the operator had typed in the submit box. The banner makes recovery explicit and one click away. M5.4's real requirement — that recovery is a **full page navigation** rather than another `fetch` — is satisfied either way.

- [ ] **Step 1: Write the failing test — `apps/web/test/components/SessionExpiredBanner.test.tsx`**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionExpiredBanner } from "../../src/components/SessionExpiredBanner";
import { ApiError, SessionExpiredError } from "../../src/api/session";

describe("SessionExpiredBanner", () => {
  it("renders nothing for an ordinary API error", () => {
    const { container } = render(<SessionExpiredBanner error={new ApiError(409, "duplicate")} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when there is no error", () => {
    const { container } = render(<SessionExpiredBanner error={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers a full-page navigation to re-authenticate", async () => {
    // A full navigation, not a fetch: only a top-level load can follow Access's
    // redirect chain to the identity provider and back.
    const assign = vi.fn();
    vi.stubGlobal("location", { href: "https://crowdmon.mkcarl.com/admin", assign });

    render(<SessionExpiredBanner error={new SessionExpiredError()} />);
    await userEvent.click(screen.getByRole("button", { name: /sign in again/i }));

    expect(assign).toHaveBeenCalledWith("https://crowdmon.mkcarl.com/admin");
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @crowdmon/web test SessionExpiredBanner`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `apps/web/src/components/SessionExpiredBanner.tsx`**

```tsx
import { reauthenticate, SessionExpiredError } from "../api/session";

/**
 * The Access session lasts 24 hours, so an admin tab left open overnight meets
 * this every morning.
 *
 * Not an automatic redirect: a transient failure would then discard whatever
 * was typed into the submit box. What M5.4 actually requires is that recovery
 * is a *navigation* rather than another fetch — `fetch` cannot complete a
 * redirect flow to an identity provider — and a button does that.
 */
export function SessionExpiredBanner({ error }: { error: unknown }) {
  if (!(error instanceof SessionExpiredError)) return null;

  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-4 rounded border border-[var(--color-claimed)] p-3 text-sm"
    >
      <span>Your Access session has expired.</span>
      <button
        type="button"
        onClick={reauthenticate}
        className="rounded border border-[var(--color-border)] px-3 py-1"
      >
        Sign in again
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @crowdmon/web test SessionExpiredBanner`
Expected: PASS, 3 tests.

- [ ] **Step 5: Wire it into `apps/web/src/pages/Admin.tsx`**

```tsx
import { useJobs } from "../api/queries";
import { SessionExpiredBanner } from "../components/SessionExpiredBanner";
```

Inside `Admin`, above the submit section:

```tsx
  // Reads the same cached query the list renders — TanStack Query dedupes it,
  // so this is the existing poll's error, not a second request.
  const { error } = useJobs();
```

```tsx
      <SessionExpiredBanner error={error} />
```

- [ ] **Step 6: Verify against a genuinely expired session**

M5.4 requires this, and it cannot be simulated. Do it in this order:

1. Deploy the current branch: `pnpm --filter @crowdmon/web run build && pnpm --filter @crowdmon/api run deploy`.
2. Open `https://crowdmon.mkcarl.com/admin` and log in through Access. Confirm jobs load.
3. Revoke the session rather than waiting 24 hours — visit `https://mkcarl.cloudflareaccess.com/cdn-cgi/access/logout` in another tab, then return to the still-open admin tab **without reloading it**.
4. Wait for the next 5s poll and record what actually happens in DevTools → Network:
   - a `200` whose `content-type` is `text/html` (the symptom CONTEXT.md §Q19 documents), **or**
   - a failed request with a CORS error (`TypeError` in the console).
5. Confirm the banner appears either way, and that "Sign in again" completes the login and returns to `/admin` with jobs loading.

- [ ] **Step 7: Record which symptom production produces, in `CONTEXT.md` §Q19**

Amend the "SPA gotcha" paragraph with what step 6 observed — naming the observed symptom, and noting that the client handles both because the answer depends on whether Access's login redirect is same-origin. State that it was verified against a revoked session on a given date, not simulated.

- [ ] **Step 8: Commit**

```bash
git add apps/web CONTEXT.md
git commit -m "feat(web): recover from an expired Access session"
```

---

## Task 10: Record the decisions and close the milestone

**Files:**
- Modify: `ROADMAP.md`
- Modify: `CONTEXT.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

This project's record of *why* is load-bearing — M2.1 and M4.6 both amend the roadmap in place rather than quietly diverging from it. M5 diverges from its written plan in three places and must do the same.

- [ ] **Step 1: Amend M5.1 in `ROADMAP.md`**

Replace the M5.1 block with the deployed reality and the reason:

```markdown
### M5.1 — SPA shell on the API Worker — **amended from "on Pages"**

The original bullet said Pages. Pages would have put the SPA on a second
hostname, making every admin call cross-origin: CORS with credentials, a
cookie policy nobody had written down, and — worse — M5.4's documented expiry
symptom replaced by a CORS failure, so the milestone's hardest bullet would
have been verifying the wrong thing. Cloudflare also now steers new projects to
Workers static assets. Serving the SPA from the Worker that already answers
`/api/*` costs one `[assets]` table.

- [x] Vite + React, built by CI and uploaded by the same `wrangler deploy`
- [x] `run_worker_first` covers `/api/*`, `/health` and `/openapi.json` —
      `not_found_handling = "single-page-application"` answers every other path
      with `index.html`, which would have made the deploy's health check curl
      the SPA shell and pass over a dead API
- [x] `preview_urls = false`, with a test. Version preview URLs are on
      `*.workers.dev`, which Access cannot cover; leaving them on would have
      republished `/api/admin/*` ungated — the M4.6 hole through a setting M4.6
      never touched
- [x] One hostname, `crowdmon.mkcarl.com`. `api.` retired; the Access
      application moved with it, which regenerated its `aud`
- [x] No Access application on the UI route. CONTEXT.md §Q19 gates the API, not
      the bundle — the original bullet's "Access application covering the admin
      route" contradicted it
```

- [ ] **Step 2: Add the scope correction to M5.3 in `ROADMAP.md`**

Note under M5.3 that it required `GET /api/admin/jobs`, which did not exist — M5 was written as a frontend milestone and is not one — and that the endpoint returns the server's clock so heartbeat ages do not inherit the browser's skew.

- [ ] **Step 3: Amend `CONTEXT.md` §Q6**

The "React SPA on Pages" decision now reads "React SPA served by the API Worker". Record the four reasons: one origin, no CORS, M5.4's symptom preserved, and Pages being in maintenance. Record too that the public surface staying thin (§Q11: landing, about, demo) is what keeps a single Vite app correct — and that if it ever grows into content, the answer is a second app in the monorepo sharing components, not a framework migration of the admin panel.

- [ ] **Step 4: Add a §Q-level note on the type-sharing decision in `CONTEXT.md`**

The Go worker gets generated types because it is across a language boundary. The SPA imports `@crowdmon/api/schemas` directly, because TypeScript-to-TypeScript in one workspace does not need codegen — and importing the schema rather than a generated type means a contract change fails `pnpm typecheck` immediately, and `schema.parse()` at the client boundary doubles as the tripwire that catches an Access login page arriving where JSON was expected.

- [ ] **Step 5: Update `README.md`**

Add the admin dashboard to the architecture summary: one Worker at `crowdmon.mkcarl.com` serving the SPA and the API, Access on `/api/admin`, local development via `wrangler dev` plus `vite` with the proxy.

- [ ] **Step 6: Verify the whole repo is green**

```bash
pnpm typecheck && pnpm lint && pnpm test
pnpm --filter @crowdmon/web run build
cd worker && go vet ./... && go build ./... && go test ./... && cd ..
git status --short
```

Expected: everything passes and the tree is clean apart from intended changes.

- [ ] **Step 7: Commit**

```bash
git add ROADMAP.md CONTEXT.md README.md
git commit -m "docs: record M5's amendments to the roadmap and design record"
```

---

## Done When

- [ ] A YouTube URL submitted at `https://crowdmon.mkcarl.com/admin` creates a job, and the job appears in the list without a manual refresh.
- [ ] Job status visibly moves `pending` → `claimed` → `done` as the home worker picks it up.
- [ ] Heartbeat age advances on its own and is correct on a machine with a deliberately skewed clock.
- [ ] `https://crowdmon.mkcarl.com/api/admin/jobs` returns 302 to Access when unauthenticated, and 401 from the Worker if reached without an assertion.
- [ ] `https://api.crowdmon.mkcarl.com/health` fails on five consecutive samples.
- [ ] A revoked Access session produces the banner, and "Sign in again" restores the page.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass, and the Go drift check passes on the regenerated spec.
