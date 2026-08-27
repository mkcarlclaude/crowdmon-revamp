import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../bindings";
import { frameUrls } from "../frame-urls";
import {
  ADMIN_PAGE_LIMIT_DEFAULT,
  AdminVideoIdParam,
  AdminVideoImages,
  AdminVideoImagesQuery,
  errorResponse,
} from "../schemas";

/**
 * The browsable frame grid `/admin/videos/:id` reads (M16, ROADMAP M16.5).
 *
 * A new route, not a reuse of `listVideoImagesHandler`
 * (`apps/api/src/routes/jobs.ts`). That route answers a different question —
 * "what can `ImageSampler` draw from" — and proves it by requiring a
 * `worker_id` holding a claimed `prelabel` or `dryrun` lease for this video.
 * A browser holds no such lease and never will; gating this route the same
 * way would mean an admin can only browse a video's frames while a worker
 * happens to be mid-job on it, which is not a real constraint this screen
 * should have. The two routes share a table, not a trust boundary — this one
 * sits under `/api/admin/*` and is gated by `requireAccess` like every other
 * admin read.
 *
 * The `sampled` field this route adds to each frame (M17, plan §B) is what
 * makes this screen double as the on-demand supplementary prelabel's
 * selection surface (`admin-prelabel.ts`'s own module comment): an operator
 * needs to see which frames an earlier pass already claimed before picking
 * more, not learn it from a 400 after clicking.
 *
 * **The `selection_reason` filter (M25.1) is what makes this screen an
 * inspection surface and not just a picker.** M25's `diverse` draw stamps 400
 * frames in one click, and before this filter existed there was no way to see
 * which 400 — the grid flattened the column to a boolean, and the queue that
 * serves frames for verification walks `images.id` globally, so a freshly
 * drawn set could sit behind hundreds of unrelated frames and never surface.
 * The only answer was to export the database. `?selection_reason=diverse` is
 * that answer as a screen.
 *
 * `verdict_state` exists because a prediction count alone cannot tell "the
 * detector found nothing here" apart from "the detector found three boxes and
 * nobody has looked at them yet" — the first needs no operator attention, the
 * second is exactly what `LabellingSession` exists to work through, and a
 * grid that could not tell them apart would be a worse version of the pool
 * count `labellingStatsHandler` already reports in aggregate.
 *
 * **Frame URLs come from `frameUrls`, not from a path the client builds.**
 * M16 shipped this grid pointing every `<img>` at `/api/admin/image`, which
 * is one Worker invocation and one Worker-egress copy of a full-resolution
 * frame per tile — twenty-four to a page, against a video with hundreds. That
 * is the case CONTEXT.md §Q25 settled as presigned URLs fetched straight from
 * R2, and the reason it got missed is worth more than the fix: the proxy's own
 * justification in `admin-images.ts` was written as a *size* argument ("fifty
 * frames per dry-run is well inside that noise"), and a size argument silently
 * extends to any number that still feels small. It has been rewritten as a
 * lifetime argument, which does not.
 */

/**
 * `unruled` only means something once there is at least one prediction to
 * rule on — a frame with none is not "unverified", it is a frame the
 * detector had nothing to say about. A named function rather than the
 * ternary inline: `Array.prototype.map`'s callback return does not get
 * contextually typed against `c.json`'s schema, so an inline ternary widens
 * to `string` and fails against the generated `verdict_state` union; a
 * function with its return type spelled out here narrows it explicitly
 * instead.
 */
function verdictState(
  predictions: number,
  unruled: number,
): "no_predictions" | "unverified" | "verified" {
  if (predictions === 0) return "no_predictions";
  return unruled > 0 ? "unverified" : "verified";
}

/**
 * The value `selection_reason=` takes to mean "no pass has claimed this
 * frame". Reserved rather than free, and the one string an operator can never
 * use as a real selector name.
 */
const UNSAMPLED = "none";

/**
 * The `selection_reason` filter as a SQL fragment and its bound parameters,
 * so the count and the page statements share one definition of what is being
 * filtered rather than two that can drift.
 *
 * Returns a fragment that begins with ` AND` (or is empty), meant to be
 * appended to an existing `WHERE i.video_id = ?`. That shape rather than a
 * standalone predicate because both callers already have that first
 * condition and neither can ever omit it — this route is per-video by
 * definition, and a fragment that could be used without it would be a
 * fragment that could accidentally read another video's frames.
 */
function reasonFilter(reason: string | undefined): { clause: string; params: string[] } {
  if (reason === undefined) return { clause: "", params: [] };
  if (reason === UNSAMPLED) return { clause: " AND i.selection_reason IS NULL", params: [] };
  return { clause: " AND i.selection_reason = ?", params: [reason] };
}

/** The shape D1 returns for the join in `listAdminVideoImages`. */
interface AdminVideoImageRow {
  id: number;
  r2_key: string;
  timestamp_seconds: number;
  public_sample: number | null;
  predictions: number;
  unruled: number;
  selection_reason: string | null;
}

