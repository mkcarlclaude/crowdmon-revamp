import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type { Bindings } from "./bindings";
import { requireAccess } from "./middleware/access";
import { nameSpanAfterRoute } from "./middleware/trace-route";
import { openApiConfig } from "./openapi";
import { listJobsHandler, listJobsRoute } from "./routes/admin-jobs";
import { adminLoginHandler, adminLoginRoute } from "./routes/admin-login";
import { healthHandler, healthRoute } from "./routes/health";
import {
  claimJobHandler,
  claimJobRoute,
  completeJobHandler,
  completeJobRoute,
  fanOutJobHandler,
  fanOutJobRoute,
  heartbeatHandler,
  heartbeatRoute,
  jobStatsHandler,
  jobStatsRoute,
  reportImagesHandler,
  reportImagesRoute,
  reportPredictionsHandler,
  reportPredictionsRoute,
} from "./routes/jobs";
import { submitVideoHandler, submitVideoRoute } from "./routes/videos";

/**
 * The routes, with no knowledge of how the Worker is bootstrapped.
 *
 * Kept apart from index.ts on purpose: `instrument()` reaches for
 * `cloudflare:workers`, a module only workerd can resolve, so anything that
 * imports the entry point can only run inside the real runtime. Tests import
 * this file and stay on plain Node.
 *
 * `OpenAPIHono` extends `Hono`, so middleware, `notFound` and `app.request`
 * behave exactly as before — the tracing middleware below still sees every
 * route, matched or not.
 */
export const app = new OpenAPIHono<{ Bindings: Bindings }>({
  // Without this, a validation failure returns zod's raw error payload, which
  // has its own shape — clients would need one parser for validation errors
  // and another for every other failure. Registered once on the app rather
  // than per route: a route that forgets its hook is a route that answers in
  // the wrong shape, and nothing would catch it.
  defaultHook: (result, c) => {
    if (result.success) return;

    return c.json(
      {
        error: "invalid request",
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      400,
    );
  },
});

// An unparseable body never reaches a schema: Hono's validator throws an
// HTTPException with a plain-text message before the hook above can run. Left
// alone, that is the one malformed-input case answering in a shape the spec
// does not declare, and the shape M3.3's generated Go client cannot unmarshal.
app.onError((err, c) => {
  if (err instanceof HTTPException && err.status === 400) {
    return c.json({ error: "malformed request body" }, 400);
  }

  // Anything else is a bug, not bad input. Rethrown rather than dressed up as
  // JSON so it reaches the instrumentation wrapper and records on the span.
  throw err;
});

app.use("*", nameSpanAfterRoute);

// Registered before the routes, and by path prefix rather than per route: a
// new admin endpoint is then gated by existing, not by remembering to add the
// middleware to it.
app.use("/api/admin/*", requireAccess);

// /health goes through the OpenAPI router like everything else. A spec that
// omits the one endpoint external checks actually call would describe less
// than the whole surface, and the deploy workflow would be curling an
// undocumented path.
app.openapi(healthRoute, healthHandler);

app.openapi(submitVideoRoute, submitVideoHandler);
app.openapi(listJobsRoute, listJobsHandler);
app.openapi(adminLoginRoute, adminLoginHandler);
app.openapi(claimJobRoute, claimJobHandler);
app.openapi(heartbeatRoute, heartbeatHandler);
app.openapi(completeJobRoute, completeJobHandler);
app.openapi(fanOutJobRoute, fanOutJobHandler);
app.openapi(reportImagesRoute, reportImagesHandler);
app.openapi(reportPredictionsRoute, reportPredictionsHandler);
app.openapi(jobStatsRoute, jobStatsHandler);

// Serves the same document the build artifact contains, from the same config.
// A deployed Worker that describes itself is worth one route: it answers "what
// contract is actually live" without cross-referencing a commit.
app.doc("/openapi.json", openApiConfig);

app.notFound((c) => c.json({ error: "not found" }, 404));
