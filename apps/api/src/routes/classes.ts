import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { Bindings } from "../bindings";
import { ActiveClasses } from "../schemas";

/**
 * What a prelabel job's detector runs against — the fix for the drift
 * hazard M11 left open (M11.5).
 *
 * `worker.Pipeline` used to carry `Prompts []ClassPrompt` as static
 * configuration nobody ever populated (`worker/cmd/worker/main.go`'s own
 * comment said M12 would wire it); this endpoint is what wires it instead,
 * straight from migration 0003's `classes` table — the same table migration
 * 0006 seeded five real rows into. Two copies of the same wording, one in D1
 * and one typed into a worker's environment, is exactly the drift
 * `predictions.prompt_version` exists to prevent (migration 0003's own
 * comment on that column): a reworded migration with an un-updated worker
 * would silently stamp a version onto boxes that describes different text
 * than the one that actually produced them, and the two-regimes-inside-one-
 * class failure would happen with nothing in the data to catch it.
 *
 * `active = 0` rows are excluded by the query, not filtered client-side: a
 * deactivated class must stop being detected, the entire point of migration
 * 0003's soft delete (`classes.active`'s own comment), and a worker that saw
 * every row regardless of that flag would keep detecting a class an operator
 * just turned off.
 *
 * No `worker_id`, unlike `listVideoImages`. That route's worker_id does real
 * work — it proves the caller holds the one prelabel lease for a specific
 * video, gating a read that genuinely differs by who is asking and which
 * video they are asking about. This read has no such axis: every prelabel
 * job needs the identical answer (ROADMAP.md's own framing, "M11 reads
 * prompts that were seeded by hand," names no per-job or per-video scope to
 * check), so a worker_id parameter here would be a credential with nothing
 * behind it to verify — there is no lease, no video and no job this call is
 * about, only one global answer every caller gets alike. It carries the same
 * trust tier `jobStatsRoute`'s own comment argues for on that same basis: no
 * Access assertion and no worker-id credential today, and a stray caller
 * learns nothing here it could not already read directly out of the
 * repository — `appearance_prompt` is the literal text of a committed,
 * reviewed migration (0006), not a secret this endpoint would be the first
 * place to leak.
 */
export const listActiveClassesRoute = createRoute({
  method: "get",
  path: "/api/classes/active",
  operationId: "listActiveClasses",
  tags: ["classes"],
  summary: "The classes a prelabel job's detector currently runs against",
  description:
    "M11.5: the fetch that replaces `worker.Pipeline`'s old static `Prompts` field. " +
    "Reads migration 0003's `classes` table, filtered to `active = 1` — a deactivated " +
    "class must stop being detected. Every prelabel job gets the identical answer, so " +
    "unlike `listVideoImages` this carries no `worker_id`: there is no lease, no video " +
    "and no job to scope the read against, only one global list every caller sees alike " +
    "(see this route's own module comment for the fuller argument, and `jobStatsRoute`'s " +
    "for the matching trust-tier precedent).",
  responses: {
    200: {
      description: "Every class with `active = 1`",
      content: { "application/json": { schema: ActiveClasses } },
    },
  },
});

export const listActiveClassesHandler: RouteHandler<
  typeof listActiveClassesRoute,
  { Bindings: Bindings }
> = async (c) => {
  // Ordered by name rather than left at SQLite's default row order: the Go
  // worker's `boxesByClass` (worker/internal/worker/pipeline.go) already
  // sorts its own span attribute by name so two spans over the same active
  // set render identically, and giving this response a stable order once,
  // here, means nothing downstream has to re-sort what should already read
  // the same way on every poll.
  const { results } = await c.env.DB.prepare(
    "SELECT name, appearance_prompt, prompt_version FROM classes WHERE active = 1 ORDER BY name",
  ).all<{ name: string; appearance_prompt: string; prompt_version: string }>();

  return c.json({ classes: results }, 200);
};
