package worker_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/api"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/queue"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/worker"
)

// The prelabel path's collaborators (M11.1). The detector is a table of known
// boxes rather than a model — CONTEXT.md §12's commitment that no test needs a
// model file, an ONNX runtime or a GPU is a property of this seam, and it is
// what these fakes exist to demonstrate as much as to enable.

type fakeSampler struct {
	images  []worker.SampledImage
	err     error
	videoID string
	calls   int
}

func (s *fakeSampler) Sample(_ context.Context, videoID string) ([]worker.SampledImage, error) {
	s.calls++
	s.videoID = videoID
	return s.images, s.err
}

// fakeDetector answers from a table keyed by R2 key: the substituted "table of
// known boxes" M11.2 requires, with an error table alongside it so the
// terminal-versus-retryable split can be exercised per image.
type fakeDetector struct {
	boxes   map[string][]queue.Box
	errs    map[string]error
	modelID string
	seen    []string
	prompts []worker.ClassPrompt
}

func (d *fakeDetector) Detect(
	_ context.Context, image worker.SampledImage, prompts []worker.ClassPrompt,
) ([]queue.Box, error) {
	d.seen = append(d.seen, image.Key)
	d.prompts = prompts
	if err, ok := d.errs[image.Key]; ok {
		return nil, err
	}
	return d.boxes[image.Key], nil
}

func (d *fakeDetector) ModelID() string {
	if d.modelID == "" {
		return "fake-detector-v1"
	}
	return d.modelID
}

type fakePredictionReporter struct {
	err   error
	jobID int
	sent  queue.Detections
	calls int
}

func (r *fakePredictionReporter) ReportPredictions(
	_ context.Context, jobID int, d queue.Detections,
) error {
	r.calls++
	r.jobID, r.sent = jobID, d
	return r.err
}

func prelabelJob() *api.Job {
	return &api.Job{Id: 7, Kind: api.Prelabel, VideoId: "dQw4w9WgXcQ"}
}

var testPrompts = []worker.ClassPrompt{
	{Name: "Paimon", Appearance: "a small white-haired flying companion", Version: "2026-08-08-a"},
}

func TestPrelabelReportsEveryBoxUnderOneModelID(t *testing.T) {
	sampler := &fakeSampler{images: []worker.SampledImage{
		{Key: "frames/dQw4w9WgXcQ/00000.000.jpg", TimestampSeconds: 0},
		{Key: "frames/dQw4w9WgXcQ/00600.000.jpg", TimestampSeconds: 600},
	}}
	detector := &fakeDetector{
		modelID: "owlvit-base-patch32.onnx",
		boxes: map[string][]queue.Box{
			// Two boxes on one frame, none on the other: a detector finding
			// nothing on an image is a real outcome and must not be an error.
			"frames/dQw4w9WgXcQ/00000.000.jpg": {
				{ClassName: "Paimon", XMax: 0.5, YMax: 0.5, Confidence: 0.9, PromptVersion: "2026-08-08-a"},
				{ClassName: "Paimon", XMax: 0.9, YMax: 0.9, Confidence: 0.4, PromptVersion: "2026-08-08-a"},
			},
		},
	}
	reporter := &fakePredictionReporter{}

	p := worker.Pipeline{
		Sampler: sampler, Detector: detector, Predictions: reporter, Prompts: testPrompts,
	}

	if err := p.Work(context.Background(), prelabelJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}

	if sampler.videoID != "dQw4w9WgXcQ" {
		t.Errorf("sampled %q, want the job's video", sampler.videoID)
	}
	if len(detector.seen) != 2 {
		t.Errorf("detector saw %d images, want both sampled ones", len(detector.seen))
	}
	if reporter.calls != 1 {
		t.Fatalf("reported %d times, want exactly one call for the whole job", reporter.calls)
	}
	if reporter.jobID != 7 {
		t.Errorf("reported against job %d, want 7", reporter.jobID)
	}
	if reporter.sent.ModelID != "owlvit-base-patch32.onnx" {
		t.Errorf("model id %q, want the detector's own", reporter.sent.ModelID)
	}
	if len(reporter.sent.Boxes) != 2 {
		t.Fatalf("reported %d boxes, want 2", len(reporter.sent.Boxes))
	}
	// Attribution is the pipeline's to fill in, not the detector's: both boxes
	// must carry the key of the image they were found on even though the fake
	// returned them with Key unset.
	for _, box := range reporter.sent.Boxes {
		if box.Key != "frames/dQw4w9WgXcQ/00000.000.jpg" {
			t.Errorf("box carries key %q, want the image it was detected on", box.Key)
		}
	}
}

func TestPrelabelPassesEveryPromptToTheDetector(t *testing.T) {
	detector := &fakeDetector{}
	p := worker.Pipeline{
		Sampler:     &fakeSampler{images: []worker.SampledImage{{Key: "frames/x/00000.000.jpg"}}},
		Detector:    detector,
		Predictions: &fakePredictionReporter{},
		Prompts:     testPrompts,
	}

	if err := p.Work(context.Background(), prelabelJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}

	if len(detector.prompts) != 1 || detector.prompts[0].Version != "2026-08-08-a" {
		t.Errorf("detector got %+v, want the configured prompt and its version", detector.prompts)
	}
}

