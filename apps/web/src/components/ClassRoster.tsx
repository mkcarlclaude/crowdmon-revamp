import type { AdminClassRow } from "@crowdmon/api/schemas";
import { useState } from "react";
import { useClasses, useUpdateClass } from "../api/queries";
import { DryRunPanel } from "./DryRunPanel";

/**
 * The class roster (M12.1): every class, active and retired, each editable in
 * place.
 *
 * Retired rows are rendered, not filtered out. A retired class is the one an
 * admin most needs to see — reactivating it is the only way it ever comes
 * back, and there is no delete anywhere in this surface because the
 * predictions a retired prompt produced still reference its row.
 *
 * Nothing here hides the prompt version. It is the column that says which
 * wording produced which boxes, and an operator who cannot see it cannot tell
 * whether the change they just made has taken effect.
 */
export function ClassRoster() {
  const { data, isPending, error } = useClasses();
  const update = useUpdateClass();

  if (isPending) return <p className="text-[var(--color-text-muted)]">Loading…</p>;
  if (error)
    return (
      <p role="alert" className="text-[var(--color-failed)]">
        {error.message}
      </p>
    );
  if (data.classes.length === 0)
    return <p className="text-[var(--color-text-muted)]">No classes yet.</p>;

  return (
    <div className="flex flex-col gap-3">
      {/* One shared error line rather than one per row: there is one mutation,
          so there is one error at a time, and the row it came from is named in
          the API's own message. */}
      {update.isError && (
        <p role="alert" className="text-sm text-[var(--color-failed)]">
          {update.error.message}
        </p>
      )}
      {data.classes.map((klass) => (
        <ClassCard
          key={klass.id}
          klass={klass}
          // Which row is busy, derived from the shared mutation's own
          // variables rather than from per-row state: two saves in flight at
          // once would otherwise light up the wrong row's spinner.
          busy={update.isPending && update.variables?.id === klass.id}
          onSave={(appearance_prompt) => update.mutate({ id: klass.id, appearance_prompt })}
          onToggle={() => update.mutate({ id: klass.id, active: !klass.active })}
        />
      ))}
    </div>
  );
}

function ClassCard({
  klass,
  busy,
  onSave,
  onToggle,
}: {
  klass: AdminClassRow;
  busy: boolean;
  onSave: (appearancePrompt: string) => void;
  onToggle: () => void;
}) {
  const [prompt, setPrompt] = useState(klass.appearance_prompt);

  // Compared against the server's copy, not tracked as a dirty flag: the
  // roster is refetched after every save, so this is what makes the button go
  // quiet again once the edit has landed — and what keeps it quiet for a save
  // that would only have re-sent identical text (the API declines to bump a
  // version for that, and there is no reason to make it say so).
  const changed = prompt.trim() !== klass.appearance_prompt && prompt.trim().length > 0;

  return (
    <section
      aria-label={klass.name}
      className="rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 className="text-sm font-semibold">{klass.name}</h3>
        <span style={{ color: klass.active ? "var(--color-done)" : "var(--color-text-muted)" }}>
          {klass.active ? "active" : "retired"}
        </span>
        <span className="font-mono text-xs text-[var(--color-text-muted)]">
          {klass.prompt_version}
        </span>
      </div>

      <textarea
        aria-label={`${klass.name} appearance prompt`}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        rows={2}
        className="mt-2 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
      />

      <div className="mt-2 flex flex-wrap items-baseline gap-3">
        <button
          type="button"
          disabled={!changed || busy}
          onClick={() => onSave(prompt.trim())}
          className="rounded border border-[var(--color-border)] px-3 py-1 text-sm disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save wording"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onToggle}
          className="rounded border border-[var(--color-border)] px-3 py-1 text-sm disabled:opacity-50"
        >
          {klass.active ? "Retire" : "Activate"}
        </button>
        {changed && (
          <span className="text-xs text-[var(--color-text-muted)]">
            Saving reworded text stamps a new prompt version — the boxes already produced keep the
            old one.
          </span>
        )}
      </div>

      {/* M12.2, and it reads the *unsaved* textarea above rather than the
          class's stored prompt — trying a wording before saving it is the
          entire ordering this milestone exists to establish. */}
      <DryRunPanel classId={klass.id} prompt={prompt} />
    </section>
  );
}
