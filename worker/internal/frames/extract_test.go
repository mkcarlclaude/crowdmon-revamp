package frames_test

import (
	"context"
	"image/jpeg"
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
	// frames.FPS, and the output template ffmpeg writes numbered files under.
	want := strings.Join([]string{
		"-v", "error",
		"-nostdin",
		"-ss", "120",
		"-i", "/videos/aaaaaaaaaaa.mp4",
		"-t", "60",
		"-vf", "fps=1",
		"-q:v", "2",
		"-f", "image2",
		filepath.Join(dir, "%06d.jpg"),
	}, "\n") + "\n"

	if string(got) != want {
		t.Errorf("ffmpeg argv =\n%s\nwant\n%s", got, want)
	}
}

func TestExtractReturnsFramesInTimestampOrder(t *testing.T) {
	dir := t.TempDir()

	// A fake that behaves like ffmpeg landed mid-video: three frames, numbered
	// the way the image2 muxer numbers them, deliberately out of the order a
	// naive directory read might return them in on some filesystems.
	binary := fakeBinary(t, `
touch "`+dir+`/000002.jpg" "`+dir+`/000001.jpg" "`+dir+`/000003.jpg"
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
	}
}
