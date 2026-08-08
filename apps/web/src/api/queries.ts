import {
  AdminClass,
  AdminClassList,
  type CreateClassRequest,
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
