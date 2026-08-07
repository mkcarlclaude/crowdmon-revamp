package frames

import (
	"fmt"
	"image"
	_ "image/jpeg" // registers the JPEG decoder Decode below needs
	"math"
	"os"
	"sort"
	"sync"
)

// hashSize is the side of the greyscale grid the DCT runs over. 32 is the
// textbook pHash size: large enough that the low-frequency coefficients it
// produces still describe the frame's actual structure, small enough that the
// O(n^4) DCT below stays cheap per frame (CONTEXT.md §Q12 wants this run
// concurrently across a whole chunk, not once).
const hashSize = 32

// blockSize is the side of the top-left coefficient block kept after the DCT.
// 8x8 is where the DCT-II concentrates a natural image's energy — low spatial
// frequencies, which survive resizing, recompression and the sensor noise a
// higher block would start encoding. It also fixes the hash at 64 bits: one
// bit per coefficient, minus the DC term (see PHashImage).
const blockSize = 8

// PHash computes the 64-bit perceptual hash of the JPEG at path.
//
// It reads and decodes the whole file rather than streaming it, because the
// downscale to hashSize needs every pixel once and a 1fps gameplay frame is a
// few hundred KB — decoding it twice to avoid holding it in memory would cost
// more than the memory saves.
func PHash(path string) (Hash, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, fmt.Errorf("hashing %s: %w", path, err)
	}
	defer f.Close()

	img, _, err := image.Decode(f)
	if err != nil {
		return 0, fmt.Errorf("hashing %s: decoding: %w", path, err)
	}

	return PHashImage(img), nil
}

// PHashImage is PHash for an already-decoded image, so the tests can hash a
// generated image without a round trip through a file, and so PHash itself is
// just "decode, then this".
//
// This is a DCT hash, not the simpler average hash (resize small, threshold
// against the mean). Average hash is thrown by two things this worker's
// frames actually have: a brightness shift (a torch flicking on shifts every
// pixel the same direction, and the mean moves with them, so the bit pattern
// changes even though nothing in the scene did) and a static HUD overlay
// (a health bar occupying a fixed corner dominates the small thumbnail's mean
// far out of proportion to how much of the *scene* it is). The DCT separates
// the image into spatial frequencies, and both of those failure modes are
// energy concentrated in the low frequencies alongside the real structure —
// exactly where dropping the DC term (below) removes them.
func PHashImage(img image.Image) Hash {
	grey := resizeGreyscale(img, hashSize, hashSize)
	coeffs := dct2D(grey)

	// The top-left blockSize x blockSize block: the lowest spatial
	// frequencies, where a photograph's energy concentrates. Everything
	// outside this block is detail fine enough that a resize, a JPEG
	// re-encode or a single-pixel camera shake could flip it, which would
	// make the hash track compression artifacts instead of the picture.
	values := make([]float64, 0, blockSize*blockSize)
	for v := 0; v < blockSize; v++ {
		for u := 0; u < blockSize; u++ {
			values = append(values, coeffs[v][u])
		}
	}

	// values[0] is coeffs[0][0], the DC term: the average brightness of the
	// whole 32x32 grid, carrying no structure at all. Comparing it against
	// its own neighbours would produce a bit that tracks exposure rather than
	// content, i.e. exactly the average-hash failure this function exists to
	// avoid. It is dropped from the median and its slot — bit 63, the MSB —
	// is left zero: a stated decision, not an off-by-one. 63 real comparisons
	// live in bits 62 down to 0; bit 63 is a placeholder rather than a 64th
	// comparison against noise.
	acCoeffs := values[1:]

	median := medianOf(acCoeffs)

	var hash uint64
	for i, v := range acCoeffs {
		if v > median {
			// Row-major from coeffs[0][1] (i == 0) down to coeffs[7][7]
			// (i == 62), packed MSB-first starting at bit 62. The exact
			// ordering only has to be consistent with itself — nothing
			// outside this file interprets individual bit positions — so
			// "first coefficient in the highest surviving bit" is chosen for
			// readability when a hash is printed in hex, not for any
			// property Distance relies on.
			hash |= 1 << (62 - i)
		}
	}

	return Hash(hash)
}

// medianOf returns the median of a copy of vs, leaving the caller's slice
// order untouched — dct2D's caller has no reason to expect its coefficients
// reordered by a hash computation run over them.
func medianOf(vs []float64) float64 {
	sorted := make([]float64, len(vs))
	copy(sorted, vs)
	sort.Float64s(sorted)

	n := len(sorted)
	if n%2 == 1 {
		return sorted[n/2]
	}
	return (sorted[n/2-1] + sorted[n/2]) / 2
}

