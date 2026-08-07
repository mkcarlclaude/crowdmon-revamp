package frames_test

import (
	"context"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/frames"
)

// fakeBinary writes an executable shell script and returns its path.
//
// Copied from worker/internal/video's helper of the same name rather than
// shared: this package cannot import a test-only helper from another
// package's _test.go, and the two fakes drift for unrelated reasons — this
// one's callers care about argv, video's care about stdout framing.
func fakeBinary(t *testing.T, script string) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "fake-ffmpeg")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatalf("writing the fake binary: %v", err)
	}

	return path
}

func TestExtractPassesTheExpectedArguments(t *testing.T) {
	dir := t.TempDir()
	argv := filepath.Join(dir, "argv")

	binary := fakeBinary(t, `
printf '%s\n' "$@" > `+argv+`
`)

	_, err := frames.Extractor{Binary: binary}.
		Extract(t.Context(), "/videos/aaaaaaaaaaa.mp4", frames.Segment{StartSeconds: 120, EndSeconds: 180}, dir)
	if err != nil {
		t.Fatalf("Extract: %v", err)
	}

	got, err := os.ReadFile(argv)
	if err != nil {
		t.Fatal(err)
	}
	// -ss before -i (fast input seek), -t for a duration rather than -to
	// (unambiguous once -ss has moved the stream's origin), fps=1 baked in by
	// frames.FPS, and two outputs off one decode.
	//
	// The single `fps` ahead of `split` is the part worth pinning: two
	// independent `-vf fps=1` chains would decimate identically almost always,
	// and pair a frame with a different frame's thumbnail the once they did
	// not.
	want := strings.Join([]string{
		"-v", "error",
		"-nostdin",
		"-ss", "120",
		"-i", "/videos/aaaaaaaaaaa.mp4",
		"-t", "60",
		"-filter_complex", "[0:v]fps=1,split=2[full][small];[small]scale=32:32:flags=area,format=gray[grey]",
		"-map", "[full]",
		"-q:v", "2",
		"-f", "image2",
		filepath.Join(dir, "%06d.jpg"),
		"-map", "[grey]",
		"-f", "image2",
		filepath.Join(dir, "hash-%06d.png"),
	}, "\n") + "\n"

	if string(got) != want {
		t.Errorf("ffmpeg argv =\n%s\nwant\n%s", got, want)
	}
}

func TestExtractReturnsFramesInTimestampOrder(t *testing.T) {
	dir := t.TempDir()

	// A fake that behaves like ffmpeg landed mid-video: three frames, numbered
	// the way the image2 muxer numbers them, deliberately out of the order a
	// naive directory read might return them in on some filesystems — each with
	// the thumbnail the second output branch writes beside it.
	binary := fakeBinary(t, `
touch "`+dir+`/000002.jpg" "`+dir+`/000001.jpg" "`+dir+`/000003.jpg"
touch "`+dir+`/hash-000001.png" "`+dir+`/hash-000002.png" "`+dir+`/hash-000003.png"
`)

	got, err := frames.Extractor{Binary: binary}.
		Extract(t.Context(), "/videos/x.mp4", frames.Segment{StartSeconds: 300, EndSeconds: 360}, dir)
	if err != nil {
		t.Fatalf("Extract: %v", err)
	}

	// Offsets into the source video (300, 301, 302), not into the segment
	// (0, 1, 2). Everything downstream keys on the source-video offset
	// (frames.Key), and a segment-relative number here would alias segment
	// 3's frame 0 onto segment 7's frame 0.
	wantTimestamps := []float64{300, 301, 302}
	if len(got) != len(wantTimestamps) {
		t.Fatalf("got %d frames, want %d", len(got), len(wantTimestamps))
	}
	for i, want := range wantTimestamps {
		if got[i].TimestampSeconds != want {
			t.Errorf("frame %d: TimestampSeconds = %v, want %v", i, got[i].TimestampSeconds, want)
		}
		if got[i].Path == "" {
			t.Errorf("frame %d: empty Path", i)
		}
		// Paired by name, not by position: `000002.jpg` must carry
		// `hash-000002.png` even though the directory listed it first.
		wantHash := filepath.Join(dir, "hash-"+
			strings.TrimSuffix(filepath.Base(got[i].Path), ".jpg")+".png")
		if got[i].HashPath != wantHash {
			t.Errorf("frame %d: HashPath = %q, want %q", i, got[i].HashPath, wantHash)
		}
	}
}

