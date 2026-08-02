package worker

import (
	"context"
	"log/slog"
	"time"
)

// PollFunc attempts one unit of work and reports whether it found any.
//
// A function rather than an interface, and a bool rather than a job: the loop
// is about *when* to ask, and nothing about it changes when the answer grows
// a shape. M4.3 supplies the implementation that claims, heartbeats and
// completes; this package never learns what a job is.
type PollFunc func(ctx context.Context) (found bool, err error)

// Loop polls for work until its context is cancelled.
type Loop struct {
	Poll    PollFunc
	Backoff *Backoff
	Logger  *slog.Logger
}

// Run polls until ctx is cancelled, then returns nil.
//
// Cancellation is not an error: SIGTERM is how this process is *supposed* to
// end, and returning ctx.Err() would make every ordinary shutdown exit
// non-zero and restart-loop under Docker's restart policy.
func (l Loop) Run(ctx context.Context) error {
	for {
		// Checked before polling as well as while waiting. Without this a
		// cancellation that arrives during a wait would still be followed by
		// one more poll, which on shutdown means claiming a job the process
		// is about to drop.
		if ctx.Err() != nil {
			return nil
		}

		// ctx is passed *into* the poll, so an HTTP call in flight is
		// cancelled with it — but Run does not return until the call has
		// come back. A job in flight holds a lease, and abandoning it would
		// leave the row `claimed` until the reaper times it out.
		found, err := l.Poll(ctx)

		switch {
		case err != nil && ctx.Err() != nil:
			// The error is cancellation reaching the in-flight request. Not
			// worth a line: it is the expected shape of a clean shutdown.
			return nil
		case err != nil:
			// Deliberately backs off rather than retrying hot. The usual
			// cause is the API being unreachable, and a worker that answers
			// that by polling as fast as it can is the worst possible
			// neighbour to an API that is already unhappy.
			l.Logger.WarnContext(ctx, "poll failed", "error", err)
		case found:
			l.Backoff.Reset()
			continue
		}

		wait := l.Backoff.Next()
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
	}
}
