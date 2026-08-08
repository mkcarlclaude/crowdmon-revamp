package sample_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/queue"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/sample"
)

type fakeImagesLister struct {
	candidates []queue.SampleCandidate
	err        error
	videoID    string
	calls      int
}

func (f *fakeImagesLister) Images(_ context.Context, videoID string) ([]queue.SampleCandidate, error) {
	f.calls++
	f.videoID = videoID
	return f.candidates, f.err
}

// poolOfSeconds builds n candidates at one-second intervals — a stand-in for
// a video extracted at 1fps with nothing deduplicated away — deliberately
// handed back in reverse timestamp order. sortedByTimestamp's own comment
// explains why: ListVideoImages already orders its response, so a pool that
// arrived pre-sorted could not tell a real implementation apart from one that
// forgot to sort at all.
func poolOfSeconds(n int) []queue.SampleCandidate {
	candidates := make([]queue.SampleCandidate, n)
	for i := 0; i < n; i++ {
		ts := n - 1 - i
		candidates[i] = queue.SampleCandidate{
			Key:              fmt.Sprintf("frames/v/%05d.000.jpg", ts),
			TimestampSeconds: float64(ts),
		}
	}
	return candidates
}

// TestSampleSpreadsAcrossTheWholeTimelineNotJustTheStart is the load-bearing
// test M11.3 asks for: it asserts the spread of the selected timestamps, not
// the count, and a "first N" implementation fails it outright.
//
// 5820 one-second candidates is a 97-minute video at 1fps with nothing
// deduplicated away — CONTEXT.md's own example for why bounded sampling is
// not optional. Selecting the first 200 of them would put every chosen
// timestamp under 200 seconds into a 5820-second video; this test would then
// find the last selected timestamp two orders of magnitude short of where it
// asserts it has to be.
func TestSampleSpreadsAcrossTheWholeTimelineNotJustTheStart(t *testing.T) {
	const duration = 97 * 60 // seconds
	lister := &fakeImagesLister{candidates: poolOfSeconds(duration)}
	s := sample.Sampler{Images: lister, Budget: sample.DefaultBudget}

	images, err := s.Sample(context.Background(), "v")
	if err != nil {
		t.Fatalf("Sample() returned an unexpected error: %v", err)
	}
	if len(images) != sample.DefaultBudget {
		t.Fatalf("Sample() returned %d images, want %d", len(images), sample.DefaultBudget)
	}

	stride := float64(duration) / float64(sample.DefaultBudget)

	min, max := images[0].TimestampSeconds, images[0].TimestampSeconds
	seen := make(map[float64]bool, len(images))
	for _, img := range images {
		if img.TimestampSeconds < min {
			min = img.TimestampSeconds
		}
		if img.TimestampSeconds > max {
			max = img.TimestampSeconds
		}
		if seen[img.TimestampSeconds] {
			t.Errorf("timestamp %v selected twice, want every selected frame distinct", img.TimestampSeconds)
		}
		seen[img.TimestampSeconds] = true
	}

	// The property that actually distinguishes "drawn across the timeline"
	// from "the first N": the selected timestamps have to reach essentially
	// the whole duration, not cluster in a budget-sized window at the start.
	// A "first N" sampler would put max at 199 here; this asserts it lands
	// within one stride of the video's last second instead.
	if min > stride {
		t.Errorf("earliest selected timestamp = %v, want within one stride (%v) of 0", min, stride)
	}
	if max < duration-1-stride {
		t.Errorf("latest selected timestamp = %v, want within one stride (%v) of the video's "+
			"last second (%d) — got a cluster near the start instead of a spread across it",
			max, stride, duration-1)
	}

	// No gap between consecutive selected timestamps should run much wider
	// than the stride: a sampler that front-loads its picks (an accidental
	// "first N" dressed up to return the right count) would leave one huge
	// gap covering most of the video instead of many even ones.
	sortedTimestamps := make([]float64, len(images))
	for i, img := range images {
		sortedTimestamps[i] = img.TimestampSeconds
	}
	for i := 1; i < len(sortedTimestamps); i++ {
		gap := sortedTimestamps[i] - sortedTimestamps[i-1]
		if gap < 0 {
			t.Fatalf("timestamps out of order at index %d: %v then %v", i, sortedTimestamps[i-1], sortedTimestamps[i])
		}
		if gap > stride*2 {
			t.Errorf("gap between selected timestamps %v and %v is %v, want at most ~%v (twice the stride)",
				sortedTimestamps[i-1], sortedTimestamps[i], gap, stride)
		}
	}
}

