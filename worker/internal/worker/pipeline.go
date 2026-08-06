package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/api"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/config"
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

// Pipeline is the work a claimed job asks for.
//
// Phase one only (M7): a download job fetches the video, probes it and fans it
// out into 60s chunk jobs. A chunk job checks that the video it names is on
// this box and stops there — extraction is M8, and this is where it lands.
type Pipeline struct {
	Store      SourceStore
	Downloader Downloader
	Prober     Prober
	Queue      FanOuter
	Logger     *slog.Logger
}

// Work runs the job, whichever kind it is. It satisfies WorkFunc.
func (p Pipeline) Work(ctx context.Context, job *api.Job) error {
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

// chunk is the affinity guard (M7.4), and for now it is the whole of a chunk
// job.
//
// Chunk work reads the file the download left on this box's disk (CONTEXT.md
// §Q13), so a chunk job that reaches a worker without it cannot run — today
// because one worker holds every file, and permanently if a second worker ever
// exists. Checked once, up front, rather than discovered by ffmpeg partway
// through: half a chunk's frames are worse than none, because the rows they
// produce look like a complete segment.
func (p Pipeline) chunk(ctx context.Context, job *api.Job) error {
	_, span := tracer().Start(ctx, "job.chunk", trace.WithAttributes(
		attribute.Int("crowdmon.job.id", job.Id),
		attribute.String("crowdmon.video.id", job.VideoId),
	))
	defer span.End()

	if job.Chunk != nil {
		span.SetAttributes(
			attribute.Int("crowdmon.chunk.segment_index", job.Chunk.SegmentIndex),
			attribute.Int("crowdmon.chunk.start_seconds", job.Chunk.StartSeconds),
			attribute.Int("crowdmon.chunk.end_seconds", job.Chunk.EndSeconds),
		)
	}

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

	// Extraction is M8.1. Said out loud in the log rather than left as a
	// silent success, so a chunk job marked `done` with no images behind it is
	// explicable while that is still true.
	p.log().InfoContext(ctx, "chunk source present; extraction lands in M8",
		"video_id", job.VideoId, "path", path)

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
