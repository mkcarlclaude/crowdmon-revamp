package telemetry

import (
	"context"
	"errors"
	"io"
	"log/slog"

	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/otel/trace"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/config"
)

// handler is a slog.Handler that stamps every record with the ids of the span
// its context carries.
//
// A wrapper rather than a from-scratch handler: JSON encoding, levelling and
// attribute resolution are slog's problem, and the only thing this adds is two
// attributes. Everything else delegates.
type handler struct{ slog.Handler }

// NewHandler builds the worker's log handler: JSON to w, at or above level,
// with trace correlation, fanned out to the OTLP log exporter Setup installed
// (a real one when logs are configured, a no-op otherwise — see setupLogs).
//
// JSON to w because these lines are also read by a human sometimes, and when
// that happens `docker compose logs | jq` is a fair price for being able to
// filter on trace_id. The OTLP copy is how they reach Loki: Setup must run
// before this so the global LoggerProvider it installs is the real one.
func NewHandler(w io.Writer, level slog.Level) slog.Handler {
	stdout := &handler{Handler: slog.NewJSONHandler(w, &slog.HandlerOptions{Level: level})}
	otlp := otelslog.NewHandler(config.ServiceName)
	return multiHandler{stdout, otlp}
}

// multiHandler fans one record out to every handler it wraps. slog has no
// built-in for this — Handler is one interface with no notion of a list —
// and pulling in a dependency for what amounts to four one-line loops was not
// worth it.
type multiHandler []slog.Handler

func (m multiHandler) Enabled(ctx context.Context, level slog.Level) bool {
	for _, h := range m {
		if h.Enabled(ctx, level) {
			return true
		}
	}
	return false
}

// Handle calls every handler regardless of an individual failure — one
// destination being down (an unreachable collector) must not silence stdout,
// and vice versa. errors.Join reports both if both fail.
func (m multiHandler) Handle(ctx context.Context, record slog.Record) error {
	var errs []error
	for _, h := range m {
		if h.Enabled(ctx, record.Level) {
			if err := h.Handle(ctx, record.Clone()); err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}

func (m multiHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	next := make(multiHandler, len(m))
	for i, h := range m {
		next[i] = h.WithAttrs(attrs)
	}
	return next
}

func (m multiHandler) WithGroup(name string) slog.Handler {
	next := make(multiHandler, len(m))
	for i, h := range m {
		next[i] = h.WithGroup(name)
	}
	return next
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
