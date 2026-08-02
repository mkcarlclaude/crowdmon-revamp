import { type FormEvent, useId, useState } from "react";
import { useSubmitVideo } from "../api/queries";
import { ApiError } from "../api/session";

/**
 * Client-side validation is deliberately thin.
 *
 * The wire contract checks `z.url()` and the server alone decides what counts
 * as a YouTube URL (see the comment on `SubmitVideoRequest` — putting host
 * matching in the contract would make a change to it a breaking API change).
 * Duplicating that here would produce a second, drifting definition. The empty
 * check exists only to avoid a round trip that can only fail.
 */
export function SubmitForm() {
  const inputId = useId();
  const [url, setUrl] = useState("");
  const submit = useSubmitVideo();

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!url.trim()) return;
    submit.mutate({ url: url.trim() }, { onSuccess: () => setUrl("") });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <label htmlFor={inputId} className="text-sm text-[var(--color-text-muted)]">
        YouTube URL
      </label>
      <div className="flex gap-2">
        <input
          id={inputId}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://www.youtube.com/watch?v=..."
          className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 font-mono text-sm"
        />
        <button
          type="submit"
          disabled={submit.isPending}
          className="rounded border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-50"
        >
          {submit.isPending ? "Submitting…" : "Submit"}
        </button>
      </div>

      {submit.isSuccess && (
        <p className="text-sm text-[var(--color-done)]">
          Queued {submit.data.video_id} as job {submit.data.job_id}
        </p>
      )}

      {submit.isError && <SubmitError error={submit.error} />}
    </form>
  );
}

/**
 * Renders the API's own words. Nothing here rewrites a server message into a
 * friendlier one — M5.2's requirement is that failures surface, and a
 * translated message is a message that goes stale the first time the API's
 * wording changes.
 */
function SubmitError({ error }: { error: Error }) {
  const issues = error instanceof ApiError ? error.issues : undefined;

  return (
    <div role="alert" className="text-sm text-[var(--color-failed)]">
      <p>{error.message}</p>
      {issues && (
        <ul className="mt-1 list-disc pl-5">
          {issues.map((issue) => (
            <li key={`${issue.path}:${issue.message}`}>
              {issue.path}: {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
