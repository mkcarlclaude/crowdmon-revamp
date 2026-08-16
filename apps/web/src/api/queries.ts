import {
  AdminAnnotatorList,
  AdminClass,
  AdminClassList,
  AdminImage,
  AdminSession,
  AdminVerdictList,
  AdminVideoDetail,
  AdminVideoImages,
  AdminVideoList,
  ContributeBatch,
  ContributeMe,
  type CreateClassRequest,
  type CreateDryRunRequest,
  type CreateMissingReportRequest,
  type CreatePrelabelRequest,
  type CreatePublicVerdictsRequest,
  type CreateVerdictsRequest,
  DryRun,
  DryRunList,
  JobList,
  type JobStatus,
  LabellingBatch,
  LabellingStats,
  MissingReport,
  PrelabelJob,
  PublicFrame,
  SnapshotJob,
  SnapshotList,
  type SubmitVideoRequest,
  type UpdateClassRequest,
  VerdictBatch,
  VideoSubmission,
} from "@crowdmon/api/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import { getAnonSessionId } from "./anon-session";
import { apiFetch } from "./client";

export const adminSessionKey = ["admin", "session"] as const;

/**
 * Whether the browser already has an Access session (M16, CONTEXT.md §Q19
 * amendment). `AdminLayout` calls this once on mount and treats any error —
 * 401, 403, or the `SessionExpiredError` a cross-origin Access redirect
 * throws (`apps/web/src/api/session.ts`) — identically: redirect to
 * `/admin/login`. There is no case here worth telling apart the way
 * `SessionExpiredBanner` tells a mid-session expiry apart from other
 * failures, because this probe has nothing else to fall back to showing —
 * unlike a page with data already on screen, there is no "everything except
 * this one thing" to keep rendering.
 */
export function useAdminSession() {
  return useQuery({
    queryKey: adminSessionKey,
    queryFn: () => apiFetch("/api/admin/session", AdminSession),
  });
}

/**
 * The prefix every jobs query key shares, for invalidation only — TanStack
 * matches a query key by prefix, so `invalidateQueries({ queryKey:
 * jobsKeyPrefix })` catches every status chip's own key below it without
 * this file having to track which ones are currently mounted anywhere. Never
 * pass this to `useQuery` itself; use `jobsKey(status)`.
 */
export const jobsKeyPrefix = ["jobs"] as const;

/** One status filter's own key, `"all"` standing in for "no filter" so `undefined` still has a stable slot. */
export const jobsKey = (status?: z.infer<typeof JobStatus>) =>
  [...jobsKeyPrefix, status ?? "all"] as const;

/**
 * The job list, refreshed on an interval (M5.3; M19, plan §C2 adds the
 * optional status filter).
 *
 * Five seconds: the Go worker heartbeats every 30s and its poll floor is 30s,
 * so anything faster shows the same row repeatedly while adding D1 reads for
 * every open tab. `refetchIntervalInBackground` is left off — a hidden tab
 * polling a database is cost with nobody watching.
 *
 * Every existing caller passes nothing and keeps today's unfiltered
 * behaviour. Switching `status` changes the query key, so the first render
 * after a chip click is a fresh fetch rather than a filtered read of
 * whatever the previous chip already had cached — acceptable at this queue's
 * size, and deliberately not smoothed over with `placeholderData`: a stale
 * list rendered under a new filter is a list that looks wrong for one tick,
 * which is worse than a brief "Loading…" naming what it is.
 */
export function useJobs(status?: z.infer<typeof JobStatus>) {
  return useQuery({
    queryKey: jobsKey(status),
    queryFn: () => apiFetch(`/api/admin/jobs${status ? `?status=${status}` : ""}`, JobList),
    refetchInterval: 5_000,
  });
}

export function useSubmitVideo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: z.infer<typeof SubmitVideoRequest>) =>
      apiFetch("/api/admin/videos", VideoSubmission, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    // The point of the form is watching the job appear. Waiting up to five
    // seconds for the next poll would read as the submission having failed.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: jobsKeyPrefix }),
  });
}

export const classesKey = ["classes"] as const;

/**
 * The class roster (M12.1).
 *
 * No `refetchInterval`, unlike `useJobs`. A job row changes because a worker
 * on another machine moved it, so the queue has to be polled to be true; a
 * class changes only when somebody on this page changes it, and the mutations
 * below invalidate this key when they do. Polling would be a D1 read per tab
 * per interval to re-fetch rows nobody touched.
 */
