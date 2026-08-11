import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../bindings";
import { AdminSession, errorResponse } from "../schemas";

/**
 * Whether the browser already has an Access session, for `AdminLayout` to ask
 * once on mount (M16, CONTEXT.md §Q19 amendment).
 *
 * This is the only new surface M16's login screen needs, and it is
 * deliberately thin: `requireAccess` already decides everything a caller
 * cannot influence, and this route adds no check of its own past it. What it
 * buys is a *question* nothing before M16 could ask — every other
 * `/api/admin/*` route answers "is this request authorized," never "should
 * this browser currently be shown a login screen," and those are different
 * questions with the same middleware behind them. Without this route,
 * `AdminLayout` would have to probe some other endpoint and infer session
 * state from whether *that* happened to fail, which is what
 * `SessionExpiredBanner` already does the long way round for every other
 * page — this route exists so the layout does not have to.
 *
 * Answering with the identity rather than an empty 204 is not scope creep:
 * `requireAccess` already put `email` in context for `submitVerdictsHandler`
 * and friends to read, and the sidebar this route feeds wants exactly that
 * string to say who is signed in. A 204 would just move the second request
 * `AdminLayout` would otherwise need back into the sidebar's own render.
 */
export const adminSessionRoute = createRoute({
  method: "get",
  path: "/api/admin/session",
  operationId: "adminSession",
  tags: ["admin"],
  summary: "Whether the caller has a valid Access session, and who they are",
  description:
    "Reaching this handler at all is the answer: `requireAccess` has already verified the " +
    "Access assertion and confirmed the email is on the admin allowlist by the time this " +
    "runs. `AdminLayout` calls it once on mount to decide between the sidebar shell and " +
    "the `/admin/login` gate screen. Requires a Cloudflare Access assertion.",
  responses: {
    200: {
      description: "A valid session, and the identity behind it",
      content: { "application/json": { schema: AdminSession } },
    },
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const adminSessionHandler: RouteHandler<typeof adminSessionRoute, AppEnv> = (c) =>
  // The fallback is not a reachable state, the same non-guarantee
  // `admin-verdicts.ts`'s `annotator` helper carries: this route sits under
  // `/api/admin/*`, so `requireAccess` has always run first and always set
  // this before `next()` was called.
  c.json({ email: c.get("adminEmail") ?? "unknown" }, 200);
