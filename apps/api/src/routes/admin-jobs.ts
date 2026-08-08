import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../bindings";
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
  kind: "download" | "chunk" | "prelabel" | "dryrun";
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

export const listJobsHandler: RouteHandler<typeof listJobsRoute, AppEnv> = async (c) => {
  const { status, limit } = c.req.valid("query");

  // One query with a JOIN and a LEFT JOIN rather than a jobs query followed by
  // a chunks query: the second query would be another D1 round trip on every
  // poll from every open tab, and `chunks` is 1:1 with a chunk job by unique
  // index, so the join cannot fan the result out.
  //
  // The WHERE clause is assembled rather than the whole statement being written
  // out twice. `status` is never interpolated — it is bound like every other
  // parameter; what varies is only whether the clause is present.
  const filter = status ? "WHERE j.status = ?" : "";
  const bindings = status ? [status, limit ?? DEFAULT_LIMIT] : [limit ?? DEFAULT_LIMIT];

  const { results } = await c.env.DB.prepare(
    `SELECT j.*, v.url AS video_url,
            ch.segment_index, ch.start_seconds, ch.end_seconds
       FROM jobs j
       JOIN videos v ON v.id = j.video_id
       LEFT JOIN chunks ch ON ch.job_id = j.id
       ${filter}
      ORDER BY j.id DESC
      LIMIT ?`,
  )
    .bind(...bindings)
    .all<JobRow>();

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