export function useClasses() {
  return useQuery({
    queryKey: classesKey,
    queryFn: () => apiFetch("/api/admin/classes", AdminClassList),
  });
}

export function useCreateClass() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: z.infer<typeof CreateClassRequest>) =>
      apiFetch("/api/admin/classes", AdminClass, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: classesKey }),
  });
}

/**
 * Rewording, activating and retiring, all through one mutation because they are
 * one endpoint (see `updateClassRoute`). The id travels in the same object as
 * the body and is peeled off here rather than curried into a per-row hook: a
 * hook per row would give each row its own `isPending`, which sounds better
 * until two rows are saved at once and the second one's spinner belongs to the
 * first one's request.
 */
export function useUpdateClass() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...body }: z.infer<typeof UpdateClassRequest> & { id: number }) =>
      apiFetch(`/api/admin/classes/${id}`, AdminClass, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: classesKey }),
  });
}

export const videosKey = ["videos"] as const;

/**
 * The videos a dry-run can be run against (M12.2).
 *
 * No interval, like `useClasses` and unlike `useJobs`: a video appears here
 * when somebody on this page submits one, and `image_count` grows as
 * extraction runs — but a dry-run form does not need that number live to the
 * second, and polling it would be a `GROUP BY` over every image row per tab
 * per interval.
 */
export function useVideos() {
  return useQuery({
    queryKey: videosKey,
    queryFn: () => apiFetch("/api/admin/videos", AdminVideoList),
  });
}

/**
 * `imageId` omitted is the unfiltered key, a strict prefix of every filtered
 * one — which is what lets `useCreateDryRun`'s invalidation stay a single
 * `invalidateQueries({ queryKey: dryRunsKey(classId) })` after M17 (plan §A)
 * added the filter: TanStack Query matches a query key by prefix, so
 * invalidating the two-element key also invalidates every three-element key
 * built from it, filtered or not, without this file needing to track which
 * `imageId`s are currently mounted anywhere.
 */
export const dryRunsKey = (classId: number, imageId?: number) =>
  imageId === undefined
    ? (["dryruns", classId] as const)
    : (["dryruns", classId, imageId] as const);

/**
 * One class's recent dry-runs — every one, or (M17, plan §A) one frame's own
 * attempts when `imageId` is given.
 *
 * The filter exists for `DryRunPanel`'s comparison strip: once an admin has
 * picked a frame and is iterating wordings against it, `DRYRUN_HISTORY`
 * newest-first rows unfiltered could mix in a different frame's attempts (or
 * the wide mode's), which is not what a "did this wording get better" strip
 * is for.
 *
 * Polls only while something is actually running. A dry-run is minutes of the
 * box's two cores, so the screen has to move on its own when the result lands
 * — but a class whose newest run finished has nothing left to poll for, and
 * the interval turns itself off rather than reading D1 forever behind an open
 * tab. `query.state.data?.dryruns[0]` is this query's own newest row (already
 * filtered server-side when `imageId` is given), so the interval still tracks
 * whichever run this particular query is actually waiting on.
 *
 * `classId` is required, and there is no `enabled` guard: every caller renders
 * inside a class card that already has a row id. A caller that does not have
 * one yet should not be rendering this.
 */
export function useDryRuns(classId: number, imageId?: number) {
  return useQuery({
    queryKey: dryRunsKey(classId, imageId),
    queryFn: () =>
      apiFetch(
        `/api/admin/classes/${classId}/dryruns${imageId === undefined ? "" : `?image_id=${imageId}`}`,
        DryRunList,
      ),
    refetchInterval: (query) => {
      const newest = query.state.data?.dryruns[0];
      if (!newest) return false;
      return newest.status === "pending" || newest.status === "claimed" ? 3_000 : false;
    },
  });
}

export const labellingBatchKey = ["labelling", "batch"] as const;
export const labellingStatsKey = ["labelling", "stats"] as const;

/**
 * The frames a verification session is working through (M13.4).
 *
 * No `refetchInterval`, and deliberately more than the reasoning `useClasses`
 * gives: a batch is not just unchanging, it is *being consumed*. A poll
 * landing mid-session would replace the frame under the operator's cursor with
 * a page recomputed from verdicts they just wrote. The session refetches when
 * it runs out and when a URL expires, both explicitly, and at no other time.
 *
 * `staleTime: Infinity` says the same thing to the cache: a remount inside one
 * sitting continues where it was rather than silently starting the pool again.
 */
