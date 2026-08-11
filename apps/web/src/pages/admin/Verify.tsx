import { LabellingSession } from "../../components/LabellingSession";

/**
 * `/admin/verify` (M16): the deleted `Admin.tsx`'s "Verify" section,
 * `LabellingSession` mounted exactly as it was there — full width now, since
 * a frame grid and its staging rulings are the one section on the old page
 * that benefited most from the `max-w-5xl` it used to be boxed into.
 */
export function AdminVerifyPage() {
  return <LabellingSession />;
}
