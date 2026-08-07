package frames

import (
	"image"
	"image/color"
	"image/jpeg"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
)

// verticalBars and horizontalBars build two structurally different test
// images: bars in one axis so the DCT sees energy concentrated in a
// different spatial frequency than the other, which is what should push
// their hashes far apart. Solid fills or noise would not exercise the DCT at
// all, or would exercise nothing but it.
func verticalBars(size int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			c := color.Gray{Y: 32}
			if (x/4)%2 == 0 {
				c = color.Gray{Y: 224}
			}
			img.Set(x, y, c)
		}
	}
	return img
}

func horizontalBars(size int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			c := color.Gray{Y: 32}
			if (y/4)%2 == 0 {
				c = color.Gray{Y: 224}
			}
			img.Set(x, y, c)
		}
	}
	return img
}

// gradientScene builds a synthetic "photograph": three sine ripples at
// mutually prime-ish periods, summed, so energy is spread across many DCT
// frequencies with no exact ties between coefficients.
//
// The vertical/horizontal bar images above are deliberately degenerate — a
// hard-edged period-4 pattern concentrates almost all of its energy at
// exactly the frequencies that are multiples of hashSize/4, and drives most
// of the rest to exactly zero. That is perfect for proving two *different*
// patterns hash far apart, but it is the worst possible input for the
// brightness and JPEG-round-trip tests below: with dozens of AC coefficients
// sitting at or near zero, the sub-picovolt floating-point noise a uniform
// pixel shift or a lossy re-encode introduces is enough to tip several of
// them across the median and flip bits that carry no real signal. A real
// gameplay frame does not have that many exact ties, so a smoother synthetic
// scene is the honest stand-in for it.
func gradientScene(size int) *image.RGBA {
	// A fixed seed, not crypto/rand: the test has to see the same image on
	// every run, or a flake in CI would be unreproducible by definition.
	noise := rand.New(rand.NewSource(1))

	img := image.NewRGBA(image.Rect(0, 0, size, size))
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			// Three sinusoids alone concentrate almost all of the 8x8 kept
			// block's energy in the handful of coefficients matching their
			// periods, leaving the other ~60 clustered within noise
			// distance of zero (and of each other) — nothing like a real
			// frame, and exactly the condition that makes the median flip
			// under sub-pixel perturbation instead of tolerating it. The
			// dithered noise term gives every one of the 63 kept
			// coefficients real, separated energy the way a camera
			// sensor's actual noise floor does, which is what makes this
			// synthetic image a fair stand-in for one.
			//
			// Amplitudes (40+25+15+6=86) sum to comfortably inside
			// [0,255] centred on 128, leaving headroom on both ends so
			// brighten's test shift lands without clipping — a clamped
			// highlight would be a genuine structural change, not the
			// brightness-only difference this fixture is meant to be.
			v := 128 +
				40*math.Sin(2*math.Pi*float64(x)/37) +
				25*math.Sin(2*math.Pi*float64(y)/53) +
				15*math.Sin(2*math.Pi*float64(x+y)/17) +
				6*(noise.Float64()*2-1)
			img.Set(x, y, color.Gray{Y: uint8(v)})
		}
	}
	return img
}

// brighten returns a copy of img with every channel shifted up by delta,
// clamped at 255 — a stand-in for the exposure change PHashImage's doc
// comment names as the average-hash failure this implementation avoids.
func brighten(img *image.RGBA, delta int) *image.RGBA {
	bounds := img.Bounds()
	out := image.NewRGBA(bounds)
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			r, g, b, a := img.At(x, y).RGBA()
			shift := func(v uint32) uint8 {
				n := int(v>>8) + delta
				if n > 255 {
					n = 255
				}
				if n < 0 {
					n = 0
				}
				return uint8(n)
			}
			out.Set(x, y, color.RGBA{R: shift(r), G: shift(g), B: shift(b), A: uint8(a >> 8)})
		}
	}
	return out
}

func writeJPEG(t *testing.T, img image.Image) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "frame.jpg")
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("creating temp jpeg: %v", err)
	}
	defer f.Close()
	if err := jpeg.Encode(f, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("encoding temp jpeg: %v", err)
	}
	return path
}

func TestPHashImage_IdenticalImagesMatch(t *testing.T) {
	img := verticalBars(128)
	h1 := PHashImage(img)
	h2 := PHashImage(img)
	if h1 != h2 {
		t.Fatalf("identical images hashed differently: %s vs %s", h1.Hex(), h2.Hex())
	}
}

func TestPHashImage_BrightnessShiftStaysClose(t *testing.T) {
	base := gradientScene(128)
	shifted := brighten(base, 20)

	h1 := PHashImage(base)
	h2 := PHashImage(shifted)

	// "A few bits" per the brief: loose enough to tolerate the box-filter's
	// own rounding, tight enough that a broken DC-drop (the average-hash
	// failure this whole file exists to avoid) would fail it.
	if d := h1.Distance(h2); d > 6 {
		t.Fatalf("brightness-shifted image drifted %d bits, want <= 6 (hashes %s vs %s)", d, h1.Hex(), h2.Hex())
	}
}

func TestPHashImage_StructurallyDifferentImagesAreFar(t *testing.T) {
	vertical := PHashImage(verticalBars(128))
	horizontal := PHashImage(horizontalBars(128))

	if d := vertical.Distance(horizontal); d <= 20 {
		t.Fatalf("vertical vs horizontal bars only %d bits apart, want > 20 (hashes %s vs %s)",
			d, vertical.Hex(), horizontal.Hex())
	}
}

func TestPHash_StableAcrossJPEGRoundTrip(t *testing.T) {
	img := gradientScene(128)
	direct := PHashImage(img)

	path := writeJPEG(t, img)
	fromFile, err := PHash(path)
	if err != nil {
		t.Fatalf("PHash(%s): %v", path, err)
	}

	// JPEG is lossy, so this is not bit-for-bit equality — it is the same
	// tolerance a real chunk job gets, because every frame it hashes has
	// been through exactly this round trip via ffmpeg.
	if d := direct.Distance(fromFile); d > 4 {
		t.Fatalf("hash drifted %d bits across a JPEG round-trip, want <= 4 (hashes %s vs %s)",
			d, direct.Hex(), fromFile.Hex())
	}
}

func TestPHash_MissingFile(t *testing.T) {
	if _, err := PHash(filepath.Join(t.TempDir(), "does-not-exist.jpg")); err == nil {
		t.Fatal("PHash on a missing file: want error, got nil")
	}
}

func TestHash_HexRoundTripsThroughParseHash(t *testing.T) {
	h := PHashImage(verticalBars(128))

	parsed, err := ParseHash(h.Hex())
	if err != nil {
		t.Fatalf("ParseHash(%q): %v", h.Hex(), err)
	}
	if parsed != h {
		t.Fatalf("round trip mismatch: %s became %s", h.Hex(), parsed.Hex())
	}
}