export function useLabellingBatch() {
  return useQuery({
    queryKey: labellingBatchKey,
    queryFn: () => apiFetch("/api/admin/labelling/batch", LabellingBatch),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Flag or unflag the frame on screen for the public verification page (M14.1).
 *
 * Patched into the batch already in the cache rather than refetched or
 * invalidated: `useLabellingBatch`'s own comment is why — the batch pages by
 * *unruled boxes*, and this flag has no bearing on that, so a refetch would
 * reshuffle the operator's page for a change to a field the pool query does
 * not even filter on.
 */
export function useSetPublicSample() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ imageId, publicSample }: { imageId: number; publicSample: boolean }) =>
      apiFetch(`/api/admin/images/${imageId}/public-sample`, AdminImage, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ public_sample: publicSample }),
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(
        labellingBatchKey,
        (current: z.infer<typeof LabellingBatch> | undefined) =>
          current && {
            ...current,
            images: current.images.map((image) =>
              image.id === result.id ? { ...image, public_sample: result.public_sample } : image,
            ),
          },
      );
      // M16: `/admin/videos/:id` renders this same flag off a different
      // query, keyed by video id, limit and offset rather than by image —
      // this mutation has no video id to patch the one page in the cache,
      // so every cached page of every video is invalidated instead. Broad,
      // but cheap: the underlying table is small and an admin flagging a
      // frame is not a request rate this needs to optimise around.
      queryClient.invalidateQueries({ queryKey: adminVideoImagesKeyPrefix });
    },
  });
}

/** Verdict counts, class coverage and pool size (M13.4). Business data — §7's Grafana boundary. */
export function useLabellingStats() {
  return useQuery({
    queryKey: labellingStatsKey,
    queryFn: () => apiFetch("/api/admin/labelling/stats", LabellingStats),
  });
}

/**
 * A whole frame's staged rulings, in one request (M13.1).
 *
 * Invalidates the stats and nothing else. Invalidating the batch would refetch
 * a page of frames on every submit — the endpoint pages by *unruled* boxes, so
 * the answer would shift under the session between one frame and the next,
 * which is what `useLabellingBatch`'s own comment is about.
 *
 * One request per frame rather than per box is also what keeps that stats
 * invalidation affordable: the stats query counts over `images`, `predictions`
 * and `verdicts`, and D1 bills every row those counts scan.
 */
export function useSubmitVerdicts() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      imageId,
      ...body
    }: z.infer<typeof CreateVerdictsRequest> & { imageId: number }) =>
      apiFetch(`/api/admin/images/${imageId}/verdicts`, VerdictBatch, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: labellingStatsKey }),
  });
}

/** Record something the detector never proposed (M13.3). */
export function useReportMissing() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      imageId,
      ...body
    }: z.infer<typeof CreateMissingReportRequest> & { imageId: number }) =>
      apiFetch(`/api/admin/images/${imageId}/missing`, MissingReport, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: labellingStatsKey }),
  });
}

export function useCreateDryRun(classId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: z.infer<typeof CreateDryRunRequest>) =>
      apiFetch(`/api/admin/classes/${classId}/dryrun`, DryRun, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      // Both, and for different reasons: the dry-run list is what this screen
      // renders, and the queue is where the job it just enqueued shows up.
      queryClient.invalidateQueries({ queryKey: dryRunsKey(classId) });
      queryClient.invalidateQueries({ queryKey: jobsKeyPrefix });
    },
  });
}

export const publicFrameKey = ["public", "frame"] as const;

/**
 * One frame for a visitor with no account (M14.2; M18, plan §C's `exclude`).
 *
 * `staleTime: Infinity` for `useLabellingBatch`'s own reason: the frame on
 * screen is being judged, not polled, and a background refetch landing
 * mid-judgement would swap the picture out from under the visitor's cursor.
 * `PublicVerify` asks for a new one explicitly, once a verdict has been
 * submitted.
 *
 * `exclude` is read off the cache rather than threaded through as a hook
 * argument: `PublicVerify.nextFrame()` already asks for a new frame with
 * `queryClient.refetchQueries({ queryKey: publicFrameKey })`, and a refetch
 * runs `queryFn` again while the previous response is still sitting in the
 * cache — `getQueryData` at that moment *is* "the frame currently on
 * screen." Reaching into the cache here means the exclusion follows from the
 * refetch that was already the right trigger for "show me another one,"
 * rather than adding a second thing (a hook argument, a ref) that has to be
 * kept in step with what `<img>` is actually displaying.
 */
