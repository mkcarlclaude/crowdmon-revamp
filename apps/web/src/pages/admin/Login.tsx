import { reauthenticate } from "../../api/session";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { useNoindex } from "../../hooks/use-noindex";

/**
 * The Access gate screen (M16, CONTEXT.md §Q19 amendment).
 *
 * There is no password field here and there should never be one: Access is
 * the entire auth scheme (§Q19), and the one credential this app ever
 * collects is a click on a button that leaves React Router. `reauthenticate`
 * is the same function `SessionExpiredBanner` (M5.4) already calls — a
 * top-level navigation to `/api/admin/login`, the one path Access actually
 * binds to, because `fetch` cannot complete the redirect chain to the
 * identity provider and a same-origin reload of `/admin` never reaches
 * Access at all (both failure modes are that route's own history).
 *
 * **This screen is cosmetics, not the gate.** `AdminLayout` sends a browser
 * here when `GET /api/admin/session` fails, but that is a convenience for a
 * legitimate visitor, not a security boundary — nothing stops a browser from
 * requesting `/admin/dashboard` directly, and nothing here needs to, because
 * every `/api/admin/*` endpoint still verifies the Access assertion
 * independently. §Q19's "gate the API, not the UI route" is unchanged by this
 * screen existing; see the amendment for the rest of that argument.
 */
export function AdminLoginPage() {
  // This screen renders *before* `AdminLayout` mounts (it sits outside that
  // component precisely so it can — see `routes.tsx`), so it needs its own
  // call rather than inheriting `AdminLayout`'s. Same reasoning: `public/_headers`
  // is the real noindex control here, this hook is defense in depth.
  useNoindex();
  return (
    <div className="admin-theme flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>crowdmon admin</CardTitle>
          <CardDescription>
            Sign in with your Cloudflare Access identity to continue.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button className="w-full" onClick={reauthenticate}>
            Sign in
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
