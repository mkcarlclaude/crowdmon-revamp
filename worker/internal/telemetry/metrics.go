// Package telemetry (this file) adds OTLP metrics export — M8.2's second
// acceptance criterion: "Frames extracted, frames kept and dedup ratio
// emitted as metrics."
//
// CONTEXT.md §6 records "Spans, not metrics" as a settled decision, which
// looks like a contradiction with this file until the scope is checked: that
// decision was about the Cloudflare Worker, where @microlabs/otel-cf-workers
// exports traces only and a counter would have had nowhere to go — the choice
// was never open there. This is the Go worker. It runs the full OTel SDK, and
// the home collector's pipeline was verified to carry an `otlp` receiver into
// a `metrics` pipeline that lands on a `prometheus` exporter on
// `0.0.0.0:8889`, scraped by Prometheus (see otel-collector-config.yaml on
// the box). The constraint that forced spans-only on the edge does not exist
// on this side, so it does not apply here.
package telemetry

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/metric/noop"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/config"
)

// meterName is the instrumentation scope frame-extraction metrics register
// under. A fixed string rather than the frames package's own import path:
// this file is built without depending on internal/frames (another agent
// owns it this milestone), and the scope name is metadata Prometheus never
// surfaces anyway — only the meter provider it resolves against matters.
const meterName = "github.com/mkcarlclaude/crowdmon-revamp/worker/internal/frames"

// setupMetrics installs the global MeterProvider that FrameMetrics reads
// from — a real periodic-export exporter when metrics are configured, a
// no-op provider when they are not, so NewFrameMetrics never has to branch on
// whether export is enabled. Mirrors setupLogs and setupTracing exactly, for
// the same reason: three signals, one process-global install pattern.
func setupMetrics(ctx context.Context, res *resource.Resource, cfg config.Config) (func(context.Context) error, error) {
	noopShutdown := func(context.Context) error { return nil }

	if !cfg.MetricsEnabled() {
		otel.SetMeterProvider(noop.NewMeterProvider())
		return noopShutdown, nil
	}

	exporter, err := otlpmetrichttp.New(ctx,
		otlpmetrichttp.WithEndpointURL(cfg.OTLPMetricsEndpoint),
		otlpmetrichttp.WithHeaders(map[string]string{
			"CF-Access-Client-Id":     cfg.AccessClientID,
			"CF-Access-Client-Secret": cfg.AccessClientSecret,
		}),
	)
	if err != nil {
		return noopShutdown, fmt.Errorf("building the OTLP metric exporter: %w", err)
	}

	provider := sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(res),
		// Periodic rather than a manual reader: a chunk job runs 10-20
		// minutes and a counter that only exports at process shutdown would
		// make Grafana lag behind reality for the length of a job. The
		// default 60s interval is the same tradeoff the batched trace and
		// log exporters make — a network round trip per data point would be
		// absurd against instruments that fire per frame.
		//
		// No WithInterval override — this is still the SDK's default 60s,
		// left untouched deliberately now that the queue.depth gauge (M9.1)
		// shares this same reader. That gauge's callback makes one HTTP
		// request to the API's /api/jobs/stats per collection, whether or not
		// anything in the queue changed, so the interval is also this
		// worker's new request budget: 86400/60 = 1,440 requests/day, on top
		// of the ~1,000/day idle-poll budget CONTEXT.md §Q20 already spends
		// (Workers' free tier is 100,000/day, so the two together are still
		// under 2.5% of it). A longer interval would buy back some of that
		// budget at the cost of a staler queue-depth panel; 60s was kept
		// because the frame-extraction counters already made that call and a
		// second reader on its own interval would mean a second exporter,
		// for a saving that does not matter yet.
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exporter)),
	)
	otel.SetMeterProvider(provider)

	return provider.Shutdown, nil
}

// FrameMetrics is the extraction pipeline's one handle onto every instrument
// M8.2 requires. Declared here, once, so call sites in internal/frames do a
// single NewFrameMetrics() rather than each doing their own
// otel.Meter(...).Int64Counter(...) lookup — four instrument constructions
// scattered across the pipeline instead of one, and four chances for a typo'd
// name to split a series in Prometheus.
type FrameMetrics struct {
	framesExtracted metric.Int64Counter
	framesKept      metric.Int64Counter
	dedupRatio      metric.Float64Histogram
	chunkDuration   metric.Float64Histogram
}

