import { trace } from "@opentelemetry/api";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../bindings";

/**
 * Names the request span after the route that actually matched.
 *
 * `instrument()` opens a span per request before Hono has looked at the URL,
 * so left alone every span carries the same generic name and the raw path ends
 * up as the only distinguishing attribute. That makes Tempo's service graphs
 * and the metrics-generator's RED metrics useless the moment a route takes a
 * path parameter: `/api/jobs/1` and `/api/jobs/2` become separate series.
 *
 * Naming has to happen *after* `next()`, because the match is not known until
 * routing has run. The span is still open at that point — it is closed by the
 * instrumentation wrapper outside this middleware.
 */
export const nameSpanAfterRoute = createMiddleware<AppEnv>(async (c, next) => {
  await next();

  const span = trace.getActiveSpan();
  if (!span) return;

  const route = c.req.routePath;

  // Unmatched requests report `/*`. Recording that as `http.route` would be
  // a lie — semantic conventions want the matched template or nothing — and
  // it would collapse every 404 in the system into one bucket.
  if (route === "/*") {
    span.updateName(c.req.method);
    return;
  }

  span.updateName(`${c.req.method} ${route}`);
  span.setAttribute("http.route", route);
});
