package worker_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/api"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/frames"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/queue"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/video"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/worker"
)

// strPtr builds a *string for api.Job.VideoId and VideoUrl, both nullable
// since M15.1 (a snapshot job carries neither — see snapshot_test.go). Every
// fixture in this package that is not testing that case still needs one, so
// this is shared across the package's test files rather than repeated in
// each.
func strPtr(s string) *string { return &s }

// The download path's collaborators, at the seam the pipeline depends on.
// yt-dlp, ffprobe and the API each have their own tests against the real
// thing; what is under test here is the order, the classification, and what
// the fan-out is told.

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

// The chunk path's four collaborators. ffmpeg, the hash, R2 and the API each
// have their own tests against the real thing; what is under test here is the
// order, what each step is handed, and what survives a failure partway.

type fakeExtractor struct {
	frames []frames.Frame
	err    error
	source string
	seg    frames.Segment
	dir    string
	calls  int
}

func (e *fakeExtractor) Extract(
	_ context.Context, sourcePath string, seg frames.Segment, dir string,
) ([]frames.Frame, error) {
	e.calls++
	e.source, e.seg, e.dir = sourcePath, seg, dir
	return e.frames, e.err
}

type fakeDeduper struct {
	result    frames.DedupResult
	err       error
	threshold int
	got       []frames.Frame
	calls     int
}

func (d *fakeDeduper) Dedup(extracted []frames.Frame, threshold int) (frames.DedupResult, error) {
	d.calls++
	d.got, d.threshold = extracted, threshold
	return d.result, d.err
}

type fakeUploader struct {
	keys    []string
	err     error
	videoID string
	kept    []frames.Kept
	calls   int
}

func (u *fakeUploader) Upload(_ context.Context, videoID string, kept []frames.Kept) ([]string, error) {
	u.calls++
	u.videoID, u.kept = videoID, kept
	return u.keys, u.err
}

type fakeReporter struct {
	err   error
	jobID int
	sent  queue.Extraction
	calls int
}

func (r *fakeReporter) ReportImages(_ context.Context, jobID int, e queue.Extraction) error {
	r.calls++
	r.jobID, r.sent = jobID, e
	return r.err
}

type fakeMetrics struct {
	extracted int64
	kept      int64
	ratio     float64
	duration  time.Duration
	calls     int
}

func (m *fakeMetrics) RecordExtracted(_ context.Context, n int64) { m.calls++; m.extracted = n }
func (m *fakeMetrics) RecordKept(_ context.Context, n int64)      { m.calls++; m.kept = n }
func (m *fakeMetrics) RecordDedupRatio(_ context.Context, r float64) {
	m.calls++
	m.ratio = r
}

func (m *fakeMetrics) RecordChunkDuration(_ context.Context, d time.Duration) {
	m.calls++
	m.duration = d
}

