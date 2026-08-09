import {
  AdminClass,
  AdminClassList,
  AdminVideoList,
  type CreateClassRequest,
  type CreateDryRunRequest,
  type CreateMissingReportRequest,
  type CreateVerdictRequest,
  DryRun,
  DryRunList,
  ImageRejection,
  JobList,
  LabellingBatch,
  LabellingStats,
  MissingReport,
  type SubmitVideoRequest,
  type UpdateClassRequest,
  Verdict,
  VideoSubmission,
} from "@crowdmon/api/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
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

/** Verdict counts, class coverage and pool size (M13.4). Business data — §7's Grafana boundary. */
export function useLabellingStats() {
  return useQuery({
    queryKey: labellingStatsKey,
    queryFn: () => apiFetch("/api/admin/labelling/stats", LabellingStats),
  });
}

/**
 * One ruling on one proposed box.
 *
 * Invalidates the stats and nothing else. Invalidating the batch would refetch
 * a page of frames on every click — the endpoint pages by *unruled* boxes, so
 * the answer would shift under the session between one verdict and the next,
 * which is the one thing `useLabellingBatch`'s own comment is about.
 */
export function useCreateVerdict() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      predictionId,
      ...body
    }: z.infer<typeof CreateVerdictRequest> & { predictionId: number }) =>
      apiFetch(`/api/admin/predictions/${predictionId}/verdict`, Verdict, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: labellingStatsKey }),
  });
}

/** Reject every remaining box on one frame, in one request (M13.1). */
export function useRejectFrame() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (imageId: number) =>
      apiFetch(`/api/admin/images/${imageId}/reject`, ImageRejection, { method: "POST" }),
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
