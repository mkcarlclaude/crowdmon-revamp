import { Route, Routes } from "react-router";
import { Admin } from "./pages/Admin";
import { Home } from "./pages/Home";

/**
 * Two routes, and `/admin` is not hidden.
 *
 * CONTEXT.md §Q19: the admin bundle is assumed public. Client-side routing
 * sends no request when navigating here from a loaded page, so nothing that
 * inspects HTTP paths can gate it. Every `/api/admin/*` endpoint verifies the
 * caller independently — that is the gate, not this table.
 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/admin" element={<Admin />} />
    </Routes>
  );
}
