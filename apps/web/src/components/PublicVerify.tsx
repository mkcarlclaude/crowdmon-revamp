import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { publicFrameKey, usePublicFrame, useSubmitPublicVerdicts } from "../api/queries";
import { VerificationCard } from "./VerificationCard";

/**
 * The public mount of the verification component (M14.2, M14.4).
 *
 * `VerificationCard` knows no endpoint (M13.1's own comment on the split) —
 * everything here that knows `/api/public/*` or an anonymous session id is
 * `usePublicFrame` / `useSubmitPublicVerdicts`, not this component's own
 * fetch calls. What differs from `LabellingSession`, its admin sibling, is
 * the shape of the work: an admin walks a *batch* that drains, a visitor is
 * handed one frame at a time from a small pool that never drains — there is
 * no "remaining" to show and no queue to page through, only "another frame"
 * once this one is judged.
 *
 * `allowAdjust={false}` and no `onReportMissing`: only `accept` and `reject`
 * are legal on `/api/public/*` (`PublicStagedVerdict` carries no adjusted
 * coordinates), and missing-object reporting is admin-only. Both are
 * enforced again server-side — this is the screen staying honest about what
 * a click will do, not the access control itself.
 */
export function PublicVerify() {
  const queryClient = useQueryClient();
  const frame = usePublicFrame();
  const submit = useSubmitPublicVerdicts();

  // One re-request per viewing attempt, not per frame id — unlike
  // `LabellingSession`'s `refreshedFor`, which keys the same guard by image
  // id because its batch cursor is a stable, non-repeating walk
  // (`ORDER BY i.id`). `/api/public/frame` draws with `ORDER BY RANDOM()`, so
  // a retry after a broken image almost never comes back with the same id —
  // comparing ids here would mean the guard practically never trips, and a
  // repeatedly broken pool would silently keep re-requesting instead of ever
  // saying so. Tracking "have I already spent this attempt's one retry"
  // instead of "is this the same frame as before" is correct regardless of
  // whether the backend's selection is sequential or random: `<img>`'s
  // `onError` only fires again once its `src` changes, and `src` only
  // changes on a fetch this component itself triggered — the retry above, or
  // an explicit move to another frame, both of which reset the flag.
  const [awaitingRetryResult, setAwaitingRetryResult] = useState(false);
  const [broken, setBroken] = useState(false);
  const [justSubmitted, setJustSubmitted] = useState<number | null>(null);

  async function nextFrame() {
    setAwaitingRetryResult(false);
    setBroken(false);
    await queryClient.refetchQueries({ queryKey: publicFrameKey });
  }

  if (frame.isPending) return <p className="text-sm">Loading a frame…</p>;

  if (frame.isError) {
    return (
      <p role="alert" className="text-sm text-[var(--color-failed)]">
        {frame.error.message}
      </p>
    );
  }

  const { data } = frame;

  return (
    <div className="flex flex-col gap-3">
      {broken && (
        <p role="alert" className="text-sm text-[var(--color-failed)]">
          That frame's image could not be loaded, and re-requesting it did not fix it. Try another
          frame.
        </p>
      )}

      <VerificationCard
        key={data.id}
        frame={data}
        allowAdjust={false}
        busy={submit.isPending}
        onSubmit={(verdicts) =>
          submit.mutate(
            {
              imageId: data.id,
              // `allowAdjust={false}` above keeps `VerificationCard` from ever
              // staging one, but its own `StagedVerdict` type still admits
              // `"adjust"` — the cast names the invariant this component
              // relies on rather than widening `useSubmitPublicVerdicts`'
              // signature to match a case that cannot happen here.
              verdicts: verdicts.map((ruling) => ({
                prediction_id: ruling.prediction_id,
                verdict: ruling.verdict as "accept" | "reject",
              })),
            },
            {
              onSuccess: (result) => {
                setJustSubmitted(result.verdicts);
                void nextFrame();
              },
            },
          )
        }
        onImageError={() => {
          if (awaitingRetryResult) {
            setBroken(true);
            setAwaitingRetryResult(false);
            return;
          }
          setAwaitingRetryResult(true);
          void queryClient.invalidateQueries({ queryKey: publicFrameKey });
        }}
      />

      {submit.isError && (
        <p role="alert" className="text-sm text-[var(--color-failed)]">
          {submit.error.message}
        </p>
      )}

      {/* Shown back immediately, so the page is not theatre (ROADMAP M14.4) —
          a visitor's click has to visibly do something even though nothing
          it produces ever becomes a label. */}
      {justSubmitted !== null && (
        <p className="text-sm text-[var(--color-text-muted)]">
          Thanks — recorded {justSubmitted} {justSubmitted === 1 ? "verdict" : "verdicts"}. Here's
          another frame.
        </p>
      )}

      <div>
        <button
          type="button"
          onClick={() => {
            setJustSubmitted(null);
            void nextFrame();
          }}
          className="rounded border border-[var(--color-border)] px-3 py-1 text-sm"
        >
          Skip to another frame
        </button>
      </div>
    </div>
  );
}
