import type { DryRunRow } from "@crowdmon/api/schemas";
import { useId, useState } from "react";
import { useAdminVideoImages, useCreateDryRun, useDryRuns, useVideos } from "../api/queries";
import { cn } from "../lib/utils";
import { BoxOverlay, type OverlayBox } from "./BoxOverlay";
import { Button } from "./ui/button";

/**
 * Trying a candidate wording before it counts (M12.2; M17 plan §A adds the
 * single-frame mode).
 *
 * Sits inside a class's card and reads the wording out of that card's
 * textarea, unsaved — which is the whole ordering the milestone exists for: a
 * prompt gets looked at against real frames *before* anybody saves it, and
 * long before the class is activated. Nothing here writes to the class, and
 * nothing the detector returns becomes label data.
 *
 * **Two modes, not one (M17).** A dry-run used to sample `DRYRUN_SAMPLE_SIZE`
 * frames at random on every run, which meant a reworded prompt was compared
 * against a *different* fifty frames as well as different text — two
 * variables moving at once, nothing observed attributable to the wording
 * alone. "One frame, iterate" fixes the input: pick a frame once, then run
 * wordings against it repeatedly, rendered as a comparison strip so
 * improvement (or regression) is visible run over run. "Whole video, confirm"
 * is the original mode, kept deliberately — a wording tuned to nail one pose
 * and one lighting condition can still be worse across a whole video, so the
 * wide draw stays as the step before a wording is accepted. Iterate narrow,
 * confirm wide.
 *
 * **`BoxOverlay` renders every box on this screen**, in both modes — the
 * comparison strip and the wide-mode grid alike. `VerdictPreviewDialog`'s own
 * comment explains why: M18 extracted it out of `VerificationCard` precisely
 * so there is one box renderer, and writing a second here (as the pre-M17
 * version of this file did, by hand, before `BoxOverlay` existed) is exactly
 * what that extraction was for avoiding.
 *
 * Restyled onto shadcn/ui primitives in M16, except the video picker, which
 * stays a native `<select>`: shadcn's `Select` is a Radix listbox rather than
 * a form control, so `DryRunPanel.test.tsx`'s
 * `userEvent.selectOptions(...)` — the standard way to drive a native
 * `<select>` — would have needed rewriting to click-and-role-option
 * interactions for no behavioural gain, only styling.
 */

type Mode = "frame" | "video";

/** How many of a video's frames the picker grid shows at once. */
const FRAME_PICKER_SIZE = 12;

