package detect

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/queue"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/worker"
)

// package detect, not detect_test: the retry timing tests below need to
// shrink the unexported startup/detect backoff vars so `go test` does not
// pay for real multi-second sleeps, the same reason worker.Backoff's own
// arithmetic is tested without a clock. Every other test here only exercises
// the exported surface and would read the same from outside the package.

// fastRetries shrinks every backoff to nothing for the duration of one test,
// and stubs sleep so a retry loop that does run pays no wall-clock cost.
// Restored on cleanup so tests stay independent of run order.
func fastRetries(t *testing.T) {
	t.Helper()
	origSleep := sleep
	origStartupAttempts, origStartupBase, origStartupCap := startupAttempts, startupRetryBase, startupRetryCap
	origDetectAttempts, origDetectBase, origDetectCap := detectAttempts, detectRetryBase, detectRetryCap

	sleep = func(time.Duration) {}
	startupRetryBase, startupRetryCap = time.Microsecond, time.Microsecond
	detectRetryBase, detectRetryCap = time.Microsecond, time.Microsecond

	t.Cleanup(func() {
		sleep = origSleep
		startupAttempts, startupRetryBase, startupRetryCap = origStartupAttempts, origStartupBase, origStartupCap
		detectAttempts, detectRetryBase, detectRetryCap = origDetectAttempts, origDetectBase, origDetectCap
	})
}

func TestNewFetchesTheModelIDFromTheSidecar(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/model" || r.Method != http.MethodGet {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"model_id": "owlvit-base-patch32@cbc355f"}`)
	}))
	t.Cleanup(server.Close)

	client, err := New(context.Background(), server.URL)
	if err != nil {
		t.Fatalf("New() returned an unexpected error: %v", err)
	}
	if got := client.ModelID(); got != "owlvit-base-patch32@cbc355f" {
		t.Errorf("ModelID() = %q, want owlvit-base-patch32@cbc355f", got)
	}
}

// A trailing slash is what anyone might paste into CROWDMON_DETECTOR_BASE_URL
// — pinned here rather than left to accident, the same reason queue.New has
// an identical test for the jobs API's base URL.
func TestNewToleratesATrailingSlashOnTheBaseURL(t *testing.T) {
	var seenPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"model_id": "owlvit-base-patch32@cbc355f"}`)
	}))
	t.Cleanup(server.Close)

	if _, err := New(context.Background(), server.URL+"/"); err != nil {
		t.Fatalf("New() returned an unexpected error: %v", err)
	}
	if seenPath != "/model" {
		t.Errorf("requested %q, want /model with no double slash", seenPath)
	}
}

func TestNewRejectsAnEmptyBaseURL(t *testing.T) {
	if _, err := New(context.Background(), ""); err == nil {
		t.Fatal("New(\"\") returned no error")
	}
}

// The sidecar is slower to become ready than the worker — it is loading a
// model into memory — and New has to ride that out rather than fail on the
// first attempt. This is the case docker-compose.yml's
// `depends_on: condition: service_healthy` mostly prevents; this test is the
// fallback path working on its own.
func TestNewRetriesUntilTheSidecarAnswers(t *testing.T) {
	fastRetries(t)

	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"model_id": "owlvit-base-patch32@cbc355f"}`)
	}))
	t.Cleanup(server.Close)

	client, err := New(context.Background(), server.URL)
	if err != nil {
		t.Fatalf("New() returned an unexpected error: %v", err)
	}
	if calls != 3 {
		t.Errorf("the sidecar saw %d calls, want 3 (two failures then success)", calls)
	}
	if got := client.ModelID(); got != "owlvit-base-patch32@cbc355f" {
		t.Errorf("ModelID() = %q, want owlvit-base-patch32@cbc355f", got)
	}
}

