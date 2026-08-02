package worker_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/api"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/queue"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/worker"
)

// fakeQueue stands in for the API at the seam the runner actually depends on.
// The wire is already covered by the queue package's own tests against an
// httptest server; what is under test here is the *order* of operations and
// what happens when one of them fails.
type fakeQueue struct {
	mu sync.Mutex

	job       *api.Job
	claimErr  error
	heartbeat func(n int) error

	completeErr error

	claims         int
	heartbeats     int
	completed      bool
	completeID     int
	cause          error
	completeCtxErr error
}

func (q *fakeQueue) Claim(context.Context) (*api.Job, error) {
	q.mu.Lock()
	defer q.mu.Unlock()

	q.claims++
	return q.job, q.claimErr
}

func (q *fakeQueue) Heartbeat(_ context.Context, _ int) error {
	q.mu.Lock()
	n := q.heartbeats + 1
	q.heartbeats = n
	handler := q.heartbeat
	q.mu.Unlock()

	if handler == nil {
		return nil
	}
	return handler(n)
}

func (q *fakeQueue) Complete(ctx context.Context, jobID int, cause error) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	// Recorded, not asserted on directly: what matters is whether the report
	// could still have gone out, and a cancelled context is exactly what stops
	// it from doing so.
	q.completeCtxErr = ctx.Err()

	if q.completeErr != nil {
		return q.completeErr
	}

	q.completed = true
	q.completeID = jobID
	q.cause = cause
	return nil
}

func (q *fakeQueue) beats() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.heartbeats
}

func aJob() *api.Job {
	return &api.Job{
		Id:       7,
		Kind:     "download",
		VideoId:  "dQw4w9WgXcQ",
		VideoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		Attempts: 1,
	}
}

func TestRunnerReportsAnEmptyQueueAsNoWork(t *testing.T) {
	q := &fakeQueue{}
	runner := worker.Runner{Queue: q, Logger: quietLogger()}

	found, err := runner.PollOnce(context.Background())
	if err != nil {
		t.Fatalf("PollOnce() returned an unexpected error: %v", err)
	}
	if found {
		t.Error("PollOnce() reported work on an empty queue")
	}
	if q.completed {
		t.Error("PollOnce() completed something on an empty queue")
	}
}

// M4.3 does no extraction: a claimed job is reported done immediately. The
// point of the round trip is that the lifecycle closes, not that anything
// happened in the middle.
func TestRunnerCompletesAClaimedJob(t *testing.T) {
	q := &fakeQueue{job: aJob()}
	runner := worker.Runner{Queue: q, Logger: quietLogger()}

	found, err := runner.PollOnce(context.Background())
	if err != nil {
		t.Fatalf("PollOnce() returned an unexpected error: %v", err)
	}
	if !found {
		t.Error("PollOnce() reported no work after claiming a job")
	}
	if !q.completed || q.completeID != 7 {
		t.Errorf("completed = %v for job %d, want true for job 7", q.completed, q.completeID)
	}
	if q.cause != nil {
		t.Errorf("job was reported as failed with %v, want a success", q.cause)
	}
}

// Work that fails must still close the lease. A worker that just stopped
// would leave the row `claimed` until the reaper timed it out, and the
// failure reason — the thing M6.1 reads to tell a deleted video from a
// geo-block — would never be recorded at all.
func TestRunnerReportsFailedWorkRatherThanAbandoningIt(t *testing.T) {
	q := &fakeQueue{job: aJob()}
	runner := worker.Runner{
		Queue:  q,
		Logger: quietLogger(),
		Work:   func(context.Context, *api.Job) error { return errors.New("video unavailable") },
	}

	found, err := runner.PollOnce(context.Background())
	if err != nil {
		t.Fatalf("PollOnce() returned an unexpected error: %v", err)
	}
	if !found {
		t.Error("PollOnce() reported no work after claiming a job that then failed")
	}
	if q.cause == nil || q.cause.Error() != "video unavailable" {
		t.Errorf("completed with cause %v, want the work's own error", q.cause)
	}
}

// A failed claim is the loop's business, not the runner's: it backs off and
// tries again. The runner's job is to not swallow it.
func TestRunnerSurfacesAFailedClaim(t *testing.T) {
	q := &fakeQueue{claimErr: errors.New("connection refused")}
	runner := worker.Runner{Queue: q, Logger: quietLogger()}

	found, err := runner.PollOnce(context.Background())
	if err == nil {
		t.Fatal("PollOnce() swallowed a failed claim")
	}
	if found {
		t.Error("PollOnce() reported work despite the claim failing")
	}
}

