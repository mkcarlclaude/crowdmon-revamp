import {
  AdminClass,
  AdminClassList,
  AdminVideoList,
  type CreateClassRequest,
  type CreateDryRunRequest,
  DryRun,
  DryRunList,
  JobList,
  type SubmitVideoRequest,
  type UpdateClassRequest,
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
 * tab. Enabled only for a real class id, so the hook can be called
 * unconditionally by a component that may not have one yet.
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
