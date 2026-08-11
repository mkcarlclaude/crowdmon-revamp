import { reauthenticate, SessionExpiredError } from "../api/session";
import { Button } from "./ui/button";

/**
 * The Access session lasts 24 hours, so an admin tab left open overnight meets
 * this every morning.
 *
 * Not an automatic redirect: a transient failure would then discard whatever
 * was typed into the submit box. What M5.4 actually requires is that recovery
 * is a *navigation* rather than another fetch — `fetch` cannot complete a
 * redirect flow to an identity provider — and a button does that.
 *
 * Restyled onto shadcn/ui's `Button` in M16 — it is admin-only (only
 * `AdminVideosPage` mounts it; the public `/verify` page has no Access
 * session to expire), so unlike `VerificationCard` there is no shared-with-
 * the-public-page reason to leave it alone.
 */
export function SessionExpiredBanner({ error }: { error: unknown }) {
  if (!(error instanceof SessionExpiredError)) return null;

  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-4 rounded-md border border-[var(--color-claimed)] p-3 text-sm"
    >
      <span>Your Access session has expired.</span>
      <Button type="button" variant="outline" size="sm" onClick={reauthenticate}>
        Sign in again
      </Button>
    </div>
  );
}
