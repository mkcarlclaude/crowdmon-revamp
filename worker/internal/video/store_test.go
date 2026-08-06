package video_test

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/video"
)

func writeFile(t *testing.T, path string, age time.Duration) {
	t.Helper()

	if err := os.WriteFile(path, []byte("video bytes"), 0o600); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
	if age > 0 {
		at := time.Now().Add(-age)
		if err := os.Chtimes(path, at, at); err != nil {
			t.Fatalf("ageing %s: %v", path, err)
		}
	}
}

func TestStorePathFindsTheDownloadedFile(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "aaaaaaaaaaa.mp4"), 0)

	store := video.Store{Dir: dir, TTL: time.Hour}

	path, err := store.Path("aaaaaaaaaaa")
	if err != nil {
		t.Fatalf("Path: %v", err)
	}
	if want := filepath.Join(dir, "aaaaaaaaaaa.mp4"); path != want {
		t.Errorf("Path = %q, want %q", path, want)
	}
}

func TestStorePathIgnoresPartialDownloads(t *testing.T) {
	dir := t.TempDir()
	// What a killed yt-dlp leaves behind. Treating it as the source would hand
	// ffmpeg a truncated file and produce a chunk that looks extracted.
	writeFile(t, filepath.Join(dir, "aaaaaaaaaaa.mp4.part"), 0)
	writeFile(t, filepath.Join(dir, "aaaaaaaaaaa.f299.mp4.ytdl"), 0)

	_, err := video.Store{Dir: dir}.Path("aaaaaaaaaaa")

	if !errors.Is(err, video.ErrNotDownloaded) {
		t.Fatalf("Path error = %v, want ErrNotDownloaded", err)
	}
}

func TestStorePathReportsAMissingVideoDistinctly(t *testing.T) {
	// The affinity guard (M7.4) branches on this: a chunk job whose source is
	// not on this box is a job that can never succeed here, and telling that
	// apart from an unreadable directory is the difference between retiring
	// the job and retrying it.
	_, err := video.Store{Dir: t.TempDir()}.Path("aaaaaaaaaaa")

	if !errors.Is(err, video.ErrNotDownloaded) {
		t.Fatalf("Path error = %v, want ErrNotDownloaded", err)
	}
}

func TestStorePathDoesNotMatchOnAPrefix(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "aaaaaaaaaaabbb.mp4"), 0)

	_, err := video.Store{Dir: dir}.Path("aaaaaaaaaaa")

	if !errors.Is(err, video.ErrNotDownloaded) {
		t.Fatalf("Path error = %v, want ErrNotDownloaded", err)
	}
}

func TestPruneDeletesSourcesPastTheTTL(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "old.mp4"), 7*time.Hour)
	writeFile(t, filepath.Join(dir, "fresh.mp4"), 30*time.Minute)
	writeFile(t, filepath.Join(dir, "abandoned.mp4.part"), 7*time.Hour)

	removed, err := video.Store{Dir: dir, TTL: 6 * time.Hour}.Prune()
	if err != nil {
		t.Fatalf("Prune: %v", err)
	}

	// The abandoned `.part` counts: a download killed halfway leaves one, and
	// nothing else ever cleans it up.
	if removed != 2 {
		t.Errorf("Prune removed %d, want 2", removed)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "fresh.mp4" {
		t.Errorf("directory holds %v, want only fresh.mp4", entries)
	}
}

func TestPruneOnAMissingDirectoryIsNotAnError(t *testing.T) {
	// The first run on a fresh box prunes before it has ever downloaded
	// anything. Failing there would fail the job for the state the job is
	// about to fix.
	removed, err := video.Store{Dir: filepath.Join(t.TempDir(), "nothing-here"), TTL: time.Hour}.Prune()
	if err != nil {
		t.Fatalf("Prune: %v", err)
	}
	if removed != 0 {
		t.Errorf("Prune removed %d, want 0", removed)
	}
}

func TestPruneWithoutATTLKeepsEverything(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "ancient.mp4"), 30*24*time.Hour)

	removed, err := video.Store{Dir: dir}.Prune()
	if err != nil {
		t.Fatalf("Prune: %v", err)
	}
	if removed != 0 {
		t.Fatalf("Prune removed %d with no TTL set, want 0", removed)
	}
}
