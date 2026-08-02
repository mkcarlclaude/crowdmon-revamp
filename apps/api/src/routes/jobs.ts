import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { Bindings } from "../bindings";
import {
  ClaimRequest,
  CompleteRequest,
  errorResponse,
  HeartbeatRequest,
  Job,
  JobIdParam,
} from "../schemas";

/**
 * The queue endpoints the Go worker drives (CONTEXT.md §Q14).
 *
 * Handlers are stubs returning 501 until M3.4 — the schemas and status codes
 * here are the contract M3.3 generates the worker's client from, so they are
 * the part that has to be right now.
 */

export const claimJobRoute = createRoute({
  method: "post",
  path: "/api/jobs/claim",
  tags: ["jobs"],
  summary: "Claim the next pending job",
  description:
    "Atomic: the claim is a single `UPDATE ... WHERE status='pending' ... RETURNING`, " +
    "so two workers polling at once cannot take the same row.",
  request: {
    body: { content: { "application/json": { schema: ClaimRequest } }, required: true },
  },
  responses: {
    200: {
      description: "A job was claimed",
      content: { "application/json": { schema: Job } },
    },
    // Distinct from 200-with-null so the worker's backoff (CONTEXT.md §Q20)
    // branches on the status line rather than parsing a body to find out that
    // there was nothing in it. Empty polls are the common case by far.
    204: { description: "Nothing to claim" },
    400: errorResponse("Malformed request body"),
    501: errorResponse("Not implemented until M3.4"),
  },
});

export const heartbeatRoute = createRoute({
  method: "post",
  path: "/api/jobs/{id}/heartbeat",
  tags: ["jobs"],
  summary: "Renew the lease on a held job",
  description:
    "Called every 30s while a job is held. Missing heartbeats are what the reaper " +
    "watches for; a job whose `heartbeat_at` goes stale returns to `pending`.",
  request: {
    params: JobIdParam,
    body: { content: { "application/json": { schema: HeartbeatRequest } }, required: true },
  },
  responses: {
    204: { description: "Lease renewed" },
    400: errorResponse("Malformed job id or body"),
    // Also the answer when the job exists but this worker no longer holds it,
    // because the reaper took it back. Deliberately not distinguished from a
    // missing job: the worker's response is identical either way — stop.
    404: errorResponse("No job with this id is held by this worker"),
    501: errorResponse("Not implemented until M3.4"),
  },
});

export const completeJobRoute = createRoute({
  method: "post",
  path: "/api/jobs/{id}/complete",
  tags: ["jobs"],
  summary: "Report a held job as done or failed",
  request: {
    params: JobIdParam,
    body: { content: { "application/json": { schema: CompleteRequest } }, required: true },
  },
  responses: {
    204: { description: "Outcome recorded" },
    400: errorResponse("Malformed job id or body"),
    404: errorResponse("No job with this id is held by this worker"),
    501: errorResponse("Not implemented until M3.4"),
  },
});

export const claimJobHandler: RouteHandler<typeof claimJobRoute, { Bindings: Bindings }> = (c) =>
  c.json({ error: "not implemented" }, 501);

export const heartbeatHandler: RouteHandler<typeof heartbeatRoute, { Bindings: Bindings }> = (c) =>
  c.json({ error: "not implemented" }, 501);

export const completeJobHandler: RouteHandler<typeof completeJobRoute, { Bindings: Bindings }> = (
  c,
) => c.json({ error: "not implemented" }, 501);
