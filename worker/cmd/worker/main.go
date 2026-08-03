// Command worker is the home-side extraction worker.
//
// It polls the queue, claims a job, holds the lease while it runs, and reports
// the outcome. What it does not do is any video work: Runner.Work is nil, so a
// claimed job is reported done immediately. Extraction lands in M7 and slots
// in there, which is the only line of this file it should need to change.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/config"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/queue"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/telemetry"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/worker"
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

	jobs, err := queue.New(cfg.APIBaseURL, cfg.WorkerID)
	if err != nil {
		return err
	}

	// Work is nil by default: M4.3 claims a job, holds the lease, and reports
	// it done without touching the video. Extraction lands in M7 and slots in
	// here.
	//
	// CROWDMON_SIMULATED_WORK substitutes a job that merely takes time, which
	// M6.4 needs — killing a worker mid-job requires a job with a middle, and
	// the real one closes in about 90ms. Nothing else reads the setting, and
	// M7 removes it.
	var work worker.WorkFunc
	if cfg.SimulatedWork > 0 {
		logger.WarnContext(ctx, "simulating work instead of running jobs",
			"duration", cfg.SimulatedWork)
		work = worker.SimulatedWork(cfg.SimulatedWork)
	}

	runner := worker.Runner{
		Queue:             jobs,
		Logger:            logger,
		HeartbeatInterval: worker.DefaultHeartbeatInterval,
		Work:              work,
	}

	loop := worker.Loop{
		Poll:    runner.PollOnce,
		Backoff: worker.NewBackoff(worker.IdleInterval, worker.MaxInterval),
		Logger:  logger,
	}

	if err := loop.Run(ctx); err != nil {
		return err
	}

	logger.InfoContext(ctx, "worker stopping")
	return nil
}
