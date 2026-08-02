package worker_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/worker"
)

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// recorder is the fake at the seam: it records when each poll happened and
// replays a scripted set of outcomes. Wall-clock gaps are the only way to
// observe the loop's waiting from outside it, so the tests below use
// millisecond intervals and assert on *ordering* of gaps rather than their
// exact size — a busy CI runner may stretch them but cannot reorder them.
type recorder struct {
	mu      sync.Mutex
	calls   []time.Time
	outcome func(n int) (bool, error)
	release chan struct{}
}

func (r *recorder) poll(ctx context.Context) (bool, error) {
	r.mu.Lock()
	r.calls = append(r.calls, time.Now())
	n := len(r.calls)
	r.mu.Unlock()

	if r.release != nil {
		select {
		case <-r.release:
		case <-time.After(5 * time.Second):
		}
	}
	if r.outcome == nil {
		return false, nil
	}
	return r.outcome(n)
}

func (r *recorder) gaps() []time.Duration {
	r.mu.Lock()
	defer r.mu.Unlock()

	gaps := make([]time.Duration, 0, len(r.calls))
	for i := 1; i < len(r.calls); i++ {
		gaps = append(gaps, r.calls[i].Sub(r.calls[i-1]))
	}
	return gaps
}

func (r *recorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.calls)
}

func TestLoopRepollsImmediatelyAfterFindingWork(t *testing.T) {
	r := &recorder{outcome: func(n int) (bool, error) { return n <= 4, nil }}

	// An idle interval far longer than the test could tolerate: if a single
	// one of the first four polls waits, this cannot finish.
	loop := worker.Loop{
		Poll:    r.poll,
		Backoff: worker.NewBackoff(30*time.Second, 120*time.Second),
		Logger:  quietLogger(),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if err := loop.Run(ctx); err != nil {
		t.Fatalf("Run() returned an unexpected error: %v", err)
	}

	if got := r.count(); got != 5 {
		t.Fatalf("polled %d times, want 5 — four with work, then one empty that starts the wait", got)
	}
	for i, gap := range r.gaps() {
		if gap > 500*time.Millisecond {
			t.Errorf("gap %d after a poll that found work = %v, want no wait at all", i+1, gap)
		}
	}
}

func TestLoopBacksOffBetweenEmptyPolls(t *testing.T) {
	r := &recorder{}

	loop := worker.Loop{
		Poll:    r.poll,
		Backoff: worker.NewBackoff(20*time.Millisecond, 200*time.Millisecond),
		Logger:  quietLogger(),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	if err := loop.Run(ctx); err != nil {
		t.Fatalf("Run() returned an unexpected error: %v", err)
	}

	gaps := r.gaps()
	if len(gaps) < 3 {
		t.Fatalf("only %d gaps recorded, want at least 3 to see the doubling", len(gaps))
	}
	// Ordering, not magnitude. A poll that waits its stated interval cannot be
	// distinguished from one that waited slightly longer under load, but a
	// loop that is not backing off produces gaps that do not grow.
	for i := 1; i < 3; i++ {
		if gaps[i] <= gaps[i-1] {
			t.Errorf("gap %d (%v) did not exceed gap %d (%v) — the wait is not doubling",
				i+1, gaps[i], i, gaps[i-1])
		}
	}
}

// Work arriving after a long idle stretch has to put the loop back on the
// short interval, or the first job of the day is followed by a two-minute
// pause before the second — precisely when the queue is busiest.
func TestLoopReturnsToTheIdleIntervalAfterWork(t *testing.T) {
	// Empty, empty, found, then empty again. The wait after the third poll is
	// the one under test.
	r := &recorder{outcome: func(n int) (bool, error) { return n == 3, nil }}

	loop := worker.Loop{
		Poll:    r.poll,
		Backoff: worker.NewBackoff(20*time.Millisecond, 400*time.Millisecond),
		Logger:  quietLogger(),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()

	if err := loop.Run(ctx); err != nil {
		t.Fatalf("Run() returned an unexpected error: %v", err)
	}

	gaps := r.gaps()
	if len(gaps) < 4 {
		t.Fatalf("only %d gaps recorded, want at least 4", len(gaps))
	}
	// gaps[1] is the grown wait between the second and third polls; gaps[3]
	// is the wait after the poll that found work. Comparing the two needs no
	// absolute timings, which is what keeps this honest on a loaded runner.
	if gaps[3] >= gaps[1] {
		t.Errorf("wait after finding work = %v, want less than the grown wait %v that preceded it",
			gaps[3], gaps[1])
	}
}

// The queue being unreachable is the common failure — a Worker deploy, a DNS
// blip, the home box's uplink. It must not exit the loop, and it must not
// turn into a hot retry against an API that is already unhappy.
func TestLoopBacksOffOnAFailedPollRatherThanExiting(t *testing.T) {
	r := &recorder{outcome: func(int) (bool, error) { return false, errors.New("connection refused") }}

	loop := worker.Loop{
		Poll:    r.poll,
		Backoff: worker.NewBackoff(20*time.Millisecond, 200*time.Millisecond),
		Logger:  quietLogger(),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	if err := loop.Run(ctx); err != nil {
		t.Fatalf("Run() returned an unexpected error: %v", err)
	}

	if got := r.count(); got < 2 {
		t.Fatalf("polled %d times, want the loop to keep polling after an error", got)
	}
	gaps := r.gaps()
	if len(gaps) > 0 && gaps[0] < 15*time.Millisecond {
		t.Errorf("first gap after an error = %v, want a backoff and not a hot retry", gaps[0])
	}
}

func TestLoopStopsPromptlyWhileWaiting(t *testing.T) {
	r := &recorder{}

	loop := worker.Loop{
		Poll: r.poll,
		// Longer than the assertion below allows, so a loop that sleeps
		// through cancellation fails rather than passing slowly.
		Backoff: worker.NewBackoff(30*time.Second, 120*time.Second),
		Logger:  quietLogger(),
	}

	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan error, 1)
	go func() { done <- loop.Run(ctx) }()

	// Let the first (empty) poll happen and the wait begin.
	time.Sleep(50 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() returned an unexpected error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Run() did not return within a second of cancellation")
	}
}

// The graceful half of graceful shutdown. A job in flight holds a lease; if
// the loop abandoned it on SIGTERM the job would sit `claimed` until the
// reaper timed it out, delaying it by the whole lease window for no reason.
func TestLoopLetsAnInFlightPollFinishBeforeReturning(t *testing.T) {
	r := &recorder{release: make(chan struct{})}

	loop := worker.Loop{
		Poll:    r.poll,
		Backoff: worker.NewBackoff(20*time.Millisecond, 200*time.Millisecond),
		Logger:  quietLogger(),
	}

	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan error, 1)
	go func() { done <- loop.Run(ctx) }()

	// Wait for the poll to be in flight, then cancel underneath it.
	for r.count() == 0 {
		time.Sleep(time.Millisecond)
	}
	cancel()

	select {
	case <-done:
		t.Fatal("Run() returned while a poll was still in flight")
	case <-time.After(100 * time.Millisecond):
	}

	close(r.release)

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() returned an unexpected error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Run() did not return after the in-flight poll finished")
	}
}
