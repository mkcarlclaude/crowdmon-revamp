import { type FormEvent, useId, useState } from "react";
import { useCreateClass } from "../api/queries";
import { ApiError } from "../api/session";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

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
 * second definition that drifts.
 *
 * Restyled onto shadcn/ui primitives in M16. The prompt field stays a plain
 * `<textarea>` — `textarea` is not in the plan's expected component set, and
 * a two-row free-text field has nothing a generated wrapper would add over
 * the existing token classes — restyled to the new token names for visual
 * consistency with the fields around it.
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
      <Label htmlFor={nameId} className="text-muted-foreground">
        Class name
      </Label>
      <Input
        id={nameId}
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Nahida"
      />

      <Label htmlFor={promptId} className="text-muted-foreground">
        Appearance prompt
      </Label>
      {/* Said here rather than only in the docs: an open-vocabulary detector
          has no concept of a proper noun, so a prompt that names the character
          finds nothing and looks like a bad model. */}
      <p className="text-xs text-muted-foreground">
        Describe what the detector should see, not who it is — "a small girl with long
        white-and-green hair", not "Nahida".
      </p>
      <textarea
        id={promptId}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        rows={2}
        className="rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />

      <div className="flex items-baseline gap-3">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? "Adding…" : "Add class"}
        </Button>
        <span className="text-xs text-muted-foreground">
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
