import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  contributeBatchKey,
  useContributeBatch,
  useSubmitContributeVerdicts,
} from "../api/queries";
import { Button } from "./ui/button";
import { VerificationCard } from "./VerificationCard";

/**
 * The contributor mount of the verification component (M20, plan §B4) — the
 * third mount `VerificationCard` was built for from the start (M13.1's own
 * comment). Structurally this is `LabellingSession` (the admin mount) over a
 * different pool: same local "which frames has this session finished with"
 * bookkeeping, same one-refresh-per-frame image-error handling, because both
 * are "walk a batch that drains" sessions and only the endpoints and the two
 * capabilities below differ.
 *
 * `allowAdjust` stays the default `true` — plan §B4's table gives a
 * contributor's ruling the same weight an admin's carries, unlike the
 * anonymous mount. `onReportMissing` is left off entirely: naming a class
 * from the roster is an authoring act, admin-only (plan §B4,
 * `admin-verdicts.ts`'s own comment on `createMissingReportHandler`), and
 * there is no public class roster this component could offer contributors
 * anyway.
 */
export function ContributeVerify() {
  const queryClient = useQueryClient();
  const batch = useContributeBatch();
  const submit = useSubmitContributeVerdicts();

  const [ruled, setRuled] = useState<ReadonlySet<number>>(new Set());
  const [done, setDone] = useState<ReadonlySet<number>>(new Set());
  const [refreshedFor, setRefreshedFor] = useState<ReadonlySet<number>>(new Set());
  const [brokenFrames, setBrokenFrames] = useState<ReadonlySet<number>>(new Set());

  const remainingFrames = (batch.data?.images ?? [])
    .filter((image) => !done.has(image.id))
    .map((image) => ({
      ...image,
      predictions: image.predictions.filter((box) => !ruled.has(box.id)),
    }))
    .filter((image) => image.predictions.length > 0);

  const frame = remainingFrames[0];

  const consumed = (batch.data?.images.length ?? 0) - remainingFrames.length;
  const stillWaiting = Math.max(0, (batch.data?.remaining ?? 0) - consumed);

  async function nextBatch() {
    await queryClient.refetchQueries({ queryKey: contributeBatchKey });
    setRuled(new Set());
    setDone(new Set());
    setRefreshedFor(new Set());
    setBrokenFrames(new Set());
  }

  if (batch.isPending) return <p className="text-sm">Loading frames…</p>;

  if (batch.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {batch.error.message}
      </p>
    );
  }

  if (!frame) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm">
          {stillWaiting > 0
            ? `Batch done. ${stillWaiting} frames still waiting.`
            : "Nothing left to verify right now — every frame has a ruling."}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={nextBatch}
        >
          {stillWaiting > 0 ? "Next batch" : "Check again"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        <span className="font-mono">{remainingFrames.length}</span> in this batch,{" "}
        <span className="font-mono">{stillWaiting}</span> in the pool · {frame.video_id} @{" "}
        {frame.timestamp_seconds}s
      </p>

      {brokenFrames.has(frame.id) && (
        <p role="alert" className="text-sm text-destructive">
          That frame's image could not be loaded, and re-requesting the batch did not fix it.
        </p>
      )}

      <VerificationCard
        key={frame.id}
        frame={frame}
        busy={submit.isPending}
        onSubmit={(verdicts) =>
          submit.mutate(
            { imageId: frame.id, verdicts },
            {
              onSuccess: () =>
                setRuled((seen) => {
                  const next = new Set(seen);
                  for (const ruling of verdicts) next.add(ruling.prediction_id);
                  return next;
                }),
            },
          )
        }
        onImageError={() => {
          if (refreshedFor.has(frame.id)) {
            setBrokenFrames((seen) => new Set(seen).add(frame.id));
            return;
          }
          setRefreshedFor((seen) => new Set(seen).add(frame.id));
          void queryClient.invalidateQueries({ queryKey: contributeBatchKey });
        }}
      />

      {submit.isError && (
        <p role="alert" className="text-sm text-destructive">
          {submit.error.message}
        </p>
      )}
    </div>
  );
}
