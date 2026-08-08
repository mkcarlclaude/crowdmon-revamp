import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { Bindings } from "../bindings";
import { nextPromptVersion } from "../prompt-version";
import {
  AdminClass,
  AdminClassList,
  type AdminClassRow,
  ClassIdParam,
  CreateClassRequest,
  errorResponse,
  MAX_ACTIVE_CLASSES,
  UpdateClassRequest,
} from "../schemas";

/**
 * Class management behind Access (M12.1).
 *
 * The milestone's own sentence is "a prompt can be tried before it counts, and
 * changed without a deploy" — until these routes existed, changing one meant
 * writing another migration the way 0006 did, which is the right friction for
 * a seed and the wrong friction for an edit.
 *
 * Three rules run through the file, and each is a constraint rather than a
 * convenience:
 *
 * 1. **Nothing is deleted.** There is no DELETE route, and that absence is the
 *    feature: `predictions.class_id` and `missing_reports.class_id` reference
 *    these rows, so a hard delete either cascades into label history or leaves
 *    it dangling (migration 0003's own comment on `classes.active`).
 *    Retirement is `active = 0`, which the worker's `/api/classes/active`
 *    already filters on.
 * 2. **Rewording bumps the version.** Computed by `nextPromptVersion`, never
 *    supplied by the caller — see that module for why an operator-chosen tag
 *    is a collision waiting to happen.
 * 3. **A new class arrives deactivated.** M12.2's dry-run is the step between
 *    writing a prompt and letting it label anything, and a create that could
 *    activate in the same request would be the one path around it.
 *
 * Split into its own file from `classes.ts` for the reason `admin-jobs.ts` is
 * split from `jobs.ts`: the two surfaces sit in different trust tiers, and one
 * file mixing an Access-gated write with an unauthenticated worker read is one
 * file where a mistake about which is which is easy to make.
 */

/** The shape D1 returns — `active` is an INTEGER there, a boolean on the wire. */
interface ClassRow {
  id: number;
  name: string;
  appearance_prompt: string;
  prompt_version: string;
  active: number;
  created_at: number;
  updated_at: number;
}

