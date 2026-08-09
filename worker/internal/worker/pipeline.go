package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sort"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/api"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/config"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/frames"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/queue"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/video"
)

// Downloader fetches a source video. The interface is declared here, on the
// side that depends on it, so the tests can substitute one without a yt-dlp.
type Downloader interface {
	Download(ctx context.Context, videoID, url string) (video.Source, error)
}

// Prober measures a downloaded file.
type Prober interface {
	Probe(ctx context.Context, path string) (video.Metadata, error)
}

// FanOuter records what was probed and enqueues the video's chunk jobs.
type FanOuter interface {
	FanOut(ctx context.Context, jobID int, probed queue.Probed) (queue.FanOutResult, error)
}

// SourceStore is where downloaded videos live: the affinity constraint made
// into an interface (M7.4).
type SourceStore interface {
	Path(videoID string) (string, error)
	Prune() (int, error)
}

// FrameExtractor turns a segment of a source video into JPEGs on disk (M8.1).
type FrameExtractor interface {
	Extract(ctx context.Context, sourcePath string, seg frames.Segment, dir string) ([]frames.Frame, error)
}

// FrameDeduper drops the near-duplicates (M8.2).
type FrameDeduper interface {
	Dedup(extracted []frames.Frame, threshold int) (frames.DedupResult, error)
}

// FrameUploader writes the survivors to R2 (M8.3).
type FrameUploader interface {
	Upload(ctx context.Context, videoID string, kept []frames.Kept) ([]string, error)
}

// ImageReporter records the rows and the provenance behind them (M8.4).
//
// Separate from FanOuter although one *queue.Client satisfies both, because
// they belong to different job kinds: a download job never reports images and a
// chunk job never fans out, so a test for either path would otherwise have to
// stub a method it will never call.
type ImageReporter interface {
	ReportImages(ctx context.Context, jobID int, extraction queue.Extraction) error
}

// SampledImage is one frame the prelabel job will run the detector over.
//
// Carries the R2 key rather than a local path: what is on this box after a
// chunk job finished is a temp directory that has already been cleaned up, so
// a prelabel job's input is the object, not a file. Turning one into a
// readable path is the Detector implementation's problem (M11.2), which is
// where the sidecar's fetch-or-mount decision belongs.
type SampledImage struct {
	Key              string
	TimestampSeconds float64
}

// ImageSampler chooses which of a video's frames get pre-labelled.
//
// The seam M11.3 fills: bounded sampling drawn across the whole timeline
// rather than the first N, with the budget in force stamped onto what it
// produces. Declared here because the prelabel branch cannot be written
// without naming its input, and stubbed in tests until M11.3 lands — the same
// arrangement frames.Deduper's injectable hash has.
type ImageSampler interface {
	Sample(ctx context.Context, videoID string) ([]SampledImage, error)
}

// BoundedImageSampler draws a sample of a caller-named size (M12.2).
//
// A separate interface from ImageSampler rather than a widened one, and the
// distinction is not cosmetic: a prelabel job's budget belongs to the worker's
// configuration (CROWDMON_PRELABEL_SAMPLE_SIZE), while a dry-run's belongs to
// the row the API already stamped it on and hands back on the claim. Two
// callers with genuinely different authority over the same number is what two
// methods say and one method could not.
//
// *sample.Sampler satisfies both, so the two Pipeline fields below are
// ordinarily the same value — which is fine, and still leaves a test free to
// stub one without the other.
type BoundedImageSampler interface {
	SampleN(ctx context.Context, videoID string, budget int) ([]SampledImage, error)
}

// ClassPrompt is one class as the detector needs to see it: the wording, and
// the version of that wording.
//
// Version travels with the prompt rather than being looked up when the boxes
// are written, because it describes the text that actually ran. Editing a
// prompt between a detector run and its report would otherwise stamp the new
// version onto boxes the old wording produced — the two-regimes-inside-one-
// class failure migration 0003's prompt_version exists to prevent.
type ClassPrompt struct {
	Name       string
	Appearance string
	Version    string
}

// PromptSource fetches the classes a prelabel job's detector should
// currently run against — name, appearance wording, and the version stamped
// onto every prediction it produces (migration 0003's `classes` table, read
// through `GET /api/classes/active`, M11.5).
//
// This is what replaced Pipeline's old static `Prompts []ClassPrompt` field.
// That field was configuration an operator typed in by hand, and D1 already
// has its own copy — migration 0006 seeded five real rows into `classes` —
// so two copies of the same wording is exactly the drift
// `predictions.prompt_version` exists to prevent (migration 0003's own
// comment on that column): a reworded migration with an un-updated worker
// would silently stamp a version describing different text than the one
// that actually ran, and nothing in the data would catch it. Fetching
// removes the second copy entirely rather than trying to keep the two in
// sync.
//
// One method, in the same spirit as ImageSampler, Detector and
// PredictionReporter: it lets a test substitute a fixed table without a D1
// round trip. Returns queue.ClassPrompt rather than this package's own
// ClassPrompt, and that is why *queue.Client can satisfy it directly the way
// it satisfies ImageReporter and PredictionReporter (whose signatures are
// also declared purely in queue's own types): ImageSampler and Detector, by
// contrast, are declared in terms of *this* package's types (SampledImage,
// ClassPrompt) and need an adapter package (sample, detect) in between,
// because queue cannot import worker without creating the cycle worker's own
// import of queue already forbids in the other direction. The conversion
// into this package's ClassPrompt happens once, at prelabel's own call site
// (toClassPrompts, below) — the one place that actually needs the local
// type.
type PromptSource interface {
	ActiveClasses(ctx context.Context) ([]queue.ClassPrompt, error)
}

// toClassPrompts converts PromptSource's wire-shaped result into this
// package's own ClassPrompt, the type Detector.Detect and boxesByClass
// already take. A loop rather than a shared type, for PromptSource's own
// reason: queue.ClassPrompt and ClassPrompt cannot be the same type without
// queue importing worker.
func toClassPrompts(fetched []queue.ClassPrompt) []ClassPrompt {
	prompts := make([]ClassPrompt, len(fetched))
	for i, f := range fetched {
		prompts[i] = ClassPrompt{Name: f.Name, Appearance: f.Appearance, Version: f.Version}
	}
	return prompts
}

