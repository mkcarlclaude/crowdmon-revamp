package telemetry_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/config"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/telemetry"
)

// The seam is the same as tracing's and logs': whether a data point leaves
// this process, and what headers it carries when it does. The collector's
// metrics receiver sits behind the same Access gate as traces and logs, so a
// metric export missing these headers fails exactly the same way — accepted
// by Access, rejected by the collector, absent from Prometheus days later.
func TestSetupExportsMetricsWithTheAccessHeaders(t *testing.T) {
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
		APIBaseURL:          "https://api.example.com",
		Environment:         "test",
		WorkerID:            "worker-under-test",
		OTLPMetricsEndpoint: collector.URL + "/v1/metrics",
		AccessClientID:      "id.access",
		AccessClientSecret:  "shhh",
	}

	ctx := t.Context()
	shutdown, err := telemetry.Setup(ctx, cfg)
	if err != nil {
		t.Fatalf("Setup() returned an unexpected error: %v", err)
	}

	// NewFrameMetrics must run after Setup: it reads whatever global
	// MeterProvider Setup just installed, exactly as NewHandler reads
	// whatever global LoggerProvider it installed.
	fm, err := telemetry.NewFrameMetrics()
	if err != nil {
		t.Fatalf("NewFrameMetrics() returned an unexpected error: %v", err)
	}
	fm.RecordExtracted(ctx, 42)
	fm.RecordKept(ctx, 30)
	fm.RecordDedupRatio(ctx, 30.0/42.0)
	fm.RecordChunkDuration(ctx, 3*time.Second)

	// Shutdown flushes. Asserting on the export *after* it rather than
	// sleeping is the only way this test is not a race.
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
		if got.contentType != "application/x-protobuf" {
			t.Errorf("Content-Type = %q, want application/x-protobuf", got.contentType)
		}
		if got.path != "/v1/metrics" {
			t.Errorf("path = %q, want /v1/metrics — the endpoint's own path must be honoured", got.path)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no export reached the collector")
	}
}

// With no metrics endpoint the worker still runs and exports nothing — same
// contract tracing and logs already have, and for the same reason: `go run
// ./cmd/worker` against a dev API has no collector in reach.
func TestSetupWithMetricsDisabledIsAWorkingNoOp(t *testing.T) {
	ctx := t.Context()

	shutdown, err := telemetry.Setup(ctx, config.Config{
		APIBaseURL:  "https://api.example.com",
		Environment: "test",
		WorkerID:    "worker-under-test",
	})
	if err != nil {
		t.Fatalf("Setup() returned an unexpected error: %v", err)
	}

	// Instruments built against the disabled path's no-op MeterProvider must
	// record without panicking — a worker with the variable unset behaves
	// precisely as it does today, and "precisely" includes "does not crash
	// when the pipeline calls these".
	fm, err := telemetry.NewFrameMetrics()
	if err != nil {
		t.Fatalf("NewFrameMetrics() returned an unexpected error: %v", err)
	}
	fm.RecordExtracted(ctx, 10)
	fm.RecordKept(ctx, 8)
	fm.RecordDedupRatio(ctx, 0.8)
	fm.RecordChunkDuration(ctx, time.Second)

	if err := shutdown(ctx); err != nil {
		t.Fatalf("shutdown() returned an unexpected error: %v", err)
	}
}

// A collector that is down must not take the worker with it, same as
// tracing's contract: the export is best-effort, dropping metrics is
// survivable, refusing to process jobs because the collector is unreachable
// is not.
func TestMetricsShutdownRespectsItsDeadlineAgainstAnUnreachableCollector(t *testing.T) {
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer collector.Close()

	ctx := t.Context()
	shutdown, err := telemetry.Setup(ctx, config.Config{
		APIBaseURL:          "https://api.example.com",
		Environment:         "test",
		WorkerID:            "worker-under-test",
		OTLPMetricsEndpoint: collector.URL + "/v1/metrics",
		AccessClientID:      "id.access",
		AccessClientSecret:  "shhh",
	})
	if err != nil {
		t.Fatalf("Setup() returned an unexpected error: %v", err)
	}

	fm, err := telemetry.NewFrameMetrics()
	if err != nil {
		t.Fatalf("NewFrameMetrics() returned an unexpected error: %v", err)
	}
	fm.RecordExtracted(ctx, 1)

	deadlined, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- shutdown(deadlined) }()

	select {
	case err := <-done:
		// The unreachable collector is the only signal configured, so
		// whatever error the meter provider's Shutdown produced is exactly
		// what Setup's composed shutdown must surface — errors.Join with a
		// single non-nil member returns that member's error, not nil.
		if err == nil {
			t.Error("shutdown() = nil, want the meter provider's export error propagated")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("shutdown ignored its context deadline with the collector failing")
	}
}
