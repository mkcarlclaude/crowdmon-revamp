package worker_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

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

// fakePromptSource stands in for D1's `classes` table (M11.5's
// worker.PromptSource): a fixed list handed back on every call rather than a
// real fetch, the same substitution `testPrompts` was directly before
// Pipeline.Prompts became an interface.
type fakePromptSource struct {
	classes []queue.ClassPrompt
	err     error
	calls   int
}

func (s *fakePromptSource) ActiveClasses(_ context.Context) ([]queue.ClassPrompt, error) {
	s.calls++
	return s.classes, s.err
}

// promptSource wraps prompts — written in worker.ClassPrompt form, the shape
// every assertion in this file already reads — as the queue.ClassPrompt a
// real worker.PromptSource returns over the wire. The conversion mirrors
// worker.toClassPrompts run backwards, and exists for the same reason that
// function does: queue.ClassPrompt cannot be worker.ClassPrompt without
// queue importing worker.
func promptSource(prompts ...worker.ClassPrompt) *fakePromptSource {
	classes := make([]queue.ClassPrompt, len(prompts))
	for i, p := range prompts {
		classes[i] = queue.ClassPrompt{Name: p.Name, Appearance: p.Appearance, Version: p.Version}
	}
	return &fakePromptSource{classes: classes}
}

func prelabelJob() *api.Job {
	return &api.Job{Id: 7, Kind: api.JobKindPrelabel, VideoId: strPtr("dQw4w9WgXcQ")}
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
		Sampler: sampler, Detector: detector, Predictions: reporter, Prompts: promptSource(testPrompts...),
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
		Prompts:     promptSource(testPrompts...),
	}

	if err := p.Work(context.Background(), prelabelJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}

	if len(detector.prompts) != 1 || detector.prompts[0].Version != "2026-08-08-a" {
		t.Errorf("detector got %+v, want the configured prompt and its version", detector.prompts)
	}
}

// versionEchoingDetector stands in for a real Detector's behaviour: it
// stamps a box's PromptVersion from whichever ClassPrompt.Version Detect was
// actually handed, the same as a production detector does when it matches a
// class (M11.2). fakeDetector, above, always returns whatever PromptVersion
// a test typed into its static boxes table — which cannot demonstrate that
// the version travelling all the way to a prediction came from the fetch
// rather than from the test's own fixture. This one can.
type versionEchoingDetector struct {
	prompts []worker.ClassPrompt
}

func (d *versionEchoingDetector) Detect(
	_ context.Context, _ worker.SampledImage, prompts []worker.ClassPrompt,
) ([]queue.Box, error) {
	d.prompts = prompts
	return []queue.Box{
		{ClassName: prompts[0].Name, Confidence: 0.9, PromptVersion: prompts[0].Version},
	}, nil
}

func (d *versionEchoingDetector) ModelID() string { return "fake-detector-v1" }