const toAdminClass = (row: ClassRow): AdminClassRow => ({
  id: row.id,
  name: row.name,
  appearance_prompt: row.appearance_prompt,
  prompt_version: row.prompt_version,
  active: row.active === 1,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

export const listClassesRoute = createRoute({
  method: "get",
  path: "/api/admin/classes",
  operationId: "listClasses",
  tags: ["admin"],
  summary: "The whole class roster, active and retired",
  description:
    "The operator's view of migration 0003's `classes` table. Unlike " +
    "`/api/classes/active`, retired classes are included — a deactivated class is the " +
    "one an admin most needs to see, because reactivating it is the only way it comes " +
    "back. Requires a Cloudflare Access assertion in `Cf-Access-Jwt-Assertion` for an " +
    "identity on the Worker's admin allowlist.",
  responses: {
    200: {
      description: "Every class, ordered by name",
      content: { "application/json": { schema: AdminClassList } },
    },
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const listClassesHandler: RouteHandler<
  typeof listClassesRoute,
  { Bindings: Bindings }
> = async (c) => {
  // `ORDER BY name`, matching `listActiveClasses` — the roster is read by a
  // human scanning for a character, and insertion order is the one ordering
  // that tells them nothing.
  const { results } = await c.env.DB.prepare("SELECT * FROM classes ORDER BY name").all<ClassRow>();

  return c.json({ classes: results.map(toAdminClass) }, 200);
};

export const createClassRoute = createRoute({
  method: "post",
  path: "/api/admin/classes",
  operationId: "createClass",
  tags: ["admin"],
  summary: "Add a class, deactivated",
  description:
    "Creates a class with `active = 0` and the first prompt version stamped by the " +
    "server. Deactivated is not a default the caller can override: M12.2's dry-run is " +
    "the step between writing a prompt and letting it pre-label a video, and a class " +
    "that could be created active would be the one way around it. Requires a " +
    "Cloudflare Access assertion.",
  request: {
    body: { content: { "application/json": { schema: CreateClassRequest } }, required: true },
  },
  responses: {
    201: {
      description: "The class as created — inactive, with its first prompt version",
      content: { "application/json": { schema: AdminClass } },
    },
    400: errorResponse("A malformed body, an empty name or an oversized prompt"),
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    409: errorResponse("A class with this name already exists"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const createClassHandler: RouteHandler<
  typeof createClassRoute,
  { Bindings: Bindings }
> = async (c) => {
  const { name, appearance_prompt } = c.req.valid("json");

  // `ON CONFLICT DO NOTHING ... RETURNING` for the reason `submitVideo` uses
  // it: the duplicate is detected by migration 0003's UNIQUE index rather than
  // by a SELECT that a concurrent request could slip past between the read and
  // the write.
  //
  // `active` is written explicitly rather than left to the column's `DEFAULT
  // 1` — the default is right for a seed migration, which knows the wording
  // has been reviewed, and wrong for a prompt nobody has looked at the output
  // of yet.
  const created = await c.env.DB.prepare(
    `INSERT INTO classes (name, appearance_prompt, prompt_version, active)
          VALUES (?, ?, ?, 0) ON CONFLICT DO NOTHING RETURNING *`,
  )
    .bind(name, appearance_prompt, nextPromptVersion("", new Date()))
    .first<ClassRow>();

  if (!created) {
    return c.json({ error: `a class named ${name} already exists` }, 409);
  }

  return c.json(toAdminClass(created), 201);
};

export const updateClassRoute = createRoute({
  method: "patch",
  path: "/api/admin/classes/{id}",
  operationId: "updateClass",
  tags: ["admin"],
  summary: "Reword a class's prompt, activate it or retire it",
  description:
    "Editing `appearance_prompt` bumps `prompt_version` — rewording in place would " +
    "silently create two regimes inside one class, which is what that column exists to " +
    "prevent. Resubmitting identical wording does not bump it: the boxes either side " +
    "were produced by the same text. There is no delete: retiring a class is " +
    "`active: false`, so the predictions it produced keep their referent. Requires a " +
    "Cloudflare Access assertion.",
  request: {
    params: ClassIdParam,
    body: { content: { "application/json": { schema: UpdateClassRequest } }, required: true },
  },
  responses: {
    200: {
      description: "The class as it now stands",
      content: { "application/json": { schema: AdminClass } },
    },
    400: errorResponse("A malformed body, or one that asks for no change at all"),
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    404: errorResponse("No class with this id"),
    409: errorResponse("Activating this class would exceed the active-class bound"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const updateClassHandler: RouteHandler<
  typeof updateClassRoute,
  { Bindings: Bindings }
> = async (c) => {
  const { id } = c.req.valid("param");
  const { appearance_prompt, active } = c.req.valid("json");

  const current = await c.env.DB.prepare("SELECT * FROM classes WHERE id = ?")
    .bind(id)
    .first<ClassRow>();

  if (!current) {
    return c.json({ error: `no class with id ${id}` }, 404);
  }

  // Compared against what is stored rather than trusted from the request: a UI
  // that round-trips the current wording on every save would otherwise mint a
  // new version each time somebody toggled the active flag, and a `regime`
  // boundary that separates identical text is worse than none — it puts a
  // split in the data where nothing changed.
  const reworded =
    appearance_prompt !== undefined && appearance_prompt !== current.appearance_prompt;
  const promptVersion = reworded
    ? nextPromptVersion(current.prompt_version, new Date())
    : current.prompt_version;

  // Only an activation can breach the bound, and only from a class that is not
  // already active — written as "does this add one" rather than "are we at the
  // limit", or every prompt would become uneditable the moment the roster
  // filled up.
  if (active === true && current.active === 0) {
    const active_count = await c.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM classes WHERE active = 1",
    ).first<{ count: number }>();

    if ((active_count?.count ?? 0) >= MAX_ACTIVE_CLASSES) {
      return c.json(
        {
          error: `activating this class would exceed the ${MAX_ACTIVE_CLASSES} active classes the worker's contract declares — retire one first`,
        },
        409,
      );
    }
  }

  // `updated_at` is set here rather than by a trigger: migration 0003 gives the
  // column a DEFAULT, which SQLite applies on insert and never on update, so a
  // row edited without this would keep claiming the time it was created.
  const updated = await c.env.DB.prepare(
    `UPDATE classes
        SET appearance_prompt = ?, prompt_version = ?, active = ?, updated_at = strftime('%s', 'now')
      WHERE id = ? RETURNING *`,
  )
    .bind(
      appearance_prompt ?? current.appearance_prompt,
      promptVersion,
      active === undefined ? current.active : active ? 1 : 0,
      id,
    )
    .first<ClassRow>();

  if (!updated) {
    // Unreachable today: the SELECT above found the row, and no route in this
    // application deletes one. Answered rather than asserted anyway, because
    // the alternative is a 500 on the day a class can be removed by some path
    // that does not exist yet.
    return c.json({ error: `no class with id ${id}` }, 404);
  }

  return c.json(toAdminClass(updated), 200);
};
