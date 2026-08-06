package video

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os/exec"
	"strconv"
	"strings"
)

// DefaultProbeBinary is ffprobe, on PATH in the worker image alongside ffmpeg.
const DefaultProbeBinary = "ffprobe"

// Metadata is what the file itself says about the video, which is not always
// what YouTube said about it: the format selection can hand back a stream at a
// different resolution, and the duration of what landed is the one the
// segments have to tile.
type Metadata struct {
	// Whole seconds, rounded up. See Probe.
	DurationSeconds int
	Width           int
	Height          int
}

// Prober measures a downloaded file with ffprobe.
type Prober struct {
	// Binary is the ffprobe to run. Empty means DefaultProbeBinary.
	Binary string
}

// probeOutput is the subset of `ffprobe -of json` this needs.
type probeOutput struct {
	Streams []struct {
		Width  int `json:"width"`
		Height int `json:"height"`
	} `json:"streams"`
	Format struct {
		// A string of seconds — ffprobe reports it that way, and decoding it
		// as a number would fail on the files that report `N/A`.
		Duration string `json:"duration"`
	} `json:"format"`
}

// Probe reads the duration and resolution of the file at path.
//
// The duration is rounded up to whole seconds. The fan-out's last segment ends
// at exactly this number (M7.2), so rounding down would leave the tail of the
// video in no chunk at all — a silent hole in the dataset rather than a
// visible failure.
func (p Prober) Probe(ctx context.Context, path string) (Metadata, error) {
	binary := p.Binary
	if binary == "" {
		binary = DefaultProbeBinary
	}

	var stdout, stderr bytes.Buffer

	cmd := exec.CommandContext(ctx, binary,
		// Errors only: anything else on stderr would be noise in a failure
		// message that has to explain itself to an operator.
		"-v", "error",
		// The first video stream. A file can carry several, and the one being
		// extracted from is the one ffmpeg will pick by the same rule.
		"-select_streams", "v:0",
		"-show_entries", "stream=width,height:format=duration",
		"-of", "json",
		path,
	)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return Metadata{}, fmt.Errorf("probing %s: %w", path, ctxErr)
		}

		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return Metadata{}, fmt.Errorf("probing %s: %s", path, message)
	}

	var out probeOutput
	if err := json.Unmarshal(stdout.Bytes(), &out); err != nil {
		return Metadata{}, fmt.Errorf("reading ffprobe's output for %s: %w", path, err)
	}

	if len(out.Streams) == 0 {
		return Metadata{}, fmt.Errorf("%s has no video stream", path)
	}

	seconds, err := strconv.ParseFloat(out.Format.Duration, 64)
	if err != nil || seconds <= 0 {
		// A livestream capture, or a container that lost its duration. There
		// is nothing to divide into segments, and finding that out here beats
		// finding it out as a fan-out that enqueued nothing.
		return Metadata{}, fmt.Errorf("%s reports no usable duration (%q)", path, out.Format.Duration)
	}

	return Metadata{
		DurationSeconds: int(math.Ceil(seconds)),
		Width:           out.Streams[0].Width,
		Height:          out.Streams[0].Height,
	}, nil
}
