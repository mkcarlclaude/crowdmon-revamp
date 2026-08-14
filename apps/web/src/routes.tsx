import { Navigate, Route, Routes } from "react-router";
import { AdminLayout } from "./components/AdminLayout";
import { AdminAnnotationsPage } from "./pages/admin/Annotations";
import { AdminClassesPage } from "./pages/admin/Classes";
import { AdminDashboardPage } from "./pages/admin/Dashboard";
import { AdminLoginPage } from "./pages/admin/Login";
import { AdminQueuePage } from "./pages/admin/Queue";
import { AdminSnapshotsPage } from "./pages/admin/Snapshots";
import { AdminVerifyPage } from "./pages/admin/Verify";
import { AdminVideoDetailPage } from "./pages/admin/VideoDetail";
import { AdminVideosPage } from "./pages/admin/Videos";
import { Home } from "./pages/Home";
import { Verify } from "./pages/Verify";

/**
 * `/`, `/verify` and everything under `/admin`, and none of it is hidden.
 *
 * CONTEXT.md §Q19: the admin bundle is assumed public. Client-side routing
 * sends no request when navigating here from a loaded page, so nothing that
 * inspects HTTP paths can gate it. Every `/api/admin/*` endpoint verifies the
 * caller independently — that is the gate, not this table. `/verify` (M14)
 * has no gate to speak of: it is the public surface, and `/api/public/*`
 * carries its own bounds (a curated pool, rate limiting) rather than an
 * identity check.
 *
 * `/admin/login` sits outside `AdminLayout` rather than as one of its
 * children: it is the one screen a browser reaches *before* `AdminLayout`'s
 * session probe would have anything to show a sidebar around, so it renders
 * no sidebar and no `<Outlet />` — just the gate screen itself. Every other
 * `/admin/*` route is a child of `AdminLayout`, which redirects here on a
 * failed probe (see that component's own comment) — a client-side
 * convenience, not the boundary; §Q19's amendment is explicit that this is
 * cosmetics.
 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/verify" element={<Verify />} />
      <Route path="/admin/login" element={<AdminLoginPage />} />
      <Route path="/admin" element={<AdminLayout />}>
        {/* Not a route of its own — `/admin` has nothing to show until it
            picks one of its children, and the dashboard is the least
            surprising default (ROADMAP M16: "an authenticated one lands on
            a sidebar shell"). */}
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<AdminDashboardPage />} />
        <Route path="videos" element={<AdminVideosPage />} />
        <Route path="videos/:id" element={<AdminVideoDetailPage />} />
        {/* M19, plan §C1: every job of every kind, flat — replaces the
            grouped `JobList` that used to live on `/admin/videos`. */}
        <Route path="queue" element={<AdminQueuePage />} />
        <Route path="verify" element={<AdminVerifyPage />} />
        <Route path="annotations" element={<AdminAnnotationsPage />} />
        {/* M19, plan §B2: the coverage table folded into `/admin/videos`.
            A redirect rather than a 404 — this repo's own docs and issue
            #140 link `/admin/detection` directly. */}
        <Route path="detection" element={<Navigate to="/admin/videos" replace />} />
        <Route path="classes" element={<AdminClassesPage />} />
        <Route path="snapshots" element={<AdminSnapshotsPage />} />
      </Route>
    </Routes>
  );
}