export function usePublicFrame() {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: publicFrameKey,
    queryFn: () => {
      const current = queryClient.getQueryData<z.infer<typeof PublicFrame>>(publicFrameKey);
      const path =
        current === undefined ? "/api/public/frame" : `/api/public/frame?exclude=${current.id}`;
      return apiFetch(path, PublicFrame);
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * An anonymous visitor's rulings on one frame (M14.2, M14.4).
 *
 * `session_id` is read off `getAnonSessionId()` here rather than threaded in
 * by the caller — every submission on this surface carries the same one, so
 * there is exactly one place to get that right rather than one per call
 * site. No query invalidation: unlike `useSubmitVerdicts`, there is no
 * public-facing stats panel this write should refresh, and the batch it
 * belongs to is unrelated to what `/api/public/frame` returns next.
 */
export function useSubmitPublicVerdicts() {
  return useMutation({
    mutationFn: ({
      imageId,
      verdicts,
    }: { imageId: number } & Pick<z.infer<typeof CreatePublicVerdictsRequest>, "verdicts">) =>
      apiFetch(`/api/public/images/${imageId}/verdicts`, VerdictBatch, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: getAnonSessionId(), verdicts }),
      }),
  });
}

export const snapshotsKey = ["snapshots"] as const;

/**
 * Every dataset snapshot built so far (M15.1's "listable with counts and
 * dates"). No `refetchInterval` — the same reasoning `useClasses` gives: a
 * finished snapshot never changes, and `useCreateSnapshot` invalidates this
 * key the moment a new build is queued so a poller sees it land without
 * re-fetching a table nobody else is writing to in the meantime.
 */
export function useSnapshots() {
  return useQuery({
    queryKey: snapshotsKey,
    queryFn: () => apiFetch("/api/admin/snapshots", SnapshotList),
  });
}

/**
 * Triggers a snapshot build (M15.1). Building itself runs as a queued job on
 * the home box, not inside this request — this only ever writes one `jobs`
 * row — so `onSuccess` invalidates the jobs list too, the same place a
 * queued dry-run shows up.
 */
export function useCreateSnapshot() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      apiFetch("/api/admin/snapshots", SnapshotJob, {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: jobsKeyPrefix });
      queryClient.invalidateQueries({ queryKey: snapshotsKey });
    },
  });
}

export const adminVideoImagesKeyPrefix = ["admin", "video-images"] as const;

/** One page of one video's frames, so two pages of the same video get their own cache entry. */
export const adminVideoImagesKey = (videoId: string, limit: number, offset: number) =>
  [...adminVideoImagesKeyPrefix, videoId, limit, offset] as const;

/**
 * One video's frames, with prediction counts and verdict state, paginated
 * (M16, ROADMAP M16.5): what `/admin/videos/:id` reads.
 *
 * A new route (`GET /api/admin/videos/{id}/images`), not the worker-facing
 * `/api/videos/{video_id}/images` `useVideos`'s sibling hooks never touch —
 * that endpoint requires a held `prelabel`/`dryrun` lease no browser holds,
 * which is exactly why this route exists separately (see the route's own
 * comment in `admin-video-images.ts`).
 *
 * `enabled: Boolean(videoId)` (M17, plan §A): `DryRunPanel`'s frame picker
 * calls this with whatever the video `<select>` currently holds, which is
 * `""` before an admin has chosen one — a state `VideoDetail`'s own call
 * never has, since its `videoId` comes off the route. Firing the request
 * anyway would ask `/api/admin/videos//images` for nothing.
 */
export function useAdminVideoImages(
  videoId: string,
  { limit, offset }: { limit: number; offset: number },
) {
  return useQuery({
    queryKey: adminVideoImagesKey(videoId, limit, offset),
    queryFn: () =>
      apiFetch(
        `/api/admin/videos/${encodeURIComponent(videoId)}/images?limit=${limit}&offset=${offset}`,
        AdminVideoImages,
      ),
    enabled: Boolean(videoId),
  });
}

/** One video's own key, so two different videos' headers get their own cache entry. */
export const adminVideoDetailKey = (videoId: string) => ["admin", "video-detail", videoId] as const;