func aChunkJob() *api.Job {
	return &api.Job{
		Id:       9,
		Kind:     api.JobKindChunk,
		VideoId:  strPtr("dQw4w9WgXcQ"),
		VideoUrl: strPtr("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
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
		Extractor:  &fakeExtractor{frames: extractedFrames()},
		Deduper:    &fakeDeduper{result: dedupedFrames()},
		Uploader:   &fakeUploader{keys: uploadedKeys()},
		Images:     &fakeReporter{},
		Extraction: frames.Config{DedupThreshold: 8},
		Metrics:    &fakeMetrics{},
		Logger:     quietLogger(),
	}, downloader, prober, fanOut
}

// The chunk fixtures. aChunkJob covers seconds 120-180, so the timestamps here
// are offsets into the source video rather than into the segment — the
// distinction the R2 key and the image row are both built on.

func extractedFrames() []frames.Frame {
	return []frames.Frame{
		{Path: "/tmp/x/000001.jpg", TimestampSeconds: 120},
		{Path: "/tmp/x/000002.jpg", TimestampSeconds: 121},
		{Path: "/tmp/x/000003.jpg", TimestampSeconds: 122},
		{Path: "/tmp/x/000004.jpg", TimestampSeconds: 123},
	}
}

func dedupedFrames() frames.DedupResult {
	return frames.DedupResult{
		Kept: []frames.Kept{
			{Frame: frames.Frame{Path: "/tmp/x/000001.jpg", TimestampSeconds: 120}, PHash: 0xaf3c9e1b2d4f7a80},
			{Frame: frames.Frame{Path: "/tmp/x/000004.jpg", TimestampSeconds: 123}, PHash: 0x00ff00ff00ff00ff},
		},
		Extracted: 4,
		Ratio:     0.5,
	}
}

func uploadedKeys() []string {
	return []string{
		frames.Key("dQw4w9WgXcQ", 120),
		frames.Key("dQw4w9WgXcQ", 123),
	}
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

	// A chunk job neither downloads nor fans out. What M7 owes it is the
	// guarantee that the file is there; the rest is M8's.
	if downloader.calls != 0 || fanOut.calls != 0 {
		t.Errorf("a chunk job downloaded %d times and fanned out %d times, want neither",
			downloader.calls, fanOut.calls)
	}
}

func TestChunkJobExtractsOnlyItsOwnSegmentFromTheLocalFile(t *testing.T) {
	pipeline, _, _, _ := workingPipeline()
	extractor := pipeline.Extractor.(*fakeExtractor)

	if err := pipeline.Work(t.Context(), aChunkJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}

	// The file the store found, not the URL: the same argument the download
	// path's probe makes.
	if extractor.source != "/videos/dQw4w9WgXcQ.mp4" {
		t.Errorf("extracted from %q, want the file on this box", extractor.source)
	}
	// Exactly this chunk's window. A segment extracted wider would produce
	// frames another chunk job is also producing, at the same deterministic
	// keys, under two different lease holders.
	if want := (frames.Segment{StartSeconds: 120, EndSeconds: 180}); extractor.seg != want {
		t.Errorf("extracted %+v, want %+v", extractor.seg, want)
	}
}

func TestChunkJobClearsItsWorkingDirectory(t *testing.T) {
	pipeline, _, _, _ := workingPipeline()
	extractor := pipeline.Extractor.(*fakeExtractor)

	if err := pipeline.Work(t.Context(), aChunkJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}

	// The frames are worthless once they are in R2, and a worker that leaked
	// one directory per chunk would fill the disk the *source videos* need —
	// which fails as a download failure, several jobs away from the cause.
	if _, err := os.Stat(extractor.dir); !os.IsNotExist(err) {
		t.Errorf("working directory %s still exists after the job (stat error %v)", extractor.dir, err)
	}
}

func TestChunkJobDedupsAtTheConfiguredThreshold(t *testing.T) {
	pipeline, _, _, _ := workingPipeline()
	deduper := pipeline.Deduper.(*fakeDeduper)

	if err := pipeline.Work(t.Context(), aChunkJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}

	// The configured 8, not frames.DefaultDedupThreshold. A pipeline that
	// quietly deduplicated at the default while reporting the configured
	// number would stamp every row with a threshold that did not produce it —
	// the exact provenance lie M8.4 exists to prevent.
	if deduper.threshold != 8 {
		t.Errorf("deduplicated at threshold %d, want the configured 8", deduper.threshold)
	}
	if len(deduper.got) != 4 {
		t.Errorf("deduplicated %d frames, want the 4 that were extracted", len(deduper.got))
	}
}

func TestChunkJobUploadsOnlyTheFramesItKept(t *testing.T) {
	pipeline, _, _, _ := workingPipeline()
	uploader := pipeline.Uploader.(*fakeUploader)

	if err := pipeline.Work(t.Context(), aChunkJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}

	if uploader.videoID != "dQw4w9WgXcQ" {
		t.Errorf("uploaded under video %q, want the job's", uploader.videoID)
	}
	// Two of four. Uploading the dropped frames would put the near-duplicates
	// in the bucket with no row pointing at them — storage nothing will ever
	// read and nothing will ever clean up.
	if len(uploader.kept) != 2 {
		t.Errorf("uploaded %d frames, want the 2 that survived dedup", len(uploader.kept))
	}
}

func TestChunkJobReportsRowsCarryingTheThresholdThatProducedThem(t *testing.T) {
	pipeline, _, _, _ := workingPipeline()
	reporter := pipeline.Images.(*fakeReporter)

	if err := pipeline.Work(t.Context(), aChunkJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}

	if reporter.jobID != 9 {
		t.Errorf("reported against job %d, want the claimed job 9", reporter.jobID)
	}

	sent := reporter.sent
	if sent.Extracted != 4 || sent.Kept != 2 {
		t.Errorf("reported %d extracted and %d kept, want 4 and 2", sent.Extracted, sent.Kept)
	}
	// M8.4's whole point: the number in force travels with the rows it made.
	if sent.DedupThreshold != 8 {
		t.Errorf("stamped threshold %d, want the 8 that produced these rows", sent.DedupThreshold)
	}
	if !strings.Contains(sent.ConfigVersion, "threshold=8") {
		t.Errorf("config version %q does not name the threshold in force", sent.ConfigVersion)
	}

	if len(sent.Images) != 2 {
		t.Fatalf("reported %d rows, want 2", len(sent.Images))
	}
	// The key the uploader actually wrote to, paired with the frame it came
	// from. Pairing these by index is the one place the two lists could slip
	// past each other, and a slip would file every image under its neighbour's
	// timestamp.
	if sent.Images[0].Key != frames.Key("dQw4w9WgXcQ", 120) {
		t.Errorf("first row's key is %q, want the deterministic key for t=120", sent.Images[0].Key)
	}
	if sent.Images[0].TimestampSeconds != 120 {
		t.Errorf("first row is at t=%v, want 120", sent.Images[0].TimestampSeconds)
	}
	if sent.Images[0].PHash != "af3c9e1b2d4f7a80" {
		t.Errorf("first row's phash is %q, want the 16-character hex the API accepts", sent.Images[0].PHash)
	}
}

func TestChunkJobRecordsItsMetricsOnceItHasActuallyFinished(t *testing.T) {
	pipeline, _, _, _ := workingPipeline()
	metrics := pipeline.Metrics.(*fakeMetrics)

	if err := pipeline.Work(t.Context(), aChunkJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}

	if metrics.extracted != 4 || metrics.kept != 2 || metrics.ratio != 0.5 {
		t.Errorf("recorded extracted=%d kept=%d ratio=%v, want 4, 2 and 0.5",
			metrics.extracted, metrics.kept, metrics.ratio)
	}
	if metrics.duration <= 0 {
		t.Errorf("recorded a chunk duration of %v", metrics.duration)
	}
}

func TestChunkJobRecordsNoMetricsWhenTheWorkWasThrownAway(t *testing.T) {
	pipeline, _, _, _ := workingPipeline()
	pipeline.Uploader = &fakeUploader{err: errors.New("R2 said no")}
	metrics := pipeline.Metrics.(*fakeMetrics)

	if err := pipeline.Work(t.Context(), aChunkJob()); err == nil {
		t.Fatal("a chunk whose upload failed reported success")
	}

	// A dedup ratio from a chunk that then failed describes work nothing kept.
	// Averaged into the dashboard it is not merely useless, it is wrong.
	if metrics.calls != 0 {
		t.Errorf("recorded %d measurements for a chunk that failed", metrics.calls)
	}
}

func TestChunkJobRetriesAFailedUpload(t *testing.T) {
	pipeline, _, _, _ := workingPipeline()
	pipeline.Uploader = &fakeUploader{err: errors.New("connection reset")}

	err := pipeline.Work(t.Context(), aChunkJob())

	// R2 or the network, both of which a retry fixes — and the re-run
	// overwrites whatever the failed attempt managed to write, because the
	// keys are deterministic (M8.3).
	if err == nil || worker.IsTerminal(err) {
		t.Errorf("error = %v, want a non-terminal failure", err)
	}
}

func TestChunkJobIsRetiredWhenTheContractRefusesItsReport(t *testing.T) {
	pipeline, _, _, _ := workingPipeline()
	pipeline.Images = &fakeReporter{err: fmt.Errorf("reporting: %w: 400", queue.ErrRejected)}

	err := pipeline.Work(t.Context(), aChunkJob())

	// A malformed report is malformed on every attempt: a phash that is not 16
	// hex characters does not become one by being sent again, and the retries
	// would cost three downloads' worth of lease to arrive at the same 400.
	if err == nil || !worker.IsTerminal(err) {
		t.Errorf("error = %v, want a terminal failure", err)
	}
}

func TestChunkJobWithNoSegmentIsRetired(t *testing.T) {
	pipeline, _, _, _ := workingPipeline()
	job := aChunkJob()
	job.Chunk = nil

	err := pipeline.Work(t.Context(), job)

	// Unreachable in practice — the claim handler retires a chunk job whose
	// `chunks` row is missing. Terminal here anyway, because the alternative
	// is guessing at a segment and writing rows under timestamps belonging to
	// another part of the video.
	if err == nil || !worker.IsTerminal(err) {
		t.Errorf("error = %v, want a terminal failure", err)
	}
	if pipeline.Extractor.(*fakeExtractor).calls != 0 {
		t.Error("ffmpeg ran for a chunk job with no segment")
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

// M9.2: a job carrying a stored traceparent opens its span as a child of it,
// which is what joins this worker's spans onto the trace that started at
// submit — there is no HTTP call between the two for header propagation to
// ride, so the job row is the only thing carrying the context across.
//
// setStoredPropagator installs the same propagator telemetry.Setup does in
// production and restores the package default on cleanup, since the global is
// otherwise left however the previous test in this binary left it.
func setStoredPropagator(t *testing.T) {
	t.Helper()
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() { otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator()) })
}

// recordingProvider installs a tracer provider that captures every span this
// process opens for the rest of the test, and restores a fresh one on
// cleanup so later tests do not inherit these recordings.
func recordingProvider(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	spans := tracetest.NewSpanRecorder()
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spans)))
	t.Cleanup(func() { otel.SetTracerProvider(sdktrace.NewTracerProvider()) })
	return spans
}

