package video_test

import (
	"strings"
	"testing"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/video"
)

// prints is a fake ffprobe that writes fixed JSON on stdout.
func prints(t *testing.T, out string) string {
	t.Helper()
	return fakeBinary(t, "cat <<'PROBE_JSON'\n"+out+"\nPROBE_JSON\n")
}

func TestProbeReadsDurationAndResolution(t *testing.T) {
	// ffprobe's real shape: duration is a string of seconds on `format`, and
	// the dimensions are on the first video stream.
	binary := prints(t, `{
  "programs": [],
  "streams": [ { "width": 1920, "height": 1080 } ],
  "format": { "duration": "150.400000" }
}`)

	meta, err := video.Prober{Binary: binary}.Probe(t.Context(), "/videos/aaaaaaaaaaa.mp4")
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}

	// Rounded up, not truncated. The fan-out's last segment ends at the
	// duration, and a video reported as 150s would leave the final four tenths
	// of a second in no chunk at all.
	if meta.DurationSeconds != 151 {
		t.Errorf("DurationSeconds = %d, want 151", meta.DurationSeconds)
	}
	if meta.Width != 1920 || meta.Height != 1080 {
		t.Errorf("resolution = %dx%d, want 1920x1080", meta.Width, meta.Height)
	}
}

func TestProbeRejectsAFileWithNoVideoStream(t *testing.T) {
	binary := prints(t, `{ "streams": [], "format": { "duration": "150.0" } }`)

	_, err := video.Prober{Binary: binary}.Probe(t.Context(), "/videos/aaaaaaaaaaa.mp4")

	// There is nothing to extract frames from, and fanning out would enqueue
	// chunk jobs that each discover this separately.
	if err == nil {
		t.Fatal("Probe succeeded on a file with no video stream")
	}
}

func TestProbeRejectsAFileWithNoDuration(t *testing.T) {
	// A livestream capture, or a file whose container lost its duration. The
	// fan-out has nothing to divide into segments.
	binary := prints(t, `{ "streams": [ { "width": 1920, "height": 1080 } ], "format": {} }`)

	_, err := video.Prober{Binary: binary}.Probe(t.Context(), "/videos/aaaaaaaaaaa.mp4")

	if err == nil {
		t.Fatal("Probe succeeded on a file with no duration")
	}
}

func TestProbeCarriesWhatFfprobeSaid(t *testing.T) {
	binary := fakeBinary(t, `echo "/videos/x.mp4: Invalid data found when processing input" >&2; exit 1`)

	_, err := video.Prober{Binary: binary}.Probe(t.Context(), "/videos/aaaaaaaaaaa.mp4")

	if err == nil {
		t.Fatal("Probe succeeded on an unreadable file")
	}
	if !strings.Contains(err.Error(), "Invalid data found") {
		t.Errorf("error %q does not say what ffprobe said", err)
	}
}
