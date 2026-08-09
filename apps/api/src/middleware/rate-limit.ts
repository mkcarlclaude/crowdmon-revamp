import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../bindings";

/**
 * Bounds the public verification surface (M14.3, CONTEXT.md §Q25's third
 * bound: "not at scale" enforced by a mechanism rather than asserted in a
 * document).
 *
 * `bucket` is a literal chosen at registration (`"frame"`, `"verdict"`)
 * rather than read off `c.req.routePath`: that getter returns whichever
 * pattern the router happened to match *this* middleware invocation against
 * (`app.use`'s own registered pattern, before `next()` has advanced past it),
 * not the specific leaf route about to run — so every route this middleware
 * was mounted on by prefix would collapse into one counter instead of one
 * each. A literal per mount point is the whole fix.
 *
 * Keyed by `${bucket}:${ip}`. `cf-connecting-ip` is set by Cloudflare's edge
 * on every request this Worker receives in production; nothing else on the
 * request is trustworthy for this purpose (`X-Forwarded-For` is
 * caller-suppliable). Its absence — local dev, a test harness — falls back to
 * one shared bucket per bucket label rather than failing closed: the admin
 * surface answers a hard `503` for a missing gate because a silently-open
 * admin API is the one failure this repo cannot tolerate, but a shared bucket
 * for anonymous traffic under `wrangler dev` only makes the demo stricter
 * than production, never weaker than the gate it is bounding.
 */
export const publicRateLimit = (bucket: string) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const { success } = await c.env.PUBLIC_RATE_LIMITER.limit({ key: `${bucket}:${ip}` });

    if (!success) {
      return c.json({ error: "too many requests" }, 429);
    }

    await next();
  });