// Detector proposes boxes for the given prompts on one image.
//
// The one-method interface CONTEXT.md §12 commits to, and the whole reason
// the model is a swap rather than a commitment: production talks to an ONNX
// open-vocabulary model behind a sidecar (M11.2), tests substitute a table of
// known boxes, and no test needs a model file, an ONNX runtime or a GPU.
//
// Returns queue.Box values with Key left unset — the caller knows which image
// it asked about and fills it in, so an implementation cannot get the
// attribution wrong.
type Detector interface {
	Detect(ctx context.Context, image SampledImage, prompts []ClassPrompt) ([]queue.Box, error)
	// ModelID identifies what Detect is running, recorded on every prediction
	// so that swapping the model is visible in the data rather than inferred
	// from dates (M11.2).
	ModelID() string
}

// PredictionReporter records a prelabel job's boxes (M10.3's endpoint).
//
// Separate from ImageReporter although one *queue.Client satisfies both, for
// the reason ImageReporter is separate from FanOuter: they belong to
// different job kinds, and a test for either path would otherwise have to
// stub a method it will never call.
type PredictionReporter interface {
	ReportPredictions(ctx context.Context, jobID int, detections queue.Detections) error
}

// DryRunReporter records what a candidate prompt found (M12.2).
//
// Separate from PredictionReporter for a stronger reason than the one that
// separates PredictionReporter from ImageReporter. Those two are different job
// kinds writing comparable data; this one writes data that is deliberately
// *not* label data — a dry-run's boxes never become `predictions` rows — and
// one interface covering both would be the first step towards one call site
// covering both.
type DryRunReporter interface {
	ReportDryRun(ctx context.Context, jobID int, result queue.DryRunResult) error
}

// SnapshotFetcher fetches every image and label the current inclusion policy
// admits (M15.1's `GET /api/jobs/{id}/snapshot-source`) — the whole input to
// one snapshot build. The method name matches *queue.Client's own
// SnapshotSource so that value satisfies this interface directly, the same
// arrangement ImageReporter and PredictionReporter already have.
type SnapshotFetcher interface {
	SnapshotSource(ctx context.Context, jobID int) (queue.SnapshotSource, error)
}

// SnapshotBuilder copies the admitted images into R2 under one prefix and
// writes the manifest tying them to their labels and their train/eval split
// (M15.1, M15.2). Declared here, on the side that depends on it, so a test
// can substitute a fake with no R2 — the same pattern FrameUploader gives
// frames.Uploader.
type SnapshotBuilder interface {
	Build(ctx context.Context, prefix string, source queue.SnapshotSource) (queue.SnapshotArtifact, error)
}

// SnapshotReporter records a finished snapshot build (M15.1's `POST
// /api/jobs/{id}/snapshot`).
type SnapshotReporter interface {
	ReportSnapshot(ctx context.Context, jobID int, artifact queue.SnapshotArtifact) error
}

// Metrics is the chunk pipeline's view of telemetry.FrameMetrics: the four
// measurements M8.2 asks for.
//
// An interface rather than the concrete type so this package does not import
// telemetry, and so a nil Metrics is a legitimate configuration — see
// Pipeline.metrics.
type Metrics interface {
	RecordExtracted(ctx context.Context, n int64)
	RecordKept(ctx context.Context, n int64)
	RecordDedupRatio(ctx context.Context, ratio float64)
	RecordChunkDuration(ctx context.Context, d time.Duration)
}

// Pipeline is the work a claimed job asks for.
//
// Both phases of CONTEXT.md §Q13 now live here. A download job fetches the
// video, probes it and fans it out into 60s chunk jobs (M7). A chunk job checks
// that the video is on this box, then extracts its segment at 1fps, drops the
// near-duplicates, uploads what survives to R2 and reports the rows (M8).
type Pipeline struct {
	Store      SourceStore
	Downloader Downloader
	Prober     Prober
	Queue      FanOuter
	Extractor  FrameExtractor
	Deduper    FrameDeduper
	Uploader   FrameUploader
	Images     ImageReporter
	// The prelabel branch's three dependencies (M11.1). Sampler and Detector
	// are nil until M11.3 and M11.2 land, which prelabel treats as a
	// misconfiguration rather than a crash — see its own comment.
	Sampler     ImageSampler
	Detector    Detector
	Predictions PredictionReporter
	// Prompts fetches the active classes the detector should run against
	// (M11.5). D1 is the single source of the wording — see PromptSource's
	// own comment for why a second, worker-side copy is not an option — so
	// this is called once per prelabel job rather than cached at startup: a
	// class activated, deactivated or reworded between two jobs is visible on
	// the very next one, with no restart required.
	Prompts PromptSource
	// The dry-run branch's two extra dependencies (M12.2). It reuses Detector
	// unchanged — the whole point of M11.2's one-method interface is that the
	// caller decides what prompts go in — but samples through
	// BoundedImageSampler, because the budget comes off the job rather than
	// out of this worker's configuration.
	DryRunSampler BoundedImageSampler
	DryRuns       DryRunReporter
	// The snapshot branch's three dependencies (M15.1), nil until wired —
	// treated as a misconfiguration rather than a crash, in prelabel's and
	// dry-run's own idiom, see the branch's own comment.
	SnapshotSource   SnapshotFetcher
	SnapshotBuilder  SnapshotBuilder
	SnapshotReporter SnapshotReporter
	// Extraction is the settings in force, and therefore what gets stamped
	// onto the rows this pipeline produces (M8.4).
	Extraction frames.Config
	// Metrics may be nil, which is a worker with no metrics endpoint
	// configured rather than a mistake.
	Metrics Metrics
	Logger  *slog.Logger
	// WorkerID names this process on the job.claimed span (M9.2's join point,
	// below). It duplicates queue.Client's own workerID rather than reaching
	// into that package for it: config.Config.WorkerID is already the single
	// source both are built from, and a getter here would exist only to read
	// a private field the queue package has no other reason to expose.
	WorkerID string
}

// Work runs the job, whichever kind it is. It satisfies WorkFunc.
func (p Pipeline) Work(ctx context.Context, job *api.Job) error {
	ctx = withStoredTraceContext(ctx, job.Traceparent)

	p.recordClaimed(ctx, job)

	switch job.Kind {
	case api.JobKindDownload:
		return p.download(ctx, job)
	case api.JobKindChunk:
		return p.chunk(ctx, job)
	case api.JobKindPrelabel:
		return p.prelabel(ctx, job)
	case api.JobKindDryrun:
		return p.dryrun(ctx, job)
	case api.JobKindSnapshot:
		return p.snapshot(ctx, job)
	default:
		// Terminal, not retryable: a kind this binary does not understand will
		// still be unknown on the next attempt. It means the API is ahead of
		// the worker, and a job cycling until the ceiling retires it would
		// hide that behind a generic "exhausted its attempts".
		return Terminal(fmt.Errorf("this worker does not know how to run a %q job", job.Kind))
	}
}

