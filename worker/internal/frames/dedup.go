package frames

import (
	"fmt"
	"runtime"
	"sync"
)

// hashFunc computes a Frame's perceptual hash. A field on Deduper rather than
// a hard call to PHash so the tests can substitute a table of known
// distances — building real images with a specific bit distance from each
// other is possible but roundabout, and the seam costs nothing in the
// production path, which just leaves it nil and gets PHash.
type hashFunc func(path string) (Hash, error)

// Deduper hashes frames and decides which survive. It exists as a type,
// rather than Dedup taking a hash function parameter directly, because the
// zero value is the production behaviour — callers that only ever want PHash
// write `frames.Deduper{}` and never see the seam.
type Deduper struct {
	// Hash computes a frame's hash. Nil means PHash.
	Hash hashFunc
}

// DedupResult is frames extracted, frames kept, and the ratio between them.
//
// One struct, computed in one function, so a caller reporting "extracted vs
// kept vs ratio" as OTel attributes (CONTEXT.md §Q12 — "dedup ratio" is one
// of the two headline numbers this milestone exists to produce) reads three
// fields off one value instead of recomputing Ratio from Extracted and
// len(Kept) at the call site, where it could disagree with this file's own
// arithmetic after either one is edited alone.
type DedupResult struct {
	Kept      []Kept
	Extracted int
	// Ratio is (Extracted-len(Kept))/Extracted, the fraction dropped as
	// near-duplicates. Zero when Extracted is zero rather than NaN or a
	// panic — an empty chunk (a segment that ffmpeg produced no frames for)
	// is a real, quiet case, not a divide-by-zero the caller has to guard.
	Ratio float64
}

// Dedup hashes frames concurrently and then walks them in timestamp order,
// keeping a frame only when it is at least threshold bits from the last
// *kept* frame. It is Deduper{}.Dedup, spelled out as a package function so a
// caller with no need for the injectable-hash seam (see hashFunc) never has
// to know Deduper exists.
//
// Comparing against the last kept frame, not the immediately preceding one,
// is CONTEXT.md §Q12's rule: a slow camera pan changes the picture only a
// little from one frame to the next, so every adjacent pair would fall under
// threshold and nothing after the first frame would ever be dropped — while
// the same pan drifts arbitrarily far from where the last *kept* frame left
// off, which is what actually makes it a new frame worth having.
//
// threshold <= 0 means DefaultDedupThreshold, mirroring Config.Threshold()
// rather than requiring the caller to route every call through a Config —
// dedup.go does not import config, and Config.Threshold's own defaulting
// rule is duplicated here in one line rather than pulling that dependency in
// for it.
//
// frames must already be in timestamp order; this function does not sort
// them, because ffmpeg emits them in extraction order and re-sorting a slice
// that is already sorted would hide a caller bug (frames arriving out of
// order) instead of surfacing it.
func Dedup(frames []Frame, threshold int) (DedupResult, error) {
	return Deduper{}.Dedup(frames, threshold)
}

// Dedup is the method Dedup delegates to; see that function's comment for the
// policy. It exists on Deduper so tests can set Hash to a fake and exercise
// the same keep/drop logic without a JPEG in sight.
func (d Deduper) Dedup(frames []Frame, threshold int) (DedupResult, error) {
	if threshold <= 0 {
		threshold = DefaultDedupThreshold
	}

	hash := d.Hash
	if hash == nil {
		hash = PHash
	}

	if len(frames) == 0 {
		return DedupResult{Extracted: 0, Ratio: 0}, nil
	}

	hashes, err := hashAll(frames, hash)
	if err != nil {
		return DedupResult{}, err
	}

	// The decision is inherently sequential — each frame's keep/drop verdict
	// depends on which earlier frame was last kept — but nothing about
	// computing a hash depends on any other frame's hash. Splitting the
	// concurrent, expensive step (above) from this cheap, ordered walk is
	// exactly the "concurrent extract, hash, compare" CONTEXT.md §Q12 names
	// as what makes this worker more than a shell script: the DCT in
	// phash.go is ~1M multiply-adds per frame, and a 60-frame chunk on 2
	// cores run serially would cost roughly NumCPU times longer for a step
	// that has no sequential dependency to justify it.
	kept := make([]Kept, 0, len(frames))
	var lastKept Hash
	for i, f := range frames {
		h := hashes[i]
		if i == 0 || h.Distance(lastKept) >= threshold {
			kept = append(kept, Kept{Frame: f, PHash: h})
			lastKept = h
		}
	}

	extracted := len(frames)
	dropped := extracted - len(kept)
	result := DedupResult{
		Kept:      kept,
		Extracted: extracted,
		Ratio:     float64(dropped) / float64(extracted),
	}
	return result, nil
}

// hashAll computes hash(f.Path) for every frame, bounded to runtime.NumCPU()
// concurrent hashes.
//
// Unbounded concurrency (one goroutine per frame with no limit) would be fine
// for the 60 frames in a chunk today, but it is the kind of thing that stops
// being fine the moment segment length or extraction rate changes, and
// nothing about this function's contract says "bounded to chunk size" —
// bounding it to NumCPU costs one semaphore channel and is correct regardless
// of how many frames arrive.
//
// Writes land at hashes[i], the frame's own index, rather than through an
// append behind a mutex: the slice is preallocated to len(frames) up front,
// so every goroutine owns a disjoint slot and nothing needs to serialise on
// it. dedup then reads hashes in order, which is what makes the sequential
// walk correct without the hashing goroutines needing to agree on an order
// among themselves.
//
// A frame that fails to hash — a truncated JPEG from a chunk job that died
// mid-extraction — fails the whole call, naming the file. A dedup that
// silently skipped it would hand the caller a segment one frame short of
// what ffmpeg actually produced, and nothing downstream would know to tell
// the difference between "dropped as a duplicate" and "could not be read".
func hashAll(frames []Frame, hash hashFunc) ([]Hash, error) {
	hashes := make([]Hash, len(frames))

	limit := runtime.NumCPU()
	if limit < 1 {
		limit = 1
	}
	sem := make(chan struct{}, limit)

	var wg sync.WaitGroup
	errs := make([]error, len(frames))

	for i, f := range frames {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, f Frame) {
			defer wg.Done()
			defer func() { <-sem }()

			h, err := hash(f.Path)
			if err != nil {
				errs[i] = fmt.Errorf("hashing %s: %w", f.Path, err)
				return
			}
			hashes[i] = h
		}(i, f)
	}
	wg.Wait()

	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}

	return hashes, nil
}