/**
 * `/admin/videos/:id`'s header (M19, plan §A): the video's own YouTube-derived
 * metadata plus its per-video aggregates — everything `AdminVideoDetailPage`
 * renders above `useAdminVideoImages`'s frame grid.
 *
 * No `refetchInterval`, `useVideos`'s own reason: this header is not being
 * consumed the way `useLabellingBatch`'s pool is, and `image_count`,
 * `frames_verified` and the rest do not need to be live to the second. No
 * `enabled` guard either, unlike `useAdminVideoImages` — `videoId` here always
 * comes off the route param (`VideoDetail`'s own `useParams`), which is never
 * the empty-string "nothing chosen yet" state `DryRunPanel`'s picker can be in.
 */
export function useAdminVideoDetail(videoId: string) {
  return useQuery({
    queryKey: adminVideoDetailKey(videoId),
    queryFn: () => apiFetch(`/api/admin/videos/${encodeURIComponent(videoId)}`, AdminVideoDetail),
  });
}

/**
 * Queues an on-demand supplementary prelabel pass over one video (M17, plan
 * §B) — `VideoDetail`'s two actions, "prelabel selected" (`image_ids`) and
 * "randomise N un-sampled" (`{count, strategy:'random'}`), share this one
 * mutation because they share everything downstream of the request body:
 * `CreatePrelabelRequest`'s own `superRefine` is what tells the two modes
 * apart, not two different hooks here.
 *
 * Invalidates `jobsKeyPrefix`, `useCreateDryRun`'s own idiom — the queue is
 * where the job this just created shows up. The *prefix*, not one status's
 * own key: M19 (plan §C2) split the jobs key by status chip, and invalidating
 * `jobsKey()` alone would refresh whichever chip happens to be "all" while
 * leaving a `/admin/queue` filtered to `pending` showing a queue without the
 * job just queued. Deliberately does *not* invalidate
 * `labellingStatsKey` or `adminVideoImagesKeyPrefix`: the pool count and each
 * frame's `sampled` flag both read `images.selection_reason`, which is
 * stamped once a worker actually reports back
 * (`reportPredictionsHandler`'s own comment on why that stamp lands with the
 * report rather than at selection time) — refetching either query the
 * instant this call returns would show the same numbers it showed before,
 * for a job that has not run yet.
 */
export function useCreatePrelabel(videoId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: z.infer<typeof CreatePrelabelRequest>) =>
      apiFetch(`/api/admin/videos/${encodeURIComponent(videoId)}/prelabel`, PrelabelJob, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: jobsKeyPrefix }),
  });
}

/**
 * Every filter `GET /api/admin/verdicts` accepts, beyond paging (M18, plan
 * §A). One type shared by the query key, the hook's params and
 * `Annotations.tsx`'s own filter state, rather than three shapes that have
 * to be kept in sync by hand — a filter this type does not know about is a
 * filter the request URL below silently drops.
 */
export interface VerdictFilters {
  source?: "admin" | "anon" | "user";
  verdict?: Array<"accept" | "adjust" | "reject">;
  classId?: number;
  videoId?: string;
  annotatorId?: string;
  from?: number;
  to?: number;
}

export const adminVerdictsKey = (params: VerdictFilters & { limit: number; offset: number }) =>
  ["admin", "verdicts", params] as const;

/**
 * Every verdict, joined to its frame and class, newest first (M16, ROADMAP
 * M16.4; M18, plan §A adds five filters and a `total`): what
 * `/admin/annotations` reads below `LabellingStats`. `source` omitted
 * returns both tiers in one list — CONTEXT.md §Q10's split stays visible per
 * row rather than by narrowing the query, and the annotations page's own
 * tabs are what actually pass a `source` through. Every other filter is
 * omitted by default the same way.
 *
 * `verdict` becomes a repeated query parameter (`verdict=accept&verdict=…`),
 * matching what `AdminVerdictListQuery` actually parses on the API side —
 * Hono's own query parser turns one occurrence into a string and several
 * into an array, so this is the wire shape the schema was built to read, not
 * a comma-joined string that would need a second parsing convention.
 */