// recordClaimed emits job.claimed, the join point Issue #47 and PRD §5
// criterion 6 both name as part of the single trace — until now the only
// piece of the job lifecycle that was not actually in it. The real claim,
// the `POST /api/jobs/claim` round trip, happened before this function ever
// ran, inside the worker's own polling trace: the response has to come back
// before anything knows which trace this job belongs to, so there is no
// request left to re-parent by the time withStoredTraceContext (just above,
// in Work) has adopted that trace. What this span honestly is: a marker
// dropped into the adopted context saying a claim happened and what it
// carried, not the request itself wearing a new parent. Placed before
// job.download/job.chunk opens so it reads first in the trace, the way the
// claim itself came first.
//
// No duration worth measuring, so none is faked — started and ended
// immediately, exactly as reclaim-spans.ts's job.reclaimed and job.retired
// are: this is an event, and the interesting fact is that it happened.
//
// Attributes are what an operator staring at this trace at 2am would want
// without leaving it: which worker took the job (there is only one today,
// but CONTEXT.md's affinity constraint already anticipates a second), the
// attempt number (a job.claimed on attempt 3 is a job about to be retired
// if this run also fails), and the queue wait the API computed and handed
// back on the claim response — how long the row sat pending before this
// worker picked it up, the one number here that could not be reconstructed
// from anywhere else in the trace.
func (p Pipeline) recordClaimed(ctx context.Context, job *api.Job) {
	_, span := tracer().Start(ctx, "job.claimed", trace.WithAttributes(
		attribute.String("crowdmon.worker.id", p.WorkerID),
		attribute.Int("crowdmon.job.attempts", job.Attempts),
		attribute.Int("crowdmon.job.queue_wait_seconds", job.QueueWaitSeconds),
	))
	span.End()
}

// download is phase one of CONTEXT.md §Q13: fetch, measure, fan out.
func (p Pipeline) download(ctx context.Context, job *api.Job) error {
	ctx, span := tracer().Start(ctx, "job.download", trace.WithAttributes(
		attribute.Int("crowdmon.job.id", job.Id),
		attribute.String("crowdmon.video.id", *job.VideoId),
	))
	defer span.End()

	// Downloads are what fills the disk, so downloads pay for the cleanup.
	// A worker that has stopped downloading is a worker whose disk is not
	// growing, which is why there is no separate timer for this.
	p.prune(ctx)

	source, err := p.downloadSource(ctx, job)
	if err != nil {
		return recordErr(span, err)
	}

	metadata, err := p.probe(ctx, source.Path)
	if err != nil {
		return recordErr(span, err)
	}

	if err := p.fanOut(ctx, job, source, metadata); err != nil {
		return recordErr(span, err)
	}

	return nil
}

func (p Pipeline) downloadSource(ctx context.Context, job *api.Job) (video.Source, error) {
	ctx, span := tracer().Start(ctx, "video.download")
	defer span.End()

	start := time.Now()
	source, err := p.Downloader.Download(ctx, *job.VideoId, *job.VideoUrl)
	elapsed := time.Since(start)

	if err != nil {
		// The one classification this pipeline makes, and the reason the video
		// package draws the distinction at all: deleted, private, geo-blocked
		// and members-only videos are the poison cases M6.1 named, and a retry
		// spends the ceiling to be told the same thing three times.
		if errors.Is(err, video.ErrUnavailable) {
			err = Terminal(err)
		}
		return video.Source{}, recordErr(span, fmt.Errorf("downloading %s: %w", *job.VideoId, err))
	}

	// M7.1 asks for both as attributes. The span's own duration covers the
	// wall clock, but only for a span that is exactly the download — an
	// attribute survives this function growing a second step, and it is what a
	// Tempo query can filter on.
	span.SetAttributes(
		attribute.Int64("crowdmon.download.bytes", source.Bytes),
		attribute.Int64("crowdmon.download.duration_ms", elapsed.Milliseconds()),
		// A reaped download re-runs (M7.3) and finds the file already there.
		// Without this the span looks like a suspiciously fast download rather
		// than one that never happened.
		attribute.Bool("crowdmon.download.skipped", source.Skipped),
	)

	p.log().InfoContext(ctx, "source video ready",
		"video_id", *job.VideoId, "path", source.Path, "bytes", source.Bytes,
		"download_ms", elapsed.Milliseconds())

	return source, nil
}

func (p Pipeline) probe(ctx context.Context, path string) (video.Metadata, error) {
	ctx, span := tracer().Start(ctx, "video.probe")
	defer span.End()

	metadata, err := p.Prober.Probe(ctx, path)
	if err != nil {
		return video.Metadata{}, recordErr(span, err)
	}

	span.SetAttributes(
		attribute.Int("crowdmon.video.duration_seconds", metadata.DurationSeconds),
		attribute.Int("crowdmon.video.width", metadata.Width),
		attribute.Int("crowdmon.video.height", metadata.Height),
	)

	return metadata, nil
}

func (p Pipeline) fanOut(
	ctx context.Context, job *api.Job, source video.Source, metadata video.Metadata,
) error {
	ctx, span := tracer().Start(ctx, "video.fanout")
	defer span.End()

	result, err := p.Queue.FanOut(ctx, job.Id, queue.Probed{
		DurationSeconds: metadata.DurationSeconds,
		Width:           metadata.Width,
		Height:          metadata.Height,
		Title:           source.Title,
	})
	if err != nil {
		// A contract violation — a video past the fan-out's ceiling, a probe
		// that came back as 0x0 — is the same 400 on every attempt.
		if errors.Is(err, queue.ErrRejected) {
			err = Terminal(err)
		}
		return recordErr(span, err)
	}

	span.SetAttributes(
		attribute.Int("crowdmon.fanout.segments", result.Segments),
		// Zero on a re-run, which is what M7.3 looks like from the outside.
		attribute.Int("crowdmon.fanout.created", result.Created),
	)

	p.log().InfoContext(ctx, "fanned out",
		"video_id", *job.VideoId, "segments", result.Segments, "created", result.Created)

	return nil
}

