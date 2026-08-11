/**
 * `/admin/dashboard` — a deliberate placeholder (M16, ROADMAP M16, CONTEXT.md
 * §Q19 amendment).
 *
 * A metrics page that guesses at which numbers matter is worse than an empty
 * one, and §Q19 already forbids the obvious filling: system data belongs to
 * Grafana (`GrafanaLink`, in the sidebar footer), business data that is
 * genuinely a per-page concern lives on `/admin/annotations` and
 * `/admin/detection`, and a dashboard that duplicated either would be a
 * second, drifting copy of a number this app does not need two of. This page
 * exists so `/admin` redirects somewhere real rather than nowhere; it does
 * not exist to be filled in later without a reason better than "it looked
 * empty."
 */
export function AdminDashboardPage() {
  return <h1 className="text-2xl font-semibold text-foreground">Dashboard</h1>;
}
