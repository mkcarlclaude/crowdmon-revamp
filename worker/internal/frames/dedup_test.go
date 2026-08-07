package frames

import (
	"fmt"
	"strings"
	"testing"
)

// framesWithHashes builds n frames whose Path encodes an index, and a
// hashFunc (for injection into Deduper.Hash) that looks the hash up from a
// map keyed by that same path — the seam hashFunc exists for, since building
// real JPEGs at a specific bit distance from each other is roundabout and
// this test cares only about the keep/drop policy, not the DCT.
func framesWithHashes(hashes []Hash) ([]Frame, hashFunc) {
	frames := make([]Frame, len(hashes))
	byPath := make(map[string]Hash, len(hashes))
	for i, h := range hashes {
		path := fmt.Sprintf("frame-%d.jpg", i)
		frames[i] = Frame{Path: path, TimestampSeconds: float64(i)}
		byPath[path] = h
	}
	return frames, func(path string) (Hash, error) {
		h, ok := byPath[path]
		if !ok {
			return 0, fmt.Errorf("no fake hash registered for %s", path)
		}
		return h, nil
	}
}

func TestDedup_IdenticalFramesCollapseToOne(t *testing.T) {
	frames, hash := framesWithHashes([]Hash{0x1, 0x1, 0x1, 0x1, 0x1})

	result, err := (Deduper{Hash: hash}).Dedup(frames, DefaultDedupThreshold)
	if err != nil {
		t.Fatalf("Dedup: %v", err)
	}

	if len(result.Kept) != 1 {
		t.Fatalf("kept %d frames, want 1: %+v", len(result.Kept), result.Kept)
	}
	if result.Kept[0].Frame != frames[0] {
		t.Fatalf("kept frame %+v, want the first frame %+v", result.Kept[0].Frame, frames[0])
	}
}

func TestDedup_FramesFarApartAreAllKept(t *testing.T) {
	// Each hash differs from every other by 32+ bits — well past any
	// reasonable threshold — so every frame should survive.
	frames, hash := framesWithHashes([]Hash{
		0x0000000000000000,
		0xFFFFFFFF00000000,
		0x00000000FFFFFFFF,
		0xFFFFFFFFFFFFFFFF,
	})

	result, err := (Deduper{Hash: hash}).Dedup(frames, DefaultDedupThreshold)
	if err != nil {
		t.Fatalf("Dedup: %v", err)
	}

	if len(result.Kept) != len(frames) {
		t.Fatalf("kept %d of %d frames, want all of them", len(result.Kept), len(frames))
	}
}

func TestDedup_FirstFrameAlwaysKept(t *testing.T) {
	// A single frame within threshold of nothing (there is nothing to
	// compare it to) still has to survive — Dedup would otherwise need a
	// caller-visible special case for a one-frame chunk.
	frames, hash := framesWithHashes([]Hash{0xABCD})

	result, err := (Deduper{Hash: hash}).Dedup(frames, DefaultDedupThreshold)
	if err != nil {
		t.Fatalf("Dedup: %v", err)
	}
	if len(result.Kept) != 1 {
		t.Fatalf("kept %d frames, want the lone frame kept", len(result.Kept))
	}
}

// TestDedup_ComparesAgainstLastKeptNotPredecessor is CONTEXT.md §Q12's slow-
// pan case. Each frame differs from its immediate predecessor by exactly 3
// bits — always under the threshold used here — by flipping 3 bits that no
// earlier step touched, so distance from frame 0 grows by exactly 3 per
// step: frame i is 3*i bits from frame 0.
//
// With threshold 30, comparing against the immediate predecessor would never
// keep anything past frame 0 (every adjacent gap is 3), which is the exact
// failure named in dedup.go's comment: a pan that drifts forever without
// ever registering a new frame. Comparing against the last *kept* frame
// keeps frame 10, whose cumulative drift from the still-current baseline
// (frame 0) has reached 30.
func TestDedup_ComparesAgainstLastKeptNotPredecessor(t *testing.T) {
	const steps = 10
	hashes := make([]Hash, steps+1)
	var h Hash
	for i := 0; i <= steps; i++ {
		hashes[i] = h
		// Flip 3 bits this step has never touched before, starting from the
		// top of the word and working down, so no earlier flip is ever
		// undone and distance-from-frame-0 accumulates monotonically. The
		// block for step i occupies bits [61-3i, 63-3i]; anchoring on the
		// block's *low* end (rather than 63-3*i directly) keeps 0b111's own
		// top bit from shifting past bit 63 and being discarded at i==0.
		shift := uint(61 - 3*i)
		h ^= Hash(0b111) << shift
	}

	frames, hash := framesWithHashes(hashes)

	result, err := (Deduper{Hash: hash}).Dedup(frames, 30)
	if err != nil {
		t.Fatalf("Dedup: %v", err)
	}

	if len(result.Kept) != 2 {
		t.Fatalf("kept %d frames, want exactly frame 0 and frame %d: %+v", len(result.Kept), steps, result.Kept)
	}
	if result.Kept[0].Frame.Path != "frame-0.jpg" {
		t.Fatalf("first kept frame was %s, want frame-0.jpg", result.Kept[0].Frame.Path)
	}
	if want := fmt.Sprintf("frame-%d.jpg", steps); result.Kept[1].Frame.Path != want {
		t.Fatalf("second kept frame was %s, want %s", result.Kept[1].Frame.Path, want)
	}

	// Sanity check on the fixture itself: every adjacent pair really is only
	// 3 bits apart, so a predecessor-based comparison genuinely could not
	// have produced the result above.
	for i := 1; i < len(hashes); i++ {
		if d := hashes[i].Distance(hashes[i-1]); d != 3 {
			t.Fatalf("fixture bug: hash %d is %d bits from its predecessor, want 3", i, d)
		}
	}
	if d := hashes[steps].Distance(hashes[0]); d != 30 {
		t.Fatalf("fixture bug: last hash is %d bits from the first, want 30", d)
	}
}