// chunk is phase two of CONTEXT.md §Q13: extract, hash, dedup, upload, record.
//
// It opens with the affinity guard (M7.4). Chunk work reads the file the
// download left on this box's disk, so a chunk job that reaches a worker
// without it cannot run — today because one worker holds every file, and
// permanently if a second worker ever exists. Checked once, up front, rather
// than discovered by ffmpeg partway through: half a chunk's frames are worse
// than none, because the rows they produce look like a complete segment.
func (p Pipeline) chunk(ctx context.Context, job *api.Job) error {
	ctx, span := tracer().Start(ctx, "job.chunk", trace.WithAttributes(
		attribute.Int("crowdmon.job.id", job.Id),
		attribute.String("crowdmon.video.id", *job.VideoId),
	))
	defer span.End()

	if job.Chunk == nil {
		// The claim handler (M3.4) already retires a chunk job whose `chunks`
		// row is missing, so this is unreachable rather than merely unlikely.
		// Terminal anyway, and stated: the alternative is extracting a segment
		// this job never defined, which would write rows under timestamps
		// belonging to some other part of the video.
		return recordErr(span, Terminal(fmt.Errorf(
			"chunk job %d arrived without a segment to work on", job.Id)))
	}

	span.SetAttributes(
		attribute.Int("crowdmon.chunk.segment_index", job.Chunk.SegmentIndex),
		attribute.Int("crowdmon.chunk.start_seconds", job.Chunk.StartSeconds),
		attribute.Int("crowdmon.chunk.end_seconds", job.Chunk.EndSeconds),
	)

	path, err := p.Store.Path(*job.VideoId)
	if err != nil {
		if errors.Is(err, video.ErrNotDownloaded) {
			// Terminal, and terminal here is the point: no amount of retrying
			// puts a file on a disk that does not have it, and the reason has
			// to name the constraint rather than say "not found", because the
			// operator reading it needs to know the job ran in the wrong place.
			return recordErr(span, Terminal(fmt.Errorf(
				"the source video for %s is not on this worker: chunk jobs must run on the box that downloaded it",
				*job.VideoId)))
		}
		return recordErr(span, err)
	}

	started := time.Now()

	// Frames go to the system temp directory, not to WorkDir beside the source
	// videos. They are small (a minute of 1fps JPEGs against a whole video),
	// they live for the length of one job, and nothing may ever read them
	// again: giving them the volume that exists specifically so source videos
	// survive a container recreate would be claiming a property they must not
	// have. Removed on every path out, including the failing ones — a chunk
	// that errors halfway is exactly the one that would otherwise leak.
	dir, err := os.MkdirTemp("", fmt.Sprintf("crowdmon-chunk-%d-", job.Id))
	if err != nil {
		return recordErr(span, fmt.Errorf("making a working directory for job %d: %w", job.Id, err))
	}
	defer func() {
		if err := os.RemoveAll(dir); err != nil {
			p.log().WarnContext(ctx, "could not clear the chunk's working directory",
				"dir", dir, "error", err)
		}
	}()

	extracted, err := p.extract(ctx, path, job.Chunk, dir)
	if err != nil {
		return recordErr(span, err)
	}

	deduped, err := p.dedup(ctx, extracted)
	if err != nil {
		return recordErr(span, err)
	}

	keys, err := p.upload(ctx, *job.VideoId, deduped.Kept)
	if err != nil {
		return recordErr(span, err)
	}

	if err := p.report(ctx, job, deduped, keys); err != nil {
		return recordErr(span, err)
	}

	elapsed := time.Since(started)

	span.SetAttributes(
		attribute.Int("crowdmon.frames.extracted", deduped.Extracted),
		attribute.Int("crowdmon.frames.kept", len(deduped.Kept)),
		attribute.Float64("crowdmon.frames.dedup_ratio", deduped.Ratio),
	)

	// The metrics M8.2 asks for. Emitted here rather than inside each step so
	// that a chunk which failed partway records nothing at all: a dedup ratio
	// from a chunk whose upload then failed describes work that was thrown
	// away, and averaged into the dashboard it is simply wrong.
	if m := p.Metrics; m != nil {
		m.RecordExtracted(ctx, int64(deduped.Extracted))
		m.RecordKept(ctx, int64(len(deduped.Kept)))
		m.RecordDedupRatio(ctx, deduped.Ratio)
		m.RecordChunkDuration(ctx, elapsed)
	}

	p.log().InfoContext(ctx, "chunk extracted",
		"video_id", *job.VideoId, "segment_index", job.Chunk.SegmentIndex,
		"extracted", deduped.Extracted, "kept", len(deduped.Kept),
		"dedup_ratio", deduped.Ratio, "duration_ms", elapsed.Milliseconds())

	return nil
}

func (p Pipeline) extract(
	ctx context.Context, sourcePath string, work *api.ChunkWork, dir string,
) ([]frames.Frame, error) {
	ctx, span := tracer().Start(ctx, "frames.extract")
	defer span.End()

	start := time.Now()
	extracted, err := p.Extractor.Extract(ctx, sourcePath, frames.Segment{
		StartSeconds: work.StartSeconds,
		EndSeconds:   work.EndSeconds,
	}, dir)
	elapsed := time.Since(start)

	if err != nil {
		return nil, recordErr(span, err)
	}

	// M8.1 asks for both. The span's duration already covers the wall clock,
	// and the attribute survives this function growing a second step — the same
	// argument the download span makes for carrying its own duration.
	span.SetAttributes(
		attribute.Int("crowdmon.frames.extracted", len(extracted)),
		attribute.Int64("crowdmon.extract.duration_ms", elapsed.Milliseconds()),
	)

	return extracted, nil
}

func (p Pipeline) dedup(ctx context.Context, extracted []frames.Frame) (frames.DedupResult, error) {
	_, span := tracer().Start(ctx, "frames.dedup")
	defer span.End()

	threshold := p.Extraction.Threshold()

	result, err := p.Deduper.Dedup(extracted, threshold)
	if err != nil {
		return frames.DedupResult{}, recordErr(span, err)
	}

	// The threshold is on the span as well as on every row it produced, for
	// two different readers: the row answers "which regime is this image
	// from" a year later, the span answers "what was this worker doing" while
	// somebody is watching a ratio move.
	span.SetAttributes(
		attribute.Int("crowdmon.dedup.threshold", threshold),
		attribute.Int("crowdmon.frames.kept", len(result.Kept)),
		attribute.Float64("crowdmon.frames.dedup_ratio", result.Ratio),
	)

	return result, nil
}