// A sidecar that never comes up — wrong URL, container never started — must
// not hang New forever. It has to give up and say so.
func TestNewGivesUpAfterTheStartupBudgetIsSpent(t *testing.T) {
	fastRetries(t)

	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	t.Cleanup(server.Close)

	_, err := New(context.Background(), server.URL)
	if err == nil {
		t.Fatal("New() returned no error for a sidecar that never answers")
	}
	if calls != startupAttempts {
		t.Errorf("the sidecar saw %d calls, want exactly startupAttempts (%d)", calls, startupAttempts)
	}
}

// testClient builds a Client against a test server that also answers the
// /model call New makes internally. handler only needs to branch on
// r.URL.Path == "/detect"; every test here gives /model a canned answer so
// construction never fails.
func testClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	fastRetries(t)

	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	client, err := New(context.Background(), server.URL)
	if err != nil {
		t.Fatalf("New() returned an unexpected error building the test client: %v", err)
	}
	return client
}

var testPrompts = []worker.ClassPrompt{
	{Name: "Paimon", Appearance: "a small white-haired flying companion", Version: "2026-08-08-a"},
}

func TestDetectReturnsTheBoxesTheSidecarReports(t *testing.T) {
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/model":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"model_id": "owlvit-base-patch32@cbc355f"}`)
		case "/detect":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"boxes": [
				{"class_name": "Paimon", "x_min": 0.1, "y_min": 0.2, "x_max": 0.5, "y_max": 0.6, "confidence": 0.87, "prompt_version": "2026-08-08-a"}
			]}`)
		default:
			t.Errorf("unexpected request to %s", r.URL.Path)
		}
	})

	boxes, err := client.Detect(context.Background(), worker.SampledImage{Key: "frames/x/00000.000.jpg"}, testPrompts)
	if err != nil {
		t.Fatalf("Detect() returned an unexpected error: %v", err)
	}
	if len(boxes) != 1 {
		t.Fatalf("Detect() returned %d boxes, want 1", len(boxes))
	}

	want := queue.Box{
		ClassName: "Paimon", XMin: 0.1, YMin: 0.2, XMax: 0.5, YMax: 0.6,
		Confidence: 0.87, PromptVersion: "2026-08-08-a",
	}
	if boxes[0] != want {
		t.Errorf("Detect() box = %+v, want %+v", boxes[0], want)
	}
	// worker.Detector's contract: the implementation must not fill in Key,
	// because the pipeline is the one that knows which image it asked about.
	if boxes[0].Key != "" {
		t.Errorf("Detect() set Key to %q, want it left for the pipeline to fill in", boxes[0].Key)
	}
}

func TestDetectSendsTheImageKeyAndEveryPrompt(t *testing.T) {
	var detectBody map[string]any
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/model" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"model_id": "owlvit-base-patch32@cbc355f"}`)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&detectBody); err != nil {
			t.Fatalf("decoding the request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"boxes": []}`)
	})

	_, err := client.Detect(context.Background(), worker.SampledImage{Key: "frames/dQw4w9WgXcQ/00120.000.jpg"}, testPrompts)
	if err != nil {
		t.Fatalf("Detect() returned an unexpected error: %v", err)
	}

	if detectBody["image_key"] != "frames/dQw4w9WgXcQ/00120.000.jpg" {
		t.Errorf("image_key = %v, want the sampled image's key", detectBody["image_key"])
	}
	prompts, ok := detectBody["prompts"].([]any)
	if !ok || len(prompts) != 1 {
		t.Fatalf("prompts = %v, want 1 prompt", detectBody["prompts"])
	}
	first, _ := prompts[0].(map[string]any)
	if first["name"] != "Paimon" || first["version"] != "2026-08-08-a" {
		t.Errorf("prompt = %v, want Paimon at version 2026-08-08-a", first)
	}
}

// A detector finding nothing on an image is a real, non-error outcome —
// mirrors prelabel_test.go's fakeDetector returning no boxes for an image it
// has no entry for.
func TestDetectReturnsNoBoxesWithoutFailing(t *testing.T) {
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/model" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"model_id": "owlvit-base-patch32@cbc355f"}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"boxes": []}`)
	})

	boxes, err := client.Detect(context.Background(), worker.SampledImage{Key: "frames/x/00000.000.jpg"}, testPrompts)
	if err != nil {
		t.Fatalf("Detect() returned an unexpected error: %v", err)
	}
	if len(boxes) != 0 {
		t.Errorf("Detect() returned %d boxes, want 0", len(boxes))
	}
}

