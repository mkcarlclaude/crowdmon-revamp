// Package sample draws the bounded, timeline-spread subset of a video's
// frames a prelabel job runs the detector over (M11.3, issue #103).
//
// Pool size here is governed by what a human can verify and by what the
// box's i5-7200U can run in a night, not by what ffmpeg can produce:
// pre-labelling every kept frame from a handful of long videos would queue
// years of backlog (CONTEXT.md's own example is a 97-minute video), while
// open-vocabulary detection at seconds per image keeps a 200-frame sample to
// minutes. That is the whole reason a sampler exists as a separate package
// rather than "detect everything Sample handed back."
package sample

import (
	"context"
	"fmt"
	"sort"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/queue"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/worker"
)

// DefaultBudget is how many images a prelabel job samples per video when
// CROWDMON_PRELABEL_SAMPLE_SIZE is unset (worker/internal/config).
//
// 200 is not a round number chosen for convenience: CONTEXT.md's own
// argument for it is CPU time, not disk or memory — an i5-7200U runs
// open-vocabulary detection in seconds per image, so 200 frames is minutes
// per video where every kept frame from a long video would be most of a
// night. It is also the assumption `MAX_PREDICTIONS_PER_JOB` on the API side
// was sized against (apps/api/src/schemas.ts) — that bound is a ceiling on
// one request, not a mirror of this default, but the two were chosen with
// the same number in mind.
const DefaultBudget = 200

// ImagesLister is what Sampler needs from the queue client: the video's
// candidate pool, read back from D1 rather than re-derived from R2 (M11.3).
//
// Declared here, on the side that depends on it, for the same reason every
// other collaborator interface in this worker is (Downloader, Prober,
// FanOuter in pipeline.go): it lets a test substitute a fake pool without
// standing up an HTTP server, and *queue.Client satisfies it without this
// package importing queue's concrete type into its own exported surface.
type ImagesLister interface {
	Images(ctx context.Context, videoID string) ([]queue.SampleCandidate, error)
}

// Sampler implements worker.ImageSampler by drawing a systematic,
// evenly-spaced subset of a video's candidate pool.
//
// A value type, not a pointer receiver: Sampler carries nothing that needs
// sharing or mutating between calls — Budget is read-only configuration and
// ImagesLister is already a reference — so there is nothing a pointer would
// buy that copying a two-field struct does not already give for free, the
// same reasoning worker.Pipeline itself is a value type for.
type Sampler struct {
	Images ImagesLister
	// Budget is how many images to draw per video. Zero (the field's own
	// zero value) means DefaultBudget, mirroring frames.Config.Threshold's
	// "<=0 means the package decides" idiom exactly — config.go does not
	// import this package for the same reason it does not import frames,
	// so the number has exactly one owner and config only ever forwards
	// whatever CROWDMON_PRELABEL_SAMPLE_SIZE said.
	Budget int
}

func (s Sampler) budget() int {
	if s.Budget <= 0 {
		return DefaultBudget
	}
	return s.Budget
}

// Sample implements worker.ImageSampler.
//
// Determinism: sampling the same video twice yields the same frames, always
// — there is no randomness anywhere in this package. That is a deliberate
// choice, not an accident of the algorithm being simple. A reap-and-rerun is
// a real scenario for a prelabel job exactly as it is for a chunk job
// (CONTEXT.md §Q14): the job loses its lease mid-detection, returns to
// `pending`, and Sample runs again from the top for the same video id. If
// each draw picked a different random subset, a rerun's report would stamp
// `images.selection_reason` on a different set of rows than the aborted
// attempt looked at, and the two attempts' worth of "frames that were
// sampled" would never line up with any single, coherent budget-in-force —
// exactly the mixture-of-regimes failure `images.dedup_threshold` exists to
// prevent for extraction. Determinism means a rerun is idempotent at the
// sampling layer the same way frames.Uploader's deterministic R2 keys make a
// reap-and-rerun idempotent at the upload layer (M8.3): the second attempt
// draws the identical set, and the stamp it writes is a no-op restamping of
// what the first attempt would have written had it finished.
func (s Sampler) Sample(ctx context.Context, videoID string) ([]worker.SampledImage, error) {
	return s.SampleN(ctx, videoID, s.budget())
}