func (p Pipeline) upload(ctx context.Context, videoID string, kept []frames.Kept) ([]string, error) {
	ctx, span := tracer().Start(ctx, "frames.upload")
	defer span.End()

	keys, err := p.Uploader.Upload(ctx, videoID, kept)
	if err != nil {
		// Not terminal, and worth saying why: a failed upload is R2 or the
		// network, both of which a retry fixes, and the re-run overwrites
		// whatever the failed attempt managed to write because the keys are
		// deterministic (M8.3). There is nothing to clean up first.
		return nil, recordErr(span, err)
	}

	span.SetAttributes(attribute.Int("crowdmon.upload.objects", len(keys)))

	return keys, nil
}

// report is the last step, and the order matters: the rows are written while
// this worker still holds the lease, so a lost lease is reported as a lost
// lease rather than discovered as a chunk marked done with nothing behind it.
func (p Pipeline) report(
	ctx context.Context, job *api.Job, deduped frames.DedupResult, keys []string,
) error {
	ctx, span := tracer().Start(ctx, "images.report")
	defer span.End()

	images := make([]queue.Image, len(deduped.Kept))
	for i, kept := range deduped.Kept {
		images[i] = queue.Image{
			Key:              keys[i],
			TimestampSeconds: kept.TimestampSeconds,
			PHash:            kept.PHash.Hex(),
		}
	}

	err := p.Images.ReportImages(ctx, job.Id, queue.Extraction{
		Extracted:      deduped.Extracted,
		Kept:           len(deduped.Kept),
		DedupThreshold: p.Extraction.Threshold(),
		ConfigVersion:  p.Extraction.ConfigVersion(),
		Images:         images,
	})
	if err != nil {
		// A report the contract refuses will be refused identically on every
		// attempt, so it is retired rather than left for the reaper — the same
		// classification the fan-out's 400 gets.
		if errors.Is(err, queue.ErrRejected) {
			err = Terminal(err)
		}
		return recordErr(span, err)
	}

	span.SetAttributes(attribute.Int("crowdmon.images.rows", len(images)))

	return nil
}

// prelabel is phase three: run the detector across a sample of the video's
// frames and report the boxes (M11.1's plumbing).
//
// One job per video, not per chunk, and this is where that pays off — the
// sample is drawn across the whole timeline by p.Sampler (M11.3), which no
// chunk job could assemble because it only ever sees its own sixty seconds.
//
// Unlike chunk, this branch has no affinity constraint: its input is R2
// objects rather than a source video on local disk, so it can run on any box
// that can reach the bucket. That is a property of the job kind and not an
// accident of the implementation, which is why nothing here calls p.Store.
func (p Pipeline) prelabel(ctx context.Context, job *api.Job) error {
	ctx, span := tracer().Start(ctx, "job.prelabel", trace.WithAttributes(
		attribute.Int("crowdmon.job.id", job.Id),
		attribute.String("crowdmon.video.id", *job.VideoId),
	))
	defer span.End()

	// Retryable, not terminal, and the distinction is the whole of terminal.go's
	// argument. A worker built without a sampler, a detector or a prompt
	// source is a deployment that is wrong right now and may be right in a
	// minute, once the binary the operator meant to ship is running: burning
	// the video permanently on that would be the expensive mistake, and
	// leaving the job claimed costs one lease window.
	if p.Sampler == nil || p.Detector == nil || p.Predictions == nil || p.Prompts == nil {
		return recordErr(span, fmt.Errorf(
			"this worker has no pre-labelling configured: it cannot run the prelabel job %d", job.Id))
	}

	// Fetched fresh for this job rather than cached (PromptSource's own
	// comment on Pipeline.Prompts explains why), and any error here defaults
	// retryable per terminal.go's own rule — a GET with no lease and no body
	// has no request-shaped failure for the API to reject, so there is no
	// case here that mirrors reportPredictions' queue.ErrRejected below.
	fetched, err := p.Prompts.ActiveClasses(ctx)
	if err != nil {
		return recordErr(span, fmt.Errorf("fetching active classes for job %d: %w", job.Id, err))
	}
	prompts := toClassPrompts(fetched)

	if len(prompts) == 0 {
		// Also retryable, and for a sharper reason than the above: an empty
		// active set means nothing in `classes` is turned on yet (or a
		// migration removed the last row), not a video that cannot be
		// labelled. Reporting zero boxes instead would be worse than failing
		// — it would be indistinguishable in the data from a detector that
		// genuinely found nothing.
		return recordErr(span, fmt.Errorf(
			"no active class prompts: prelabel job %d has nothing to detect", job.Id))
	}

	sampled, err := p.sample(ctx, *job.VideoId)
	if err != nil {
		return recordErr(span, fmt.Errorf("sampling frames for %s: %w", *job.VideoId, err))
	}

	span.SetAttributes(
		attribute.Int("crowdmon.prelabel.sampled", len(sampled)),
		attribute.Int("crowdmon.prelabel.classes", len(prompts)),
	)

	// Collected up front, before a single Detect call runs, and reported
	// unconditionally alongside whatever boxes come out of the loop below
	// (M11.3). This is the budget the sample actually drew — every frame
	// Detect is about to be asked about, whether or not it ends up with a
	// box — and it is what apps/api/src/routes/jobs.ts's
	// reportPredictionsHandler stamps images.selection_reason from. Built
	// here rather than inside the loop so a job that fails partway through
	// detection (ErrObjectMissing, a lost lease) never reaches
	// ReportPredictions at all and so never stamps a sample it did not
	// finish looking at — see that handler's own comment for the full
	// argument.
	sampledKeys := make([]string, len(sampled))
	for i, image := range sampled {
		sampledKeys[i] = image.Key
	}

	boxes := make([]queue.Box, 0, len(sampled))
	for _, image := range sampled {
		found, err := p.detect(ctx, image, prompts)
		if err != nil {
			if errors.Is(err, ErrObjectMissing) {
				// Terminal, in the same spirit as the affinity guard in chunk:
				// an image row whose object is gone will be gone on every
				// subsequent poll too, so re-queueing hands the same broken
				// video out forever. Named rather than folded into a generic
				// failure, because the operator reading it needs to know the
				// dataset has a row with no bytes behind it — that is a
				// repair, not a retry.
				return recordErr(span, Terminal(fmt.Errorf(
					"prelabel job %d: the image object %s is missing from R2: %w",
					job.Id, image.Key, err)))
			}
			// Everything else defaults to retryable, per terminal.go. A
			// sidecar that is down, a timeout, a transport error: all of them
			// are worth another attempt, and none of them is the video's
			// fault.
			return recordErr(span, fmt.Errorf(
				"detecting on %s for job %d: %w", image.Key, job.Id, err))
		}

		// Attribution is filled in here rather than trusted from the Detector,
		// so an implementation cannot mislabel which image a box came from.
		for i := range found {
			found[i].Key = image.Key
		}
		boxes = append(boxes, found...)
	}

	span.SetAttributes(
		attribute.Int("crowdmon.prelabel.boxes", len(boxes)),
		// The per-image detect.* spans already carry this breakdown one image
		// at a time; this is the same fact rolled up to the job, for the
		// reader who wants "what did this video turn up" without opening
		// every child span to add it by hand. Every configured class is
		// listed even at zero — see boxesByClass's own comment on why a class
		// with nothing found must not look like a class nobody asked about.
		attribute.StringSlice("crowdmon.prelabel.boxes_by_class", boxesByClass(prompts, boxes)),
	)

	// Reported before Complete, the ordering ReportImages established: a
	// report on a lease this worker still holds is what makes the 404
	// meaningful.
	if err := p.reportPredictions(ctx, job.Id, queue.Detections{
		ModelID:     p.Detector.ModelID(),
		Boxes:       boxes,
		SampledKeys: sampledKeys,
	}); err != nil {
		if errors.Is(err, queue.ErrRejected) {
			// The contract refused it — a key or class the API could not
			// resolve, a box outside [0, 1], a batch past the per-job bound.
			// Identical on the next attempt, so it is this worker's bug and
			// retrying only burns attempts.
			return recordErr(span, Terminal(err))
		}
		return recordErr(span, err)
	}

	return nil
}