// The load-bearing distinction the whole issue is about: a 404 that the
// sidecar marks as "object_missing" — R2 genuinely does not have this key —
// must come back as worker.ErrObjectMissing so pipeline.go's prelabel branch
// can mark the job Terminal.
func TestDetectMapsAnObjectMissingResponseToErrObjectMissing(t *testing.T) {
	var calls int
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/model" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"model_id": "owlvit-base-patch32@cbc355f"}`)
			return
		}
		calls++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error": "object_missing", "detail": "key not found in bucket crowdmon-frames"}`)
	})

	_, err := client.Detect(context.Background(), worker.SampledImage{Key: "frames/x/gone.jpg"}, testPrompts)
	if !errors.Is(err, worker.ErrObjectMissing) {
		t.Fatalf("Detect() error = %v, want it to wrap worker.ErrObjectMissing", err)
	}
	// Not retried: no number of attempts changes what R2 has, and retrying
	// would just be three round trips to learn the same fact.
	if calls != 1 {
		t.Errorf("the sidecar saw %d /detect calls for a missing object, want exactly 1 (no retry)", calls)
	}
}

// A bare 404 with no object_missing discriminator — a typo'd
// CROWDMON_DETECTOR_BASE_URL landing on an unmatched route, say — must not be
// silently promoted to ErrObjectMissing. That would burn a video's job as
// Terminal over what is actually a deployment mistake.
func TestDetectDoesNotTreatAnUndiscriminated404AsObjectMissing(t *testing.T) {
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/model" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"model_id": "owlvit-base-patch32@cbc355f"}`)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	_, err := client.Detect(context.Background(), worker.SampledImage{Key: "frames/x/00000.000.jpg"}, testPrompts)
	if err == nil {
		t.Fatal("Detect() returned no error for a 404")
	}
	if errors.Is(err, worker.ErrObjectMissing) {
		t.Errorf("Detect() error = %v, want it distinct from ErrObjectMissing without the discriminator", err)
	}
}

// A sidecar that is down, or mid-restart, must be retryable rather than
// terminal (terminal.go's default) — and Detect should ride out a transient
// 503 within its own retry budget rather than fail the whole job over one
// blip.
func TestDetectRetriesOnATransientFailureAndThenSucceeds(t *testing.T) {
	var calls int
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/model" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"model_id": "owlvit-base-patch32@cbc355f"}`)
			return
		}
		calls++
		if calls < 2 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"boxes": []}`)
	})

	_, err := client.Detect(context.Background(), worker.SampledImage{Key: "frames/x/00000.000.jpg"}, testPrompts)
	if err != nil {
		t.Fatalf("Detect() returned an unexpected error: %v", err)
	}
	if calls != 2 {
		t.Errorf("the sidecar saw %d /detect calls, want 2 (one failure then success)", calls)
	}
}

func TestDetectGivesUpAfterExhaustingItsRetries(t *testing.T) {
	var calls int
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/model" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"model_id": "owlvit-base-patch32@cbc355f"}`)
			return
		}
		calls++
		w.WriteHeader(http.StatusServiceUnavailable)
	})

	_, err := client.Detect(context.Background(), worker.SampledImage{Key: "frames/x/00000.000.jpg"}, testPrompts)
	if err == nil {
		t.Fatal("Detect() returned no error for a sidecar that never recovers")
	}
	if errors.Is(err, worker.ErrObjectMissing) {
		t.Errorf("Detect() error = %v, want retryable (not ErrObjectMissing) per terminal.go's default", err)
	}
	if calls != detectAttempts {
		t.Errorf("the sidecar saw %d /detect calls, want exactly detectAttempts (%d)", calls, detectAttempts)
	}
}
