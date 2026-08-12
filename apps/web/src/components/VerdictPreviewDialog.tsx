import type { AdminVerdictRow } from "@crowdmon/api/schemas";
import { BoxOverlay, type OverlayBox } from "./BoxOverlay";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

/**
 * "What did the detector propose, and what did the admin rule" — a click on
 * a row in `/admin/annotations` (M18, plan §B).
 *
 * **The proxy path, not presigning.** `GET /api/admin/image?key=…` — the
 * same route `DryRunPanel` already points its grid at — rather than
 * `frameUrls`' signed-URL mode. `admin-images.ts`'s own module comment
 * (CONTEXT.md §Q25's amendment) draws the line at how long a caller needs its
 * URLs to stay good, not at how many it asks for: one frame opened on demand
 * from a table row is the same shape as a dry-run grid, not the couple-
 * hundred-image labelling session §Q25 was written for, and the proxy works
 * in a deployment with no R2 S3 credential configured, which presigning
 * cannot. `apps/api/src/frame-urls.ts`'s `proxyUrl()` is not imported here —
 * `@crowdmon/api`'s package export only carries `./schemas` — so this builds
 * the identical `/api/admin/image?key=${encodeURIComponent(key)}` string
 * `DryRunPanel.tsx` already does, rather than adding a second package export
 * for one string template.
 *
 * **Two boxes, visually distinct, for an `adjust`; one, for anything else.**
 * `verdict === "adjust"` draws the prediction's original box (`neutral`,
 * "Proposed") next to the verdict's corrected one (`positive`, "Adjusted") —
 * the comparison this dialog exists to show. `accept` and `reject` have only
 * one box to show, since neither carries a second one to compare against;
 * each is coloured to say what happened to it rather than reusing the
 * neutral "nothing decided" colour a fresh prediction would get.
 */

/** Renders `BoxOverlay`'s box list for one verdict row's ruling. */
function boxesFor(verdict: AdminVerdictRow): OverlayBox[] {
  const proposed: OverlayBox = {
    id: "proposed",
    box: { x_min: verdict.x_min, y_min: verdict.y_min, x_max: verdict.x_max, y_max: verdict.y_max },
    label:
      verdict.verdict === "adjust"
        ? "Proposed"
        : verdict.verdict === "accept"
          ? "Accepted"
          : "Rejected",
    variant:
      verdict.verdict === "accept"
        ? "positive"
        : verdict.verdict === "reject"
          ? "negative"
          : "neutral",
  };

  // `adjust` always carries all four adjusted coordinates in practice —
  // migration 0003's CHECK ties them to the verdict kind — but the column
  // (and so `AdminVerdict`'s own schema) allows null because `accept` and
  // `reject` rows share it, so this still guards rather than asserting.
  if (
    verdict.verdict !== "adjust" ||
    verdict.adjusted_x_min === null ||
    verdict.adjusted_y_min === null ||
    verdict.adjusted_x_max === null ||
    verdict.adjusted_y_max === null
  ) {
    return [proposed];
  }

  return [
    proposed,
    {
      id: "adjusted",
      box: {
        x_min: verdict.adjusted_x_min,
        y_min: verdict.adjusted_y_min,
        x_max: verdict.adjusted_x_max,
        y_max: verdict.adjusted_y_max,
      },
      label: "Adjusted",
      variant: "positive",
    },
  ];
}

export interface VerdictPreviewDialogProps {
  /** `null` closes the dialog — the same "no row selected" state doubles as "not open." */
  verdict: AdminVerdictRow | null;
  onOpenChange: (open: boolean) => void;
}

export function VerdictPreviewDialog({ verdict, onOpenChange }: VerdictPreviewDialogProps) {
  return (
    <Dialog open={verdict !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {verdict && (
          <>
            <DialogHeader>
              <DialogTitle>
                {verdict.class_name} · {verdict.verdict}
              </DialogTitle>
              <DialogDescription>
                {verdict.video_id} @ {verdict.timestamp_seconds}s — confidence{" "}
                {verdict.confidence.toFixed(2)}
              </DialogDescription>
            </DialogHeader>
            <BoxOverlay
              frameUrl={`/api/admin/image?key=${encodeURIComponent(verdict.r2_key)}`}
              alt={verdict.r2_key}
              boxes={boxesFor(verdict)}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