func TestDedup_ZeroThresholdMeansDefault(t *testing.T) {
	frames, hash := framesWithHashes([]Hash{0x0, 0x1, 0x0})

	withZero, err := (Deduper{Hash: hash}).Dedup(frames, 0)
	if err != nil {
		t.Fatalf("Dedup(threshold=0): %v", err)
	}
	withDefault, err := (Deduper{Hash: hash}).Dedup(frames, DefaultDedupThreshold)
	if err != nil {
		t.Fatalf("Dedup(threshold=DefaultDedupThreshold): %v", err)
	}

	if len(withZero.Kept) != len(withDefault.Kept) {
		t.Fatalf("threshold=0 kept %d frames, threshold=DefaultDedupThreshold kept %d; want equal",
			len(withZero.Kept), len(withDefault.Kept))
	}
}

func TestDedup_MetricsAgree(t *testing.T) {
	// 5 frames, 3 collapse into the first (identical), 2 are far enough to
	// survive: kept should be 3, dropped 2, ratio 2/5.
	frames, hash := framesWithHashes([]Hash{
		0x0, 0x0, 0x0,
		0xFFFFFFFFFFFFFFFF,
		0x00000000FFFFFFFF,
	})

	result, err := (Deduper{Hash: hash}).Dedup(frames, DefaultDedupThreshold)
	if err != nil {
		t.Fatalf("Dedup: %v", err)
	}

	if result.Extracted != 5 {
		t.Fatalf("Extracted = %d, want 5", result.Extracted)
	}
	if len(result.Kept) != 3 {
		t.Fatalf("kept %d frames, want 3", len(result.Kept))
	}
	if got, want := result.Ratio, 2.0/5.0; got != want {
		t.Fatalf("Ratio = %v, want %v", got, want)
	}
}

func TestDedup_ZeroFramesNoDivideByZero(t *testing.T) {
	result, err := Dedup(nil, DefaultDedupThreshold)
	if err != nil {
		t.Fatalf("Dedup(nil): %v", err)
	}
	if result.Extracted != 0 {
		t.Fatalf("Extracted = %d, want 0", result.Extracted)
	}
	if len(result.Kept) != 0 {
		t.Fatalf("Kept = %v, want empty", result.Kept)
	}
	if result.Ratio != 0 {
		t.Fatalf("Ratio = %v, want 0 (not NaN)", result.Ratio)
	}
}

// TestDedup_HashFailureNamesTheFile is the truncated-JPEG case: a chunk that
// silently dropped the unreadable frame would produce a segment that looks
// complete, so the whole call has to fail, and the error has to say which
// file so the operator does not have to guess.
func TestDedup_HashFailureNamesTheFile(t *testing.T) {
	frames := []Frame{
		{Path: "good-0.jpg", TimestampSeconds: 0},
		{Path: "truncated-1.jpg", TimestampSeconds: 1},
		{Path: "good-2.jpg", TimestampSeconds: 2},
	}
	failing := func(path string) (Hash, error) {
		if path == "truncated-1.jpg" {
			return 0, fmt.Errorf("unexpected EOF")
		}
		return 0, nil
	}

	_, err := (Deduper{Hash: failing}).Dedup(frames, DefaultDedupThreshold)
	if err == nil {
		t.Fatal("Dedup with one unreadable frame: want error, got nil")
	}
	if !strings.Contains(err.Error(), "truncated-1.jpg") {
		t.Fatalf("error %q does not name the failing file", err.Error())
	}
}
