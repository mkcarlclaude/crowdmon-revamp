import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../bindings";
import { errorResponse } from "../schemas";

/**
 * The SPA's way back into an Access login.
 *
 * M5.1 deliberately put no Access application on `/admin` — CONTEXT.md §Q19
 * gates the API, not the bundle, and the admin bundle is assumed public. The
 * consequence nobody traced until M5 was deployed: `/admin` is a static asset,
 * so navigating a browser to it never touches Access. M5.4's recovery was
 * `window.location.assign(window.location.href)`, which reloads `/admin`, gets
 * the SPA shell back, re-fetches, fails identically, and re-renders the banner.
 * The button could not reach a login screen at all.
 *
 * This route can, because it lives under `/api/admin` and Access binds to that
 * path prefix. A top-level navigation here is intercepted before the Worker
 * sees it; the browser completes the redirect chain to the identity provider
 * that `fetch` cannot; and the request only arrives below once an assertion
 * exists. Reaching the handler therefore *means* the caller is authenticated,
 * and the one useful thing to do with that is put them back where they were.
 */
export const adminLoginRoute = createRoute({
  method: "get",
  path: "/api/admin/login",
  operationId: "adminLogin",
  tags: ["admin"],
  summary: "Complete an Access login and return to the dashboard",
  description:
    "Exists to be navigated to, not fetched. Access gates the path, so an " +
    "unauthenticated browser is sent through the login flow and only then " +
    "redirected on to `/admin`.",
  responses: {
    302: {
      description: "Authenticated; redirecting to the admin dashboard",
      headers: {
        Location: {
          description: "Always `/admin`",
          schema: { type: "string" as const },
        },
      },
    },
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const adminLoginHandler: RouteHandler<typeof adminLoginRoute, AppEnv> = (c) =>
  // A fixed internal path, never a `redirect_url` parameter off the query
  // string. Honouring caller-supplied targets here would turn the one endpoint
  // guaranteed to be reached with a freshly minted session into an open
  // redirect, which is the exact shape of a credential-phishing hop.
  c.redirect("/admin", 302);
