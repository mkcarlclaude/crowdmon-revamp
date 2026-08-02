package queue_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/queue"
)

// request is what the API saw. The seam is the wire, so the tests assert on
// this and never on how the client got there.
type request struct {
	method string
	path   string
	body   map[string]any
}

// serverRecording answers every request with the given handler and records
// what arrived.
func serverRecording(t *testing.T, handler http.HandlerFunc) (*httptest.Server, *[]request) {
	t.Helper()

	var seen []request
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("reading the request body: %v", err)
		}

		body := map[string]any{}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Errorf("request body is not JSON: %s", raw)
			}
		}
		seen = append(seen, request{method: r.Method, path: r.URL.Path, body: body})

		handler(w, r)
	}))
	t.Cleanup(server.Close)

	return server, &seen
}

func newClient(t *testing.T, baseURL string) *queue.Client {
	t.Helper()

	client, err := queue.New(baseURL, "worker-under-test")
	if err != nil {
		t.Fatalf("New() returned an unexpected error: %v", err)
	}
	return client
}

func TestClaimReturnsTheJobTheAPIHandedOut(t *testing.T) {
	server, seen := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{
			"id": 7,
			"kind": "chunk",
			"video_id": "dQw4w9WgXcQ",
			"video_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
			"attempts": 1,
			"chunk": {"segment_index": 2, "start_seconds": 120, "end_seconds": 180}
		}`)
	})

	job, err := newClient(t, server.URL).Claim(context.Background())
	if err != nil {
		t.Fatalf("Claim() returned an unexpected error: %v", err)
	}
	if job == nil {
		t.Fatal("Claim() returned no job for a 200 response")
	}

	if job.Id != 7 || job.Kind != "chunk" || job.VideoId != "dQw4w9WgXcQ" {
		t.Errorf("job = %+v, want id 7, kind chunk, video dQw4w9WgXcQ", *job)
	}
	// The nil-able chunk is the reason one Job type can carry both kinds of
	// work, so a decode that silently dropped it would be invisible until a
	// chunk job ran against the wrong segment.
	if job.Chunk == nil {
		t.Fatal("chunk work was dropped in decoding")
	}
	if job.Chunk.StartSeconds != 120 || job.Chunk.EndSeconds != 180 || job.Chunk.SegmentIndex != 2 {
		t.Errorf("chunk = %+v, want segment 2 covering 120–180s", *job.Chunk)
	}

	if len(*seen) != 1 {
		t.Fatalf("made %d requests, want 1", len(*seen))
	}
	got := (*seen)[0]
	if got.method != http.MethodPost || got.path != "/api/jobs/claim" {
		t.Errorf("claimed with %s %s, want POST /api/jobs/claim", got.method, got.path)
	}
	if got.body["worker_id"] != "worker-under-test" {
		t.Errorf("worker_id = %v, want worker-under-test", got.body["worker_id"])
	}
}

// 204 is the common case by far — most polls find nothing — and it is
// deliberately not an error. It is also why the API answers with a status
// rather than a null body: the worker branches without parsing anything.
func TestClaimReturnsNothingOnAnEmptyQueue(t *testing.T) {
	server, _ := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	job, err := newClient(t, server.URL).Claim(context.Background())
	if err != nil {
		t.Fatalf("Claim() returned an unexpected error for a 204: %v", err)
	}
	if job != nil {
		t.Errorf("Claim() returned %+v for a 204, want no job", *job)
	}
}

func TestClaimReportsAnAPIFailure(t *testing.T) {
	server, _ := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	if _, err := newClient(t, server.URL).Claim(context.Background()); err == nil {
		t.Fatal("Claim() returned no error for a 500")
	}
}

func TestHeartbeatRenewsTheLease(t *testing.T) {
	server, seen := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	if err := newClient(t, server.URL).Heartbeat(context.Background(), 7); err != nil {
		t.Fatalf("Heartbeat() returned an unexpected error: %v", err)
	}

	got := (*seen)[0]
	if got.method != http.MethodPost || got.path != "/api/jobs/7/heartbeat" {
		t.Errorf("heartbeat sent %s %s, want POST /api/jobs/7/heartbeat", got.method, got.path)
	}
	// Without this the API cannot tell a lease holder from anyone who knows a
	// job id, and the reaper's guarantee stops meaning anything.
	if got.body["worker_id"] != "worker-under-test" {
		t.Errorf("worker_id = %v, want worker-under-test", got.body["worker_id"])
	}
}

// 404 means the reaper took the job back, or it was never this worker's.
// It is a distinct outcome from a transient failure: retrying is pointless,
// and the right response is to stop working on the job.
func TestHeartbeatReportsALostLeaseDistinctly(t *testing.T) {
	server, _ := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})

	err := newClient(t, server.URL).Heartbeat(context.Background(), 7)
	if !errors.Is(err, queue.ErrLeaseLost) {
		t.Fatalf("Heartbeat() on a 404 returned %v, want ErrLeaseLost", err)
	}
}

func TestHeartbeatDoesNotMistakeAServerErrorForALostLease(t *testing.T) {
	server, _ := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	err := newClient(t, server.URL).Heartbeat(context.Background(), 7)
	if err == nil {
		t.Fatal("Heartbeat() returned no error for a 500")
	}
	// A 500 is transient; treating it as a lost lease would abandon a job the
	// worker still holds, and the reaper would then wait out the whole lease
	// window before anyone picked it up again.
	if errors.Is(err, queue.ErrLeaseLost) {
		t.Errorf("Heartbeat() reported a 500 as a lost lease: %v", err)
	}
}

func TestCompleteReportsSuccess(t *testing.T) {
	server, seen := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	if err := newClient(t, server.URL).Complete(context.Background(), 7, nil); err != nil {
		t.Fatalf("Complete() returned an unexpected error: %v", err)
	}

	got := (*seen)[0]
	if got.method != http.MethodPost || got.path != "/api/jobs/7/complete" {
		t.Errorf("completed with %s %s, want POST /api/jobs/7/complete", got.method, got.path)
	}
	if got.body["status"] != "done" {
		t.Errorf("status = %v, want done", got.body["status"])
	}
	if _, present := got.body["failure_reason"]; present {
		t.Errorf("failure_reason sent on a successful completion: %v", got.body["failure_reason"])
	}
}

// The reason is recorded verbatim so M6.1 can tell a deleted video from a
// geo-block without re-running anything — which only works if it survives
// the trip.
func TestCompleteCarriesTheFailureReason(t *testing.T) {
	server, seen := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	err := newClient(t, server.URL).Complete(context.Background(), 7, errors.New("video unavailable"))
	if err != nil {
		t.Fatalf("Complete() returned an unexpected error: %v", err)
	}

	got := (*seen)[0]
	if got.body["status"] != "failed" {
		t.Errorf("status = %v, want failed", got.body["status"])
	}
	if got.body["failure_reason"] != "video unavailable" {
		t.Errorf("failure_reason = %v, want %q", got.body["failure_reason"], "video unavailable")
	}
}

// The contract caps it at 1000 characters and rejects anything longer, so a
// yt-dlp stack trace as a failure reason would turn a failed job into a job
// that cannot be *reported* as failed — and it would then be reaped and
// retried until it exhausted its attempts.
func TestCompleteTruncatesAnOverlongFailureReason(t *testing.T) {
	server, seen := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	long := make([]byte, 4000)
	for i := range long {
		long[i] = 'x'
	}

	err := newClient(t, server.URL).Complete(context.Background(), 7, errors.New(string(long)))
	if err != nil {
		t.Fatalf("Complete() returned an unexpected error: %v", err)
	}

	reason, _ := (*seen)[0].body["failure_reason"].(string)
	if len(reason) > 1000 {
		t.Errorf("failure_reason was %d characters, want no more than the contract's 1000", len(reason))
	}
	if len(reason) == 0 {
		t.Error("failure_reason was dropped entirely rather than truncated")
	}
}

func TestCompleteReportsALostLeaseDistinctly(t *testing.T) {
	server, _ := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})

	err := newClient(t, server.URL).Complete(context.Background(), 7, nil)
	if !errors.Is(err, queue.ErrLeaseLost) {
		t.Fatalf("Complete() on a 404 returned %v, want ErrLeaseLost", err)
	}
}

// A trailing slash is what anyone might write in an env file. The generated
// client resolves operation paths relatively and already handles it — this
// pins that rather than adding code to defend against it, so a regeneration
// that changed the joining would fail here instead of in production, where
// the symptom is a 404 indistinguishable from a missing endpoint.
func TestNewToleratesATrailingSlashOnTheBaseURL(t *testing.T) {
	server, seen := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	client, err := queue.New(server.URL+"/", "worker-under-test")
	if err != nil {
		t.Fatalf("New() returned an unexpected error: %v", err)
	}
	if _, err := client.Claim(context.Background()); err != nil {
		t.Fatalf("Claim() returned an unexpected error: %v", err)
	}

	if got := (*seen)[0].path; got != "/api/jobs/claim" {
		t.Errorf("claimed at %q, want /api/jobs/claim", got)
	}
}
