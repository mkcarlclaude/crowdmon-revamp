package worker_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"go.opentelemetry.io/otel"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/api"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/queue"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/video"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/worker"
)

// The three collaborators, at the seam the pipeline depends on. yt-dlp,
// ffprobe and the API each have their own tests against the real thing; what
// is under test here is the order, the classification, and what the fan-out
// is told.

type fakeDownloader struct {
	source video.Source
	err    error
	calls  int
}

func (d *fakeDownloader) Download(context.Context, string, string) (video.Source, error) {
	d.calls++
	return d.source, d.err
}

type fakeProber struct {
	metadata video.Metadata
	err      error
	probed   string
}

func (p *fakeProber) Probe(_ context.Context, path string) (video.Metadata, error) {
	p.probed = path
	return p.metadata, p.err
}

type fakeFanOut struct {
	result queue.FanOutResult
	err    error
	jobID  int
	sent   queue.Probed
	calls  int
}

func (f *fakeFanOut) FanOut(_ context.Context, jobID int, probed queue.Probed) (queue.FanOutResult, error) {
	f.calls++
	f.jobID = jobID
	f.sent = probed
	return f.result, f.err
}

type fakeStore struct {
	path     string
	pathErr  error
	pruned   int
	pruneErr error
}

func (s *fakeStore) Path(string) (string, error) { return s.path, s.pathErr }

func (s *fakeStore) Prune() (int, error) {
	s.pruned++
	return 0, s.pruneErr
}

func aChunkJob() *api.Job {
	return &api.Job{
		Id:       9,
		Kind:     api.Chunk,
		VideoId:  "dQw4w9WgXcQ",
		VideoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		Attempts: 1,
		Chunk:    &api.ChunkWork{SegmentIndex: 2, StartSeconds: 120, EndSeconds: 180},
	}
}

func workingPipeline() (worker.Pipeline, *fakeDownloader, *fakeProber, *fakeFanOut) {
	downloader := &fakeDownloader{
		source: video.Source{Path: "/videos/dQw4w9WgXcQ.mp4", Title: "Paimon", Bytes: 1 << 20},
	}
	prober := &fakeProber{metadata: video.Metadata{DurationSeconds: 150, Width: 1920, Height: 1080}}
	fanOut := &fakeFanOut{result: queue.FanOutResult{Segments: 3, Created: 3}}

	return worker.Pipeline{
		Store:      &fakeStore{path: "/videos/dQw4w9WgXcQ.mp4"},
		Downloader: downloader,
		Prober:     prober,
		Queue:      fanOut,
		Logger:     quietLogger(),
	}, downloader, prober, fanOut
}

func TestDownloadJobProbesWhatItDownloadedAndFansItOut(t *testing.T) {
	pipeline, _, prober, fanOut := workingPipeline()

	if err := pipeline.Work(t.Context(), aJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}

	// Probed from the file on disk, not from the URL: the format selection
	// decides what actually landed, and the segments have to tile that.
	if prober.probed != "/videos/dQw4w9WgXcQ.mp4" {
		t.Errorf("probed %q, want the downloaded file", prober.probed)
	}

	if fanOut.jobID != 7 {
		t.Errorf("fanned out job %d, want the claimed job 7", fanOut.jobID)
	}
	want := queue.Probed{DurationSeconds: 150, Width: 1920, Height: 1080, Title: "Paimon"}
	if fanOut.sent != want {
		t.Errorf("fanned out %+v, want %+v", fanOut.sent, want)
	}
}

func TestDownloadJobPrunesBeforeItFetches(t *testing.T) {
	pipeline, _, _, _ := workingPipeline()
	store := pipeline.Store.(*fakeStore)

	if err := pipeline.Work(t.Context(), aJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}

	// The TTL has nothing else to enforce it: downloads are what fill the disk
	// the videos land on, so a download is where the expired ones go.
	if store.pruned != 1 {
		t.Errorf("pruned %d times, want 1", store.pruned)
	}
}

func TestDownloadJobSurvivesAPruneThatFailed(t *testing.T) {
	pipeline, _, _, fanOut := workingPipeline()
	pipeline.Store = &fakeStore{pruneErr: errors.New("permission denied")}

	// Housekeeping must not fail the job it is attached to: an unreadable
	// directory is a problem for the download that is about to fail on its own
	// terms, and failing here would blame the wrong thing.
	if err := pipeline.Work(t.Context(), aJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}
	if fanOut.calls != 1 {
		t.Errorf("fan-out ran %d times, want 1", fanOut.calls)
	}
}

func TestDownloadJobRetiresAVideoThatCanNeverBeDownloaded(t *testing.T) {
	pipeline, downloader, _, fanOut := workingPipeline()
	downloader.err = fmt.Errorf("dQw4w9WgXcQ: %w: Private video", video.ErrUnavailable)

	err := pipeline.Work(t.Context(), aJob())

	if err == nil {
		t.Fatal("Work succeeded on a private video")
	}
	if !worker.IsTerminal(err) {
		t.Errorf("error %v is not terminal; a private video would be retried to the ceiling", err)
	}
	// The reason reaches `failure_reason`, and "download failed" would tell an
	// operator nothing they could act on.
	if !strings.Contains(err.Error(), "Private video") {
		t.Errorf("error %q does not carry what yt-dlp said", err)
	}
	if fanOut.calls != 0 {
		t.Error("a video that never downloaded was fanned out")
	}
}

