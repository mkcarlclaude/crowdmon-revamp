package video_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/video"
)

// fakeBinary writes an executable shell script and returns its path.
//
// The seam under test is what the worker does with yt-dlp's behaviour — the
// file it leaves, the line it prints, the message it fails with — and a script
// reproduces all three without the network or a real YouTube video. Stubbing
// an interface here would instead test the stub.
func fakeBinary(t *testing.T, script string) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "fake-yt-dlp")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatalf("writing the fake binary: %v", err)
	}

	return path
}

// downloadsTo is a fake yt-dlp that succeeds: it writes the file and prints the
// JSON line the real one prints under `--print`.
func downloadsTo(t *testing.T, path, title string) string {
	t.Helper()

	return fakeBinary(t, `
echo "[youtube] extracting" >&2
printf 'video bytes' > "`+path+`"
printf '{"filepath": "`+path+`", "title": "`+title+`"}\n'
`)
}

func TestDownloadReturnsWhatYtDlpFetched(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "aaaaaaaaaaa.mp4")

	source, err := video.Downloader{
		Binary: downloadsTo(t, path, "Paimon compilation"),
		Store:  video.Store{Dir: dir},
	}.Download(t.Context(), "aaaaaaaaaaa", "https://www.youtube.com/watch?v=aaaaaaaaaaa")
	if err != nil {
		t.Fatalf("Download: %v", err)
	}

	if source.Path != path {
		t.Errorf("Path = %q, want %q", source.Path, path)
	}
	if source.Title != "Paimon compilation" {
		t.Errorf("Title = %q, want %q", source.Title, "Paimon compilation")
	}
	// From the file on disk, not from anything yt-dlp said about it: the size
	// is a span attribute (M7.1) and an attribute nobody measured is a rumour.
	if source.Bytes != int64(len("video bytes")) {
		t.Errorf("Bytes = %d, want %d", source.Bytes, len("video bytes"))
	}
}

func TestDownloadPassesTheURLAndRefusesPlaylists(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "aaaaaaaaaaa.mp4")
	argv := filepath.Join(dir, "argv")

	binary := fakeBinary(t, `
printf '%s\n' "$@" > `+argv+`
printf 'video bytes' > "`+path+`"
printf '{"filepath": "`+path+`", "title": "t"}\n'
`)

	url := "https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PL0000000000"
	_, err := video.Downloader{Binary: binary, Store: video.Store{Dir: dir}}.
		Download(t.Context(), "aaaaaaaaaaa", url)
	if err != nil {
		t.Fatalf("Download: %v", err)
	}

	args, err := os.ReadFile(argv)
	if err != nil {
		t.Fatal(err)
	}
	line := string(args)

	// A `&list=` URL is one paste away, and without this flag yt-dlp downloads
	// the whole playlist onto the box under one job's lease.
	if !strings.Contains(line, "--no-playlist\n") {
		t.Errorf("yt-dlp was not told --no-playlist, got:\n%s", line)
	}
	if !strings.Contains(line, url+"\n") {
		t.Errorf("yt-dlp was not given the URL, got:\n%s", line)
	}
	// The file has to land where `Store` will look for it, and the name has to
	// be the video id: the affinity guard finds it by id and nothing else.
	if !strings.Contains(line, filepath.Join(dir, "aaaaaaaaaaa")+".%(ext)s\n") {
		t.Errorf("yt-dlp was not given the store's output template, got:\n%s", line)
	}
}

func TestDownloadSkipsAVideoAlreadyOnDisk(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "aaaaaaaaaaa.webm"), 0)

	// Fails if it runs at all. A download job reaped mid-fan-out is claimed
	// again (M7.3), and re-fetching a video that is already on the disk would
	// spend ten minutes and a few gigabytes to arrive back where it started.
	source, err := video.Downloader{
		Binary: fakeBinary(t, `echo "should not have run" >&2; exit 1`),
		Store:  video.Store{Dir: dir},
	}.Download(t.Context(), "aaaaaaaaaaa", "https://www.youtube.com/watch?v=aaaaaaaaaaa")
	if err != nil {
		t.Fatalf("Download: %v", err)
	}

	if source.Path != filepath.Join(dir, "aaaaaaaaaaa.webm") {
		t.Errorf("Path = %q, want the file already on disk", source.Path)
	}
	// Nothing ran, so there is nothing to have learned a title from. The
	// fan-out treats it as absent rather than overwriting what it has.
	if source.Title != "" {
		t.Errorf("Title = %q, want empty when the download was skipped", source.Title)
	}
}

