package worker

import (
	"context"
	"time"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/api"
)

// SimulatedWork returns a WorkFunc that holds a job for d and then succeeds.
//
// It exists for one verification and says so: M6.4 asks for a worker killed
// *mid-job*, and until M7 lands extraction there is no middle — Runner.Work is
// nil and a job closes in about 90ms, far too fast to interrupt by hand. The
// alternatives were both worse. Seeding a stale `claimed` row into D1 tests
// the reaper's SQL, which reaper.test.ts already does, while saying nothing
// about what a killed container actually leaves behind. Deferring the kill to
// M7 would ship failure semantics whose headline claim had never been run.
//
// Off unless CROWDMON_SIMULATED_WORK is set, and deleted when M7 replaces it
// with real work.
func SimulatedWork(d time.Duration) WorkFunc {
	return func(ctx context.Context, _ *api.Job) error {
		timer := time.NewTimer(d)
		defer timer.Stop()

		select {
		case <-ctx.Done():
			// Returned, not swallowed. The runner reads this to tell a
			// shutdown apart from a job that failed, and a nil here would
			// report a job as done that never ran.
			return ctx.Err()
		case <-timer.C:
			return nil
		}
	}
}