func TestSampleReturnsEveryImageWhenThePoolIsSmallerThanTheBudget(t *testing.T) {
	lister := &fakeImagesLister{candidates: poolOfSeconds(5)}
	s := sample.Sampler{Images: lister, Budget: 200}

	images, err := s.Sample(context.Background(), "v")
	if err != nil {
		t.Fatalf("Sample() returned an unexpected error: %v", err)
	}
	if len(images) != 5 {
		t.Fatalf("Sample() returned %d images, want all 5", len(images))
	}
	// Sorted by timestamp even in the short-circuit path — a caller should
	// not have to know which branch of Sample produced its answer.
	for i := 1; i < len(images); i++ {
		if images[i].TimestampSeconds < images[i-1].TimestampSeconds {
			t.Errorf("images not sorted by timestamp: %v before %v",
				images[i-1].TimestampSeconds, images[i].TimestampSeconds)
		}
	}
}

func TestSampleReturnsNoErrorForAnEmptyPool(t *testing.T) {
	lister := &fakeImagesLister{}
	s := sample.Sampler{Images: lister, Budget: 200}

	images, err := s.Sample(context.Background(), "v")
	if err != nil {
		t.Fatalf("Sample() returned an unexpected error: %v", err)
	}
	if len(images) != 0 {
		t.Errorf("Sample() returned %d images, want 0 for an empty pool", len(images))
	}
}

func TestSampleDefaultsTheBudgetWhenUnconfigured(t *testing.T) {
	lister := &fakeImagesLister{candidates: poolOfSeconds(5000)}
	s := sample.Sampler{Images: lister} // Budget left at its zero value.

	images, err := s.Sample(context.Background(), "v")
	if err != nil {
		t.Fatalf("Sample() returned an unexpected error: %v", err)
	}
	if len(images) != sample.DefaultBudget {
		t.Errorf("Sample() returned %d images with no Budget configured, want DefaultBudget (%d)",
			len(images), sample.DefaultBudget)
	}
}

func TestSampleHonoursAConfiguredBudget(t *testing.T) {
	lister := &fakeImagesLister{candidates: poolOfSeconds(1000)}
	s := sample.Sampler{Images: lister, Budget: 10}

	images, err := s.Sample(context.Background(), "v")
	if err != nil {
		t.Fatalf("Sample() returned an unexpected error: %v", err)
	}
	if len(images) != 10 {
		t.Errorf("Sample() returned %d images, want the configured budget of 10", len(images))
	}
}

// TestSampleIsDeterministic pins the determinism decision Sample's own
// comment justifies: a reap-and-rerun must redraw the identical set, because
// that is what makes the API's selection-reason stamp idempotent across a
// retry instead of leaving two attempts' worth of contradictory rows.
func TestSampleIsDeterministic(t *testing.T) {
	lister := &fakeImagesLister{candidates: poolOfSeconds(5820)}
	s := sample.Sampler{Images: lister, Budget: sample.DefaultBudget}

	first, err := s.Sample(context.Background(), "v")
	if err != nil {
		t.Fatalf("Sample() returned an unexpected error: %v", err)
	}
	second, err := s.Sample(context.Background(), "v")
	if err != nil {
		t.Fatalf("Sample() returned an unexpected error: %v", err)
	}

	if len(first) != len(second) {
		t.Fatalf("two draws returned %d and %d images, want the same count", len(first), len(second))
	}
	for i := range first {
		if first[i] != second[i] {
			t.Errorf("draw 1[%d] = %+v, draw 2[%d] = %+v, want identical", i, first[i], i, second[i])
		}
	}
}

func TestSamplePassesTheVideoIDThrough(t *testing.T) {
	lister := &fakeImagesLister{candidates: poolOfSeconds(5)}
	s := sample.Sampler{Images: lister, Budget: 200}

	if _, err := s.Sample(context.Background(), "dQw4w9WgXcQ"); err != nil {
		t.Fatalf("Sample() returned an unexpected error: %v", err)
	}
	if lister.videoID != "dQw4w9WgXcQ" {
		t.Errorf("Images() called with video %q, want dQw4w9WgXcQ", lister.videoID)
	}
	if lister.calls != 1 {
		t.Errorf("Images() called %d times, want exactly 1", lister.calls)
	}
}

func TestSamplePropagatesAListingFailure(t *testing.T) {
	listErr := errors.New("connection refused")
	lister := &fakeImagesLister{err: listErr}
	s := sample.Sampler{Images: lister, Budget: 200}

	_, err := s.Sample(context.Background(), "v")
	if !errors.Is(err, listErr) {
		t.Errorf("Sample() error = %v, want it to wrap %v", err, listErr)
	}
}