// TestPrelabelStampsThePromptVersionTheFetchedClassSupplied is the property
// this whole milestone exists to guarantee (see worker.PromptSource's own
// comment, and migration 0003's comment on predictions.prompt_version): the
// version a prediction carries must be the one PromptSource's D1-backed
// fetch actually supplied for that class, not a value any local copy of the
// wording could have drifted from. The version below is chosen to look
// nothing like the "2026-08-08-a" every other test in this file hard-codes,
// specifically so a pass here cannot be explained by a stale constant
// leaking through instead of the fetched value.
func TestPrelabelStampsThePromptVersionTheFetchedClassSupplied(t *testing.T) {
	source := promptSource(worker.ClassPrompt{
		Name:       "Paimon",
		Appearance: "a small white-haired flying companion",
		Version:    "2026-09-01-fetched-from-d1",
	})
	detector := &versionEchoingDetector{}
	reporter := &fakePredictionReporter{}

	p := worker.Pipeline{
		Sampler:     &fakeSampler{images: []worker.SampledImage{{Key: "frames/x/00000.000.jpg"}}},
		Detector:    detector,
		Predictions: reporter,
		Prompts:     source,
	}

	if err := p.Work(context.Background(), prelabelJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}

	if source.calls != 1 {
		t.Fatalf("PromptSource.ActiveClasses called %d times, want exactly 1", source.calls)
	}
	if len(reporter.sent.Boxes) != 1 {
		t.Fatalf("reported %d boxes, want 1", len(reporter.sent.Boxes))
	}
	if got := reporter.sent.Boxes[0].PromptVersion; got != "2026-09-01-fetched-from-d1" {
		t.Errorf("prediction carries prompt_version %q, want the version PromptSource supplied", got)
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
		Prompts:     promptSource(testPrompts...),
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
		Prompts:     promptSource(testPrompts...),
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
		Prompts:     promptSource(testPrompts...),
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
		Prompts:     promptSource(testPrompts...),
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
		Prompts:     promptSource(testPrompts...),
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
		"no sampler":  {Detector: &fakeDetector{}, Predictions: &fakePredictionReporter{}, Prompts: promptSource(testPrompts...)},
		"no detector": {Sampler: &fakeSampler{}, Predictions: &fakePredictionReporter{}, Prompts: promptSource(testPrompts...)},
		"no reporter": {Sampler: &fakeSampler{}, Detector: &fakeDetector{}, Prompts: promptSource(testPrompts...)},
		// Prompts left nil: the field is a PromptSource now, not a slice, so
		// "not configured at all" is a nil interface rather than an empty one
		// — caught by the same collaborator check as the other three.
		"no prompt source": {Sampler: &fakeSampler{}, Detector: &fakeDetector{}, Predictions: &fakePredictionReporter{}},
		// Distinct from the above: a PromptSource that is present and answers
		// successfully, but with nothing active in D1. This is the sharper
		// case prelabel's own comment on the empty check calls out — not a
		// missing collaborator, but a roster with nothing turned on.
		"empty active classes": {
			Sampler: &fakeSampler{}, Detector: &fakeDetector{}, Predictions: &fakePredictionReporter{},
			Prompts: promptSource(),
		},
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

// endedSpansNamed returns every recorded span with the given name, in the
// order they ended. image.detect is the reason this exists alongside
// pipeline_test.go's endedSpan: it opens once per sampled image, so a test
// asserting on "the" detect span needs to say which one.
func endedSpansNamed(spans *tracetest.SpanRecorder, name string) []sdktrace.ReadOnlySpan {
	var out []sdktrace.ReadOnlySpan
	for _, span := range spans.Ended() {
		if span.Name() == name {
			out = append(out, span)
		}
	}
	return out
}

func attrs(span sdktrace.ReadOnlySpan) map[string]any {
	out := map[string]any{}
	for _, a := range span.Attributes() {
		out[string(a.Key)] = a.Value.AsInterface()
	}
	return out
}

// M11.4 (issue #104): the three spans inside job.prelabel — sample selection,
// detection, and the prediction write — are the "middle worth naming"
// CONTEXT.md §9.3 asked for. This pins their names, their attributes, and
// that they nest under job.prelabel rather than floating as siblings, the
// same way TestAJobSpanContinuesItsStoredTraceparent pins job.download's
// parentage.
func TestPrelabelOpensASpanForEachOfItsThreeSteps(t *testing.T) {
	spans := recordingProvider(t)

	sampler := &fakeSampler{images: []worker.SampledImage{
		{Key: "frames/dQw4w9WgXcQ/00000.000.jpg", TimestampSeconds: 0},
		{Key: "frames/dQw4w9WgXcQ/00600.000.jpg", TimestampSeconds: 600},
	}}
	detector := &fakeDetector{
		modelID: "owlvit-base-patch32.onnx",
		boxes: map[string][]queue.Box{
			"frames/dQw4w9WgXcQ/00000.000.jpg": {
				{ClassName: "Paimon", XMax: 0.5, YMax: 0.5, Confidence: 0.9, PromptVersion: "2026-08-08-a"},
				{ClassName: "Paimon", XMax: 0.9, YMax: 0.9, Confidence: 0.4, PromptVersion: "2026-08-08-a"},
			},
		},
	}
	p := worker.Pipeline{
		Sampler: sampler, Detector: detector, Predictions: &fakePredictionReporter{}, Prompts: promptSource(testPrompts...),
	}

	if err := p.Work(t.Context(), prelabelJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}

	job := endedSpan(t, spans, "job.prelabel")

	sample := endedSpan(t, spans, "sample.select")
	if got := attrs(sample)["crowdmon.sample.selected"]; got != int64(2) {
		t.Errorf("sample.select crowdmon.sample.selected = %v, want 2", got)
	}
	if sample.Parent().SpanID() != job.SpanContext().SpanID() {
		t.Error("sample.select is not a child of job.prelabel")
	}

	detects := endedSpansNamed(spans, "image.detect")
	if len(detects) != 2 {
		t.Fatalf("image.detect spans = %d, want one per sampled image (2)", len(detects))
	}
	byKey := map[string]sdktrace.ReadOnlySpan{}
	for _, d := range detects {
		byKey[attrs(d)["crowdmon.image.key"].(string)] = d
	}
	withBoxes, ok := byKey["frames/dQw4w9WgXcQ/00000.000.jpg"]
	if !ok {
		t.Fatal("no image.detect span for the frame the detector found boxes on")
	}
	if got := attrs(withBoxes)["crowdmon.detect.classes"]; got != int64(1) {
		t.Errorf("crowdmon.detect.classes = %v, want 1 (len(testPrompts))", got)
	}
	if got := attrs(withBoxes)["crowdmon.detect.boxes"]; got != int64(2) {
		t.Errorf("crowdmon.detect.boxes = %v, want 2", got)
	}
	// The per-class breakdown is what answers "detection per class" — a
	// count keyed by every configured prompt, not just the ones that matched.
	wantBreakdown := []string{"Paimon=2"}
	gotBreakdown := attrs(withBoxes)["crowdmon.detect.boxes_by_class"]
	if fmt.Sprint(gotBreakdown) != fmt.Sprint(wantBreakdown) {
		t.Errorf("crowdmon.detect.boxes_by_class = %v, want %v", gotBreakdown, wantBreakdown)
	}
	empty, ok := byKey["frames/dQw4w9WgXcQ/00600.000.jpg"]
	if !ok {
		t.Fatal("no image.detect span for the frame the detector found nothing on")
	}
	// Zero boxes is a real outcome, not a skipped span — the same rule
	// prelabel's own doc comment states for the whole job applies per image.
	if got := attrs(empty)["crowdmon.detect.boxes"]; got != int64(0) {
		t.Errorf("crowdmon.detect.boxes = %v, want 0", got)
	}
	if got := fmt.Sprint(attrs(empty)["crowdmon.detect.boxes_by_class"]); got != fmt.Sprint([]string{"Paimon=0"}) {
		t.Errorf("crowdmon.detect.boxes_by_class = %v, want [Paimon=0] — a class that matched nothing "+
			"must not look like a class nobody asked about", got)
	}
	for _, d := range detects {
		if d.Parent().SpanID() != job.SpanContext().SpanID() {
			t.Errorf("image.detect span for %s is not a child of job.prelabel", attrs(d)["crowdmon.image.key"])
		}
	}

	report := endedSpan(t, spans, "predictions.report")
	reportAttrs := attrs(report)
	if reportAttrs["crowdmon.predictions.model_id"] != "owlvit-base-patch32.onnx" {
		t.Errorf("crowdmon.predictions.model_id = %v, want the detector's own", reportAttrs["crowdmon.predictions.model_id"])
	}
	if reportAttrs["crowdmon.predictions.boxes"] != int64(2) {
		t.Errorf("crowdmon.predictions.boxes = %v, want 2", reportAttrs["crowdmon.predictions.boxes"])
	}
	if reportAttrs["crowdmon.predictions.sampled"] != int64(2) {
		t.Errorf("crowdmon.predictions.sampled = %v, want 2 (both sampled images, boxed or not)", reportAttrs["crowdmon.predictions.sampled"])
	}
	if report.Parent().SpanID() != job.SpanContext().SpanID() {
		t.Error("predictions.report is not a child of job.prelabel")
	}

	// The job-level rollup: the same breakdown the per-image spans carry,
	// summed across the whole video, on the span an operator opens first.
	jobBreakdown := fmt.Sprint(attrs(job)["crowdmon.prelabel.boxes_by_class"])
	if jobBreakdown != fmt.Sprint([]string{"Paimon=2"}) {
		t.Errorf("job.prelabel crowdmon.prelabel.boxes_by_class = %v, want [Paimon=2]", jobBreakdown)
	}
}

// A missing object aborts the loop before every image gets its own
// image.detect span recorded as failed — only the one that actually hit
// ErrObjectMissing does, and the job span carries the failure, not a second
// synthetic span for images Detect was never called on.
func TestPrelabelDetectSpanRecordsTheFailureThatAbortedTheJob(t *testing.T) {
	spans := recordingProvider(t)

	p := worker.Pipeline{
		Sampler: &fakeSampler{images: []worker.SampledImage{{Key: "frames/x/00000.000.jpg"}}},
		Detector: &fakeDetector{errs: map[string]error{
			"frames/x/00000.000.jpg": fmt.Errorf("fetching: %w", worker.ErrObjectMissing),
		}},
		Predictions: &fakePredictionReporter{},
		Prompts:     promptSource(testPrompts...),
	}

	if err := p.Work(t.Context(), prelabelJob()); err == nil {
		t.Fatal("Work succeeded, want a failure")
	}

	detect := endedSpan(t, spans, "image.detect")
	if detect.Status().Code != codes.Error {
		t.Errorf("image.detect status = %v, want Error", detect.Status().Code)
	}

	// No predictions.report at all: the job aborted before reaching it.
	for _, span := range spans.Ended() {
		if span.Name() == "predictions.report" {
			t.Error("predictions.report was opened despite the job failing before it")
		}
	}
}

func TestUnknownJobKindIsStillTerminal(t *testing.T) {
	// The default arm of Work's switch, asserted here because adding a third
	// case is exactly when it could have been broken.
	p := worker.Pipeline{}

	err := p.Work(context.Background(), &api.Job{Id: 1, Kind: "something-else", VideoId: strPtr("v")})
	if err == nil {
		t.Fatal("Work succeeded, want a failure")
	}
	if !worker.IsTerminal(err) {
		t.Errorf("error %v is retryable, want terminal", err)
	}
}
