import { type FormEvent, useId, useState } from "react";
import { useCreateClass } from "../api/queries";
import { ApiError } from "../api/session";

/**
 * Adding a class (M12.1) — the thing that used to require writing a migration
 * the way 0006 did.
 *
 * There is no "active" checkbox, and its absence is the design: the server
 * creates every class deactivated so that M12.2's dry-run sits between writing
 * a prompt and letting it pre-label a video. A control here would be a control
 * for skipping that, which is the one thing the ordering exists to prevent —
 * so the form says what happened instead of offering the choice.
 *
 * Client-side validation is thin for `SubmitForm`'s reason: the wire contract
 * already bounds both fields, and a second copy of those bounds here is a
 * second definition that drifts. The empty check exists only to avoid a round
 * trip that can only fail.
 */
export function AddClassForm() {
  const nameId = useId();
  const promptId = useId();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const create = useCreateClass();

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !prompt.trim()) return;
    if (create.isPending) return;

    create.mutate(
      { name: name.trim(), appearance_prompt: prompt.trim() },
      {
        onSuccess: () => {
          setName("");
          setPrompt("");
        },
      },
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <label htmlFor={nameId} className="text-sm text-[var(--color-text-muted)]">
        Class name
      </label>
      <input
        id={nameId}
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Nahida"
        className="rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm"
      />

      <label htmlFor={promptId} className="text-sm text-[var(--color-text-muted)]">
        Appearance prompt
      </label>
      {/* Said here rather than only in the docs: an open-vocabulary detector
          has no concept of a proper noun, so a prompt that names the character
          finds nothing and looks like a bad model. */}
      <p className="text-xs text-[var(--color-text-muted)]">
        Describe what the detector should see, not who it is — "a small girl with long
        white-and-green hair", not "Nahida".
      </p>
      <textarea
        id={promptId}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        rows={2}
        className="rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm"
      />

      <div className="flex items-baseline gap-3">
        <button
          type="submit"
          disabled={create.isPending}
          className="rounded border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-50"
        >
          {create.isPending ? "Adding…" : "Add class"}
        </button>
        <span className="text-xs text-[var(--color-text-muted)]">
          Added classes start retired — activate one once its prompt has been tried.
        </span>
      </div>

      {create.isSuccess && (
        <p className="text-sm text-[var(--color-done)]">
          Added {create.data.name} as {create.data.prompt_version}, retired.
        </p>
      )}

      {create.isError && <CreateError error={create.error} />}
    </form>
  );
}

/** The API's own words, for `SubmitError`'s reason: a translated message goes
 *  stale the first time the API's wording changes. */
function CreateError({ error }: { error: Error }) {
  const issues = error instanceof ApiError ? error.issues : undefined;

  return (
    <div role="alert" className="text-sm text-[var(--color-failed)]">
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