// endedSpan finds the one recorded span with the given name. Every case below
// expects the pipeline to have opened exactly one.
func endedSpan(t *testing.T, spans *tracetest.SpanRecorder, name string) sdktrace.ReadOnlySpan {
	t.Helper()
	for _, span := range spans.Ended() {
		if span.Name() == name {
			return span
		}
	}
	t.Fatalf("no %q span recorded among %d ended spans", name, len(spans.Ended()))
	return nil
}

func TestAJobSpanContinuesItsStoredTraceparent(t *testing.T) {
	setStoredPropagator(t)
	spans := recordingProvider(t)

	pipeline, _, _, _ := workingPipeline()
	job := aJob()
	// The example from the W3C trace context spec — nothing about it is
	// specific to this worker, only its shape needs to be valid.
	traceparent := "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	job.Traceparent = &traceparent

	if err := pipeline.Work(t.Context(), job); err != nil {
		t.Fatalf("Work: %v", err)
	}

	span := endedSpan(t, spans, "job.download")
	if got := span.Parent().TraceID().String(); got != "4bf92f3577b34da6a3ce929d0e0e4736" {
		t.Errorf("job.download's parent trace id = %s, want the stored traceparent's", got)
	}
	if got := span.Parent().SpanID().String(); got != "00f067aa0ba902b7" {
		t.Errorf("job.download's parent span id = %s, want the stored traceparent's", got)
	}
	// The span's own trace id has to match too — a parent from one trace and
	// a span minted into another would not be "one trace" by any definition.
	if got := span.SpanContext().TraceID().String(); got != "4bf92f3577b34da6a3ce929d0e0e4736" {
		t.Errorf("job.download's own trace id = %s, want the same trace as the stored traceparent", got)
	}
}