// dryrun is phase four: run one candidate wording across a small sample of a
// video's frames and report the boxes, writing nothing to the dataset (M12.2).
//
// Structurally the prelabel branch with three things removed, and each removal
// is the point rather than a simplification. There is no PromptSource call —
// the wording arrives on the job, because a dry-run is defined by text that is
// deliberately not what the class currently says, and fetching would run the
// wrong prompt. There is no `images.selection_reason` stamp — the frames this
// looked at are not a dataset decision. And the report goes to `dryruns`
// rather than `predictions`, which is what makes "a dry-run writes nothing"
// (ROADMAP.md M12.2) a property of the schema instead of a promise.
func (p Pipeline) dryrun(ctx context.Context, job *api.Job) error {
	ctx, span := tracer().Start(ctx, "job.dryrun", trace.WithAttributes(
		attribute.Int("crowdmon.job.id", job.Id),
		attribute.String("crowdmon.video.id", *job.VideoId),
	))
	defer span.End()

	if job.Dryrun == nil {
		// The claim handler retires a dryrun job with no `dryruns` row before
		// it ever reaches a worker, so this is unreachable rather than merely
		// unlikely — Terminal anyway, and for chunk's reason: the alternative
		// is running some other wording and reporting it as this one's result.
		return recordErr(span, Terminal(fmt.Errorf(
			"dry-run job %d arrived without a candidate prompt to try", job.Id)))
	}

	// Retryable, not terminal, exactly as prelabel's own configuration check
	// is: a worker built without a sampler, a detector or a dry-run reporter
	// is a deployment that is wrong right now and may be right in a minute.
	if p.DryRunSampler == nil || p.Detector == nil || p.DryRuns == nil {
		return recordErr(span, fmt.Errorf(
			"this worker has no pre-labelling configured: it cannot run the dry-run job %d", job.Id))
	}

	// One prompt, not the active set. The version is the candidate's own
	// marker rather than a class's `prompt_version`: nothing this run produces
	// is stamped onto a row, so there is no regime for a version to name — and
	// handing the detector the class's current version would attach a real tag
	// to boxes that did not come from the wording it names.
	prompts := []ClassPrompt{{
		Name:       job.Dryrun.ClassName,
		Appearance: job.Dryrun.AppearancePrompt,
		Version:    "candidate",
	}}

	sampled, err := p.sampleN(ctx, *job.VideoId, job.Dryrun.SampleSize)
	if err != nil {
		return recordErr(span, fmt.Errorf("sampling frames for %s: %w", *job.VideoId, err))
	}

	span.SetAttributes(
		attribute.Int("crowdmon.dryrun.sampled", len(sampled)),
		attribute.String("crowdmon.dryrun.class", job.Dryrun.ClassName),
	)

	sampledKeys := make([]string, len(sampled))
	for i, image := range sampled {
		sampledKeys[i] = image.Key
	}

	boxes := make([]queue.DryRunBox, 0, len(sampled))
	for _, image := range sampled {
		found, err := p.detect(ctx, image, prompts)
		if err != nil {
			if errors.Is(err, ErrObjectMissing) {
				// Terminal for prelabel's reason: an image row whose object is
				// gone will be gone on the next poll too.
				return recordErr(span, Terminal(fmt.Errorf(
					"dry-run job %d: the image object %s is missing from R2: %w",
					job.Id, image.Key, err)))
			}
			return recordErr(span, fmt.Errorf(
				"detecting on %s for job %d: %w", image.Key, job.Id, err))
		}

		// Attribution filled in here rather than trusted from the Detector,
		// the same rule prelabel follows. The class name and prompt version
		// the detector echoes back are dropped: this run has exactly one of
		// each, already on the `dryruns` row.
		for _, box := range found {
			boxes = append(boxes, queue.DryRunBox{
				Key:        image.Key,
				XMin:       box.XMin,
				YMin:       box.YMin,
				XMax:       box.XMax,
				YMax:       box.YMax,
				Confidence: box.Confidence,
			})
		}
	}

	span.SetAttributes(attribute.Int("crowdmon.dryrun.boxes", len(boxes)))

	if err := p.reportDryRun(ctx, job.Id, queue.DryRunResult{
		ModelID:     p.Detector.ModelID(),
		Boxes:       boxes,
		SampledKeys: sampledKeys,
	}); err != nil {
		if errors.Is(err, queue.ErrRejected) {
			return recordErr(span, Terminal(err))
		}
		return recordErr(span, err)
	}

	return nil
}

// snapshotKeyPrefix is where dataset snapshots live in the bucket —
// frames.KeyPrefix's sibling, matching that constant's own comment
// anticipating this: "models, dataset snapshots... are a sibling of this
// prefix rather than mixed into it."
const snapshotKeyPrefix = "snapshots"

