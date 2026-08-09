import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../bindings";
import { errorResponse, SnapshotJob, SnapshotList } from "../schemas";
import { currentTraceparent } from "../tracing";

/**
 * Dataset snapshots, behind Access (M15.1).
 *
 * "An admin action builds a dataset snapshot... and issues a short-lived
 * presigned GET" is §7's shape for the Kaggle handoff; v2 keeps the "an admin
 * action builds one" half and drops the presigned-GET half — CONTEXT.md §12
 * amends the handoff to the home box, which already holds R2 credentials, so
 * there is no ephemeral notebook here needing a scoped URL instead of the
 * bucket itself.
 *
 * Building is a queued job, not this route's own work — ROADMAP.md M15.1:
 * "runs as a job rather than in a request... building one must not depend on
 * a browser tab staying open." The route below only ever inserts one `jobs`
 * row; `apps/api/src/routes/jobs.ts`'s `snapshotSourceRoute` and
 * `reportSnapshotRoute` are where the actual work happens, on the home box.
 */

export const createSnapshotRoute = createRoute({
  method: "post",
  path: "/api/admin/snapshots",
  operationId: "createSnapshot",
  tags: ["admin"],
  summary: "Build a dataset snapshot from everything the inclusion policy currently admits",
  description:
    "Enqueues a `snapshot` job (migration 0008). No body: v2 has exactly one inclusion " +
    "policy (M15.3), so there is nothing for a caller to choose. Requires a Cloudflare " +
    "Access assertion.",
  responses: {
    201: {
      description: "The job, queued and not yet run",
      content: { "application/json": { schema: SnapshotJob } },
    },
    400: errorResponse("The insert did not return a row"),
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const createSnapshotHandler: RouteHandler<typeof createSnapshotRoute, AppEnv> = async (
  c,
) => {
  // No `video_id`: migration 0008's CHECK requires it be null for exactly
  // this kind, and a snapshot job is not about any one video.
  const created = await c.env.DB.prepare(
    "INSERT INTO jobs (kind, video_id, traceparent) VALUES ('snapshot', NULL, ?) RETURNING id, status",
  )
    .bind(currentTraceparent())
    .first<{ id: number; status: "pending" | "claimed" | "done" | "failed" }>();

  if (!created) return c.json({ error: "could not enqueue the snapshot job" }, 400);

  return c.json({ job_id: created.id, status: created.status }, 201);
};

export const listSnapshotsRoute = createRoute({
  method: "get",
  path: "/api/admin/snapshots",
  operationId: "listSnapshots",
  tags: ["admin"],
  summary: "Every dataset snapshot built so far, newest first",
  description:
    "M15.1's 'listable with counts and dates' — the whole `snapshots` table (migration " +
    "0003), which needs no join: unlike a job, a finished snapshot carries no lease to " +
    "trim off. Requires a Cloudflare Access assertion.",
  responses: {
    200: {
      description: "Snapshots, newest first",
      content: { "application/json": { schema: SnapshotList } },
    },
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const listSnapshotsHandler: RouteHandler<typeof listSnapshotsRoute, AppEnv> = async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, r2_key, image_count, label_count, inclusion_policy, created_at FROM snapshots ORDER BY id DESC",
  ).all<{
    id: number;
    r2_key: string;
    image_count: number;
    label_count: number;
    inclusion_policy: string;
    created_at: number;
  }>();

  return c.json({ snapshots: results }, 200);
};
