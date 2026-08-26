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
import { Contribute } from "./pages/Contribute";
import { Demo } from "./pages/Demo";
import { Home } from "./pages/Home";

/**
 * `/`, `/demo` and everything under `/admin`, and none of it is hidden.
 *
 * CONTEXT.md §Q19: the admin bundle is assumed public. Client-side routing
 * sends no request when navigating here from a loaded page, so nothing that
 * inspects HTTP paths can gate it. Every `/api/admin/*` endpoint verifies the
 * caller independently — that is the gate, not this table. `/demo` (M14,
 * renamed from `/verify` in M24) has no gate to speak of: it is the public
 * surface, and `/api/public/*` carries its own bounds (a curated pool, rate
 * limiting) rather than an identity check.
 *
 * `/verify` is kept as a redirect (M24, plan §B1) rather than deleted — it
 * is linked from the landing page's own history, from this repo's docs, and
 * from anywhere a stranger has already pasted the old URL. `<Navigate>`
 * fires client-side, after the SPA shell has already loaded; `public/_headers`
 * carries this path's own `noindex` so a crawler does not index the redirect
 * stub itself.
 *
 * `/admin/login` sits outside `AdminLayout` rather than as one of its
 * children: it is the one screen a browser reaches *before* `AdminLayout`'s
 * session probe would have anything to show a sidebar around, so it renders
 * no sidebar and no `<Outlet />` — just the gate screen itself. Every other
 * `/admin/*` route is a child of `AdminLayout`, which redirects here on a
 * failed probe (see that component's own comment) — a client-side
 * convenience, not the boundary; §Q19's amendment is explicit that this is
 * cosmetics.
 *
 * `/contribute` (M20, plan §B4) has no equivalent gate screen or redirect —
 * `Contribute.tsx` itself branches on whether `/api/contribute/me` succeeds,
 * the same "reaching the handler is the answer" shape `requireAccess` and
 * `requireUser` both give their own routes, so there is nothing here for a
 * router-level redirect to decide that the page's own render does not
 * already decide correctly.
 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/demo" element={<Demo />} />
      <Route path="/verify" element={<Navigate to="/demo" replace />} />
      <Route path="/contribute" element={<Contribute />} />
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