func TestRunnerHeartbeatsWhileWorkIsRunning(t *testing.T) {
	q := &fakeQueue{job: aJob()}

	work := make(chan struct{})
	runner := worker.Runner{
		Queue:             q,
		Logger:            quietLogger(),
		HeartbeatInterval: 20 * time.Millisecond,
		Work: func(ctx context.Context, _ *api.Job) error {
			<-work
			return nil
		},
	}

	done := make(chan error, 1)
	go func() {
		_, err := runner.PollOnce(context.Background())
		done <- err
	}()

	// Long enough for several beats at the interval above.
	time.Sleep(120 * time.Millisecond)
	if got := q.beats(); got < 2 {
		t.Errorf("%d heartbeats while work ran for ~6 intervals, want at least 2", got)
	}

	close(work)
	if err := <-done; err != nil {
		t.Fatalf("PollOnce() returned an unexpected error: %v", err)
	}

	// The lease is closed by Complete; beating on afterwards would renew a
	// job this worker no longer holds.
	after := q.beats()
	time.Sleep(80 * time.Millisecond)
	if got := q.beats(); got != after {
		t.Errorf("heartbeats continued after the job finished: %d then %d", after, got)
	}
}

// The reaper taking a job back is not a failure to report — the job is
// already `pending` again and may already be running elsewhere. Completing it
// would be writing to somebody else's lease, and the API rejects it anyway.
// What matters is that the work stops.
func TestRunnerStopsWorkWhenTheLeaseIsLost(t *testing.T) {
	q := &fakeQueue{
		job:       aJob(),
		heartbeat: func(int) error { return queue.ErrLeaseLost },
	}

	workCancelled := make(chan struct{})
	runner := worker.Runner{
		Queue:             q,
		Logger:            quietLogger(),
		HeartbeatInterval: 10 * time.Millisecond,
		Work: func(ctx context.Context, _ *api.Job) error {
			select {
			case <-ctx.Done():
				close(workCancelled)
				return ctx.Err()
			case <-time.After(5 * time.Second):
				return nil
			}
		},
	}

	found, err := runner.PollOnce(context.Background())
	if err != nil {
		t.Fatalf("PollOnce() returned an unexpected error: %v", err)
	}
	if !found {
		t.Error("PollOnce() reported no work despite having claimed a job")
	}

	select {
	case <-workCancelled:
	case <-time.After(time.Second):
		t.Fatal("work was not cancelled after the lease was lost")
	}

	if q.completed {
		t.Error("a job whose lease was lost was still reported complete")
	}
}

// A transient heartbeat failure is not a lost lease. Giving up on one would
// abandon a job the worker still holds, and the reaper would then wait out
// the entire lease window before anyone picked it up.
func TestRunnerKeepsWorkingThroughATransientHeartbeatFailure(t *testing.T) {
	q := &fakeQueue{
		job:       aJob(),
		heartbeat: func(n int) error { return errors.New("503 from the API") },
	}

	runner := worker.Runner{
		Queue:             q,
		Logger:            quietLogger(),
		HeartbeatInterval: 10 * time.Millisecond,
		Work: func(ctx context.Context, _ *api.Job) error {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(60 * time.Millisecond):
				return nil
			}
		},
	}

	if _, err := runner.PollOnce(context.Background()); err != nil {
		t.Fatalf("PollOnce() returned an unexpected error: %v", err)
	}
	if !q.completed {
		t.Error("the job was abandoned over a transient heartbeat failure")
	}
	if q.cause != nil {
		t.Errorf("the job was reported failed because of a heartbeat error: %v", q.cause)
	}
}

// The loop waits for an in-flight poll on shutdown, and its stated reason is
// that abandoning the job would leave the row `claimed` until the reaper
// timed it out. That reason only holds if the outcome report can still be
// sent — and on the shutdown path the context it would ride is already
// cancelled. Reporting on the caller's context means the waiting buys nothing
// it claims to buy.
func TestRunnerReportsTheOutcomeEvenWhenShuttingDown(t *testing.T) {
	q := &fakeQueue{job: aJob()}

	runner := worker.Runner{
		Queue:  q,
		Logger: quietLogger(),
		Work: func(ctx context.Context, _ *api.Job) error {
			// Finishes normally; the cancellation is the process going down
			// around it, not the job failing.
			<-ctx.Done()
			return nil
		},
	}

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()

	if _, err := runner.PollOnce(ctx); err != nil {
		t.Fatalf("PollOnce() returned an unexpected error: %v", err)
	}

	if !q.completed {
		t.Fatal("the job was not reported at all on the shutdown path")
	}
	if q.completeCtxErr != nil {
		t.Errorf("Complete() was called on an already-cancelled context (%v), so the report could not have been sent",
			q.completeCtxErr)
	}
}

// The reaper can take a job back in the gap between the last heartbeat and
// the completion. That is the same event as a heartbeat 404 and deserves the
// same answer — drop it quietly. Surfacing it as a poll failure instead makes
// the loop back off from a queue that is working perfectly well.
func TestRunnerTreatsALostLeaseAtCompletionAsADrop(t *testing.T) {
	q := &fakeQueue{job: aJob(), completeErr: queue.ErrLeaseLost}

	runner := worker.Runner{Queue: q, Logger: quietLogger()}

	found, err := runner.PollOnce(context.Background())
	if err != nil {
		t.Fatalf("PollOnce() surfaced a lost lease as a failure: %v", err)
	}
	if !found {
		t.Error("PollOnce() reported no work despite having claimed a job")
	}
}
