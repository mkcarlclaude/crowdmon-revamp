package telemetry_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/config"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/telemetry"
)

// The seam is the same as tracing's: whether a log record leaves this
// process, and what headers it carries when it does. Loki's ingest is behind
// the same Access gate, so a log export with no Access headers looks exactly
// like a trace export with none — accepted by Access, rejected by the
// collector, and silently absent from Loki days later.
func TestSetupExportsLogsWithTheAccessHeaders(t *testing.T) {
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
		OTLPLogsEndpoint:   collector.URL + "/v1/logs",
		AccessClientID:     "id.access",
		AccessClientSecret: "shhh",
	}

	ctx := context.Background()
	shutdown, err := telemetry.Setup(ctx, cfg)
	if err != nil {
		t.Fatalf("Setup() returned an unexpected error: %v", err)
	}

	// NewHandler must run after Setup: it fans out to whatever global
	// LoggerProvider Setup just installed.
	logger := slog.New(telemetry.NewHandler(io.Discard, slog.LevelInfo))
	logger.InfoContext(ctx, "a log line")

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
		if got.path != "/v1/logs" {
			t.Errorf("path = %q, want /v1/logs — the endpoint's own path must be honoured", got.path)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no export reached the collector")
	}
}

// With no logs endpoint the worker still logs to stdout and exports nothing —
// same contract tracing already has, and for the same reason: `go run
// ./cmd/worker` against a dev API has no collector in reach.
func TestSetupWithLogsDisabledIsAWorkingNoOp(t *testing.T) {
	ctx := context.Background()

	shutdown, err := telemetry.Setup(ctx, config.Config{
		APIBaseURL:  "https://api.example.com",
		Environment: "test",
		WorkerID:    "worker-under-test",
	})
	if err != nil {
		t.Fatalf("Setup() returned an unexpected error: %v", err)
	}

	logger := slog.New(telemetry.NewHandler(io.Discard, slog.LevelInfo))
	logger.InfoContext(ctx, "a log line")

	if err := shutdown(ctx); err != nil {
		t.Fatalf("shutdown() returned an unexpected error: %v", err)
	}
}
