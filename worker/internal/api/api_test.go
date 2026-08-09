package api_test

import (
	"encoding/json"
	"testing"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/api"
)

// The payloads below are written by hand from the contract, not produced by
// this package. That is the point: they are an independent statement of what
// the edge actually sends, so a codegen config change that renames a field or
// drops a json tag fails here instead of at runtime against production.

func TestJobDecodesADownloadClaim(t *testing.T) {
	const payload = `{
		"id": 7,
		"kind": "download",
		"video_id": "dQw4w9WgXcQ",
		"video_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		"attempts": 1
	}`

	var job api.Job
	if err := json.Unmarshal([]byte(payload), &job); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if job.Id != 7 {
		t.Errorf("Id = %d, want 7", job.Id)
	}
	if job.Kind != api.JobKindDownload {
		t.Errorf("Kind = %q, want %q", job.Kind, api.JobKindDownload)
	}
	if job.VideoId == nil || *job.VideoId != "dQw4w9WgXcQ" {
		t.Errorf("VideoId = %v, want dQw4w9WgXcQ", job.VideoId)
	}
	if job.VideoUrl == nil || *job.VideoUrl != "https://www.youtube.com/watch?v=dQw4w9WgXcQ" {
		t.Errorf("VideoUrl = %v", job.VideoUrl)
	}
	if job.Attempts != 1 {
		t.Errorf("Attempts = %d, want 1", job.Attempts)
	}
	// A download job carries no chunk work. Nil rather than a zeroed struct is
	// what lets the worker branch on the kind without consulting Kind twice.
	if job.Chunk != nil {
		t.Errorf("Chunk = %+v, want nil on a download job", job.Chunk)
	}
}

func TestJobDecodesAChunkClaim(t *testing.T) {
	const payload = `{
		"id": 8,
		"kind": "chunk",
		"video_id": "dQw4w9WgXcQ",
		"video_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		"attempts": 1,
		"chunk": {"segment_index": 2, "start_seconds": 120, "end_seconds": 180}
	}`

	var job api.Job
	if err := json.Unmarshal([]byte(payload), &job); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if job.Kind != api.JobKindChunk {
		t.Errorf("Kind = %q, want %q", job.Kind, api.JobKindChunk)
	}
	if job.Chunk == nil {
		t.Fatal("Chunk is nil on a chunk job")
	}
	if job.Chunk.SegmentIndex != 2 {
		t.Errorf("SegmentIndex = %d, want 2", job.Chunk.SegmentIndex)
	}
	if job.Chunk.StartSeconds != 120 || job.Chunk.EndSeconds != 180 {
		t.Errorf("segment = [%d,%d), want [120,180)", job.Chunk.StartSeconds, job.Chunk.EndSeconds)
	}
}

func TestJobDecodesASnapshotClaimWithNoVideo(t *testing.T) {
	// M15.1: a snapshot job is not about any one video (migration 0008), so
	// its claim carries `video_id: null` and `video_url: null` rather than
	// the strings every other kind sends — the one case this package's
	// generated `*string` fields exist to represent honestly.
	const payload = `{
		"id": 142,
		"kind": "snapshot",
		"video_id": null,
		"video_url": null,
		"attempts": 1
	}`

	var job api.Job
	if err := json.Unmarshal([]byte(payload), &job); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if job.Kind != api.JobKindSnapshot {
		t.Errorf("Kind = %q, want %q", job.Kind, api.JobKindSnapshot)
	}
	if job.VideoId != nil {
		t.Errorf("VideoId = %v, want nil", job.VideoId)
	}
	if job.VideoUrl != nil {
		t.Errorf("VideoUrl = %v, want nil", job.VideoUrl)
	}
}

func TestRequestsMarshalToTheWireNames(t *testing.T) {
	// The failure this guards against is the one the monorepo exists to
	// prevent: Go emitting WorkerId where the edge validates worker_id, and
	// nothing noticing until a request 400s in production.
	got, err := json.Marshal(api.CompleteRequest{
		WorkerId: "carls-ubuntu-1",
		Status:   api.CompleteRequestStatusFailed,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	const want = `{"status":"failed","worker_id":"carls-ubuntu-1"}`
	if string(got) != want {
		t.Errorf("marshal = %s, want %s", got, want)
	}
}

func TestErrorResponseDecodesValidationIssues(t *testing.T) {
	const payload = `{
		"error": "invalid request",
		"issues": [{"path": "url", "message": "Invalid URL"}]
	}`

	var e api.ErrorResponse
	if err := json.Unmarshal([]byte(payload), &e); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if e.Error != "invalid request" {
		t.Errorf("Error = %q", e.Error)
	}
	if e.Issues == nil || len(*e.Issues) != 1 {
		t.Fatalf("Issues = %v, want one issue", e.Issues)
	}
	if (*e.Issues)[0].Path != "url" {
		t.Errorf("Issues[0].Path = %q, want url", (*e.Issues)[0].Path)
	}
}