func TestExtractFailsWhenAFrameHasNoThumbnail(t *testing.T) {
	dir := t.TempDir()

	// Two frames, one thumbnail: the two branches of the filter graph
	// disagreed about how many frames there were.
	binary := fakeBinary(t, `
touch "`+dir+`/000001.jpg" "`+dir+`/000002.jpg"
touch "`+dir+`/hash-000001.png"
`)

	_, err := frames.Extractor{Binary: binary}.
		Extract(t.Context(), "/videos/x.mp4", frames.Segment{StartSeconds: 0, EndSeconds: 60}, dir)

	// Loud, because the quiet alternative is worse: Frame.hashSource falls back
	// to the full-size JPEG when HashPath is empty, so a missing thumbnail that
	// went unnoticed would hash one chunk through a different pipeline than
	// every other — a regime split that no config_version records, which is
	// precisely the failure M8.4 exists to make impossible.
	if err == nil {
		t.Fatal("Extract succeeded with a frame that had no thumbnail beside it")
	}
	if !strings.Contains(err.Error(), "thumbnail") {
		t.Errorf("error %q does not say what is missing", err)
	}
}

func TestExtractReturnsAnEmptySliceRatherThanAnErrorWhenNoFramesLand(t *testing.T) {
	dir := t.TempDir()

	// A real ffmpeg exits 0 having written nothing when -ss lands past the end
	// of the file — the tail segment of a video whose true length is shorter
	// than what was probed. This is boring, not a failure: the fake reproduces
	// it by simply not writing any files.
	binary := fakeBinary(t, `exit 0`)

	got, err := frames.Extractor{Binary: binary}.
		Extract(t.Context(), "/videos/x.mp4", frames.Segment{StartSeconds: 600, EndSeconds: 660}, dir)
	if err != nil {
		t.Fatalf("Extract: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("got %d frames, want 0", len(got))
	}
}

func TestExtractSurfacesStderrOnFailure(t *testing.T) {
	dir := t.TempDir()

	binary := fakeBinary(t, `echo "aaaaaaaaaaa.mp4: Invalid data found when processing input" >&2; exit 1`)

	_, err := frames.Extractor{Binary: binary}.
		Extract(t.Context(), "/videos/aaaaaaaaaaa.mp4", frames.Segment{StartSeconds: 0, EndSeconds: 60}, dir)

	if err == nil {
		t.Fatal("Extract succeeded on a failing ffmpeg")
	}
	if !strings.Contains(err.Error(), "Invalid data found") {
		t.Errorf("error %q does not say what ffmpeg said", err)
	}
}

func TestExtractReportsACancelledContextAsCancellation(t *testing.T) {
	dir := t.TempDir()

	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	binary := fakeBinary(t, `sleep 30`)

	_, err := frames.Extractor{Binary: binary}.
		Extract(ctx, "/videos/aaaaaaaaaaa.mp4", frames.Segment{StartSeconds: 0, EndSeconds: 60}, dir)

	// A chunk job whose lease expired mid-extract is killed by its context, and
	// the runner reads this to tell a shutdown from ffmpeg actually failing.
	if !isContextCanceled(err) {
		t.Fatalf("Extract error = %v, want context.Canceled", err)
	}
}

func isContextCanceled(err error) bool {
	return err != nil && strings.Contains(err.Error(), "context canceled")
}

func TestExtractRejectsAnInvalidSegment(t *testing.T) {
	dir := t.TempDir()

	for name, seg := range map[string]frames.Segment{
		"negative start":     {StartSeconds: -1, EndSeconds: 60},
		"end equal to start": {StartSeconds: 60, EndSeconds: 60},
		"end before start":   {StartSeconds: 60, EndSeconds: 30},
	} {
		t.Run(name, func(t *testing.T) {
			// Never runs: a bad segment is rejected before a subprocess starts.
			// ffmpeg reads a negative -t as "no limit", which would silently
			// extract the whole rest of the file under one chunk's job.
			binary := fakeBinary(t, `echo "should not have run" >&2; exit 1`)

			_, err := frames.Extractor{Binary: binary}.Extract(t.Context(), "/videos/x.mp4", seg, dir)
			if err == nil {
				t.Fatalf("Extract succeeded on invalid segment %+v", seg)
			}
		})
	}
}

// TestExtractEndToEndWithRealFFmpeg runs the real binary against a synthetic
// video. It is the one test in this file that would catch a wrong flag: every
// test above proves this package builds the argv it thinks it builds, and
// none of them prove ffmpeg agrees that argv means what the comments say it
// means.
func TestExtractEndToEndWithRealFFmpeg(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}

	sourceDir := t.TempDir()
	source := filepath.Join(sourceDir, "out.mp4")

	gen := exec.CommandContext(t.Context(), "ffmpeg",
		"-v", "error", "-nostdin",
		"-f", "lavfi", "-i", "testsrc=duration=10:size=320x240:rate=30",
		source,
	)
	if out, err := gen.CombinedOutput(); err != nil {
		t.Fatalf("generating the synthetic source video: %v\n%s", err, out)
	}

	dir := t.TempDir()

	got, err := frames.Extractor{}.
		Extract(t.Context(), source, frames.Segment{StartSeconds: 3, EndSeconds: 7}, dir)
	if err != nil {
		t.Fatalf("Extract: %v", err)
	}

	wantTimestamps := []float64{3, 4, 5, 6}
	if len(got) != len(wantTimestamps) {
		t.Fatalf("got %d frames, want %d", len(got), len(wantTimestamps))
	}

	for i, want := range wantTimestamps {
		if got[i].TimestampSeconds != want {
			t.Errorf("frame %d: TimestampSeconds = %v, want %v", i, got[i].TimestampSeconds, want)
		}

		f, err := os.Open(got[i].Path)
		if err != nil {
			t.Fatalf("frame %d: opening %s: %v", i, got[i].Path, err)
		}
		cfg, err := jpeg.DecodeConfig(f)
		f.Close()
		if err != nil {
			t.Fatalf("frame %d: %s does not decode as a JPEG: %v", i, got[i].Path, err)
		}
		if cfg.Width != 320 || cfg.Height != 240 {
			t.Errorf("frame %d: decoded %dx%d, want 320x240", i, cfg.Width, cfg.Height)
		}

		// The second output branch, which is the whole reason the filter graph
		// is a filter_complex. Real ffmpeg is the only thing that can prove
		// `split` plus `scale=32:32:flags=area,format=gray` produces what
		// phash.go expects to read.
		h, err := os.Open(got[i].HashPath)
		if err != nil {
			t.Fatalf("frame %d: opening thumbnail %s: %v", i, got[i].HashPath, err)
		}
		hcfg, err := png.DecodeConfig(h)
		h.Close()
		if err != nil {
			t.Fatalf("frame %d: %s does not decode as a PNG: %v", i, got[i].HashPath, err)
		}
		if hcfg.Width != 32 || hcfg.Height != 32 {
			t.Errorf("frame %d: thumbnail is %dx%d, want 32x32", i, hcfg.Width, hcfg.Height)
		}
		if _, ok := hcfg.ColorModel.(color.Palette); ok {
			t.Errorf("frame %d: thumbnail is paletted, want greyscale samples", i)
		}
	}

	// The point of the whole change: hashing the thumbnail must agree with
	// hashing nothing at all differently from frame to frame. Two visibly
	// different frames of testsrc must not collide, and the same frame hashed
	// twice must be stable.
	first, err := frames.PHash(got[0].HashPath)
	if err != nil {
		t.Fatalf("hashing the first thumbnail: %v", err)
	}
	again, err := frames.PHash(got[0].HashPath)
	if err != nil {
		t.Fatalf("re-hashing the first thumbnail: %v", err)
	}
	if first != again {
		t.Errorf("hashing the same thumbnail twice gave %s then %s", first.Hex(), again.Hex())
	}

	last, err := frames.PHash(got[len(got)-1].HashPath)
	if err != nil {
		t.Fatalf("hashing the last thumbnail: %v", err)
	}
	// testsrc's counter and colour bars move visibly across four seconds. If
	// these collided, the thumbnail would be carrying no structure and every
	// frame in a chunk would dedup away to one.
	if first == last {
		t.Errorf("frames 3s and 6s of testsrc hashed identically (%s)", first.Hex())
	}
}
