import { reauthenticate, SessionExpiredError } from "../api/session";

/**
 * The Access session lasts 24 hours, so an admin tab left open overnight meets
 * this every morning.
 *
 * Not an automatic redirect: a transient failure would then discard whatever
 * was typed into the submit box. What M5.4 actually requires is that recovery
 * is a *navigation* rather than another fetch — `fetch` cannot complete a
 * redirect flow to an identity provider — and a button does that.
 */
export function SessionExpiredBanner({ error }: { error: unknown }) {
  if (!(error instanceof SessionExpiredError)) return null;

  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-4 rounded border border-[var(--color-claimed)] p-3 text-sm"
    >
      <span>Your Access session has expired.</span>
      <button
        type="button"
        onClick={reauthenticate}
        className="rounded border border-[var(--color-border)] px-3 py-1"
      >
        Sign in again
      </button>
    </div>
  );
}
