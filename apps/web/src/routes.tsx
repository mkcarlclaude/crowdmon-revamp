import { Route, Routes } from "react-router";
import { Admin } from "./pages/Admin";
import { Home } from "./pages/Home";
import { Verify } from "./pages/Verify";

/**
 * Three routes, and none of them is hidden.
 *
 * CONTEXT.md §Q19: the admin bundle is assumed public. Client-side routing
 * sends no request when navigating here from a loaded page, so nothing that
 * inspects HTTP paths can gate it. Every `/api/admin/*` endpoint verifies the
 * caller independently — that is the gate, not this table. `/verify` (M14)
 * has no gate to speak of: it is the public surface, and `/api/public/*`
 * carries its own bounds (a curated pool, rate limiting) rather than an
 * identity check.
 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/admin" element={<Admin />} />
      <Route path="/verify" element={<Verify />} />
    </Routes>
  );
}
