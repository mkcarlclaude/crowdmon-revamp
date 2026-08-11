import { type FormEvent, useId, useState } from "react";
import { useSubmitVideo } from "../api/queries";
import { ApiError } from "../api/session";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

/**
 * Client-side validation is deliberately thin.
 *
 * The wire contract checks `z.url()` and the server alone decides what counts
 * as a YouTube URL (see the comment on `SubmitVideoRequest` — putting host
 * matching in the contract would make a change to it a breaking API change).
 * Duplicating that here would produce a second, drifting definition. The empty
 * check exists only to avoid a round trip that can only fail.
 *
 * Restyled onto shadcn/ui primitives in M16 — `Input`, `Label` and `Button`
 * render the same `<input>`/`<label>`/`<button>` elements the previous
 * markup did, with `id`/`htmlFor` still wired the same way, so nothing here
 * needed a behaviour change to move: `SubmitForm.test.tsx` queries by label
 * text and button role, neither of which this restyle touches.
 */
export function SubmitForm() {
  const inputId = useId();
  const [url, setUrl] = useState("");
  const submit = useSubmitVideo();

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!url.trim()) return;
    // `submit` is a per-render snapshot, so this reads the same `isPending`
    // value that already drives `disabled` on the button below — it does not
    // close the click-vs-click race a re-render window would leave open.
    // What it does guard is a second entry point: implicit submission via
    // Enter, which never touches the button and so never sees `disabled`.
    if (submit.isPending) return;
    submit.mutate({ url: url.trim() }, { onSuccess: () => setUrl("") });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <Label htmlFor={inputId} className="text-muted-foreground">
        YouTube URL
      </Label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://www.youtube.com/watch?v=..."
          className="font-mono"
        />
        <Button type="submit" disabled={submit.isPending}>
          {submit.isPending ? "Submitting…" : "Submit"}
        </Button>
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
    <div role="alert" className="text-sm text-destructive">
      <p>{error.message}</p>
      {issues && issues.length > 0 && (
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
