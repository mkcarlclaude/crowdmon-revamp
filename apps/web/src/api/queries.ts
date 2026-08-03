import { JobList, type SubmitVideoRequest, VideoSubmission } from "@crowdmon/api/schemas";
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
