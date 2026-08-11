import type { DryRunRow } from "@crowdmon/api/schemas";
import { useId, useState } from "react";
import { useCreateDryRun, useDryRuns, useVideos } from "../api/queries";
import { Button } from "./ui/button";

/**
 * Trying a candidate wording before it counts (M12.2).
 *
 * Sits inside a class's card and reads the wording out of that card's
 * textarea, unsaved — which is the whole ordering the milestone exists for: a
 * prompt gets looked at against real frames *before* anybody saves it, and
 * long before the class is activated. Nothing here writes to the class, and
 * nothing the detector returns becomes label data.
 *
 * The result is rendered as frames with boxes drawn over them rather than as
 * numbers, because the question a dry-run answers is not "how many" — it is
 * "is it finding the right thing", and a confidence column cannot answer that.
 *
 * Restyled onto shadcn/ui primitives in M16, except the video picker, which
 * stays a native `<select>`: shadcn's `Select` is a Radix listbox rather than
 * a form control, so `DryRunPanel.test.tsx`'s
 * `userEvent.selectOptions(...)` — the standard way to drive a native
 * `<select>` — would have needed rewriting to click-and-role-option
 * interactions for no behavioural gain, only styling. Restyled to the new
 * token classes instead.
 */
export function DryRunPanel({ classId, prompt }: { classId: number; prompt: string }) {
  const videoId = useId();
  const [video, setVideo] = useState("");
  const videos = useVideos();
  const dryRuns = useDryRuns(classId);
  const start = useCreateDryRun(classId);

  const newest = dryRuns.data?.dryruns[0];
  const running = newest?.status === "pending" || newest?.status === "claimed";
  // A video with no frames cannot be sampled, and the API refuses it. Saying so
  // here means the refusal is visible before the click rather than after it.
  const chosen = videos.data?.videos.find((candidate) => candidate.id === video);
  const runnable = Boolean(prompt.trim()) && Boolean(chosen?.image_count) && !running;

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={videoId} className="text-xs text-muted-foreground">
            Try this wording against
          </label>
          <select
            id={videoId}
            value={video}
            onChange={(event) => setVideo(event.target.value)}
            className="h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <option value="">Pick a video…</option>
            {videos.data?.videos.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.title ?? candidate.id} — {candidate.image_count} frames
              </option>
            ))}
          </select>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!runnable || start.isPending}
          onClick={() => start.mutate({ video_id: video, appearance_prompt: prompt.trim() })}
        >
          {start.isPending ? "Queueing…" : "Dry-run"}
        </Button>
        {chosen?.image_count === 0 && (
          <span className="text-xs text-muted-foreground">
            No frames extracted from that video yet.
          </span>
        )}
      </div>

      {start.isError && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {start.error.message}
        </p>
      )}

      {newest && <DryRunResult run={newest} />}
    </div>
  );
}

function DryRunResult({ run }: { run: DryRunRow }) {
  if (run.status === "failed") {
    return (
      <p role="alert" className="mt-3 text-sm text-destructive">
        The dry-run failed: {run.failure_reason ?? "no reason recorded"}
      </p>
    );
  }

  // `boxes === null` is "the worker has not reported", which is a different
  // fact from an empty array — see the `DryRun` schema's own comment. Rendering
  // them the same way would show "found nothing" for a run still in progress.
  if (run.boxes === null) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        Running against {run.sample_size} frames — {run.status}.
      </p>
    );
  }

  const sampled = run.sampled_keys ?? [];
  const byFrame = new Map<string, DryRunRow["boxes"] & object>();
  for (const box of run.boxes) {
    byFrame.set(box.r2_key, [...(byFrame.get(box.r2_key) ?? []), box]);
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      <p className="text-sm">
        <span className="font-mono">{run.boxes.length}</span> boxes on{" "}
        <span className="font-mono">{byFrame.size}</span> of{" "}
        <span className="font-mono">{sampled.length}</span> frames.{" "}
        <span className="text-muted-foreground">“{run.appearance_prompt}”</span>
      </p>

      {byFrame.size === 0 ? (
        // Stated rather than left as an empty grid: a candidate that grounds
        // on nothing is the most useful thing a dry-run can tell you, and it
        // must not look like the page failed to load.
        <p className="text-sm text-muted-foreground">
          This wording matched nothing on any sampled frame.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {[...byFrame.entries()].map(([key, boxes]) => (
            <FrameWithBoxes key={key} r2Key={key} boxes={boxes} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One frame with its boxes drawn over it.
 *
 * Coordinates are normalized to [0, 1] (migration 0003), so they become
 * percentages directly — no image dimensions are needed, which is exactly why
 * the schema stores them that way. The overlay is positioned against the
 * image's own box, so it stays correct at any rendered size.
 */
function FrameWithBoxes({
  r2Key,
  boxes,
}: {
  r2Key: string;
  boxes: NonNullable<DryRunRow["boxes"]>;
}) {
  return (
    <figure className="relative overflow-hidden rounded-md border border-border">
      <img
        src={`/api/admin/image?key=${encodeURIComponent(r2Key)}`}
        alt={r2Key}
        className="block w-full"
      />
      {boxes.map((box) => (
        <span
          key={`${box.x_min},${box.y_min},${box.x_max},${box.y_max}`}
          className="absolute border-2 border-[var(--color-claimed)]"
          style={{
            left: `${box.x_min * 100}%`,
            top: `${box.y_min * 100}%`,
            width: `${(box.x_max - box.x_min) * 100}%`,
            height: `${(box.y_max - box.y_min) * 100}%`,
          }}
          // The confidence is on the box rather than in a legend: a grid of
          // frames is read by glancing, and a number somewhere else is a
          // number nobody connects to the rectangle it belongs to.
          title={`confidence ${box.confidence.toFixed(2)}`}
        />
      ))}
    </figure>
  );
}