// SampleN is Sample with the budget named by the caller rather than by this
// Sampler's configuration, and it implements worker.BoundedImageSampler.
//
// It exists for M12.2's dry-run, whose budget is not the worker's to choose:
// the API stamps `dryruns.sample_size` on the row and hands it back on the
// claim, so that an operator raising the number later cannot make an old
// dry-run's box count read as a different result than it was (the same
// argument `images.dedup_threshold` makes for extraction). A worker that
// re-derived the budget from its own environment would be free to disagree
// with the row it is about to report against.
//
// Everything Sample's own comment says about determinism applies here
// unchanged — nothing in this package is random, so the same (video, budget)
// always draws the same frames.
func (s Sampler) SampleN(
	ctx context.Context, videoID string, budget int,
) ([]worker.SampledImage, error) {
	candidates, err := s.Images.Images(ctx, videoID)
	if err != nil {
		return nil, fmt.Errorf("listing the candidate pool for %s: %w", videoID, err)
	}

	// A caller that asks for nothing (or for a negative sample) gets this
	// Sampler's configured budget, not an empty draw: zero here is the same
	// "the package decides" signal the Budget field itself uses, and an empty
	// sample would be reported as a prompt that matched nothing.
	if budget <= 0 {
		budget = s.budget()
	}

	if len(candidates) <= budget {
		// Fewer images than the budget: return all of them, not an error and
		// not a short sample padded with nothing. A short video is a
		// legitimate input, not a misconfiguration, and the prelabel job
		// gains nothing from being told it cannot run.
		return toSampledImages(sortedByTimestamp(candidates)), nil
	}

	return toSampledImages(systematicSample(candidates, budget)), nil
}

// sortedByTimestamp returns candidates ordered by TimestampSeconds, without
// mutating the slice the caller handed in.
//
// ListVideoImages already orders its response this way (apps/api/src/routes
// /jobs.ts's SQL: "ORDER BY timestamp_seconds"), so this is defensive rather
// than load-bearing today — but systematicSample's spread guarantee depends
// entirely on the input being sorted, and a future change to the API's query
// (or a test double that does not bother) silently producing an unsorted
// slice would turn "drawn across the timeline" back into "the first N" with
// no test able to tell the difference from the algorithm's own code. Sorting
// here, in the one place that promise has to hold, costs O(n log n) against
// a pool bounded by MAX_VIDEO_SECONDS (21600) and is cheaper than trusting it.
func sortedByTimestamp(candidates []queue.SampleCandidate) []queue.SampleCandidate {
	sorted := make([]queue.SampleCandidate, len(candidates))
	copy(sorted, candidates)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].TimestampSeconds < sorted[j].TimestampSeconds
	})
	return sorted
}

// systematicSample picks budget candidates evenly spaced across the sorted
// pool — index i*n/budget for i in [0, budget) — rather than the first
// budget of them.
//
// This is the property the spread test exercises: selecting the first 200
// frames of a 97-minute video (n=5820 at 1fps) would put every chosen
// timestamp inside the first ~3.4 minutes, while this algorithm's stride
// (~29 frames) spreads the 200 across the full 97 minutes by construction —
// the last selected index is always within one stride of n-1. No randomness
// is involved (see Sample's own comment on why that matters for a
// reap-and-rerun); "across the timeline" here means evenly, not randomly.
//
// The indices produced are always strictly increasing, and therefore always
// distinct, whenever n >= budget (the only case this is called for — Sample
// returns every candidate directly otherwise): the real-valued step between
// consecutive indices is n/budget >= 1, and floor(a+d) >= floor(a) + floor(d)
// for any non-negative a, d, so floor(a+d) >= floor(a) + 1 whenever d >= 1.
// Integer division in Go truncates toward zero for non-negative operands,
// which is exactly floor here since i, n and budget are all non-negative —
// so i*n/budget computed in integers matches the real-valued analysis
// exactly, with no floating-point rounding to reason about at the boundary.
func systematicSample(candidates []queue.SampleCandidate, budget int) []queue.SampleCandidate {
	sorted := sortedByTimestamp(candidates)
	n := len(sorted)

	out := make([]queue.SampleCandidate, budget)
	for i := 0; i < budget; i++ {
		out[i] = sorted[i*n/budget]
	}
	return out
}

func toSampledImages(candidates []queue.SampleCandidate) []worker.SampledImage {
	images := make([]worker.SampledImage, len(candidates))
	for i, c := range candidates {
		images[i] = worker.SampledImage{Key: c.Key, TimestampSeconds: c.TimestampSeconds}
	}
	return images
}
