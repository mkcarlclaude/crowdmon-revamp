package worker_test

import (
	"context"
	"errors"
	"testing"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/api"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/queue"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/worker"
)

// The dry-run path (M12.2). It reuses `fakeDetector` from prelabel_test.go
// unchanged, which is the point rather than a convenience: M11.2's one-method
// interface takes the prompts as an argument, so running a candidate wording
// through it needs nothing new on the detector side at all.

type fakeBoundedSampler struct {
	images  []worker.SampledImage
	err     error
	videoID string
	budget  int
	calls   int
}

func (s *fakeBoundedSampler) SampleN(
	_ context.Context, videoID string, budget int,
) ([]worker.SampledImage, error) {
	s.calls++
	s.videoID, s.budget = videoID, budget
	return s.images, s.err
}

type fakeDryRunReporter struct {
	err   error
	jobID int
	sent  queue.DryRunResult
	calls int
}

func (r *fakeDryRunReporter) ReportDryRun(
	_ context.Context, jobID int, result queue.DryRunResult,
) error {
	r.calls++
	r.jobID, r.sent = jobID, result
	return r.err
}

func dryRunJob() *api.Job {
	return &api.Job{
		Id:      11,
		Kind:    api.Dryrun,
		VideoId: "dQw4w9WgXcQ",
		Dryrun: &api.DryRunWork{
			ClassName:        "Paimon",
			AppearancePrompt: "a tiny white-haired floating companion",
			SampleSize:       50,
		},
	}
}

func TestDryRunDetectsTheCandidateWordingAndReportsIt(t *testing.T) {
	sampler := &fakeBoundedSampler{images: []worker.SampledImage{
		{Key: "frames/dQw4w9WgXcQ/00000.000.jpg"},
		{Key: "frames/dQw4w9WgXcQ/00600.000.jpg"},
	}}
	detector := &fakeDetector{
		modelID: "owlvit-base-patch32.onnx",
		boxes: map[string][]queue.Box{
			"frames/dQw4w9WgXcQ/00000.000.jpg": {
				{ClassName: "Paimon", XMax: 0.5, YMax: 0.5, Confidence: 0.41},
			},
		},
	}
	reporter := &fakeDryRunReporter{}

	p := worker.Pipeline{DryRunSampler: sampler, Detector: detector, DryRuns: reporter}

	if err := p.Work(context.Background(), dryRunJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}

	// The wording tried is the job's candidate, never the class's current
	// prompt — nothing in this branch fetches `classes` at all.
	if len(detector.prompts) != 1 ||
		detector.prompts[0].Appearance != "a tiny white-haired floating companion" {
		t.Errorf("detector got %+v, want the job's candidate wording", detector.prompts)
	}
	if reporter.calls != 1 || reporter.jobID != 11 {
		t.Fatalf("reported %d times against job %d, want one call against 11", reporter.calls, reporter.jobID)
	}
	if reporter.sent.ModelID != "owlvit-base-patch32.onnx" {
		t.Errorf("model id %q, want the detector's own", reporter.sent.ModelID)
	}
	if len(reporter.sent.Boxes) != 1 {
		t.Fatalf("reported %d boxes, want 1", len(reporter.sent.Boxes))
	}
	// Attribution is the pipeline's to fill in, as it is for a prelabel job:
	// the fake returned the box with no key.
	if reporter.sent.Boxes[0].Key != "frames/dQw4w9WgXcQ/00000.000.jpg" {
		t.Errorf("box carries key %q, want the image it was found on", reporter.sent.Boxes[0].Key)
	}
	// Every sampled frame, not only the ones with a box: without this a prompt
	// that matched nothing is indistinguishable from a run that looked at
	// nothing.
	if len(reporter.sent.SampledKeys) != 2 {
		t.Errorf("reported %d sampled keys, want both frames", len(reporter.sent.SampledKeys))
	}
}

func TestDryRunSamplesTheBudgetTheJobCarries(t *testing.T) {
	// The budget belongs to the row the API stamped it on, not to this
	// worker's environment — a worker that used its own prelabel budget would
	// disagree with the `sample_size` the dry-run will be read against.
	sampler := &fakeBoundedSampler{}
	p := worker.Pipeline{DryRunSampler: sampler, Detector: &fakeDetector{}, DryRuns: &fakeDryRunReporter{}}

	if err := p.Work(context.Background(), dryRunJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}

	if sampler.budget != 50 {
		t.Errorf("sampled a budget of %d, want the job's 50", sampler.budget)
	}
	if sampler.videoID != "dQw4w9WgXcQ" {
		t.Errorf("sampled %q, want the job's video", sampler.videoID)
	}
}