// snapshot is phase five: package everything the current inclusion policy
// admits into one R2 artifact and record it (M15.1).
//
// Unlike every other kind, this job names no video (migration 0008) — it is
// not about one video, but the whole dataset's current qualifying rows
// across every video at once — so job.VideoId is nil here and nothing in
// this branch may dereference it, unlike download/chunk/prelabel/dryrun
// above.
func (p Pipeline) snapshot(ctx context.Context, job *api.Job) error {
	ctx, span := tracer().Start(ctx, "job.snapshot", trace.WithAttributes(
		attribute.Int("crowdmon.job.id", job.Id),
	))
	defer span.End()

	// Retryable, not terminal, in prelabel's and dry-run's own idiom: a
	// worker built without snapshot building configured is a deployment that
	// is wrong right now and may be right in a minute.
	if p.SnapshotSource == nil || p.SnapshotBuilder == nil || p.SnapshotReporter == nil {
		return recordErr(span, fmt.Errorf(
			"this worker has no snapshot building configured: it cannot run the snapshot job %d",
			job.Id))
	}

	source, err := p.fetchSnapshotSource(ctx, job.Id)
	if err != nil {
		return recordErr(span, fmt.Errorf("fetching the snapshot source for job %d: %w", job.Id, err))
	}

	span.SetAttributes(attribute.Int("crowdmon.snapshot.images", len(source.Images)))

	// One prefix per job, not per snapshot row: the row does not exist yet
	// when the build starts, and the job id is already a stable, unique
	// handle this worker holds without a second round trip (migration 0003's
	// own comment on `snapshots.r2_key`: "expected to embed this row's own id
	// or a timestamp" — the job id serves the same purpose).
	prefix := fmt.Sprintf("%s/job-%d", snapshotKeyPrefix, job.Id)

	artifact, err := p.buildSnapshot(ctx, prefix, source)
	if err != nil {
		return recordErr(span, fmt.Errorf("building snapshot job %d: %w", job.Id, err))
	}

	span.SetAttributes(
		attribute.String("crowdmon.snapshot.r2_key", artifact.R2Key),
		attribute.Int("crowdmon.snapshot.image_count", artifact.ImageCount),
		attribute.Int("crowdmon.snapshot.label_count", artifact.LabelCount),
	)

	// Reported before Complete, the ordering every other report in this file
	// uses: reporting on a lease this worker still holds is what makes the
	// 404 meaningful.
	if err := p.reportSnapshot(ctx, job.Id, artifact); err != nil {
		if errors.Is(err, queue.ErrRejected) {
			return recordErr(span, Terminal(err))
		}
		return recordErr(span, err)
	}

	return nil
}

// fetchSnapshotSource reads the current inclusion policy's whole admitted
// set inside its own span — snapshot.fetch, not job.snapshot.fetch: the same
// flat naming sample.select and dryrun.select already use, so a Tempo query
// for one step is not nested inside a name naming the whole job.
func (p Pipeline) fetchSnapshotSource(ctx context.Context, jobID int) (queue.SnapshotSource, error) {
	ctx, span := tracer().Start(ctx, "snapshot.fetch")
	defer span.End()

	source, err := p.SnapshotSource.SnapshotSource(ctx, jobID)
	if err != nil {
		return queue.SnapshotSource{}, recordErr(span, err)
	}

	span.SetAttributes(attribute.Int("crowdmon.snapshot.images", len(source.Images)))
	return source, nil
}

// buildSnapshot copies the admitted images and writes the manifest inside
// its own span.
func (p Pipeline) buildSnapshot(
	ctx context.Context, prefix string, source queue.SnapshotSource,
) (queue.SnapshotArtifact, error) {
	ctx, span := tracer().Start(ctx, "snapshot.build", trace.WithAttributes(
		attribute.String("crowdmon.snapshot.prefix", prefix),
	))
	defer span.End()

	artifact, err := p.SnapshotBuilder.Build(ctx, prefix, source)
	if err != nil {
		return queue.SnapshotArtifact{}, recordErr(span, err)
	}

	span.SetAttributes(
		attribute.Int("crowdmon.snapshot.image_count", artifact.ImageCount),
		attribute.Int("crowdmon.snapshot.label_count", artifact.LabelCount),
	)
	return artifact, nil
}

// reportSnapshot writes the `snapshots` row inside its own span.
// snapshot.report, not job.snapshot.report, matching predictions.report and
// dryrun.report's own flat naming.
func (p Pipeline) reportSnapshot(ctx context.Context, jobID int, artifact queue.SnapshotArtifact) error {
	ctx, span := tracer().Start(ctx, "snapshot.report", trace.WithAttributes(
		attribute.String("crowdmon.snapshot.r2_key", artifact.R2Key),
	))
	defer span.End()

	if err := p.SnapshotReporter.ReportSnapshot(ctx, jobID, artifact); err != nil {
		return recordErr(span, err)
	}

	return nil
}

// sampleN is sample's bounded twin, in its own span for the same reason.
// dryrun.select, not sample.select: a Tempo query for one job kind's sampling
// must not also return the other's, the same argument predictions.report makes
// for not being called images.report.
func (p Pipeline) sampleN(ctx context.Context, videoID string, budget int) ([]SampledImage, error) {
	ctx, span := tracer().Start(ctx, "dryrun.select", trace.WithAttributes(
		attribute.Int("crowdmon.dryrun.budget", budget),
	))
	defer span.End()

	sampled, err := p.DryRunSampler.SampleN(ctx, videoID, budget)
	if err != nil {
		return nil, recordErr(span, err)
	}

	span.SetAttributes(attribute.Int("crowdmon.sample.selected", len(sampled)))
	return sampled, nil
}

// reportDryRun writes the candidate's boxes inside its own span. dryrun.report,
// not predictions.report: the two write to different tables with deliberately
// different meanings, and one span name would make a Tempo query for either
// ambiguous about which it found.
func (p Pipeline) reportDryRun(ctx context.Context, jobID int, result queue.DryRunResult) error {
	ctx, span := tracer().Start(ctx, "dryrun.report", trace.WithAttributes(
		attribute.String("crowdmon.dryrun.model_id", result.ModelID),
	))
	defer span.End()

	if err := p.DryRuns.ReportDryRun(ctx, jobID, result); err != nil {
		return recordErr(span, err)
	}

	span.SetAttributes(
		attribute.Int("crowdmon.dryrun.boxes", len(result.Boxes)),
		attribute.Int("crowdmon.dryrun.sampled", len(result.SampledKeys)),
	)
	return nil
}

// sample draws the job's bounded, timeline-spread frame set (M11.3) inside
// its own span — the first of the three the prelabel branch needed to become
// the "middle worth naming" CONTEXT.md §9.3 asked for and never got until
// this one landed. Mirrors extract/dedup/upload/report's shape in the chunk
// branch above: one collaborator call, one span, attributes set only on the
// success path so a failed call leaves nothing half-true on the span.
func (p Pipeline) sample(ctx context.Context, videoID string) ([]SampledImage, error) {
	ctx, span := tracer().Start(ctx, "sample.select")
	defer span.End()

	sampled, err := p.Sampler.Sample(ctx, videoID)
	if err != nil {
		return nil, recordErr(span, err)
	}

	span.SetAttributes(attribute.Int("crowdmon.sample.selected", len(sampled)))
	return sampled, nil
}