func TestPrelabelReportsAnEmptySampleWithoutFailing(t *testing.T) {
	// A video whose sample came back empty still completes: nothing detected is
	// a real answer, and failing here would retry a video that has no more to
	// give until the attempt ceiling retired it.
	reporter := &fakePredictionReporter{}
	p := worker.Pipeline{
		Sampler:     &fakeSampler{},
		Detector:    &fakeDetector{},
		Predictions: reporter,
		Prompts:     testPrompts,
	}

	if err := p.Work(context.Background(), prelabelJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}
	if reporter.calls != 1 || len(reporter.sent.Boxes) != 0 {
		t.Errorf("reported %d times with %d boxes, want one empty report",
			reporter.calls, len(reporter.sent.Boxes))
	}
}

func TestPrelabelMissingObjectIsTerminal(t *testing.T) {
	// M11.1: an image row whose object is gone will be gone on the next poll
	// too, so re-queueing hands the same broken video out forever.
	reporter := &fakePredictionReporter{}
	p := worker.Pipeline{
		Sampler: &fakeSampler{images: []worker.SampledImage{{Key: "frames/x/00000.000.jpg"}}},
		Detector: &fakeDetector{errs: map[string]error{
			"frames/x/00000.000.jpg": fmt.Errorf("fetching: %w", worker.ErrObjectMissing),
		}},
		Predictions: reporter,
		Prompts:     testPrompts,
	}

	err := p.Work(context.Background(), prelabelJob())
	if err == nil {
		t.Fatal("Work succeeded, want a failure")
	}
	if !worker.IsTerminal(err) {
		t.Errorf("error %v is retryable, want terminal", err)
	}
	if reporter.calls != 0 {
		t.Error("reported predictions despite failing, want nothing written")
	}
}

func TestPrelabelDetectorFailureDefaultsToRetryable(t *testing.T) {
	// terminal.go's rule: the cheap mistake is the one to make by default. A
	// sidecar that is down is exactly this case.
	p := worker.Pipeline{
		Sampler: &fakeSampler{images: []worker.SampledImage{{Key: "frames/x/00000.000.jpg"}}},
		Detector: &fakeDetector{errs: map[string]error{
			"frames/x/00000.000.jpg": errors.New("connection refused"),
		}},
		Predictions: &fakePredictionReporter{},
		Prompts:     testPrompts,
	}

	err := p.Work(context.Background(), prelabelJob())
	if err == nil {
		t.Fatal("Work succeeded, want a failure")
	}
	if worker.IsTerminal(err) {
		t.Errorf("error %v is terminal, want retryable", err)
	}
}

func TestPrelabelRejectedReportIsTerminal(t *testing.T) {
	// A 400 from the contract is this worker's bug and will be identical next
	// attempt, so retrying only burns attempts against the ceiling.
	p := worker.Pipeline{
		Sampler:     &fakeSampler{images: []worker.SampledImage{{Key: "frames/x/00000.000.jpg"}}},
		Detector:    &fakeDetector{},
		Predictions: &fakePredictionReporter{err: fmt.Errorf("reporting: %w", queue.ErrRejected)},
		Prompts:     testPrompts,
	}

	err := p.Work(context.Background(), prelabelJob())
	if err == nil {
		t.Fatal("Work succeeded, want a failure")
	}
	if !worker.IsTerminal(err) {
		t.Errorf("error %v is retryable, want terminal", err)
	}
}

func TestPrelabelLostLeaseIsRetryable(t *testing.T) {
	// The reaper took it back mid-job. Nothing about the video is wrong, so
	// this must not be marked terminal.
	p := worker.Pipeline{
		Sampler:     &fakeSampler{images: []worker.SampledImage{{Key: "frames/x/00000.000.jpg"}}},
		Detector:    &fakeDetector{},
		Predictions: &fakePredictionReporter{err: fmt.Errorf("reporting: %w", queue.ErrLeaseLost)},
		Prompts:     testPrompts,
	}

	err := p.Work(context.Background(), prelabelJob())
	if err == nil {
		t.Fatal("Work succeeded, want a failure")
	}
	if worker.IsTerminal(err) {
		t.Errorf("error %v is terminal, want retryable", err)
	}
}

func TestPrelabelWithoutCollaboratorsIsRetryable(t *testing.T) {
	// A worker deployed without pre-labelling configured is wrong right now and
	// may be right in a minute. Burning the video permanently on that is the
	// expensive mistake terminal.go's default exists to avoid.
	for name, p := range map[string]worker.Pipeline{
		"no sampler":  {Detector: &fakeDetector{}, Predictions: &fakePredictionReporter{}, Prompts: testPrompts},
		"no detector": {Sampler: &fakeSampler{}, Predictions: &fakePredictionReporter{}, Prompts: testPrompts},
		"no reporter": {Sampler: &fakeSampler{}, Detector: &fakeDetector{}, Prompts: testPrompts},
		"no prompts":  {Sampler: &fakeSampler{}, Detector: &fakeDetector{}, Predictions: &fakePredictionReporter{}},
	} {
		t.Run(name, func(t *testing.T) {
			err := p.Work(context.Background(), prelabelJob())
			if err == nil {
				t.Fatal("Work succeeded, want a failure")
			}
			if worker.IsTerminal(err) {
				t.Errorf("error %v is terminal, want retryable", err)
			}
		})
	}
}

func TestUnknownJobKindIsStillTerminal(t *testing.T) {
	// The default arm of Work's switch, asserted here because adding a third
	// case is exactly when it could have been broken.
	p := worker.Pipeline{}

	err := p.Work(context.Background(), &api.Job{Id: 1, Kind: "something-else", VideoId: "v"})
	if err == nil {
		t.Fatal("Work succeeded, want a failure")
	}
	if !worker.IsTerminal(err) {
		t.Errorf("error %v is retryable, want terminal", err)
	}
}