func TestDryRunReportsAnEmptyResultWithoutFailing(t *testing.T) {
	// A candidate that matches nothing is the most useful result a dry-run
	// produces — it is the whole reason to run one before activating.
	reporter := &fakeDryRunReporter{}
	p := worker.Pipeline{
		DryRunSampler: &fakeBoundedSampler{
			images: []worker.SampledImage{{Key: "frames/x/00000.000.jpg"}},
		},
		Detector: &fakeDetector{},
		DryRuns:  reporter,
	}

	if err := p.Work(context.Background(), dryRunJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}

	if reporter.calls != 1 {
		t.Fatalf("reported %d times, want one call even with no boxes", reporter.calls)
	}
	if len(reporter.sent.Boxes) != 0 {
		t.Errorf("reported %d boxes, want none", len(reporter.sent.Boxes))
	}
	if len(reporter.sent.SampledKeys) != 1 {
		t.Errorf("reported %d sampled keys, want the frame that was looked at", len(reporter.sent.SampledKeys))
	}
}

func TestDryRunWithoutAWorkDefinitionIsTerminal(t *testing.T) {
	// Unreachable through the claim endpoint, which retires such a job before
	// handing it out. Terminal here anyway: running some other wording and
	// reporting it as this one's result is the alternative.
	p := worker.Pipeline{
		DryRunSampler: &fakeBoundedSampler{},
		Detector:      &fakeDetector{},
		DryRuns:       &fakeDryRunReporter{},
	}

	err := p.Work(context.Background(), &api.Job{Id: 11, Kind: api.Dryrun, VideoId: "v"})

	if err == nil {
		t.Fatal("Work: want an error for a dry-run with no candidate prompt")
	}
	if !worker.IsTerminal(err) {
		t.Errorf("error is retryable, want terminal: %v", err)
	}
}

func TestDryRunWithoutADetectorIsRetryable(t *testing.T) {
	// A deployment that is wrong right now and may be right in a minute, once
	// the binary the operator meant to ship is running — prelabel's own
	// argument, unchanged.
	p := worker.Pipeline{DryRunSampler: &fakeBoundedSampler{}, DryRuns: &fakeDryRunReporter{}}

	err := p.Work(context.Background(), dryRunJob())

	if err == nil {
		t.Fatal("Work: want an error for a worker with no detector")
	}
	if worker.IsTerminal(err) {
		t.Errorf("error is terminal, want retryable: %v", err)
	}
}

func TestDryRunOnAMissingObjectIsTerminal(t *testing.T) {
	// An image row whose object is gone will be gone on the next poll too, so
	// re-queueing hands the same broken video out forever.
	p := worker.Pipeline{
		DryRunSampler: &fakeBoundedSampler{
			images: []worker.SampledImage{{Key: "frames/x/00000.000.jpg"}},
		},
		Detector: &fakeDetector{
			errs: map[string]error{"frames/x/00000.000.jpg": worker.ErrObjectMissing},
		},
		DryRuns: &fakeDryRunReporter{},
	}

	err := p.Work(context.Background(), dryRunJob())

	if err == nil {
		t.Fatal("Work: want an error for a missing object")
	}
	if !worker.IsTerminal(err) {
		t.Errorf("error is retryable, want terminal: %v", err)
	}
}

func TestDryRunDoesNotReportWhenDetectionFails(t *testing.T) {
	// Reporting a partial run would show boxes from half a sample under a
	// `sample_size` claiming the whole one.
	reporter := &fakeDryRunReporter{}
	p := worker.Pipeline{
		DryRunSampler: &fakeBoundedSampler{
			images: []worker.SampledImage{{Key: "a"}, {Key: "b"}},
		},
		Detector: &fakeDetector{errs: map[string]error{"b": errors.New("the sidecar is down")}},
		DryRuns:  reporter,
	}

	if err := p.Work(context.Background(), dryRunJob()); err == nil {
		t.Fatal("Work: want the detector's error")
	}

	if reporter.calls != 0 {
		t.Errorf("reported %d times, want none — the run never finished", reporter.calls)
	}
}

func TestDryRunRejectedByTheContractIsTerminal(t *testing.T) {
	// A box outside [0, 1] or a batch past the bound is this worker's bug and
	// will be refused identically next time, so retrying only burns attempts.
	p := worker.Pipeline{
		DryRunSampler: &fakeBoundedSampler{},
		Detector:      &fakeDetector{},
		DryRuns:       &fakeDryRunReporter{err: queue.ErrRejected},
	}

	err := p.Work(context.Background(), dryRunJob())

	if err == nil {
		t.Fatal("Work: want the reporter's error")
	}
	if !worker.IsTerminal(err) {
		t.Errorf("error is retryable, want terminal: %v", err)
	}
}