export function useAdminVerdicts(params: VerdictFilters & { limit: number; offset: number }) {
  const query = new URLSearchParams({
    limit: String(params.limit),
    offset: String(params.offset),
  });
  if (params.source) query.set("source", params.source);
  for (const kind of params.verdict ?? []) query.append("verdict", kind);
  if (params.classId !== undefined) query.set("class_id", String(params.classId));
  if (params.videoId) query.set("video_id", params.videoId);
  if (params.annotatorId) query.set("annotator_id", params.annotatorId);
  if (params.from !== undefined) query.set("from", String(params.from));
  if (params.to !== undefined) query.set("to", String(params.to));

  return useQuery({
    queryKey: adminVerdictsKey(params),
    queryFn: () => apiFetch(`/api/admin/verdicts?${query}`, AdminVerdictList),
  });
}

export const adminVerdictAnnotatorsKey = ["admin", "verdicts", "annotators"] as const;

/**
 * Populates the annotator filter's dropdown (M18, plan §A). No paging and no
 * arguments — `listVerdictAnnotatorsHandler` binds nothing and returns every
 * distinct `(annotator_id, source)` pair in one grouped scan, which is small
 * by construction (bounded by how many people have ever ruled on anything,
 * not by how many verdicts they have written).
 */
export function useAdminVerdictAnnotators() {
  return useQuery({
    queryKey: adminVerdictAnnotatorsKey,
    queryFn: () => apiFetch("/api/admin/verdicts/annotators", AdminAnnotatorList),
  });
}

// -----------------------------------------------------------------------
// Contributor accounts (M20, plan §B4, §B5)
// -----------------------------------------------------------------------

export const contributeMeKey = ["contribute", "me"] as const;

/**
 * The signed-in contributor's own counts (plan §B5). A 401 here — no cookie,
 * or an expired one — is what `Contribute.tsx` reads to decide between the
 * sign-in prompt and the verification session, the same "reaching the
 * handler answers the question" shape `useAdminSession` already uses for
 * `requireAccess`; `retry: false` is what keeps TanStack from quietly
 * retrying a 401 a few times before that decision ever renders.
 */
export function useContributeMe() {
  return useQuery({
    queryKey: contributeMeKey,
    queryFn: () => apiFetch("/api/contribute/me", ContributeMe),
    retry: false,
  });
}

export const contributeBatchKey = ["contribute", "batch"] as const;

/**
 * A contributor's next frames (plan §B4) — `useLabellingBatch`'s own shape
 * and its own reasoning for `staleTime: Infinity`: this pool is being
 * consumed by a session, not polled, and a background refetch landing
 * mid-judgement would replace the frame under the contributor's cursor.
 */
export function useContributeBatch() {
  return useQuery({
    queryKey: contributeBatchKey,
    queryFn: () => apiFetch("/api/contribute/batch", ContributeBatch),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * A contributor's rulings on one frame (plan §B4). Reuses `CreateVerdictsRequest`
 * and `VerdictBatch` — the same request and response shapes
 * `useSubmitVerdicts` posts to `/api/admin/images/{id}/verdicts`, because
 * `submitContributeVerdictsHandler` and `submitVerdictsHandler` accept and
 * answer with the identical wire shape and differ only in which `source`
 * they stamp, which the caller never sends either way.
 *
 * Invalidates `contributeMeKey`, unlike `useSubmitVerdicts`'s admin
 * equivalent invalidating `labellingStatsKey`: the personal-counts screen
 * (plan §B5) is this tier's equivalent of the admin stats panel, and a
 * contributor who just ruled on a frame should see their own count move.
 */
export function useSubmitContributeVerdicts() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      imageId,
      ...body
    }: z.infer<typeof CreateVerdictsRequest> & { imageId: number }) =>
      apiFetch(`/api/contribute/images/${imageId}/verdicts`, VerdictBatch, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contributeMeKey }),
  });
}

/**
 * Ends the contributor session (plan §B2). Not routed through `apiFetch`:
 * `logoutHandler` answers `204 No Content` on purpose (there is nothing to
 * report beyond "this succeeded"), and `apiFetch`'s own contract is built
 * around every response carrying a JSON body — a 204's missing
 * `content-type` would trip its "non-JSON on a 2xx" branch and be
 * misread as an expired Access session, which this has nothing to do with.
 *
 * Invalidates `contributeMeKey` on success so `Contribute.tsx` re-renders
 * the signed-out state without a full page reload — the one thing a plain
 * HTML form POST to the same endpoint could not do on its own.
 */
export function useLogout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(`logout failed with status ${response.status}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contributeMeKey }),
  });
}