// resizeGreyscale downscales img to width x height greyscale samples using a
// box (area-average) filter.
//
// Nearest-neighbour would pick one source pixel per destination cell and
// throw the rest away; on a downscale from typical 720p/1080p source frames
// to 32x32, that is discarding upwards of 99% of the pixels the DCT is
// supposed to be summarising, and it aliases exactly the kind of fine texture
// (grass, gravel, a HUD's edge) that gameplay footage is full of. Averaging
// every source pixel that falls in each destination cell is the honest
// downscale: it is what the resulting low-frequency DCT coefficients assume
// happened.
func resizeGreyscale(img image.Image, width, height int) [][]float64 {
	bounds := img.Bounds()
	srcW, srcH := bounds.Dx(), bounds.Dy()

	out := make([][]float64, height)
	for i := range out {
		out[i] = make([]float64, width)
	}

	for y := 0; y < height; y++ {
		// The source row band this destination row averages over, in source
		// pixel coordinates.
		y0 := y * srcH / height
		y1 := (y + 1) * srcH / height
		if y1 <= y0 {
			y1 = y0 + 1
		}

		for x := 0; x < width; x++ {
			x0 := x * srcW / width
			x1 := (x + 1) * srcW / width
			if x1 <= x0 {
				x1 = x0 + 1
			}

			var sum float64
			var count int
			for sy := y0; sy < y1; sy++ {
				for sx := x0; sx < x1; sx++ {
					r, g, b, _ := img.At(bounds.Min.X+sx, bounds.Min.Y+sy).RGBA()
					// Rec. 601 luma weights. Any fixed weighting is fine here
					// — the hash only needs to be consistent with itself
					// frame to frame, not colourimetrically accurate — but
					// matching the standard weights means a greyscale source
					// frame hashes the same as a colour one of the same
					// scene, which is one less variable when debugging a
					// hash that looks wrong.
					grey := 0.299*float64(r>>8) + 0.587*float64(g>>8) + 0.114*float64(b>>8)
					sum += grey
					count++
				}
			}
			out[y][x] = sum / float64(count)
		}
	}

	return out
}

// cosineTable holds cos((2x+1)*u*pi/(2*hashSize)) for every (x, u) pair the
// 2-D DCT needs. Built once, not per frame: the naive O(n^4) DCT below already
// does hashSize^4 (~1M) multiply-adds per frame, and a chunk hashes up to 60
// of them concurrently (dedup.go) — calling math.Cos inside that loop would
// mean paying its cost roughly hashSize^2 times more often than the number of
// distinct inputs it ever receives, since cos((2x+1)*u*pi/(2N)) only depends
// on (x, u), both bounded by hashSize, and repeats identically across every v
// row, every image, and every frame in the chunk.
var cosineTable = sync.OnceValue(func() [hashSize][hashSize]float64 {
	var t [hashSize][hashSize]float64
	for x := 0; x < hashSize; x++ {
		for u := 0; u < hashSize; u++ {
			t[x][u] = math.Cos(float64(2*x+1) * float64(u) * math.Pi / (2 * hashSize))
		}
	}
	return t
})

// dct2D computes the 2-D DCT-II of an N x N matrix, N == hashSize.
//
// A DCT rather than an FFT-based average: N is fixed at 32, the transform
// runs once per frame rather than in a hot loop over the whole video, and the
// straightforward O(n^4) sum over (x, y, u, v) is easier to verify against the
// textbook formula than a separable or FFT-based version would be to get
// right — correctness matters more than the last order of magnitude here,
// per the performance note this file's tests hold it to (60 frames per
// chunk, not 60 per second).
func dct2D(pixels [][]float64) [hashSize][hashSize]float64 {
	table := cosineTable()

	var out [hashSize][hashSize]float64
	for v := 0; v < hashSize; v++ {
		for u := 0; u < hashSize; u++ {
			var sum float64
			for y := 0; y < hashSize; y++ {
				cv := table[y][v]
				row := pixels[y]
				for x := 0; x < hashSize; x++ {
					sum += row[x] * table[x][u] * cv
				}
			}

			// Orthonormal scaling factors: 1/N for the DC row/column, 2/N
			// elsewhere. Only the *relative* magnitude of coefficients
			// matters for the median-threshold bit pattern, but using the
			// standard normalisation keeps this function's output equal to
			// any reference DCT-II implementation, which is what the tests
			// check it against.
			cu, cvScale := 2.0, 2.0
			if u == 0 {
				cu = 1.0
			}
			if v == 0 {
				cvScale = 1.0
			}
			out[v][u] = sum * math.Sqrt(cu/hashSize) * math.Sqrt(cvScale/hashSize)
		}
	}
	return out
}