// detect runs one image through the configured prompts inside its own span —
// the second of the three, and the one the prelabel loop opens up to a couple
// hundred times per job (M11.3's budget). That volume is the point, not a
// cost to apologise for: CONTEXT.md §9.4 is the sampling-posture argument for
// why a span this rare and this specific must not be thinned by a ratio
// sampler aimed at trimming somebody else's noise.
//
// image.detect, not job.prelabel.detect or detect.image: singular "image"
// distinguishes a call scoped to the one frame Detect just ran on from
// images.report's plural, which reports the whole set chunk work produced —
// the same singular/plural split that already separates SampledImage (one)
// from queue.Extraction.Images (many).
func (p Pipeline) detect(ctx context.Context, image SampledImage, prompts []ClassPrompt) ([]queue.Box, error) {
	ctx, span := tracer().Start(ctx, "image.detect", trace.WithAttributes(
		attribute.String("crowdmon.image.key", image.Key),
		attribute.Int("crowdmon.detect.classes", len(prompts)),
	))
	defer span.End()

	found, err := p.Detector.Detect(ctx, image, prompts)
	if err != nil {
		return nil, recordErr(span, err)
	}

	span.SetAttributes(
		attribute.Int("crowdmon.detect.boxes", len(found)),
		attribute.StringSlice("crowdmon.detect.boxes_by_class", boxesByClass(prompts, found)),
	)
	return found, nil
}

// reportPredictions writes a prelabel job's boxes inside its own span — the
// third of the three, and the one that turns a detector run into a durable
// row. predictions.report, not images.report: a different job kind reports
// through PredictionReporter for the same reason it is a separate interface
// from ImageReporter (that interface's own doc comment), and two spans
// sharing one name would make a Tempo query for either ambiguous about which
// job kind it was looking at.
func (p Pipeline) reportPredictions(ctx context.Context, jobID int, detections queue.Detections) error {
	ctx, span := tracer().Start(ctx, "predictions.report", trace.WithAttributes(
		attribute.String("crowdmon.predictions.model_id", detections.ModelID),
	))
	defer span.End()

	if err := p.Predictions.ReportPredictions(ctx, jobID, detections); err != nil {
		return recordErr(span, err)
	}

	span.SetAttributes(
		attribute.Int("crowdmon.predictions.boxes", len(detections.Boxes)),
		attribute.Int("crowdmon.predictions.sampled", len(detections.SampledKeys)),
	)
	return nil
}

// boxesByClass counts found's boxes against every one of prompts, not merely
// the classes that produced one. A class prompt ran and matched nothing is a
// real result — the same "a detector finding nothing is a real outcome" rule
// prelabel's own doc comment already states for a whole image — and folding
// it into absence would make "this class was never checked" indistinguishable
// from "this class was checked and the answer was none," which is exactly the
// distinction an operator staring at a span needs the most.
//
// A []string of "name=count" pairs rather than two parallel slices: OTel span
// attributes have no map type, and a pair of same-length arrays keyed by
// index is a footgun the moment either one is edited without the other — this
// keeps each fact self-contained. Sorted by name so two spans over the same
// prompt set render identically regardless of the fetched slice's iteration
// order (which, since M11.5, is the API's `ORDER BY name` — stable, but not
// a guarantee this function should have to trust).
func boxesByClass(prompts []ClassPrompt, found []queue.Box) []string {
	counts := make(map[string]int, len(prompts))
	for _, prompt := range prompts {
		counts[prompt.Name] = 0
	}
	for _, box := range found {
		counts[box.ClassName]++
	}

	names := make([]string, 0, len(counts))
	for name := range counts {
		names = append(names, name)
	}
	sort.Strings(names)

	out := make([]string, len(names))
	for i, name := range names {
		out[i] = fmt.Sprintf("%s=%d", name, counts[name])
	}
	return out
}

// prune clears expired source videos, and never fails the job it runs inside.
// A full disk is what this prevents; a directory it could not read is a
// problem for the download that is about to fail on its own terms.
func (p Pipeline) prune(ctx context.Context) {
	removed, err := p.Store.Prune()
	if err != nil {
		p.log().WarnContext(ctx, "pruning expired source videos failed", "error", err)
		return
	}
	if removed > 0 {
		p.log().InfoContext(ctx, "pruned expired source videos", "removed", removed)
	}
}

func (p Pipeline) log() *slog.Logger {
	if p.Logger == nil {
		return slog.Default()
	}
	return p.Logger
}

// withStoredTraceContext extracts a job's stored traceparent (M9.2) into ctx,
// so the `job.download` or `job.chunk` span opened a moment later is a child
// of whichever request wrote the row — submit for a download job, the
// fan-out call for a chunk job — joining this worker's spans to the trace
// that has been running since the video was first submitted.
//
// `propagation.TraceContext`, not a hand-rolled parse: it is the propagator
// telemetry.Setup already installs as the global (for the outbound side —
// see queue.tracingTransport), and using it here rather than a second parser
// means there is exactly one place that decides what a valid `traceparent`
// looks like.
//
// A nil or malformed value is not an error and is never logged as one:
// Extract leaves ctx unchanged when the carrier's `traceparent` does not
// parse, which is precisely today's behaviour for a job with nothing stored
// at all — a fresh root span. Telemetry must never be the reason a job fails,
// so there is nothing here worth checking or reporting.
func withStoredTraceContext(ctx context.Context, traceparent *string) context.Context {
	if traceparent == nil || *traceparent == "" {
		return ctx
	}
	carrier := propagation.MapCarrier{"traceparent": *traceparent}
	return otel.GetTextMapPropagator().Extract(ctx, carrier)
}

// tracer is resolved per call rather than once at construction. The global
// provider is installed by telemetry.Setup, and a tracer captured before that
// would be the one that exports nothing.
func tracer() trace.Tracer { return otel.Tracer(config.ServiceName) }

// recordErr marks the span failed and returns the error unchanged, so the
// call sites stay `return recordErr(span, err)` rather than three lines that
// can forget one.
func recordErr(span trace.Span, err error) error {
	span.RecordError(err)
	span.SetStatus(codes.Error, err.Error())
	return err
}
