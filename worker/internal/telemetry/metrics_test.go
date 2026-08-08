package telemetry_test

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

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

// collectQueueDepth wires a ManualReader up as the global MeterProvider,
// registers the gauge against fetch, and returns whatever one synchronous
// Collect() produced — the deterministic alternative to waiting out a real
// export interval, which is all a ManualReader is for.
func collectQueueDepth(t *testing.T, fetch telemetry.QueueDepthFetcher, logger *slog.Logger) metricdata.ResourceMetrics {
	t.Helper()

	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	otel.SetMeterProvider(provider)
	t.Cleanup(func() { otel.SetMeterProvider(sdkmetric.NewMeterProvider()) })

	if err := telemetry.NewQueueDepthGauge(fetch, logger); err != nil {
		t.Fatalf("NewQueueDepthGauge() returned an unexpected error: %v", err)
	}

	var rm metricdata.ResourceMetrics
	if err := reader.Collect(t.Context(), &rm); err != nil {
		t.Fatalf("Collect() returned an unexpected error: %v", err)
	}
	return rm
}

// queueDepthPoints flattens the one queue.depth gauge's data points into
// (status, kind) -> value, however many scopes and metrics Collect produced —
// this instrument is the only one registered against a fresh ManualReader in
// these tests, but reading it by name rather than by position is one fewer
// thing a reordering elsewhere in the SDK could silently break.
func queueDepthPoints(t *testing.T, rm metricdata.ResourceMetrics) map[[2]string]int64 {
	t.Helper()

	points := map[[2]string]int64{}
	for _, scope := range rm.ScopeMetrics {
		for _, m := range scope.Metrics {
			if m.Name != "queue.depth" {
				continue
			}
			gauge, ok := m.Data.(metricdata.Gauge[int64])
			if !ok {
				t.Fatalf("queue.depth data is %T, want metricdata.Gauge[int64]", m.Data)
			}
			for _, dp := range gauge.DataPoints {
				status, _ := dp.Attributes.Value("status")
				kind, _ := dp.Attributes.Value("kind")
				points[[2]string{status.AsString(), kind.AsString()}] = dp.Value
			}
		}
	}
	return points
}

// The whole reason M9.1's queue-depth panel exists: an empty queue and a
// worker that stopped exporting must not look the same in Prometheus. This
// asserts the gauge actually reports every combination fetch hands it — real
// zeros, not absent series — rather than trusting fetch's own contract.
func TestQueueDepthGaugeReportsZeroForAnEmptyQueue(t *testing.T) {
	fetch := func(context.Context) ([]telemetry.QueueCount, error) {
		return []telemetry.QueueCount{
			{Status: "pending", Kind: "download", Count: 0},
			{Status: "pending", Kind: "chunk", Count: 0},
			{Status: "claimed", Kind: "download", Count: 0},
			{Status: "claimed", Kind: "chunk", Count: 0},
			{Status: "done", Kind: "download", Count: 0},
			{Status: "done", Kind: "chunk", Count: 0},
			{Status: "failed", Kind: "download", Count: 0},
			{Status: "failed", Kind: "chunk", Count: 0},
		}, nil
	}

	rm := collectQueueDepth(t, fetch, slog.New(slog.NewTextHandler(bytes.NewBuffer(nil), nil)))
	points := queueDepthPoints(t, rm)

	if len(points) != 8 {
		t.Fatalf("queue.depth reported %d series, want all 8 (status, kind) combinations present at zero", len(points))
	}
	for pair, value := range points {
		if value != 0 {
			t.Errorf("queue.depth{status=%s,kind=%s} = %d, want 0", pair[0], pair[1], value)
		}
	}
}

func TestQueueDepthGaugeReportsWhatFetchReturns(t *testing.T) {
	fetch := func(context.Context) ([]telemetry.QueueCount, error) {
		return []telemetry.QueueCount{
			{Status: "pending", Kind: "download", Count: 2},
			{Status: "claimed", Kind: "chunk", Count: 5},
		}, nil
	}

	rm := collectQueueDepth(t, fetch, slog.New(slog.NewTextHandler(bytes.NewBuffer(nil), nil)))
	points := queueDepthPoints(t, rm)

	if points[[2]string{"pending", "download"}] != 2 {
		t.Errorf("queue_depth{status=pending,kind=download} = %d, want 2", points[[2]string{"pending", "download"}])
	}
	if points[[2]string{"claimed", "chunk"}] != 5 {
		t.Errorf("queue_depth{status=claimed,kind=chunk} = %d, want 5", points[[2]string{"claimed", "chunk"}])
	}
}

// Telemetry must never be the reason a job fails, and this callback runs off
// the SDK's own export timer rather than inside PollOnce — so an unreachable
// API has to become a gap in a graph, not an error that unwinds anything. A
// failed fetch must not even fail Collect() itself: returning an error from
// the callback would drop every instrument sharing this collection, which
// (once this gauge shares a reader with the frame-extraction instruments, as
// it does in production) would be a worse outcome than the one missing point
// this survives to produce.
func TestQueueDepthGaugeSurvivesAnAPIErrorWithoutFailingCollection(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buf, nil))

	fetch := func(context.Context) ([]telemetry.QueueCount, error) {
		return nil, errors.New("dial tcp: connection refused")
	}

	rm := collectQueueDepth(t, fetch, logger)
	points := queueDepthPoints(t, rm)

	if len(points) != 0 {
		t.Errorf("queue.depth reported %d series after a failed fetch, want none", len(points))
	}
	if !strings.Contains(buf.String(), "queue.depth") {
		t.Errorf("the fetch error was not logged: %s", buf.String())
	}
}
