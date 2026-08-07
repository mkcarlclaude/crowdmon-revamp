// Package telemetry wires this process into the observability spine M2 built:
// spans over OTLP HTTP to the collector behind otlp.mkcarl.com, logs that
// carry the ids of the span they were emitted under, and — as of M8.2 —
// metrics counting frame extraction and dedup for chunk jobs.
//
// All three are set up here rather than at the call sites because all three are
// process-global — OTel's tracer, logger and meter providers are single
// values, and having independent packages race to install them is how a worker
// ends up exporting to nowhere.
package telemetry

import (
	"context"
	"errors"
	"fmt"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.27.0"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/config"
)

// Setup installs the global tracer provider, logger provider, meter provider
// and propagator, and returns the shutdown that flushes whatever is still
// buffered in any of them.
//
// The returned shutdown is always non-nil, including on the disabled path and
// on error, so callers can defer it unconditionally instead of guarding every
// early return.
func Setup(ctx context.Context, cfg config.Config) (func(context.Context) error, error) {
	noop := func(context.Context) error { return nil }

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(config.ServiceName),
			// The lease holder, and the one attribute that tells two workers
			// apart once there is more than one. Same string the queue sees in
			// `claimed_by`, so a job row and its spans can be lined up by eye.
			semconv.ServiceInstanceID(cfg.WorkerID),
			attribute.String("deployment.environment.name", cfg.Environment),
		),
	)
	if err != nil {
		return noop, fmt.Errorf("building the telemetry resource: %w", err)
	}

	// Set even when tracing is disabled. Spans are still created and still
	// carry ids, so the log correlation in NewHandler works with no collector
	// in reach — the ids just never leave the process.
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{},
	))

	shutdownTracing, err := setupTracing(ctx, res, cfg)
	if err != nil {
		return noop, err
	}

	shutdownLogs, err := setupLogs(ctx, res, cfg)
	if err != nil {
		return shutdownTracing, err
	}

	shutdownMetrics, err := setupMetrics(ctx, res, cfg)
	if err != nil {
		// Tracing and logs already installed successfully — their shutdowns
		// still have to run on the way out even though metrics failed to set
		// up, or a worker that fails only the metrics half loses trace and
		// log export it never needed to lose.
		return func(ctx context.Context) error {
			return errors.Join(shutdownTracing(ctx), shutdownLogs(ctx))
		}, err
	}

	// All three flushed on the way out. A worker that exports all three
	// signals must not lose one because another's Shutdown errored first —
	// collecting rather than short-circuiting is what makes that true.
	return func(ctx context.Context) error {
		return errors.Join(shutdownTracing(ctx), shutdownLogs(ctx), shutdownMetrics(ctx))
	}, nil
}

func setupTracing(ctx context.Context, res *resource.Resource, cfg config.Config) (func(context.Context) error, error) {
	noop := func(context.Context) error { return nil }

	if !cfg.TracingEnabled() {
		otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithResource(res)))
		return noop, nil
	}

	// WithEndpointURL rather than WithEndpoint: the collector is reached
	// through a path (`/v1/traces`) on a host that fronts other things, and
	// WithEndpoint takes a host:port and appends the default path itself.
	// It also derives the scheme, so an http:// endpoint needs no separate
	// WithInsecure.
	exporter, err := otlptracehttp.New(ctx,
		otlptracehttp.WithEndpointURL(cfg.OTLPEndpoint),
		otlptracehttp.WithHeaders(map[string]string{
			"CF-Access-Client-Id":     cfg.AccessClientID,
			"CF-Access-Client-Secret": cfg.AccessClientSecret,
		}),
	)
	if err != nil {
		return noop, fmt.Errorf("building the OTLP trace exporter: %w", err)
	}

	provider := sdktrace.NewTracerProvider(
		sdktrace.WithResource(res),
		// Batched, not synchronous: a job's spans must not pay a network round
		// trip each, and the worker is long-lived enough for a batcher to be
		// the obvious shape. Sampling stays at the default of "record
		// everything" — CONTEXT.md §9.4 leaves the sampling posture open, and
		// this worker's span volume is a few per job.
		sdktrace.WithBatcher(exporter),
	)
	otel.SetTracerProvider(provider)

	return provider.Shutdown, nil
}
