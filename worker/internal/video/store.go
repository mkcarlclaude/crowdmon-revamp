// Package video is the worker's side of phase one: fetch the source video with
// yt-dlp, measure it with ffprobe, and keep it on local disk for the chunk jobs
// that will read it.
//
// Local disk is the design, not a shortcut. CONTEXT.md §Q13 keeps the source
// video off R2 — it is far larger than the frames extracted from it, and it is
// wanted for minutes rather than kept — which is also where the affinity
// constraint comes from: a chunk job can only run on the box that downloaded.
package video

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ErrNotDownloaded means no complete source file for this video is on this
// box. It is a state, not a fault: it is the ordinary answer before a download
// runs, and it is what the affinity guard (M7.4) checks for.
var ErrNotDownloaded = errors.New("no downloaded source video")

// partialSuffixes are what an interrupted yt-dlp leaves lying about. A `.part`
// file is a truncated video that would decode far enough to look like a
// successful extraction, so it must never be mistaken for the source.
var partialSuffixes = []string{".part", ".ytdl"}

// Store is the directory downloaded videos live in, and how long they live.
type Store struct {
	// Dir holds one file per downloaded video, named `<video id>.<ext>`. The
	// extension is yt-dlp's choice — mp4 or webm depending on what the format
	// selection got — so nothing here may assume it.
	Dir string

	// TTL is how long a source video is kept after its last modification.
	// Zero keeps everything, which is what a worker with no pruning wants.
	//
	// It bounds disk, and it has to be comfortably longer than a video's whole
	// fan-out takes: chunk jobs read the file the download left behind, and
	// pruning one out from under a pending chunk turns a working video into
	// M7.4's clean failure for no reason.
	TTL time.Duration
}

// Path returns the source file for videoID, or ErrNotDownloaded.
//
// Directory entries are matched by prefix rather than by glob because a video
// id is data: `filepath.Glob` would read `*` and `?` in one as a pattern, and
// the ids come from a URL somebody pasted.
func (s Store) Path(videoID string) (string, error) {
	entries, err := os.ReadDir(s.Dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("%s: %w", videoID, ErrNotDownloaded)
		}
		return "", fmt.Errorf("reading %s: %w", s.Dir, err)
	}

	prefix := videoID + "."

	for _, entry := range entries {
		name := entry.Name()

		if entry.IsDir() || !strings.HasPrefix(name, prefix) || isPartial(name) {
			continue
		}

		return filepath.Join(s.Dir, name), nil
	}

	return "", fmt.Errorf("%s: %w", videoID, ErrNotDownloaded)
}

// outputTemplate is where yt-dlp is told to put a video: the id, and yt-dlp's
// choice of extension. Naming the file after the id is what lets Path find it
// again, and is therefore the affinity guard's foundation rather than a
// tidiness preference.
func (s Store) outputTemplate(videoID string) string {
	return filepath.Join(s.Dir, videoID) + ".%(ext)s"
}

// isPartial reports whether a filename is an interrupted download rather than
// a video. Suffix, not extension: yt-dlp writes `<name>.<ext>.part`, so the
// video's own extension is still in the middle of it.
func isPartial(name string) bool {
	for _, suffix := range partialSuffixes {
		if strings.HasSuffix(name, suffix) {
			return true
		}
	}
	return false
}

// Prune deletes everything in the directory older than the TTL, and reports
// how many files went.
//
// Everything, not only complete videos: a `.part` left by a killed download is
// exactly the file nothing else will ever clean up, and it is as large as the
// video it failed to become.
//
// A missing directory prunes nothing and is not an error — that is the state
// of a box that has not downloaded anything yet.
func (s Store) Prune() (int, error) {
	if s.TTL <= 0 {
		return 0, nil
	}

	entries, err := os.ReadDir(s.Dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, nil
		}
		return 0, fmt.Errorf("reading %s: %w", s.Dir, err)
	}

	cutoff := time.Now().Add(-s.TTL)
	removed := 0

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}

		info, err := entry.Info()
		if err != nil {
			// Raced with something else removing it, which is the outcome this
			// wanted anyway.
			continue
		}
		if info.ModTime().After(cutoff) {
			continue
		}

		if err := os.Remove(filepath.Join(s.Dir, entry.Name())); err != nil {
			return removed, fmt.Errorf("pruning %s: %w", entry.Name(), err)
		}
		removed++
	}

	return removed, nil
}