// NewFrameMetrics builds the four instruments against whatever MeterProvider
// is currently global — a real one when Setup ran with metrics configured, a
// no-op otherwise. Must run after Setup for the same reason NewHandler must:
// the global provider Setup installs is the one this resolves against, and
// calling this first would silently bind every instrument to the SDK
// default's no-op provider forever.
func NewFrameMetrics() (*FrameMetrics, error) {
	meter := otel.GetMeterProvider().Meter(meterName)

	// Counters: frames.extracted and frames.kept are monotonic totals. What
	// a dashboard wants from a counter is its *rate* — frames per second
	// across the fleet — and Prometheus derives that from a running total
	// far more cheaply than from a pre-computed rate this process would have
	// to re-derive a window for. Unit {frame} per UCUM annotation
	// conventions: a bare count, not a physical unit, so the annotation is
	// what keeps two counters named similarly from being compared as if they
	// shared a unit.
	framesExtracted, err := meter.Int64Counter("frames.extracted",
		metric.WithDescription("Frames decoded from a chunk before dedup."),
		metric.WithUnit("{frame}"),
	)
	if err != nil {
		return nil, fmt.Errorf("building the frames.extracted counter: %w", err)
	}

	framesKept, err := meter.Int64Counter("frames.kept",
		metric.WithDescription("Frames retained after dedup — the ones actually written to R2."),
		metric.WithUnit("{frame}"),
	)
	if err != nil {
		return nil, fmt.Errorf("building the frames.kept counter: %w", err)
	}

	// Histogram, not a counter or gauge: a ratio is a distribution over
	// chunks, and the one number a dashboard must never show is the mean of
	// per-chunk ratios averaged again in the exporter — that collapses a
	// bimodal "mostly static shots, occasional fast-motion chunk" pattern
	// into a meaningless middle value. A histogram keeps the buckets, so p50
	// vs p99 dedup ratio is answerable; a gauge sampling "the last chunk's
	// ratio" would just be noise between scrapes. Unit "1" per UCUM — a
	// dimensionless ratio, not a count of anything.
	dedupRatio, err := meter.Float64Histogram("frames.dedup.ratio",
		metric.WithDescription("kept/extracted for one chunk. A histogram, not a gauge, because averaging a ratio across chunks in the exporter would be meaningless."),
		metric.WithUnit("1"),
	)
	if err != nil {
		return nil, fmt.Errorf("building the frames.dedup.ratio histogram: %w", err)
	}

	// chunk.duration in seconds, not milliseconds: OTel's semantic-convention
	// guidance for duration metrics (the same rule http.server.request.duration
	// follows) is base units unless sub-millisecond precision is load-bearing,
	// and a chunk here runs whole seconds to low minutes — milliseconds would
	// just be trailing zeros with extra conversion at every call site.
	chunkDuration, err := meter.Float64Histogram("chunk.duration",
		metric.WithDescription("Wall time to extract and dedup one chunk."),
		metric.WithUnit("s"),
	)
	if err != nil {
		return nil, fmt.Errorf("building the chunk.duration histogram: %w", err)
	}

	return &FrameMetrics{
		framesExtracted: framesExtracted,
		framesKept:      framesKept,
		dedupRatio:      dedupRatio,
		chunkDuration:   chunkDuration,
	}, nil
}

// RecordExtracted adds n to frames.extracted. Called once a chunk's decode
// pass finishes, before dedup runs.
func (m *FrameMetrics) RecordExtracted(ctx context.Context, n int64) {
	// No crowdmon.video.id attribute, deliberately. A video id is unbounded
	// cardinality — every video ever submitted gets its own label value —
	// and Prometheus keeps every series it has ever seen in memory for the
	// life of the TSDB block. Attributing per-video here is how a metrics
	// pipeline becomes the thing that fills the box's memory, discovered
	// months from now as "why is Prometheus OOMing" with no obvious link
	// back to this line. deployment.environment.name and service.instance.id
	// on the shared resource are the only dimensions this needs — both
	// bounded by how many workers exist, not by how many videos are ever
	// processed.
	m.framesExtracted.Add(ctx, n)
}

// RecordKept adds n to frames.kept. Called once dedup has decided which
// frames survive.
func (m *FrameMetrics) RecordKept(ctx context.Context, n int64) {
	m.framesKept.Add(ctx, n)
}

// RecordDedupRatio records one chunk's kept/extracted ratio. The caller
// computes the division rather than this method taking both counts: the
// ratio is undefined at extracted == 0, and that is a decision the pipeline
// (which knows whether a zero-frame chunk is an error or a legitimate no-op)
// is better placed to make than this package guessing.
func (m *FrameMetrics) RecordDedupRatio(ctx context.Context, ratio float64) {
	m.dedupRatio.Record(ctx, ratio)
}

