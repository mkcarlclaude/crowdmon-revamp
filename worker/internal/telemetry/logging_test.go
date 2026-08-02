package telemetry_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"testing"

	"go.opentelemetry.io/otel"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/config"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/telemetry"
)

func decodeOneRecord(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()

	var record map[string]any
	if err := json.Unmarshal(buf.Bytes(), &record); err != nil {
		t.Fatalf("log line is not JSON (%v): %s", err, buf.String())
	}
	return record
}

// The whole point of the handler. A log line found in Loki has to name the
// trace it belongs to, or correlating the two means guessing by timestamp.
func TestLoggerTagsRecordsWithTheirTraceAndSpanIDs(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(telemetry.NewHandler(&buf, slog.LevelInfo))

	// A real provider, so the ids are real. The disabled path still creates
	// recording spans, which is what makes correlation work with no collector.
	if _, err := telemetry.Setup(context.Background(), config.Config{
		APIBaseURL:  "https://api.example.com",
		Environment: "test",
		WorkerID:    "worker-under-test",
	}); err != nil {
		t.Fatalf("Setup() returned an unexpected error: %v", err)
	}

	ctx, span := otel.Tracer("test").Start(context.Background(), "a-span")
	defer span.End()

	logger.InfoContext(ctx, "claimed a job")

	record := decodeOneRecord(t, &buf)
	if got, want := record["trace_id"], span.SpanContext().TraceID().String(); got != want {
		t.Errorf("trace_id = %v, want %q", got, want)
	}
	if got, want := record["span_id"], span.SpanContext().SpanID().String(); got != want {
		t.Errorf("span_id = %v, want %q", got, want)
	}
	if record["msg"] != "claimed a job" {
		t.Errorf("msg = %v, want %q", record["msg"], "claimed a job")
	}
}

// Startup, shutdown and the poll loop's own logging all happen outside any
// span. Those lines must still be emitted, and must not carry the all-zero id
// that an unset span context reports.
func TestLoggerOmitsTraceIDsOutsideASpan(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(telemetry.NewHandler(&buf, slog.LevelInfo))

	logger.InfoContext(context.Background(), "starting up")

	record := decodeOneRecord(t, &buf)
	if _, present := record["trace_id"]; present {
		t.Errorf("trace_id present on a record logged outside a span: %v", record["trace_id"])
	}
	if record["msg"] != "starting up" {
		t.Errorf("msg = %v, want %q", record["msg"], "starting up")
	}
}

// The poll loop hands each job a sub-logger carrying its id, so almost every
// interesting line in this worker comes from a With() logger rather than the
// root one. A handler that returns the *embedded* handler from WithAttrs
// keeps the attributes and silently loses the correlation — every line still
// looks right, and none of them can be tied to a trace.
func TestLoggerKeepsCorrelationThroughWith(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(telemetry.NewHandler(&buf, slog.LevelInfo)).With("job_id", 7)

	if _, err := telemetry.Setup(context.Background(), config.Config{
		APIBaseURL:  "https://api.example.com",
		Environment: "test",
		WorkerID:    "worker-under-test",
	}); err != nil {
		t.Fatalf("Setup() returned an unexpected error: %v", err)
	}

	ctx, span := otel.Tracer("test").Start(context.Background(), "a-span")
	defer span.End()

	logger.InfoContext(ctx, "working")

	record := decodeOneRecord(t, &buf)
	if record["job_id"] != float64(7) {
		t.Errorf("job_id = %v, want 7", record["job_id"])
	}
	if got, want := record["trace_id"], span.SpanContext().TraceID().String(); got != want {
		t.Errorf("trace_id = %v, want %q", got, want)
	}
}

// Under a group the ids nest with everything else the group holds. The
// worker never opens one — this pins the behaviour so that if something ever
// does, the cost is visible here rather than as a Loki query that matches
// nothing.
func TestLoggerNestsCorrelationUnderAnOpenGroup(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(telemetry.NewHandler(&buf, slog.LevelInfo).WithGroup("job"))

	if _, err := telemetry.Setup(context.Background(), config.Config{
		APIBaseURL:  "https://api.example.com",
		Environment: "test",
		WorkerID:    "worker-under-test",
	}); err != nil {
		t.Fatalf("Setup() returned an unexpected error: %v", err)
	}

	ctx, span := otel.Tracer("test").Start(context.Background(), "a-span")
	defer span.End()

	logger.InfoContext(ctx, "working")

	record := decodeOneRecord(t, &buf)
	group, ok := record["job"].(map[string]any)
	if !ok {
		t.Fatalf("expected a %q group in the record, got: %s", "job", buf.String())
	}
	if got, want := group["trace_id"], span.SpanContext().TraceID().String(); got != want {
		t.Errorf("job.trace_id = %v, want %q", got, want)
	}
}

func TestLoggerDropsRecordsBelowItsLevel(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(telemetry.NewHandler(&buf, slog.LevelInfo))

	logger.DebugContext(context.Background(), "noisy")

	if buf.Len() != 0 {
		t.Errorf("a debug record was written to an info-level handler: %s", buf.String())
	}
}