func TestDownloadReportsUnavailableVideosAsTerminal(t *testing.T) {
	// Verbatim yt-dlp stderr. These are the cases M7.1 names, and every one of
	// them is permanent: retrying spends the ceiling to arrive at the same
	// answer three times.
	for name, stderr := range map[string]string{
		"deleted":     "ERROR: [youtube] dQw4w9WgXcQ: Video unavailable. This video has been removed by the uploader",
		"private":     "ERROR: [youtube] dQw4w9WgXcQ: Private video. Sign in if you've been granted access to this video",
		"geo-blocked": "ERROR: [youtube] dQw4w9WgXcQ: The uploader has not made this video available in your country",
		"members":     "ERROR: [youtube] dQw4w9WgXcQ: Join this channel to get access to members-only content",
		"age-gated":   "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm your age. This video may be inappropriate for some users",
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()

			_, err := video.Downloader{
				Binary: fakeBinary(t, `echo `+quote(stderr)+` >&2; exit 1`),
				Store:  video.Store{Dir: dir},
			}.Download(t.Context(), "aaaaaaaaaaa", "https://www.youtube.com/watch?v=aaaaaaaaaaa")

			if !errors.Is(err, video.ErrUnavailable) {
				t.Fatalf("Download error = %v, want ErrUnavailable", err)
			}
			// The reason is what the API stores as `failure_reason` and what an
			// operator reads in the dashboard, so it has to say which of these
			// it was rather than "yt-dlp exited 1".
			if !strings.Contains(err.Error(), "Video unavailable") &&
				!strings.Contains(err.Error(), stringAfterColon(stderr)) {
				t.Errorf("error %q does not carry what yt-dlp said", err)
			}
		})
	}
}

func TestDownloadTreatsEverythingElseAsRetryable(t *testing.T) {
	for name, stderr := range map[string]string{
		// A transient network failure. Reported as terminal it would burn a
		// video that has nothing wrong with it — the failure M6 fixed for
		// graceful shutdown, arriving from the other side.
		"network": "ERROR: unable to download video data: <urlopen error timed out>",
		// YouTube deciding the box looks like a bot. It is about this worker's
		// address and cookies, not about the video, and it clears up — which is
		// also why it must not be caught by the age-gate pattern it reads like.
		"bot-check": "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot. Use --cookies-from-browser",
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()

			_, err := video.Downloader{
				Binary: fakeBinary(t, `echo `+quote(stderr)+` >&2; exit 1`),
				Store:  video.Store{Dir: dir},
			}.Download(t.Context(), "aaaaaaaaaaa", "https://www.youtube.com/watch?v=aaaaaaaaaaa")

			if err == nil {
				t.Fatal("Download succeeded, want an error")
			}
			if errors.Is(err, video.ErrUnavailable) {
				t.Fatalf("Download error = %v, want a retryable error", err)
			}
		})
	}
}

func TestDownloadFailsWhenTheFileIsNotWhereItWasSaid(t *testing.T) {
	dir := t.TempDir()

	// yt-dlp exiting 0 having written nothing is not a success anybody can
	// use: the chunk jobs about to be enqueued would each fail on a missing
	// source. Better to fail the one job that can still explain why.
	_, err := video.Downloader{
		Binary: fakeBinary(t, `printf '{"filepath": "`+dir+`/gone.mp4", "title": "t"}\n'`),
		Store:  video.Store{Dir: dir},
	}.Download(t.Context(), "aaaaaaaaaaa", "https://www.youtube.com/watch?v=aaaaaaaaaaa")

	if err == nil {
		t.Fatal("Download succeeded on a file that does not exist")
	}
}

func TestDownloadStopsWithItsContext(t *testing.T) {
	dir := t.TempDir()

	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	_, err := video.Downloader{
		Binary: fakeBinary(t, `sleep 30`),
		Store:  video.Store{Dir: dir},
	}.Download(ctx, "aaaaaaaaaaa", "https://www.youtube.com/watch?v=aaaaaaaaaaa")

	// A download outlives its job's lease otherwise, and a worker shutting
	// down would wait on a ten-minute fetch nothing will read.
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Download error = %v, want context.Canceled", err)
	}
}

// quote wraps a string for `sh`. The fixtures are yt-dlp's real messages and
// several contain an apostrophe, which closes the quoting and would turn the
// rest of the message into shell.
func quote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func stringAfterColon(s string) string {
	_, rest, found := strings.Cut(s, ": ")
	if !found {
		return s
	}
	return rest
}
