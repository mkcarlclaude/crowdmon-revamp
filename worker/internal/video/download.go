package video

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// ErrUnavailable marks a download that failed for a reason retrying cannot
// fix: the video is deleted, private, geo-blocked, members-only or age-gated.
//
// The distinction is the whole of M7.1's second bullet, and it is drawn here
// rather than in the worker because this package is the only one that ever
// sees yt-dlp's message. What the worker does with it — report the job failed
// instead of leaving it for the reaper — is the worker's decision to make.
var ErrUnavailable = errors.New("the video cannot be downloaded")

// DefaultBinary is the downloader, on PATH in the worker image.
const DefaultBinary = "yt-dlp"

// terminalMarkers are substrings of yt-dlp's stderr that mean the video will
// never download. Matched as fragments of the message rather than whole lines
// because yt-dlp prefixes them with the extractor and the video id, and the
// wording after them varies.
//
// Deliberately a short list of certainties. Everything unlisted is retried,
// which costs a lease window; a wrong entry here retires a video permanently
// on its first bad day. `Sign in to confirm you're not a bot` is the one to
// keep out — it reads exactly like the age gate and is about this box's
// address, not about the video.
var terminalMarkers = []string{
	"Video unavailable",
	"This video is unavailable",
	"Private video",
	"This video is private",
	"has been removed",
	"account associated with this video has been terminated",
	"available in your country",
	"blocked it in your country",
	"available from your location",
	"members-only",
	"Join this channel to get access",
	"Sign in to confirm your age",
	"age-restricted",
}

// Source is a downloaded video on local disk.
type Source struct {
	Path string
	// Title as yt-dlp reported it. Empty when the file was already on disk and
	// no download ran — nothing on the video's own row depends on it, and the
	// fan-out leaves what it has rather than overwriting a title with nothing.
	Title string
	Bytes int64
}

// Downloader fetches source videos with yt-dlp.
type Downloader struct {
	// Binary is the yt-dlp to run. Empty means DefaultBinary; a path is what
	// the tests use to stand a script in its place.
	Binary string
	Store  Store
}

// Download fetches the video into the store, or returns what stopped it.
//
// A video already on disk is returned as it is. That is not an optimisation:
// a download job reaped mid-fan-out is claimed again (M7.3), and re-fetching
// several gigabytes to arrive at the file that is already there would make a
// reap during phase one cost more than the work it interrupted.
func (d Downloader) Download(ctx context.Context, videoID, url string) (Source, error) {
	switch path, err := d.Store.Path(videoID); {
	case err == nil:
		info, statErr := os.Stat(path)
		if statErr != nil {
			return Source{}, fmt.Errorf("measuring the source video: %w", statErr)
		}
		return Source{Path: path, Bytes: info.Size()}, nil
	case !errors.Is(err, ErrNotDownloaded):
		return Source{}, err
	}

	if err := os.MkdirAll(d.Store.Dir, 0o755); err != nil {
		return Source{}, fmt.Errorf("creating the video directory: %w", err)
	}

	printed, err := d.run(ctx, videoID, url)
	if err != nil {
		return Source{}, err
	}

	// yt-dlp is trusted for where it put the file, and the filesystem for
	// everything else. A size read from the JSON would be whatever the server
	// claimed rather than what landed.
	info, err := os.Stat(printed.Filepath)
	if err != nil {
		return Source{}, fmt.Errorf("yt-dlp reported a file that is not there: %w", err)
	}

	return Source{Path: printed.Filepath, Title: printed.Title, Bytes: info.Size()}, nil
}

// downloadResult is the one line yt-dlp prints under the JSON template below.
type downloadResult struct {
	Filepath string `json:"filepath"`
	Title    string `json:"title"`
}

func (d Downloader) run(ctx context.Context, videoID, url string) (downloadResult, error) {
	binary := d.Binary
	if binary == "" {
		binary = DefaultBinary
	}

	var stdout, stderr bytes.Buffer

	cmd := exec.CommandContext(ctx, binary, d.args(videoID, url)...)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		// Checked before the message is classified: a cancelled download is
		// killed mid-fetch, and its half-written stderr says nothing about the
		// video. The runner reads this to tell a shutdown from a failure.
		if ctxErr := ctx.Err(); ctxErr != nil {
			return downloadResult{}, fmt.Errorf("downloading %s: %w", videoID, ctxErr)
		}
		return downloadResult{}, downloadError(videoID, stderr.String(), err)
	}

	// The last non-empty line: `--no-simulate` leaves `--print`'s implied
	// `--quiet` in force, so this is normally the only line, but a warning
	// printed to stdout by an extractor would otherwise be parsed as the
	// result.
	lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
	last := strings.TrimSpace(lines[len(lines)-1])

	var result downloadResult
	if err := json.Unmarshal([]byte(last), &result); err != nil {
		return downloadResult{}, fmt.Errorf("yt-dlp printed %q, which is not the expected JSON: %w", last, err)
	}
	if result.Filepath == "" {
		return downloadResult{}, fmt.Errorf("yt-dlp printed no file path for %s", videoID)
	}

	return result, nil
}

func (d Downloader) args(videoID, url string) []string {
	return []string{
		// One video. A `&list=` URL is one paste away from the submit form,
		// and without this yt-dlp fetches the whole playlist under one lease.
		"--no-playlist",
		"--no-color",
		// Video only, and no larger than 1080p. Frames are all this pipeline
		// wants, so an audio stream is bytes and a merge step for nothing; the
		// fallbacks keep a video that has no video-only format downloadable.
		"-f", "bv*[height<=1080]/b[height<=1080]/b",
		// The store finds a source by video id (M7.4), so the name is not a
		// preference — a file named after the title could not be found again.
		"-o", d.Store.outputTemplate(videoID),
		// After the merge and the move, so the path printed is the file that
		// ends up on disk rather than a temporary one. `--no-simulate` because
		// `--print` on its own turns the download into a dry run.
		"--print", "after_move:%(.{filepath,title})j",
		"--no-simulate",
		// yt-dlp's own retries, for the failures too small to be worth a whole
		// job attempt: a dropped fragment costs seconds here against a lease
		// window and a reaper tick out there.
		"--retries", "3",
		"--fragment-retries", "3",
		url,
	}
}

// downloadError turns a failed run into an error that says whether retrying
// could ever help.
func downloadError(videoID, stderr string, cause error) error {
	message := lastErrorLine(stderr)
	if message == "" {
		message = strings.TrimSpace(stderr)
	}
	if message == "" {
		message = cause.Error()
	}

	for _, marker := range terminalMarkers {
		if strings.Contains(message, marker) {
			return fmt.Errorf("%s: %w: %s", videoID, ErrUnavailable, message)
		}
	}

	return fmt.Errorf("downloading %s: %s", videoID, message)
}

// lastErrorLine picks yt-dlp's own ERROR line out of its output. The lines
// before it are progress and extractor chatter, and the ones after it are
// usually a traceback; the classification and the operator both want this one.
func lastErrorLine(stderr string) string {
	var found string

	for _, line := range strings.Split(stderr, "\n") {
		if trimmed := strings.TrimSpace(line); strings.HasPrefix(trimmed, "ERROR:") {
			found = trimmed
		}
	}

	return found
}
