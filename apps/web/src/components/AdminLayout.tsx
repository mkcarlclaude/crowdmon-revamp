import { Navigate, NavLink, Outlet, useLocation } from "react-router";
import { useAdminSession } from "../api/queries";
import { useNoindex } from "../hooks/use-noindex";
import { GrafanaLink } from "./GrafanaLink";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "./ui/sidebar";

/**
 * The admin shell: sidebar, session probe, `<Outlet />` (M16, CONTEXT.md §Q19
 * amendment).
 *
 * The probe is `useAdminSession`, and what it decides is cosmetic, not the
 * gate: `requireAccess` verifies every `/api/admin/*` request independently
 * regardless of what this component renders, and the admin bundle is still
 * assumed public (§Q19's original "gate the API, not the UI route"). What
 * this buys is that an unauthenticated browser lands on `/admin/login` — a
 * button, not a shell full of failed requests — the same problem
 * `SessionExpiredBanner` (M5.4) already solved for a session that expired
 * *mid-visit*. This solves it for a session that was never there to begin
 * with, which is the case `SessionExpiredBanner` never had to handle: nothing
 * before M16 rendered anything under `/admin` until a request had already
 * failed once.
 *
 * `<Navigate>` rather than `window.location.assign` — this redirect crosses
 * no origin and completes no Access flow, so a client-side route change is
 * both sufficient and correct. `AdminLogin`'s own button is the one place in
 * this surface that has to leave React Router, and its own comment says why.
 */
export function AdminLayout() {
  // Assumed public (§Q19) but never meant to be crawled. `public/_headers`
  // is the real control (`X-Robots-Tag`, seen by non-JS crawlers too); this
  // hook is defense in depth — see `use-noindex.ts`.
  useNoindex();
  const session = useAdminSession();
  const location = useLocation();

  if (session.isPending) {
    return (
      <div className="admin-theme flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Checking your session…
      </div>
    );
  }

  if (session.isError) {
    return <Navigate to="/admin/login" replace />;
  }

  return (
    <div className="admin-theme">
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader>
            <span className="px-2 py-1 text-sm font-semibold">crowdmon admin</span>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  {NAV_ITEMS.map((item) => (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton asChild isActive={location.pathname.startsWith(item.to)}>
                        <NavLink to={item.to}>{item.label}</NavLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          {/* CONTEXT.md §7: system data stays in Grafana rather than being
              rebuilt here, so the one link out to it lives in the footer of
              every admin page instead of being repeated per screen the way
              M5–M13 had it once each on the single scrolling page. */}
          <SidebarFooter>
            <div className="flex flex-col gap-2 px-2 pb-2 text-xs text-muted-foreground">
              <span data-testid="admin-email">{session.data.email}</span>
              <GrafanaLink />
            </div>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset>
          <header className="flex items-center gap-2 border-b border-border px-4 py-3">
            <SidebarTrigger />
          </header>
          <div className="p-6">
            <Outlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}

const NAV_ITEMS = [
  { to: "/admin/dashboard", label: "Dashboard" },
  { to: "/admin/videos", label: "Videos" },
  // "Detection" was removed here in M19 (plan §B2): its coverage table
  // folded into `/admin/videos` above, and `/admin/detection` now just
  // redirects there (`routes.tsx`). "Queue" (plan §C1) sits between Videos
  // and Verify — it is what `/admin/videos`'s own `JobList` used to be.
  { to: "/admin/queue", label: "Queue" },
  { to: "/admin/verify", label: "Verify" },
  { to: "/admin/annotations", label: "Annotations" },
  { to: "/admin/classes", label: "Classes" },
  { to: "/admin/snapshots", label: "Snapshots" },
] as const;