func TestDownloadJobLeavesATransientFailureRetryable(t *testing.T) {
	pipeline, downloader, _, _ := workingPipeline()
	downloader.err = errors.New("unable to download video data: timed out")

	err := pipeline.Work(t.Context(), aJob())

	if err == nil {
		t.Fatal("Work succeeded on a failed download")
	}
	if worker.IsTerminal(err) {
		t.Errorf("error %v is terminal; a timeout would burn a working video", err)
	}
}

func TestDownloadJobRetiresAFanOutTheAPIRefuses(t *testing.T) {
	pipeline, _, _, fanOut := workingPipeline()
	fanOut.err = fmt.Errorf("fanning out job 7: %w: video too long", queue.ErrRejected)

	err := pipeline.Work(t.Context(), aJob())

	// The same 400 on every attempt, each one preceded by re-downloading the
	// whole video.
	if !worker.IsTerminal(err) {
		t.Errorf("error %v is not terminal, want a rejected fan-out retired", err)
	}
}

func TestDownloadJobKeepsALostLeaseRetryable(t *testing.T) {
	pipeline, _, _, fanOut := workingPipeline()
	fanOut.err = fmt.Errorf("fanning out job 7: %w", queue.ErrLeaseLost)

	err := pipeline.Work(t.Context(), aJob())

	// The reaper already took the job back; it is pending again and somebody
	// will run it. Retiring it here would overrule that.
	if err == nil || worker.IsTerminal(err) {
		t.Errorf("error = %v, want a non-terminal failure", err)
	}
}

func TestDownloadJobDoesNotProbeWhatItCouldNotDownload(t *testing.T) {
	pipeline, downloader, prober, _ := workingPipeline()
	downloader.err = errors.New("timed out")

	_ = pipeline.Work(t.Context(), aJob())

	if prober.probed != "" {
		t.Errorf("probed %q after a failed download", prober.probed)
	}
	if downloader.calls != 1 {
		t.Errorf("downloaded %d times, want 1", downloader.calls)
	}
}

func TestChunkJobRunsWhenItsSourceIsOnThisBox(t *testing.T) {
	pipeline, downloader, _, fanOut := workingPipeline()

	if err := pipeline.Work(t.Context(), aChunkJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}

	// A chunk job neither downloads nor fans out. Extraction is M8; what M7
	// owes it is the guarantee that the file is there.
	if downloader.calls != 0 || fanOut.calls != 0 {
		t.Errorf("a chunk job downloaded %d times and fanned out %d times, want neither",
			downloader.calls, fanOut.calls)
	}
}

func TestChunkJobFailsCleanlyWhenItsSourceIsElsewhere(t *testing.T) {
	pipeline, _, _, _ := workingPipeline()
	pipeline.Store = &fakeStore{pathErr: fmt.Errorf("dQw4w9WgXcQ: %w", video.ErrNotDownloaded)}

	err := pipeline.Work(t.Context(), aChunkJob())

	if err == nil {
		t.Fatal("a chunk job ran with no source video on this box")
	}
	// Terminal: no amount of retrying puts a file on a disk that does not have
	// it. The reason has to name the constraint, because an operator reading
	// "not found" would go looking for a bug rather than for the second worker
	// that should not exist (CONTEXT.md §Q13).
	if !worker.IsTerminal(err) {
		t.Errorf("error %v is not terminal; the file will not appear on a retry", err)
	}
	if !strings.Contains(err.Error(), "must run on the box that downloaded") {
		t.Errorf("error %q does not explain the affinity constraint", err)
	}
}

func TestChunkJobRetriesAStoreItCouldNotRead(t *testing.T) {
	pipeline, _, _, _ := workingPipeline()
	pipeline.Store = &fakeStore{pathErr: errors.New("input/output error")}

	err := pipeline.Work(t.Context(), aChunkJob())

	// A disk that answered with an error is not a disk that answered "no". The
	// first is worth another attempt; only the second is the affinity failure.
	if err == nil || worker.IsTerminal(err) {
		t.Errorf("error = %v, want a non-terminal failure", err)
	}
}

func TestAnUnknownKindOfJobIsRetiredRatherThanRetried(t *testing.T) {
	pipeline, _, _, _ := workingPipeline()

	job := aJob()
	job.Kind = "transcribe"

	err := pipeline.Work(t.Context(), job)

	// It means the API is ahead of this binary. Cycling to the ceiling would
	// hide that behind "exhausted its attempts".
	if !worker.IsTerminal(err) {
		t.Errorf("error = %v, want an unknown kind retired", err)
	}
}

func TestDownloadRecordsItsSizeAndDurationOnASpan(t *testing.T) {
	spans := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spans))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() { otel.SetTracerProvider(sdktrace.NewTracerProvider()) })

	pipeline, _, _, _ := workingPipeline()
	if err := pipeline.Work(t.Context(), aJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}

	attributes := map[string]any{}
	for _, span := range spans.Ended() {
		for _, attribute := range span.Attributes() {
			attributes[string(attribute.Key)] = attribute.Value.AsInterface()
		}
	}

	// M7.1's third bullet. Named rather than left to the span's duration
	// because a Tempo query filters on attributes.
	if attributes["crowdmon.download.bytes"] != int64(1<<20) {
		t.Errorf("crowdmon.download.bytes = %v, want %d", attributes["crowdmon.download.bytes"], 1<<20)
	}
	if _, present := attributes["crowdmon.download.duration_ms"]; !present {
		t.Error("no crowdmon.download.duration_ms attribute")
	}
	if attributes["crowdmon.fanout.segments"] != int64(3) {
		t.Errorf("crowdmon.fanout.segments = %v, want 3", attributes["crowdmon.fanout.segments"])
	}
}