export const listAdminVideoImagesRoute = createRoute({
  method: "get",
  path: "/api/admin/videos/{id}/images",
  operationId: "listAdminVideoImages",
  tags: ["admin"],
  summary: "One video's frames, with prediction counts and verdict state",
  description:
    "Every `images` row for this video, oldest timestamp first, with how many predictions " +
    "each carries and whether an admin has ruled on all of them. Unlike `listVideoImages` " +
    "(`/api/videos/{video_id}/images`), this route needs no worker lease — it is a browser " +
    "read behind Cloudflare Access, not a sampler's candidate pool. No 404 for a video id " +
    "that does not exist: an empty page is the honest answer, the same choice " +
    "`listDryRuns` makes for an unknown class. `selection_reason` filters to one slice — " +
    "any value the column holds (`random`, `manual`, `diverse`), or `none` for frames no " +
    "pass has claimed; `total` follows the filter so pagination stays correct. " +
    "Requires a Cloudflare Access assertion.",
  request: { params: AdminVideoIdParam, query: AdminVideoImagesQuery },
  responses: {
    200: {
      description: "This video's frame count and one page of its frames",
      content: { "application/json": { schema: AdminVideoImages } },
    },
    400: errorResponse("An out-of-range limit or offset"),
    401: errorResponse("Missing or invalid Access assertion"),
    403: errorResponse("A verified identity that is not an administrator"),
    503: errorResponse("Admin access is not configured on this deployment"),
  },
});

export const listAdminVideoImagesHandler: RouteHandler<
  typeof listAdminVideoImagesRoute,
  AppEnv
> = async (c) => {
  const { id } = c.req.valid("param");
  const { limit, offset, selection_reason: reason } = c.req.valid("query");

  // The filter is one SQL fragment and one bound-parameter list, built once
  // and spliced into both statements below, so the count and the page can
  // never disagree about what they are describing — a `total` computed over a
  // wider set than the page would render page controls for pages that do not
  // exist.
  //
  // `none` is a reserved value rather than another `= ?`, because SQL has no
  // way to match NULL through equality: `selection_reason = NULL` is NULL,
  // which is not true, so binding it would silently return an empty grid for
  // the one filter an operator reaches for most (`which frames are still
  // free to sample?`).
  const { clause, params } = reasonFilter(reason);

  // Two statements in one batch rather than a single query with a window
  // function: D1 is SQLite, which has no cheap "total rows regardless of
  // LIMIT" primitive short of a second pass over the same predicate, so this
  // just runs that second pass explicitly instead of pretending one query
  // could do it.
  const [totalResult, pageResult] = await c.env.DB.batch<{ total: number } | AdminVideoImageRow>([
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM images i WHERE i.video_id = ?${clause}`).bind(
      id,
      ...params,
    ),
    c.env.DB.prepare(
      `SELECT i.id, i.r2_key, i.timestamp_seconds, i.public_sample, i.selection_reason,
              (SELECT COUNT(*) FROM predictions p WHERE p.image_id = i.id) AS predictions,
              (SELECT COUNT(*) FROM predictions p
                 WHERE p.image_id = i.id
                   AND NOT EXISTS (
                         SELECT 1 FROM verdicts v
                          WHERE v.prediction_id = p.id AND v.source = 'admin')
              ) AS unruled
         FROM images i
        WHERE i.video_id = ?${clause}
        ORDER BY i.timestamp_seconds
        LIMIT ? OFFSET ?`,
    ).bind(id, ...params, limit ?? ADMIN_PAGE_LIMIT_DEFAULT, offset ?? 0),
  ]);

  const total = (totalResult?.results[0] as { total: number } | undefined)?.total ?? 0;
  const page = (pageResult?.results ?? []) as AdminVideoImageRow[];

  // Asked even for an empty page, exactly as `labellingBatchHandler` does:
  // there is no URL to hold, but `url_mode` and `expires_at` are on the wire
  // unconditionally and a client that had to special-case their absence would
  // be a client with two code paths for one response shape.
  const { mode, expiresAt, byKey } = await frameUrls(
    c.env,
    page.map((row) => row.r2_key),
  );

  return c.json(
    {
      video_id: id,
      total,
      images: page.map((row) => ({
        id: row.id,
        r2_key: row.r2_key,
        // `?? ""` is unreachable — every key on this page was just signed —
        // and is here only because a Map lookup types as possibly absent.
        url: byKey.get(row.r2_key) ?? "",
        timestamp_seconds: row.timestamp_seconds,
        public_sample: row.public_sample === 1,
        predictions: row.predictions,
        verdict_state: verdictState(row.predictions, row.unruled),
        sampled: row.selection_reason !== null,
        selection_reason: row.selection_reason,
      })),
      url_mode: mode,
      expires_at: expiresAt,
    },
    200,
  );
};
