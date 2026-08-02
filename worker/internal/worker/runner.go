package worker

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/api"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/queue"
)

// DefaultHeartbeatInterval is the lease renewal cadence from CONTEXT.md §Q14.
// The reaper's staleness threshold is a multiple of it, so beating slower
// than this is how a healthy worker gets its own job taken away.
const DefaultHeartbeatInterval = 30 * time.Second

// reportTimeout bounds the completion call, which runs on a context detached
// from the caller's so that a job finishing as the process goes down is still
// reported. Detached and unbounded is how a shutdown hangs; this has to fit
// inside the container's stop grace period alongside the telemetry flush.
const reportTimeout = 5 * time.Second

// Queue is the runner's view of the API: exactly the three calls the job
// lifecycle needs. Declared here rather than in the queue package because
// this is the side that depends on it, which is also what lets the tests
// substitute a recorder without a network.
type Queue interface {
	Claim(ctx context.Context) (*api.Job, error)
	Heartbeat(ctx context.Context, jobID int) error
	Complete(ctx context.Context, jobID int, cause error) error
}

// WorkFunc runs a claimed job. Its context is cancelled if the lease is lost,
// so anything long-running inside it must respect the context rather than
// carry on with a job the queue has already handed to somebody else.
type WorkFunc func(ctx context.Context, job *api.Job) error

// Runner turns one poll into a complete job lifecycle: claim, hold the lease
// while working, report the outcome.
type Runner struct {
	Queue             Queue
	Logger            *slog.Logger
	HeartbeatInterval time.Duration

	// Work is the job itself. Nil succeeds immediately, which is M4.3's whole
	// behaviour: the round trip is what is being proven, and extraction does
	// not exist until M7.
	Work WorkFunc
}

// PollOnce claims a job and sees it through, reporting whether there was one.
// It satisfies PollFunc, which is the only thing the loop knows about it.
func (r Runner) PollOnce(ctx context.Context) (bool, error) {
	job, err := r.Queue.Claim(ctx)
	if err != nil {
		return false, err
	}
	if job == nil {
		return false, nil
	}

	logger := r.Logger.With("job_id", job.Id, "job_kind", string(job.Kind), "video_id", job.VideoId)
	logger.InfoContext(ctx, "claimed a job", "attempts", job.Attempts)

	// The lease context is cancelled by a lost lease as well as by shutdown,
	// so the work stops on either. It is derived from ctx, not replacing it,
	// so SIGTERM still reaches the work.
	leaseCtx, releaseLease := context.WithCancel(ctx)
	defer releaseLease()

	var leaseLost bool
	beating := r.keepLeaseAlive(leaseCtx, job.Id, logger, func() {
		leaseLost = true
		releaseLease()
	})

	workErr := r.work(leaseCtx, job)

	// Stop beating before reporting, so a heartbeat cannot land after the
	// completion that closed the lease and renew a job this worker no longer
	// holds.
	releaseLease()
	<-beating

	if leaseLost {
		// Nothing to report: the job is already back in `pending` and may
		// well be running elsewhere. Completing it would be writing to
		// somebody else's lease, which the API rejects anyway.
		logger.WarnContext(ctx, "lease lost, dropping the job")
		return true, nil
	}

	// Detached from ctx, not derived from it. Reporting the outcome is the one
	// call that must still go out, and by this point ctx may already be
	// cancelled two ways: leaseCtx is released the moment work returns, and on
	// shutdown ctx itself is gone. Riding either would fail the report and
	// leave the row `claimed` until the reaper timed it out — which would make
	// the loop's whole reason for waiting on an in-flight poll a fiction.
	//
	// Bounded, because a detached context with no deadline is how a shutdown
	// hangs: this runs after SIGTERM, inside whatever grace period the
	// container was given.
	reportCtx, cancelReport := context.WithTimeout(context.WithoutCancel(ctx), reportTimeout)
	defer cancelReport()

	switch err := r.Queue.Complete(reportCtx, job.Id, workErr); {
	case errors.Is(err, queue.ErrLeaseLost):
		// The reaper got in between the last heartbeat and this call. Same
		// event as a heartbeat 404, so the same answer: drop it quietly.
		// Surfacing it would back the loop off from a queue that is working.
		logger.WarnContext(ctx, "lease lost before the outcome could be reported")
		return true, nil
	case err != nil:
		return true, err
	}

	if workErr != nil {
		logger.ErrorContext(ctx, "job failed", "error", workErr)
	} else {
		logger.InfoContext(ctx, "job done")
	}

	return true, nil
}

// work runs the job, or succeeds immediately when there is nothing to run.
func (r Runner) work(ctx context.Context, job *api.Job) error {
	if r.Work == nil {
		return nil
	}
	return r.Work(ctx, job)
}

// keepLeaseAlive beats until ctx is cancelled, calling onLeaseLost if the API
// says the job is no longer this worker's. The returned channel closes once
// the beating has stopped.
func (r Runner) keepLeaseAlive(
	ctx context.Context, jobID int, logger *slog.Logger, onLeaseLost func(),
) <-chan struct{} {
	interval := r.HeartbeatInterval
	if interval <= 0 {
		interval = DefaultHeartbeatInterval
	}

	stopped := make(chan struct{})

	go func() {
		defer close(stopped)

		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}

			switch err := r.Queue.Heartbeat(ctx, jobID); {
			case errors.Is(err, queue.ErrLeaseLost):
				onLeaseLost()
				return
			case errors.Is(err, context.Canceled):
				// The job finished or the process is shutting down and the
				// in-flight request was cancelled with it. Not a failure.
				return
			case err != nil:
				// Transient. Keep working and keep beating: giving up here
				// would abandon a job this worker still holds, and the reaper
				// would then wait out the whole lease window before anyone
				// picked it up.
				logger.WarnContext(ctx, "heartbeat failed", "error", err)
			}
		}
	}()

	return stopped
}
