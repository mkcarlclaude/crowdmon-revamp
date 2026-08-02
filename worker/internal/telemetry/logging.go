package telemetry

import (
	"context"
	"io"
	"log/slog"

	"go.opentelemetry.io/otel/trace"
)

// handler is a slog.Handler that stamps every record with the ids of the span
// its context carries.
//
// A wrapper rather than a from-scratch handler: JSON encoding, levelling and
// attribute resolution are slog's problem, and the only thing this adds is two
// attributes. Everything else delegates.
type handler struct{ slog.Handler }

// NewHandler builds the worker's log handler: JSON to w, at or above level,
// with trace correlation.
//
// JSON because these lines are read by Loki far more often than by a human —
// and when a human does read them, `docker compose logs | jq` is a fair price
// for being able to filter on trace_id at all.
func NewHandler(w io.Writer, level slog.Level) slog.Handler {
	return &handler{Handler: slog.NewJSONHandler(w, &slog.HandlerOptions{Level: level})}
}

// Handle adds trace_id and span_id when the context is inside a recording
// span, and adds nothing when it is not. An unsampled or absent span reports
// an all-zero id, and emitting that would be worse than emitting nothing: it
// looks like a real id and matches every other line that lacked a span.
func (h *handler) Handle(ctx context.Context, record slog.Record) error {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		record.AddAttrs(
			slog.String("trace_id", sc.TraceID().String()),
			slog.String("span_id", sc.SpanID().String()),
		)
	}
	return h.Handler.Handle(ctx, record)
}

// WithAttrs and WithGroup have to be overridden even though they only
// delegate: the embedded handler returns a bare slog.Handler, so without
// these a sub-logger built by With() would quietly lose the correlation while
// still logging everything else correctly — the worst kind of broken.
//
// Under an open group the ids nest inside it, because a record's attributes
// cannot straddle a group boundary. The worker logs flat and never opens one.

func (h *handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &handler{Handler: h.Handler.WithAttrs(attrs)}
}

func (h *handler) WithGroup(name string) slog.Handler {
	return &handler{Handler: h.Handler.WithGroup(name)}
}