func TestAMalformedTraceparentDegradesToARootSpanRatherThanFailingTheJob(t *testing.T) {
	setStoredPropagator(t)
	spans := recordingProvider(t)

	pipeline, _, _, _ := workingPipeline()
	job := aJob()
	malformed := "not-a-w3c-traceparent"
	job.Traceparent = &malformed

	// The job must still run: a value that failed to parse is a reason to
	// fall back to today's default, never a reason to fail the job — telemetry
	// is not allowed that kind of leverage over the pipeline it observes.
	if err := pipeline.Work(t.Context(), job); err != nil {
		t.Fatalf("Work: %v", err)
	}

	span := endedSpan(t, spans, "job.download")
	if span.Parent().IsValid() {
		t.Errorf("job.download has a parent %v from a malformed traceparent, want a root span", span.Parent())
	}
}

func TestAJobWithNoStoredTraceparentIsARootSpan(t *testing.T) {
	setStoredPropagator(t)
	spans := recordingProvider(t)

	pipeline, _, _, _ := workingPipeline()

	// aJob() carries no Traceparent — the state of every job from before
	// migration 0002 and every job submitted with tracing disabled.
	if err := pipeline.Work(t.Context(), aJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}

	span := endedSpan(t, spans, "job.download")
	if span.Parent().IsValid() {
		t.Errorf("job.download has a parent %v with no stored traceparent, want a root span", span.Parent())
	}
}

