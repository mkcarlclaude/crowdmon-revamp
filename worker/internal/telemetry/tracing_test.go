package telemetry_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/trace"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/config"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/telemetry"
)

// The seam is the HTTP boundary: whether a span leaves this process, and what
// headers it carries when it does. Everything the Access gate cares about is
// visible from there, and nothing below it is worth pinning down.
func TestSetupExportsSpansWithTheAccessHeaders(t *testing.T) {
	type export struct {
		clientID     string
		clientSecret string
		contentType  string
		path         string
	}
	exports := make(chan export, 4)

	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		exports <- export{
			clientID:     r.Header.Get("CF-Access-Client-Id"),
			clientSecret: r.Header.Get("CF-Access-Client-Secret"),
			contentType:  r.Header.Get("Content-Type"),
			path:         r.URL.Path,
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer collector.Close()

	cfg := config.Config{
		APIBaseURL:         "https://api.example.com",
		Environment:        "test",
		WorkerID:           "worker-under-test",
		OTLPEndpoint:       collector.URL + "/v1/traces",
		AccessClientID:     "id.access",
		AccessClientSecret: "shhh",
	}

	ctx := context.Background()
	shutdown, err := telemetry.Setup(ctx, cfg)
	if err != nil {
		t.Fatalf("Setup() returned an unexpected error: %v", err)
	}

	_, span := otel.Tracer("test").Start(ctx, "a-span")
	span.End()

	// Shutdown flushes. Asserting on the export *after* it rather than sleeping
	// is the only way this test is not a race.
	if err := shutdown(ctx); err != nil {
		t.Fatalf("shutdown() returned an unexpected error: %v", err)
	}

	select {
	case got := <-exports:
		if got.clientID != "id.access" {
			t.Errorf("CF-Access-Client-Id = %q, want %q", got.clientID, "id.access")
		}
		if got.clientSecret != "shhh" {
			t.Errorf("CF-Access-Client-Secret = %q, want %q", got.clientSecret, "shhh")
		}
		// The collector's HTTP receiver rejects anything else, and getting this
		// wrong looks identical to a network failure from in here.
		if got.contentType != "application/x-protobuf" {
			t.Errorf("Content-Type = %q, want application/x-protobuf", got.contentType)
		}
		if got.path != "/v1/traces" {
			t.Errorf("path = %q, want /v1/traces — the endpoint's own path must be honoured", got.path)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no export reached the collector")
	}
}

// CONTEXT.md §9.4's sampling-posture decision, pinned on the property that
// actually matters rather than on which constructor setupTracing calls: a
// span whose context carries a *remote, explicitly unsampled* parent must
// still reach the collector. That is the one behavioural difference between
// plain AlwaysSample and the SDK's own default, ParentBased(AlwaysSample()) —
// the two are indistinguishable for a root span, which is why a test that
// only started fresh spans (as every other test in this file does) could not
// tell them apart and would keep passing after a regression to the default.
//
// The scenario is not contrived: withStoredTraceContext (pipeline.go)
// extracts exactly this kind of remote parent from a job's stored
// traceparent, minted by apps/api rather than by this worker. Under
// ParentBased, an upstream sampled=0 would silently drop job.prelabel and
// everything sample.select/image.detect/predictions.report put under it —
// losing the flywheel data this milestone exists to keep, for a sampling
// decision this process never made and does not control.
func TestSetupSamplesAChildOfAnUnsampledRemoteParent(t *testing.T) {
	received := make(chan int, 1)
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		received <- len(body)
		w.WriteHeader(http.StatusOK)
	}))
	defer collector.Close()

	ctx := context.Background()
	shutdown, err := telemetry.Setup(ctx, config.Config{
		APIBaseURL:   "https://api.example.com",
		Environment:  "test",
		WorkerID:     "worker-under-test",
		OTLPEndpoint: collector.URL + "/v1/traces",
	})
	if err != nil {
		t.Fatalf("Setup() returned an unexpected error: %v", err)
	}

	// TraceFlags 0: unsampled, exactly what a traceparent whose own head
	// sampler said no would carry. Remote: true is what makes ParentBased
	// consult this flag at all — a local parent is never in question here.
	remoteParent := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    trace.TraceID{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16},
		SpanID:     trace.SpanID{1, 2, 3, 4, 5, 6, 7, 8},
		TraceFlags: trace.TraceFlags(0),
		Remote:     true,
	})
	parented := trace.ContextWithRemoteSpanContext(ctx, remoteParent)

	_, span := otel.Tracer("test").Start(parented, "job.prelabel")
	span.End()

	if err := shutdown(ctx); err != nil {
		t.Fatalf("shutdown() returned an unexpected error: %v", err)
	}

	select {
	case n := <-received:
		if n == 0 {
			t.Error("the collector received an empty export body")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no export reached the collector: an unsampled remote parent dropped the span, " +
			"which means setupTracing regressed to ParentBased(AlwaysSample()) or is not sampling everything")
	}
}

// With no endpoint the worker still runs, still traces locally, and exports
// nothing. `go run ./cmd/worker` against a dev API is the case this exists for.
func TestSetupWithTracingDisabledIsAWorkingNoOp(t *testing.T) {
	ctx := context.Background()

	shutdown, err := telemetry.Setup(ctx, config.Config{
		APIBaseURL:  "https://api.example.com",
		Environment: "test",
		WorkerID:    "worker-under-test",
	})
	if err != nil {
		t.Fatalf("Setup() returned an unexpected error: %v", err)
	}

	_, span := otel.Tracer("test").Start(ctx, "a-span")
	span.End()

	if err := shutdown(ctx); err != nil {
		t.Fatalf("shutdown() returned an unexpected error: %v", err)
	}
}

// A collector that is down must not take the worker with it. The export is
// best-effort by design: dropping spans is survivable, refusing to process
// jobs because Tempo is unreachable is not.
func TestShutdownReportsAnUnreachableCollectorWithoutBlockingForever(t *testing.T) {
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer collector.Close()

	ctx := context.Background()
	shutdown, err := telemetry.Setup(ctx, config.Config{
		APIBaseURL:         "https://api.example.com",
		Environment:        "test",
		WorkerID:           "worker-under-test",
		OTLPEndpoint:       collector.URL + "/v1/traces",
		AccessClientID:     "id.access",
		AccessClientSecret: "shhh",
	})
	if err != nil {
		t.Fatalf("Setup() returned an unexpected error: %v", err)
	}

	_, span := otel.Tracer("test").Start(ctx, "a-span")
	span.End()

	// The exporter retries a 500 with backoff. A caller-imposed deadline is
	// what stops that from holding shutdown open past the container's grace
	// period, so the deadline has to be respected.
	deadlined, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- shutdown(deadlined) }()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("shutdown ignored its context deadline with the collector failing")
	}
}
