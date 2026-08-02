package worker_test

import (
	"testing"
	"time"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/worker"
)

// The numbers are CONTEXT.md §Q20's, and they are a request budget rather
// than a taste: 30s idle polling is ~1,000 requests/day against a 100,000/day
// free tier, where a 5s interval would be 17,280 of them returning nothing.
func TestBackoffDoublesFromTheIdleIntervalUpToTheCap(t *testing.T) {
	b := worker.NewBackoff(30*time.Second, 120*time.Second)

	want := []time.Duration{
		30 * time.Second,
		60 * time.Second,
		120 * time.Second,
		120 * time.Second,
		120 * time.Second,
	}
	for i, w := range want {
		if got := b.Next(); got != w {
			t.Errorf("empty poll %d waited %v, want %v", i+1, got, w)
		}
	}
}

// "Immediate re-poll after finding work" is the other half of the budget: a
// queue with a backlog must drain at the speed of the work, not at the speed
// of the idle interval.
func TestBackoffResetsAfterFindingWork(t *testing.T) {
	b := worker.NewBackoff(30*time.Second, 120*time.Second)

	b.Next()
	b.Next()
	b.Reset()

	if got := b.Next(); got != 30*time.Second {
		t.Errorf("first wait after a reset = %v, want the idle interval %v", got, 30*time.Second)
	}
}

// A cap below the idle interval is a configuration mistake with no sensible
// reading — it asks the wait to double *up* to something shorter than where
// it starts. Both bounds cannot be honoured, and the idle interval wins:
// §Q20's argument is a request budget, so the failure mode to avoid is
// polling more often than intended, not waiting longer than intended.
func TestBackoffWithAnInvertedPairHoldsTheIdleInterval(t *testing.T) {
	b := worker.NewBackoff(90*time.Second, 30*time.Second)

	for i := range 4 {
		if got := b.Next(); got != 90*time.Second {
			t.Fatalf("wait %d = %v, want the idle interval %v held flat", i+1, got, 90*time.Second)
		}
	}
}
