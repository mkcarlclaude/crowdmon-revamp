import { useContributeMe, useLogout } from "../api/queries";
import { ContributeVerify } from "../components/ContributeVerify";
import { useNoindex } from "../hooks/use-noindex";

/**
 * `/contribute` (M20, plan §B4) — the signed-in contributor surface.
 *
 * `useContributeMe`'s 401 is what tells this page apart from `/admin/verify`:
 * there is no separate "am I signed in" probe the way `AdminLayout` has one
 * (`useAdminSession`, CONTEXT.md §Q19's amendment) — `/api/contribute/me`
 * already answers both "who is this" and "is anyone signed in at all" in one
 * request, so a second one would exist only to ask a question this one
 * already answers.
 *
 * The sign-in control itself is a plain top-level navigation to
 * `/api/auth/google/start`, matching `reauthenticate()`'s own reasoning for
 * `/api/admin/login`: `fetch` cannot complete a redirect chain to an
 * identity provider on another origin, so the browser has to be sent there
 * directly rather than asked to retrieve it.
 *
 * **What this page does not render.** The nav's own "Sign in" control and
 * any Turnstile challenge in front of `/api/auth/google/start` are the
 * landing page's concern (plan §A3) and a product decision about how that
 * challenge is surfaced that this milestone does not settle — see the PR
 * body. A visitor who lands here signed out gets a working link, not a
 * silently broken page.
 *
 * **Wider than a text column, on purpose (M24, plan §C).** `ContributeVerify`
 * now renders `SwipeCard`, which grows a second column at `lg:` (plan §A2) —
 * a `max-w-2xl` reading-width container would starve that column down to
 * nothing before the frame ever reached its own 720px cap. `max-w-[1200px]`
 * matches the swipe surface's own internal cap (`SwipeCard.tsx`), so the
 * header and trust copy above it just read a little wider than they used to
 * rather than fighting the widget for room.
 */
export function Contribute() {
  // A signed-in personal surface, same reasoning as `/admin` — never meant
  // to be crawled. M20 plan §A4 only made `/` indexable; every other route
  // keeps the `noindex` the old blanket `<meta>` tag in `index.html` used to
  // give it for free (see `use-noindex.ts`).
  useNoindex();
  const me = useContributeMe();
  const logout = useLogout();

  if (me.isPending) return <p className="p-8 text-sm">Loading…</p>;

  if (me.isError) {
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-4 p-8">
        <h1 className="text-2xl font-semibold">Contribute</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Sign in with Google to start verifying frames. Your rulings are recorded under your own
          account, and count toward the dataset once an admin has trusted it.
        </p>
        <a
          href="/api/auth/google/start"
          className="inline-block w-fit rounded border border-[var(--color-border)] px-3 py-1 text-sm"
        >
          Sign in with Google
        </a>
      </main>
    );
  }

  const { data } = me;

  return (
    <main className="mx-auto flex max-w-[1200px] flex-col gap-6 p-8">
      {/* Kept at reading width even though the `<main>` around it now isn't
          (M24, plan §C) — `ContributeVerify` below needs the room its own
          two-column layout grows into at `lg:`, but a name, a count and a
          sentence do not, and stretching them across 1200px would just make
          them harder to read. */}
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold">Contribute</h1>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Signed in as {data.display_name ?? data.email}.
            </p>
          </div>
          <button
            type="button"
            disabled={logout.isPending}
            onClick={() => logout.mutate()}
            className="rounded border border-[var(--color-border)] px-3 py-1 text-sm disabled:opacity-50"
          >
            {logout.isPending ? "Signing out…" : "Sign out"}
          </button>
        </div>

        {/* Honest about `trusted` rather than showing a bare count that implies
            more than it means (plan §B5) — a contributor whose verdicts are
            recorded but not yet promoted has no way to tell from the numbers
            alone whether any of it is a label yet. */}
        <p className="text-sm text-[var(--color-text-muted)]">
          {data.frames_touched} frames · {data.verdicts.accept} accepted, {data.verdicts.adjust}{" "}
          adjusted, {data.verdicts.reject} rejected.{" "}
          {data.trusted
            ? "Your verdicts can be selected as labels."
            : "Recorded, but not yet trusted — an admin promotes accounts before their verdicts can be selected as labels."}
        </p>
      </div>

      <ContributeVerify />
    </main>
  );
}
