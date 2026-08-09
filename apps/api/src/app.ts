import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./bindings";
import { requireAccess } from "./middleware/access";
import { publicRateLimit } from "./middleware/rate-limit";
import { nameSpanAfterRoute } from "./middleware/trace-route";
import { openApiConfig } from "./openapi";
import {
  createClassHandler,
  createClassRoute,
  listClassesHandler,
  listClassesRoute,
  updateClassHandler,
  updateClassRoute,
} from "./routes/admin-classes";
import {
  createDryRunHandler,
  createDryRunRoute,
  listDryRunsHandler,
  listDryRunsRoute,
} from "./routes/admin-dryruns";
import {
  getImageHandler,
  getImageRoute,
  updatePublicSampleHandler,
  updatePublicSampleRoute,
} from "./routes/admin-images";
import { listJobsHandler, listJobsRoute } from "./routes/admin-jobs";
import {
  labellingBatchHandler,
  labellingBatchRoute,
  labellingStatsHandler,
  labellingStatsRoute,
} from "./routes/admin-labelling";
import { adminLoginHandler, adminLoginRoute } from "./routes/admin-login";
import {
  createSnapshotHandler,
  createSnapshotRoute,
  listSnapshotsHandler,
  listSnapshotsRoute,
} from "./routes/admin-snapshots";
import {
  createMissingReportHandler,
  createMissingReportRoute,
  submitVerdictsHandler,
  submitVerdictsRoute,
} from "./routes/admin-verdicts";
import { listActiveClassesHandler, listActiveClassesRoute } from "./routes/classes";
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
  listVideoImagesHandler,
  listVideoImagesRoute,
  reportDryRunHandler,
  reportDryRunRoute,
  reportImagesHandler,
  reportImagesRoute,
  reportPredictionsHandler,
  reportPredictionsRoute,
  reportSnapshotHandler,
  reportSnapshotRoute,
  snapshotSourceHandler,
  snapshotSourceRoute,
} from "./routes/jobs";
import {
  publicFrameHandler,
  publicFrameRoute,
  submitPublicVerdictsHandler,
  submitPublicVerdictsRoute,
} from "./routes/public";
import {
  listVideosHandler,
  listVideosRoute,
  submitVideoHandler,
  submitVideoRoute,
} from "./routes/videos";

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
export const app = new OpenAPIHono<AppEnv>({
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

// M14.3: the public verification surface's rate limit. One mount per route
// rather than a prefix, and each with its own literal bucket — see
// `publicRateLimit`'s own comment for why a shared `/api/public/*` mount
// would collapse both routes onto one counter.
app.use("/api/public/frame", publicRateLimit("frame"));
app.use("/api/public/images/:id/verdicts", publicRateLimit("verdict"));

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
app.openapi(listVideoImagesRoute, listVideoImagesHandler);
app.openapi(jobStatsRoute, jobStatsHandler);
app.openapi(listActiveClassesRoute, listActiveClassesHandler);
app.openapi(listClassesRoute, listClassesHandler);
app.openapi(createClassRoute, createClassHandler);
app.openapi(updateClassRoute, updateClassHandler);
app.openapi(listVideosRoute, listVideosHandler);
app.openapi(createDryRunRoute, createDryRunHandler);
app.openapi(listDryRunsRoute, listDryRunsHandler);
app.openapi(getImageRoute, getImageHandler);
app.openapi(reportDryRunRoute, reportDryRunHandler);
app.openapi(submitVerdictsRoute, submitVerdictsHandler);
app.openapi(createMissingReportRoute, createMissingReportHandler);
app.openapi(updatePublicSampleRoute, updatePublicSampleHandler);
app.openapi(publicFrameRoute, publicFrameHandler);
app.openapi(submitPublicVerdictsRoute, submitPublicVerdictsHandler);
app.openapi(labellingBatchRoute, labellingBatchHandler);
app.openapi(labellingStatsRoute, labellingStatsHandler);
app.openapi(createSnapshotRoute, createSnapshotHandler);
app.openapi(listSnapshotsRoute, listSnapshotsHandler);
app.openapi(snapshotSourceRoute, snapshotSourceHandler);
app.openapi(reportSnapshotRoute, reportSnapshotHandler);

// Serves the same document the build artifact contains, from the same config.
// A deployed Worker that describes itself is worth one route: it answers "what
// contract is actually live" without cross-referencing a commit.
app.doc("/openapi.json", openApiConfig);

app.notFound((c) => c.json({ error: "not found" }, 404));