// M9.2: job.claimed is the join point that puts the claim itself inside the
// job's one trace. These tests are the honest version of that claim — they
// prove the span lands in the adopted trace and carries what it says it
// carries, not that it re-parents the HTTP round trip that already happened.

func TestJobClaimedCarriesTheWorkerAttemptAndQueueWait(t *testing.T) {
	spans := recordingProvider(t)

	pipeline, _, _, _ := workingPipeline()
	pipeline.WorkerID = "carls-ubuntu-1"

	job := aJob()
	job.Attempts = 2
	job.QueueWaitSeconds = 37

	if err := pipeline.Work(t.Context(), job); err != nil {
		t.Fatalf("Work: %v", err)
	}

	span := endedSpan(t, spans, "job.claimed")

	attributes := map[string]any{}
	for _, attribute := range span.Attributes() {
		attributes[string(attribute.Key)] = attribute.Value.AsInterface()
	}
	if attributes["crowdmon.worker.id"] != "carls-ubuntu-1" {
		t.Errorf("crowdmon.worker.id = %v, want carls-ubuntu-1", attributes["crowdmon.worker.id"])
	}
	if attributes["crowdmon.job.attempts"] != int64(2) {
		t.Errorf("crowdmon.job.attempts = %v, want 2", attributes["crowdmon.job.attempts"])
	}
	// The one number here that could not be reconstructed from anywhere else
	// in the trace: how long the row sat pending before this claim, computed
	// by the API from the same request that returned it (schemas.ts).
	if attributes["crowdmon.job.queue_wait_seconds"] != int64(37) {
		t.Errorf("crowdmon.job.queue_wait_seconds = %v, want 37", attributes["crowdmon.job.queue_wait_seconds"])
	}
}

func TestJobClaimedJoinsTheStoredTraceAheadOfTheWorkSpan(t *testing.T) {
	setStoredPropagator(t)
	spans := recordingProvider(t)

	pipeline, _, _, _ := workingPipeline()
	job := aJob()
	traceparent := "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	job.Traceparent = &traceparent

	if err := pipeline.Work(t.Context(), job); err != nil {
		t.Fatalf("Work: %v", err)
	}

	claimed := endedSpan(t, spans, "job.claimed")
	if got := claimed.Parent().TraceID().String(); got != "4bf92f3577b34da6a3ce929d0e0e4736" {
		t.Errorf("job.claimed's parent trace id = %s, want the stored traceparent's", got)
	}
	if got := claimed.Parent().SpanID().String(); got != "00f067aa0ba902b7" {
		t.Errorf("job.claimed's parent span id = %s, want the stored traceparent's", got)
	}

	// A sibling of job.download under the trace M9.2 adopted, not a parent of
	// it: job.claimed marks that the claim happened, it is not a wrapper
	// around the work the claim led to. Both spans share the same parent —
	// the stored traceparent's own span — rather than job.download nesting
	// inside job.claimed.
	download := endedSpan(t, spans, "job.download")
	if got := download.Parent().SpanID().String(); got != "00f067aa0ba902b7" {
		t.Errorf("job.download's parent span id = %s, want the stored traceparent's, same as job.claimed's",
			got)
	}
	if download.Parent().SpanID() == claimed.SpanContext().SpanID() {
		t.Error("job.download is parented on job.claimed rather than on the trace both were adopted into")
	}
}

func TestJobClaimedIsARootSpanWithNoStoredTraceparent(t *testing.T) {
	setStoredPropagator(t)
	spans := recordingProvider(t)

	pipeline, _, _, _ := workingPipeline()

	if err := pipeline.Work(t.Context(), aJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}

	span := endedSpan(t, spans, "job.claimed")
	if span.Parent().IsValid() {
		t.Errorf("job.claimed has a parent %v with no stored traceparent, want a root span", span.Parent())
	}
}

func TestJobClaimedIsEmittedForAChunkJobToo(t *testing.T) {
	spans := recordingProvider(t)

	pipeline, _, _, _ := workingPipeline()

	if err := pipeline.Work(t.Context(), aChunkJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}

	// The claim precedes the work regardless of which kind of job it claimed;
	// Work emits it once, ahead of the switch on job.Kind.
	endedSpan(t, spans, "job.claimed")
}