export function DryRunPanel({ classId, prompt }: { classId: number; prompt: string }) {
  const videoSelectId = useId();
  const pasteId = useId();

  const [mode, setMode] = useState<Mode>("frame");
  const [video, setVideo] = useState("");
  const [frameId, setFrameId] = useState<number | null>(null);
  // The frame picker's own pick already carries the key, so this is known the
  // instant an admin clicks a thumbnail. A pasted id does not — nothing here
  // resolves an id to a key on its own, since the only admin route for a
  // video's frames is the picker's own paginated grid — so a pasted frame
  // renders as "frame #N" until its first dry-run reports and hands back a
  // `sampled_keys[0]` to backfill this from.
  const [frameKey, setFrameKey] = useState<string | null>(null);
  const [pasteValue, setPasteValue] = useState("");

  const videos = useVideos();
  const videoImages = useAdminVideoImages(mode === "frame" ? video : "", {
    limit: FRAME_PICKER_SIZE,
    offset: 0,
  });
  const start = useCreateDryRun(classId);

  // Filtered to this frame's own attempts in frame mode — `useDryRuns`'s own
  // comment on why — and unfiltered in video mode, where "this class's most
  // recent run" is exactly the wide-mode history it always was.
  const dryRuns = useDryRuns(classId, mode === "frame" ? (frameId ?? undefined) : undefined);
  const runs = dryRuns.data?.dryruns ?? [];
  const newest = runs[0];
  const running = newest?.status === "pending" || newest?.status === "claimed";

  const chosenVideo = videos.data?.videos.find((candidate) => candidate.id === video);

  const runnable =
    Boolean(prompt.trim()) &&
    !running &&
    (mode === "frame" ? frameId !== null : Boolean(chosenVideo?.image_count));

  function selectVideo(nextVideo: string) {
    setVideo(nextVideo);
    // A frame belongs to the video it was drawn from — switching videos
    // without clearing this would let a stale `frameId` from the previous
    // video's grid be run against the newly-selected one's wording context,
    // which is confusing even though the API would still resolve it correctly
    // (an image's `video_id` is its own, not the form's).
    setFrameId(null);
    setFrameKey(null);
    setPasteValue("");
  }

  function pickFrame(id: number, r2Key: string) {
    setFrameId(id);
    setFrameKey(r2Key);
    setPasteValue("");
  }

  function usePastedFrame() {
    const id = Number(pasteValue);
    if (!Number.isInteger(id) || id <= 0) return;
    setFrameId(id);
    setFrameKey(null);
  }

  function run() {
    if (!prompt.trim()) return;
    if (mode === "frame" && frameId !== null) {
      start.mutate({ image_id: frameId, appearance_prompt: prompt.trim() });
    } else if (mode === "video" && video) {
      start.mutate({ video_id: video, appearance_prompt: prompt.trim() });
    }
  }

  return (
    <div className="mt-3 border-t border-border pt-3">
      <fieldset className="flex flex-wrap items-center gap-3">
        <legend className="sr-only">Dry-run mode</legend>
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="radio"
            name={`dryrun-mode-${classId}`}
            checked={mode === "frame"}
            onChange={() => setMode("frame")}
          />
          One frame, iterate
        </label>
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="radio"
            name={`dryrun-mode-${classId}`}
            checked={mode === "video"}
            onChange={() => setMode("video")}
          />
          Whole video, confirm
        </label>
      </fieldset>

      <div className="mt-2 flex flex-col gap-1">
        <label htmlFor={videoSelectId} className="text-xs text-muted-foreground">
          {mode === "frame" ? "Pick a frame from" : "Try this wording against"}
        </label>
        <select
          id={videoSelectId}
          value={video}
          onChange={(event) => selectVideo(event.target.value)}
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

      {mode === "frame" && video && (
        <div className="mt-2 flex flex-col gap-2">
          {videoImages.data && videoImages.data.images.length > 0 && (
            <div className="grid grid-cols-6 gap-1">
              {videoImages.data.images.map((image) => (
                <button
                  key={image.id}
                  type="button"
                  onClick={() => pickFrame(image.id, image.r2_key)}
                  aria-pressed={frameId === image.id}
                  className={cn(
                    "overflow-hidden rounded border-2",
                    frameId === image.id ? "border-[var(--color-done)]" : "border-transparent",
                  )}
                >
                  <img src={image.url} alt={image.r2_key} className="block w-full" />
                </button>
              ))}
            </div>
          )}
          {videoImages.data?.images.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No frames extracted from that video yet.
            </p>
          )}
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-1">
              <label htmlFor={pasteId} className="text-xs text-muted-foreground">
                Or paste a frame id
              </label>
              <input
                id={pasteId}
                value={pasteValue}
                onChange={(event) => setPasteValue(event.target.value)}
                className="h-8 w-24 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!pasteValue.trim()}
              onClick={usePastedFrame}
            >
              Use
            </Button>
            {frameId !== null && (
              <span className="text-xs text-muted-foreground">Frame #{frameId} selected.</span>
            )}
          </div>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!runnable || start.isPending}
          onClick={run}
        >
          {start.isPending ? "Queueing…" : "Dry-run"}
        </Button>
        {mode === "video" && chosenVideo?.image_count === 0 && (
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

      {mode === "frame" ? (
        <ComparisonStrip runs={runs} pickedFrameKey={frameKey} />
      ) : (
        newest && <WideDryRunResult run={newest} />
      )}
    </div>
  );
}

/**
 * The narrow mode's own screen: every iteration against the picked frame,
 * newest first (the order `GET .../dryruns?image_id=…` already returns them
 * in), each labelled with the wording it tried.
 */
function ComparisonStrip({
  runs,
  pickedFrameKey,
}: {
  runs: DryRunRow[];
  pickedFrameKey: string | null;
}) {
  if (runs.length === 0) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        Pick a frame above, then try a wording against it.
      </p>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      {runs.map((run) => (
        <DryRunIteration key={run.id} run={run} pickedFrameKey={pickedFrameKey} />
      ))}
    </div>
  );
}

/** One wording's attempt against the picked frame. */
function DryRunIteration({
  run,
  pickedFrameKey,
}: {
  run: DryRunRow;
  pickedFrameKey: string | null;
}) {
  // The frame this run actually reported against, falling back to the
  // picker's own pick — a run still `pending` has no `sampled_keys` yet, and
  // a picked-from-the-grid frame's key is known before any run finishes.
  // Only a *pasted* id with no completed run yet has neither, which is the
  // one case rendered as a bare placeholder below.
  const frameKey = run.sampled_keys?.[0] ?? pickedFrameKey;

  if (run.status === "failed") {
    return (
      <div className="rounded-md border border-destructive/40 p-2">
        <Wording prompt={run.appearance_prompt} />
        <p role="alert" className="mt-1 text-sm text-destructive">
          Failed: {run.failure_reason ?? "no reason recorded"}
        </p>
      </div>
    );
  }

  // `boxes === null` is "the worker has not reported", a different fact from
  // an empty array — see the `DryRun` schema's own comment. Rendering them
  // the same way would show "found nothing" for a run still in progress.
  if (run.boxes === null) {
    return (
      <div className="rounded-md border border-border p-2">
        <Wording prompt={run.appearance_prompt} />
        <p className="mt-1 text-sm text-muted-foreground">Running — {run.status}.</p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border p-2">
      <Wording prompt={run.appearance_prompt} count={run.boxes.length} />
      {run.boxes.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">Matched nothing on this frame.</p>
      ) : frameKey ? (
        <BoxOverlay
          frameUrl={`/api/admin/image?key=${encodeURIComponent(frameKey)}`}
          alt={frameKey}
          boxes={boxesFor(run.boxes)}
          className="mt-1 max-w-xs"
        />
      ) : (
        // Reachable only for a pasted id whose very first run has not
        // reported yet, so there is no `sampled_keys[0]` to build a URL from
        // and no grid pick to fall back to either.
        <p className="mt-1 text-sm text-muted-foreground">Frame not yet known.</p>
      )}
    </div>
  );
}

function Wording({ prompt, count }: { prompt: string; count?: number }) {
  return (
    <p className="text-xs text-muted-foreground">
      “{prompt}”
      {count !== undefined && (
        <>
          {" — "}
          <span className="font-mono">{count}</span> box{count === 1 ? "" : "es"}
        </>
      )}
    </p>
  );
}

function boxesFor(boxes: NonNullable<DryRunRow["boxes"]>): OverlayBox[] {
  return boxes.map((box, index) => ({
    id: index,
    box,
    label: index + 1,
    variant: "neutral",
    title: `confidence ${box.confidence.toFixed(2)}`,
  }));
}

/**
 * The wide mode's own screen (M12.2, pre-M17 behaviour, unchanged in
 * substance): every sampled frame that got a box, grouped, newest run only —
 * a confirmation pass has no "iteration" to compare, only "does this look
 * right across the video."
 */
function WideDryRunResult({ run }: { run: DryRunRow }) {
  if (run.status === "failed") {
    return (
      <p role="alert" className="mt-3 text-sm text-destructive">
        The dry-run failed: {run.failure_reason ?? "no reason recorded"}
      </p>
    );
  }

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
            <BoxOverlay
              key={key}
              frameUrl={`/api/admin/image?key=${encodeURIComponent(key)}`}
              alt={key}
              boxes={boxesFor(boxes)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
