package telemetry

import (
	"context"
	"fmt"

	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/log/noop"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/resource"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/config"
)

// setupLogs installs the global LoggerProvider that NewHandler's OTel bridge
// reads from — a real batched exporter when logs are configured, a no-op
// provider when they are not, so NewHandler never has to branch on whether
// export is enabled. Mirrors setupTracing exactly, for the same reason.
func setupLogs(ctx context.Context, res *resource.Resource, cfg config.Config) (func(context.Context) error, error) {
	noopShutdown := func(context.Context) error { return nil }

	if !cfg.LogsEnabled() {
		global.SetLoggerProvider(noop.NewLoggerProvider())
		return noopShutdown, nil
	}

	exporter, err := otlploghttp.New(ctx,
		otlploghttp.WithEndpointURL(cfg.OTLPLogsEndpoint),
		otlploghttp.WithHeaders(map[string]string{
			"CF-Access-Client-Id":     cfg.AccessClientID,
			"CF-Access-Client-Secret": cfg.AccessClientSecret,
		}),
	)
	if err != nil {
		return noopShutdown, fmt.Errorf("building the OTLP log exporter: %w", err)
	}

	provider := sdklog.NewLoggerProvider(
		sdklog.WithResource(res),
		// Batched to match the trace exporter — a log line must not pay a
		// network round trip each, and stdout already gives the worker an
		// unbuffered copy for anyone watching `docker compose logs` live.
		sdklog.WithProcessor(sdklog.NewBatchProcessor(exporter)),
	)
	global.SetLoggerProvider(provider)

	return provider.Shutdown, nil
}
