package frames

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// DefaultExtractBinary is ffmpeg, on PATH in the worker image alongside
// ffprobe and yt-dlp.
const DefaultExtractBinary = "ffmpeg"

// Segment is the slice of the source video a chunk job covers (CONTEXT.md
// §Q13): StartSeconds inclusive, EndSeconds exclusive, both offsets into the
// source video rather than into anything relative.
type Segment struct {
	StartSeconds int
	EndSeconds   int
}

// duration is the segment's length in whole seconds, the number ffmpeg is told
// to run for.
func (s Segment) duration() int {
	return s.EndSeconds - s.StartSeconds
}

// validate rejects a segment that cannot be turned into an ffmpeg invocation.
// Checked before a subprocess runs rather than left for ffmpeg to reject: a
// negative duration reads to ffmpeg as "until end of file", which would
// silently extract the whole remainder of the video under one chunk's job
// instead of failing.
func (s Segment) validate() error {
	if s.StartSeconds < 0 {
		return fmt.Errorf("segment start %ds is negative", s.StartSeconds)
	}
	if s.EndSeconds <= s.StartSeconds {
		return fmt.Errorf("segment [%ds, %ds) does not end after it starts", s.StartSeconds, s.EndSeconds)
	}
	return nil
}

// Extractor runs ffmpeg to turn a segment of a source video into JPEGs.
type Extractor struct {
	// Binary is the ffmpeg to run. Empty means DefaultExtractBinary; a path is
	// what the tests use to stand a script in its place.
	Binary string
}

// Extract writes one JPEG per second of seg into dir and returns them in
// timestamp order.
//
// dir is created and owned by the caller — a chunk job's scratch directory,
// used for nothing else — and Extract only writes into it. Cleanup belongs at
// the call site that created it: an Extract that removed dir out from under a
// caller still holding its path would turn a defer ordering mistake into a
// missing-directory error two functions away from the code that made it.
func (e Extractor) Extract(ctx context.Context, sourcePath string, seg Segment, dir string) ([]Frame, error) {
	if err := seg.validate(); err != nil {
		return nil, err
	}

	binary := e.Binary
	if binary == "" {
		binary = DefaultExtractBinary
	}

	var stderr bytes.Buffer

	cmd := exec.CommandContext(ctx, binary,
		// Errors only, matching Prober: anything else on stderr is noise in a
		// failure message an operator has to read cold.
		"-v", "error",
		"-nostdin",
		// Input seeking: -ss before -i tells the demuxer to jump straight to
		// the timestamp before decoding starts, so extracting segment 50 of a
		// long video costs the same as extracting segment 0. Placed after -ss,
		// -i would decode and discard every frame before the segment, turning
		// a fan-out's worth of chunk jobs into a fan-out's worth of full
		// linear scans of the same file.
		"-ss", strconv.Itoa(seg.StartSeconds),
		"-i", sourcePath,
		// A duration, not an end time: with -ss already before -i, ffmpeg has
		// moved the stream's origin to the seek point, and -to's timestamp is
		// read against that moved origin rather than the source video's own
		// timeline. -t sidesteps the question by never naming an absolute time
		// at all.
		"-t", strconv.Itoa(seg.duration()),
		// One frame per second (CONTEXT.md §Q12). Not configurable here: the
		// rate is baked into how the returned timestamps are computed below,
		// and frames.FPS is the one place that assumption is allowed to live.
		"-vf", fmt.Sprintf("fps=%d", FPS),
		// Quality 2: visually lossless-ish JPEG, the low end of ffmpeg's
		// scale. The dataset's fidelity ceiling is this number, not the model
		// training on it later, so it errs toward quality over the bytes it
		// costs in R2.
		"-q:v", "2",
		"-f", "image2",
		filepath.Join(dir, "%06d.jpg"),
	)
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		// Checked before the message is read: a job whose lease expired mid-
		// extract is killed by its context, and the stderr of a killed ffmpeg
		// says nothing about the video.
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, fmt.Errorf("extracting %s [%ds, %ds): %w", sourcePath, seg.StartSeconds, seg.EndSeconds, ctxErr)
		}

		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return nil, fmt.Errorf("extracting %s [%ds, %ds): %s", sourcePath, seg.StartSeconds, seg.EndSeconds, message)
	}

	return readFrames(dir, seg.StartSeconds)
}

// readFrames lists dir rather than trusting ffmpeg produced exactly
// duration() files: the final segment of a video is routinely shorter than
// 60s of source, ffmpeg stops emitting frames when the input runs out, and a
// count assumed rather than discovered would either wait on frames that will
// never arrive or index past the ones that exist. Zero files is a real
// outcome, not an error — a segment that starts past the true end of a
// (mis-probed, or since-changed) file is boring, and it is the caller's job to
// decide what an empty chunk means.
func readFrames(dir string, startSeconds int) ([]Frame, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("reading extracted frames from %s: %w", dir, err)
	}

	var names []string
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jpg") {
			continue
		}
		names = append(names, entry.Name())
	}

	// Lexicographic sort matches numeric order because the %06d pattern above
	// pads every name to the same width; ffmpeg's own numbering (which may not
	// start at 0, and is never trusted to mean anything) never has to be
	// parsed.
	sort.Strings(names)

	frames := make([]Frame, len(names))
	for i, name := range names {
		// The offset into the *source* video, not the index into this
		// segment: fps=1 emits its first frame at the start of the trimmed
		// stream regardless of where that stream began, so frame i lands at
		// startSeconds+i. frames.Key and the images row are both keyed on this
		// number (frames.go), so getting it wrong here does not fail loudly —
		// it silently aliases one segment's frames onto another's R2 keys.
		frames[i] = Frame{
			Path:             filepath.Join(dir, name),
			TimestampSeconds: float64(startSeconds + i),
		}
	}

	return frames, nil
}
