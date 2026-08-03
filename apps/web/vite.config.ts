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
    // Lowers the threshold at which `vite build` prints its bundle-size
    // warning. It is only that — a warning. `vite build` still exits 0 past
    // it, so nothing here fails a CI run or blocks a deploy; this is a
    // tripwire for whoever is watching build output, not a gate. The admin
    // surface is three screens (current output is ~552 kB), so anything past
    // 600 kB is worth a look, not an automatic block.
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
