// Package frames is phase two of CONTEXT.md §Q13: a chunk job's slice of a
// downloaded video, turned into deduplicated JPEGs in R2 and rows in D1.
//
// The four steps — extract, hash, dedup, upload — are separate files with
// separate tests because they fail for unrelated reasons and are worth
// swapping independently: ffmpeg is a subprocess, the hash is pure
// computation, the dedup is a policy, and the upload is a network call. This
// file holds only what all four have to agree on, so that agreement is in one
// place rather than restated three times.
package frames

import (
	"fmt"
	"strconv"
)

// Frame is one extracted still, on disk, and where in the source video it came
// from.
//
// TimestampSeconds is an offset into the *source video*, not into the chunk's
// slice of it. Everything downstream — the R2 key, the images row, the
// idempotency this whole milestone rests on — is keyed on that offset, and a
// chunk-relative number would make segment 3's frame 0 and segment 7's frame 0
// collide on the same key.
type Frame struct {
	Path             string
	TimestampSeconds float64
	// HashPath is a 32x32 greyscale copy of the same frame, emitted by the same
	// ffmpeg pass that wrote Path (M8.1). The hash reads this instead of Path.
	//
	// It exists because the alternative measured badly: hashing decoded the
	// full-resolution JPEG again purely to average it down to 32x32, which is
	// work ffmpeg had already done once — it had every frame in memory before
	// it encoded them. Emitting the thumbnail from the same decode turned a
	// 3.5s dedup step into a rounding error.
	//
	// Empty means "hash Path itself", which is what a caller constructing
	// Frames by hand (the tests) gets. Nothing downstream uploads or records
	// this file; it dies with the chunk's working directory.
	HashPath string
}

// hashSource is the file the perceptual hash should read for this frame.
func (f Frame) hashSource() string {
	if f.HashPath != "" {
		return f.HashPath
	}
	return f.Path
}

// Kept is a frame that survived dedup, carrying the hash that decided it.
//
// The hash travels with the frame rather than being recomputed at upload time:
// it goes into the images row (M8.4), and hashing a JPEG twice to get the same
// number back is both wasted work and a second place for the algorithm to
// drift.
type Kept struct {
	Frame
	PHash Hash
}

// Hash is a 64-bit perceptual hash. A number rather than a string because the
// dedup compares them by Hamming distance, and the string form exists only for
// the wire.
type Hash uint64

// Hex renders the hash as the fixed-width 16 characters that go into
// `images.phash`. Zero-padded so the column sorts and compares as text, which
// a variable-width rendering of the same number would not.
func (h Hash) Hex() string { return fmt.Sprintf("%016x", uint64(h)) }

// ParseHash reads back what Hex wrote. Only the tests and anything reading a
// row need this, but the pair belongs together.
func ParseHash(s string) (Hash, error) {
	v, err := strconv.ParseUint(s, 16, 64)
	if err != nil {
		return 0, fmt.Errorf("%q is not a 16-character hex hash: %w", s, err)
	}
	return Hash(v), nil
}

// Distance is the Hamming distance between two hashes: the number of bits that
// differ, 0 for identical images and around 32 for unrelated ones.
func (h Hash) Distance(other Hash) int {
	return popcount(uint64(h) ^ uint64(other))
}

func popcount(v uint64) int {
	n := 0
	for ; v != 0; v &= v - 1 {
		n++
	}
	return n
}

// KeyPrefix is where extracted frames live in the bucket. Everything else in
// R2 — models, dataset snapshots (CONTEXT.md §7) — is a sibling of this prefix
// rather than mixed into it.
const KeyPrefix = "frames"

// Key is the R2 object key for a frame, and it is the whole of M8.3's
// idempotency argument.
//
// Deterministic in `(video_id, timestamp)` (CONTEXT.md §Q14), so a chunk job
// that is reaped mid-upload and re-run overwrites the objects it already wrote
// instead of adding near-duplicates of them under fresh names. The timestamp is
// rendered zero-padded to three decimals: fixed width so keys sort in the order
// the frames appear, and rendered from the float exactly once so the key in R2
// and the `timestamp_seconds` in D1 cannot disagree about rounding.
//
//	frames/dQw4w9WgXcQ/00123.000.jpg
func Key(videoID string, timestampSeconds float64) string {
	return fmt.Sprintf("%s/%s/%09.3f.jpg", KeyPrefix, videoID, timestampSeconds)
}

// DefaultDedupThreshold is the Hamming distance at which two frames are treated
// as the same frame.
//
// 10 of 64 bits. Gameplay footage holds a near-static HUD over a moving scene,
// so the distances cluster low; 10 removes the 40-70% CONTEXT.md §Q12 expects
// without dropping the moment a new enemy appears. It is a default, not a
// constant — see Config, and M8.4 for why the number in force is stamped onto
// every row it produced.
const DefaultDedupThreshold = 10

// FPS is the extraction rate, fixed at 1 (CONTEXT.md §Q12). Not configurable:
// it is baked into the timestamps, the key format and the dedup's assumption
// that consecutive frames are a second apart, and a second rate would make the
// dataset a mixture in a way `dedup_threshold` alone could not record.
const FPS = 1

// Config is the extraction settings in force, and the thing M8.4 stamps onto
// its output.
//
// One struct rather than loose arguments so that ConfigVersion cannot describe
// a setting the run did not actually use: the same value produces the string
// and drives the work.
type Config struct {
	// DedupThreshold is the Hamming distance below which a frame is dropped as
	// a near-duplicate of the last kept one. Zero means DefaultDedupThreshold.
	DedupThreshold int
}

// Threshold is the effective threshold, defaulted.
func (c Config) Threshold() int {
	if c.DedupThreshold <= 0 {
		return DefaultDedupThreshold
	}
	return c.DedupThreshold
}

// ConfigVersion is what goes into `jobs.config_version` (M8.4): a short,
// stable, human-readable description of every setting that shaped this job's
// output.
//
// Stated rather than hashed, because the operator reading it a year from now
// wants to know *what* the settings were, not that they differed from another
// opaque digest. Anything added here that does not change the output is noise
// in that answer; anything that changes the output and is not here makes the
// dataset an unrecorded mixture, which is the exact failure M8.4 exists to
// prevent.
// The token names the *whole* hash pipeline, not just the transform, because
// the downscale in front of the DCT is part of what decides a bit. It changed
// once already: `dct64` hashed a Go box-filter downscale of the full-size JPEG,
// `dct64-va32` hashes ffmpeg's `scale=32:32:flags=area` output from the same
// decode. The two do not agree bit for bit, so rows produced under each are
// different regimes and have to say so — which is the entire reason this string
// is stamped per job rather than assumed constant.
func (c Config) ConfigVersion() string {
	return fmt.Sprintf("extract=ffmpeg-fps%d;phash=dct64-va32;threshold=%d", FPS, c.Threshold())
}
