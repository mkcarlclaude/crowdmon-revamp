// Command worker is the home-side extraction worker.
//
// It is still a skeleton: the poll loop lands in M4.2, claim and complete in
// M4.3, and extraction not until M7. What is here is the process shell —
// configuration, telemetry, and a context a signal cancels — which everything
// after this hangs off.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/config"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/telemetry"
)

// How long shutdown gets to flush buffered spans once the process is on its
// way out. Docker's default stop grace period is 10s and the container is
// killed at the end of it, so this has to leave room for the rest of shutdown.
const flushTimeout = 5 * time.Second

func main() {
	// Signals are wired before anything else can block, so a worker stuck on a
	// misconfigured collector still answers Ctrl-C. SIGTERM is the one that
	// matters in production — it is what `docker stop` sends.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx); err != nil {
		slog.Error("worker exiting on error", "error", err)
		os.Exit(1)
	}
}

// run is separated from main so that every path out of it runs the deferred
// shutdowns. os.Exit skips defers, and a skipped provider.Shutdown means the
// last spans before a fatal error — the interesting ones — never leave.
func run(ctx context.Context) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	shutdown, err := telemetry.Setup(ctx, cfg)
	if err != nil {
		return err
	}
	defer func() {
		// A fresh context: ctx is already cancelled by the time this runs on
		// the signal path, and a cancelled context flushes nothing.
		flushCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), flushTimeout)
		defer cancel()

		if err := shutdown(flushCtx); err != nil {
			slog.Warn("telemetry shutdown did not complete cleanly", "error", err)
		}
	}()

	logger := slog.New(telemetry.NewHandler(os.Stdout, slog.LevelInfo))
	slog.SetDefault(logger)

	logger.InfoContext(ctx, "worker starting",
		"service", config.ServiceName,
		"environment", cfg.Environment,
		"worker_id", cfg.WorkerID,
		"api_base_url", cfg.APIBaseURL,
		"tracing", cfg.TracingEnabled(),
	)

	// The poll loop lands in M4.2 and takes this same ctx. Until then the
	// process proves the shell works and exits on a signal rather than
	// immediately, which is what makes it a container worth deploying.
	<-ctx.Done()

	logger.InfoContext(ctx, "worker stopping")
	return nil
}
