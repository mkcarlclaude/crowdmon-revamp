/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
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
  resolve: {
    // The runtime half of the `@/*` alias declared in tsconfig.json. Kept in
    // sync by hand: a mismatch typechecks and fails at build, or vice versa.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    outDir: "dist",
    // Lowers the threshold at which `vite build` prints its bundle-size
    // warning. It is only that — a warning. `vite build` still exits 0 past
    // it, so nothing here fails a CI run or blocks a deploy; this is a
    // tripwire for whoever is watching build output, not a gate.
    //
    // Raised from 600 in M16: shadcn/ui's Radix primitives plus a sidebar
    // shell and eight routed admin pages crossed it (~692 kB), exactly as
    // ROADMAP M16's own plan expected — "a component library plus five new
    // pages will cross it." Raised deliberately, in the commit that crosses
    // it, per that plan's own rule, rather than left to trip on some later
    // PR that added one component nobody thought was the straw. 800 leaves
    // headroom for the remaining M16 pages (a frame grid, a verdict list)
    // without being so loose the tripwire stops meaning anything — the next
    // deliberate crossing should raise it again, not the number picked here.
    chunkSizeWarningLimit: 800,
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