// RecordChunkDuration records how long one chunk took to extract and dedup.
func (m *FrameMetrics) RecordChunkDuration(ctx context.Context, d time.Duration) {
	m.chunkDuration.Record(ctx, d.Seconds())
}

// QueueCount is one (status, kind) combination's row count, as read off the
// stats endpoint M9.1 adds (apps/api/src/routes/jobs.ts's jobStatsHandler).
//
// A plain struct rather than this package importing the queue package's
// api-derived types: FrameMetrics already keeps telemetry unaware of the
// frames package's types for the same reason (NewFrameMetrics's doc comment
// on meterName), and the dependency belongs pointing at telemetry, not the
// other way round. cmd/worker is where both packages are already imported,
// so it is where the adapter from queue.Client.Stats to a []QueueCount lives.
type QueueCount struct {
	Status string
	Kind   string
	Count  int64
}

// QueueDepthFetcher is telemetry's whole view of the queue: whatever can
// answer "how many jobs sit at each status and kind combination right now."
// A function type rather than an interface with one method, for the same
// reason worker.PollFunc is a function and not an interface (loop.go) — the
// caller has nothing else to implement.
type QueueDepthFetcher func(ctx context.Context) ([]QueueCount, error)

// queueDepthCallbackTimeout bounds one collection's call to fetch,
// independent of whatever timeout the HTTP client underneath it carries.
// queue.Client already bounds every request it makes to 30s (queue.go's
// requestTimeout), but that number is sized for the job lifecycle, where a
// slow claim is still worth waiting out. This callback runs on the SDK's own
// export timer, sharing it with the frame-extraction instruments (see
// setupMetrics's comment on why there is only one reader), so a call left
// free to run the full 30s would delay every other point in that same
// collection behind a queue-depth read nobody is blocking on. Ten seconds is
// short enough that a stalled call costs one missed point on a chart that
// updates every 60s, not a stall the operator would ever notice as such.
const queueDepthCallbackTimeout = 10 * time.Second

// NewQueueDepthGauge registers queue.depth as an observable gauge, backed by
// fetch — cmd/worker supplies a closure over queue.Client.Stats. Observable
// rather than a synchronous instrument (contrast FrameMetrics's counters and
// histograms): nothing in this process holds a running count to add to or
// record against. The depth lives in D1, not in this worker's memory, and an
// Int64ObservableGauge's callback is exactly the shape OTel gives for "ask
// something external whenever the SDK is about to export."
//
// Two things this callback exists to get right, beyond the SDK plumbing:
//
//   - Telemetry must never be the reason a job fails, and this callback runs
//     entirely off the SDK's own export timer, decoupled from PollOnce — an
//     error here cannot block or fail a job the way a queue.Client method
//     returning one would, because nothing in the job lifecycle is waiting on
//     it. So a failed fetch is logged and swallowed rather than returned to
//     the SDK: returning an error would drop every instrument sharing this
//     collection (this gauge included) for that one interval, which is worse
//     than the one missing point a plain log line costs. The API being
//     unreachable becomes a gap in the queue-depth graph, never a reason the
//     worker stops claiming jobs.
//   - Zero must be reported as zero. fetch is expected to return all eight
//     (status, kind) combinations every time — that is what the API's
//     zero-fill (schemas.ts's JobStats comment) buys back here — and this
//     function observes every element it is given without filtering zeros
//     out. Doing otherwise would make a drained queue and a worker that
//     stopped exporting indistinguishable in Prometheus, which is the one
//     failure mode M9.1's queue-depth panel exists to catch.
func NewQueueDepthGauge(fetch QueueDepthFetcher, logger *slog.Logger) error {
	meter := otel.GetMeterProvider().Meter(meterName)

	_, err := meter.Int64ObservableGauge("queue.depth",
		metric.WithDescription("D1 job rows by status and kind, refreshed once per metrics export interval (M9.1)."),
		metric.WithUnit("{job}"),
		metric.WithInt64Callback(func(ctx context.Context, o metric.Int64Observer) error {
			ctx, cancel := context.WithTimeout(ctx, queueDepthCallbackTimeout)
			defer cancel()

			counts, err := fetch(ctx)
			if err != nil {
				logger.WarnContext(ctx, "reading queue depth for the queue.depth gauge failed", "error", err)
				return nil
			}

			for _, c := range counts {
				o.Observe(c.Count, metric.WithAttributes(
					attribute.String("status", c.Status),
					attribute.String("kind", c.Kind),
				))
			}
			return nil
		}),
	)
	if err != nil {
		return fmt.Errorf("building the queue.depth gauge: %w", err)
	}

	return nil
}
