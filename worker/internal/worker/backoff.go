// Package worker holds the poll loop: the thing that turns an idle process
// into one that takes work off the queue.
package worker

import "time"

// The polling budget from CONTEXT.md §Q20. Constants rather than environment
// variables: they are a shared-quota decision about a free tier, not a
// per-deployment preference, and a second worker tuning them privately would
// break the arithmetic that justified them.
const (
	// IdleInterval is the wait after the first empty poll. ~1,000 requests a
	// day against a 100,000/day quota; a 5s interval would be 17,280 of them
	// returning nothing.
	IdleInterval = 30 * time.Second
	// MaxInterval caps the doubling. Up to two minutes of pickup latency is
	// invisible against 10–20 minute jobs.
	MaxInterval = 120 * time.Second
)

// Backoff is the polling budget from CONTEXT.md §Q20, as a value: start at the
// idle interval, double on every empty poll, stop at the cap, and go back to
// the start the moment there is work.
//
// It is a plain policy with no clock of its own. The loop owns the waiting,
// which is what lets the arithmetic be tested without any.
type Backoff struct {
	min, max time.Duration
	next     time.Duration
}

// NewBackoff returns a Backoff that starts at min and doubles to max.
//
// A max below min is clamped rather than rejected: the loop's job is to poll,
// and refusing to start over a configuration mistake with an obvious reading
// trades a slow worker for no worker.
func NewBackoff(min, max time.Duration) *Backoff {
	if max < min {
		max = min
	}
	return &Backoff{min: min, max: max, next: min}
}

// Next returns how long to wait before the next poll, and advances the
// sequence. Call it once per empty poll.
func (b *Backoff) Next() time.Duration {
	wait := min(b.next, b.max)
	b.next = min(wait*2, b.max)
	return wait
}

// Reset returns to the idle interval. Call it on finding work.
func (b *Backoff) Reset() { b.next = b.min }
