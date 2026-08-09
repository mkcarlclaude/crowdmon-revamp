import {
  AdminClass,
  AdminClassList,
  AdminImage,
  AdminVideoList,
  type CreateClassRequest,
  type CreateDryRunRequest,
  type CreateMissingReportRequest,
  type CreatePublicVerdictsRequest,
  type CreateVerdictsRequest,
  DryRun,
  DryRunList,
  JobList,
  LabellingBatch,
  LabellingStats,
  MissingReport,
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

export const jobsKey = ["jobs"] as const;

/**
 * The job list, refreshed on an interval (M5.3).
 *
 * Five seconds: the Go worker heartbeats every 30s and its poll floor is 30s,
 * so anything faster shows the same row repeatedly while adding D1 reads for
 * every open tab. `refetchIntervalInBackground` is left off — a hidden tab
 * polling a database is cost with nobody watching.
 */
export function useJobs() {
  return useQuery({
    queryKey: jobsKey,
    queryFn: () => apiFetch("/api/admin/jobs", JobList),
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: jobsKey }),
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

export const dryRunsKey = (classId: number) => ["dryruns", classId] as const;

/**
 * One class's recent dry-runs.
 *
 * Polls only while something is actually running. A dry-run is minutes of the
 * box's two cores, so the screen has to move on its own when the result lands
 * — but a class whose newest run finished has nothing left to poll for, and
 * the interval turns itself off rather than reading D1 forever behind an open
 * tab.
 *
 * `classId` is required, and there is no `enabled` guard: every caller renders
 * inside a class card that already has a row id. A caller that does not have
 * one yet should not be rendering this.
 */
export function useDryRuns(classId: number) {
  return useQuery({
    queryKey: dryRunsKey(classId),
    queryFn: () => apiFetch(`/api/admin/classes/${classId}/dryruns`, DryRunList),
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
      queryClient.invalidateQueries({ queryKey: jobsKey });
    },
  });
}

export const publicFrameKey = ["public", "frame"] as const;

/**
 * One frame for a visitor with no account (M14.2).
 *
 * `staleTime: Infinity` for `useLabellingBatch`'s own reason: the frame on
 * screen is being judged, not polled, and a background refetch landing
 * mid-judgement would swap the picture out from under the visitor's cursor.
 * `PublicVerify` asks for a new one explicitly, once a verdict has been
 * submitted.
 */
export function usePublicFrame() {
  return useQuery({
    queryKey: publicFrameKey,
    queryFn: () => apiFetch("/api/public/frame", PublicFrame),
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
      queryClient.invalidateQueries({ queryKey: jobsKey });
      queryClient.invalidateQueries({ queryKey: snapshotsKey });
    },
  });
}
