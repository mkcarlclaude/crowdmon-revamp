package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
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
	// Extraction is the settings in force, and therefore what gets stamped
	// onto the rows this pipeline produces (M8.4).
	Extraction frames.Config
	// Metrics may be nil, which is a worker with no metrics endpoint
	// configured rather than a mistake.
	Metrics Metrics
	Logger  *slog.Logger
}

// Work runs the job, whichever kind it is. It satisfies WorkFunc.
func (p Pipeline) Work(ctx context.Context, job *api.Job) error {
	ctx = withStoredTraceContext(ctx, job.Traceparent)

	switch job.Kind {
	case api.Download:
		return p.download(ctx, job)
	case api.Chunk:
		return p.chunk(ctx, job)
	default:
		// Terminal, not retryable: a kind this binary does not understand will
		// still be unknown on the next attempt. It means the API is ahead of
		// the worker, and a job cycling until the ceiling retires it would
		// hide that behind a generic "exhausted its attempts".
		return Terminal(fmt.Errorf("this worker does not know how to run a %q job", job.Kind))
	}
}

// download is phase one of CONTEXT.md §Q13: fetch, measure, fan out.
func (p Pipeline) download(ctx context.Context, job *api.Job) error {
	ctx, span := tracer().Start(ctx, "job.download", trace.WithAttributes(
		attribute.Int("crowdmon.job.id", job.Id),
		attribute.String("crowdmon.video.id", job.VideoId),
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
	source, err := p.Downloader.Download(ctx, job.VideoId, job.VideoUrl)
	elapsed := time.Since(start)

	if err != nil {
		// The one classification this pipeline makes, and the reason the video
		// package draws the distinction at all: deleted, private, geo-blocked
		// and members-only videos are the poison cases M6.1 named, and a retry
		// spends the ceiling to be told the same thing three times.
		if errors.Is(err, video.ErrUnavailable) {
			err = Terminal(err)
		}
		return video.Source{}, recordErr(span, fmt.Errorf("downloading %s: %w", job.VideoId, err))
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
		"video_id", job.VideoId, "path", source.Path, "bytes", source.Bytes,
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
		"video_id", job.VideoId, "segments", result.Segments, "created", result.Created)

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
		attribute.String("crowdmon.video.id", job.VideoId),
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

	path, err := p.Store.Path(job.VideoId)
	if err != nil {
		if errors.Is(err, video.ErrNotDownloaded) {
			// Terminal, and terminal here is the point: no amount of retrying
			// puts a file on a disk that does not have it, and the reason has
			// to name the constraint rather than say "not found", because the
			// operator reading it needs to know the job ran in the wrong place.
			return recordErr(span, Terminal(fmt.Errorf(
				"the source video for %s is not on this worker: chunk jobs must run on the box that downloaded it",
				job.VideoId)))
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

	keys, err := p.upload(ctx, job.VideoId, deduped.Kept)
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
		"video_id", job.VideoId, "segment_index", job.Chunk.SegmentIndex,
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
