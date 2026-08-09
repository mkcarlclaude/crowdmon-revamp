package queue_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/queue"
)

// request is what the API saw. The seam is the wire, so the tests assert on
// this and never on how the client got there.
type request struct {
	method string
	// path is the request URI, query string included when there is one
	// (r.URL.RequestURI(), not r.URL.Path) — Images (M11.3) is the first
	// lease-checked call in this package to carry its identity as a query
	// parameter rather than a JSON body, and a test asserting on it needs the
	// query string to be there to assert on.
	path    string
	body    map[string]any
	headers http.Header
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
		seen = append(seen, request{method: r.Method, path: r.URL.RequestURI(), body: body, headers: r.Header})

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

	if job.Id != 7 || job.Kind != "chunk" || job.VideoId == nil || *job.VideoId != "dQw4w9WgXcQ" {
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

func TestFanOutSendsWhatWasProbed(t *testing.T) {
	server, seen := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"video_id": "dQw4w9WgXcQ", "segments": 3, "created": 2}`)
	})

	result, err := newClient(t, server.URL).FanOut(context.Background(), 7, queue.Probed{
		DurationSeconds: 150,
		Width:           1920,
		Height:          1080,
		Title:           "Paimon compilation",
	})
	if err != nil {
		t.Fatalf("FanOut() returned an unexpected error: %v", err)
	}

	if result.Segments != 3 || result.Created != 2 {
		t.Errorf("FanOut() = %+v, want 3 segments and 2 created", result)
	}

	if len(*seen) != 1 {
		t.Fatalf("the API saw %d requests, want 1", len(*seen))
	}
	got := (*seen)[0]
	if got.method != http.MethodPost || got.path != "/api/jobs/7/fanout" {
		t.Errorf("FanOut() sent %s %s", got.method, got.path)
	}
	// The lease holder, on the one endpoint that writes a video's whole work
	// definition. Without it anything that knew a job id could enqueue chunks.
	if got.body["worker_id"] != "worker-under-test" {
		t.Errorf("body carried worker_id %v", got.body["worker_id"])
	}
	if got.body["duration_seconds"] != float64(150) {
		t.Errorf("body carried duration_seconds %v", got.body["duration_seconds"])
	}
	if got.body["title"] != "Paimon compilation" {
		t.Errorf("body carried title %v", got.body["title"])
	}
}

func TestFanOutOmitsATitleItDoesNotHave(t *testing.T) {
	// A skipped download (the file was already on disk) has no title to send,
	// and sending an empty one would overwrite the title already stored.
	server, seen := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"video_id": "dQw4w9WgXcQ", "segments": 1, "created": 0}`)
	})

	_, err := newClient(t, server.URL).FanOut(context.Background(), 7, queue.Probed{
		DurationSeconds: 60, Width: 1920, Height: 1080,
	})
	if err != nil {
		t.Fatalf("FanOut() returned an unexpected error: %v", err)
	}

	if _, present := (*seen)[0].body["title"]; present {
		t.Errorf("body carried a title key with no title to put in it: %v", (*seen)[0].body)
	}
}

// The other half of M9.2's join: whatever span is active on the caller's
// context has to reach the API as a `traceparent` header, or the API's own
// span for this request — and the stored value it later stamps onto every
// chunk job — would start a trace of its own instead of continuing this one.
func TestFanOutCarriesTheActiveSpanAsATraceparentHeader(t *testing.T) {
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() { otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator()) })

	provider := sdktrace.NewTracerProvider()
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })

	server, seen := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"video_id": "dQw4w9WgXcQ", "segments": 1, "created": 1}`)
	})

	ctx, span := provider.Tracer("test").Start(context.Background(), "video.fanout")
	_, err := newClient(t, server.URL).FanOut(ctx, 7, queue.Probed{
		DurationSeconds: 60, Width: 1920, Height: 1080,
	})
	span.End()
	if err != nil {
		t.Fatalf("FanOut() returned an unexpected error: %v", err)
	}

	want := "00-" + span.SpanContext().TraceID().String() + "-" + span.SpanContext().SpanID().String() + "-01"
	if got := (*seen)[0].headers.Get("traceparent"); got != want {
		t.Errorf("traceparent header = %q, want %q (the fan-out call's own active span)", got, want)
	}
}

// With no active span, injection has nothing to write — the propagator's own
// validity check is what makes this a no-op rather than a header carrying a
// zero-valued trace id, which the API would otherwise store as if it meant
// something.
func TestFanOutSendsNoTraceparentWithoutAnActiveSpan(t *testing.T) {
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() { otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator()) })

	server, seen := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"video_id": "dQw4w9WgXcQ", "segments": 1, "created": 1}`)
	})

	_, err := newClient(t, server.URL).FanOut(context.Background(), 7, queue.Probed{
		DurationSeconds: 60, Width: 1920, Height: 1080,
	})
	if err != nil {
		t.Fatalf("FanOut() returned an unexpected error: %v", err)
	}

	if got := (*seen)[0].headers.Get("traceparent"); got != "" {
		t.Errorf("traceparent header = %q with no active span, want none sent at all", got)
	}
}

func TestFanOutReportsALostLease(t *testing.T) {
	server, _ := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error": "no job with this id is held by this worker"}`)
	})

	_, err := newClient(t, server.URL).FanOut(context.Background(), 7, queue.Probed{
		DurationSeconds: 60, Width: 1920, Height: 1080,
	})

	// Same event as a heartbeat 404, so the same error: the reaper took the
	// job back and this worker must stop rather than report an outcome.
	if !errors.Is(err, queue.ErrLeaseLost) {
		t.Fatalf("FanOut() error = %v, want ErrLeaseLost", err)
	}
}

func TestFanOutReportsARejectedFanOutAsPermanent(t *testing.T) {
	server, _ := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error": "invalid request"}`)
	})

	_, err := newClient(t, server.URL).FanOut(context.Background(), 7, queue.Probed{
		DurationSeconds: 9 * 60 * 60, Width: 1920, Height: 1080,
	})

	// A video the contract will not accept — too long, or a resolution of zero
	// — is rejected the same way on every attempt. Retried it would burn the
	// ceiling and re-download several gigabytes each time.
	if !errors.Is(err, queue.ErrRejected) {
		t.Fatalf("FanOut() error = %v, want ErrRejected", err)
	}
	if errors.Is(err, queue.ErrLeaseLost) {
		t.Fatalf("FanOut() error = %v, want it distinct from a lost lease", err)
	}
}

func anExtraction() queue.Extraction {
	return queue.Extraction{
		Extracted:      60,
		Kept:           2,
		DedupThreshold: 8,
		ConfigVersion:  "extract=ffmpeg-fps1;phash=dct64;threshold=8",
		Images: []queue.Image{
			{Key: "frames/dQw4w9WgXcQ/00120.000.jpg", TimestampSeconds: 120, PHash: "af3c9e1b2d4f7a80"},
			{Key: "frames/dQw4w9WgXcQ/00123.000.jpg", TimestampSeconds: 123, PHash: "00ff00ff00ff00ff"},
		},
	}
}

func TestReportImagesSendsTheRowsAndTheProvenanceTogether(t *testing.T) {
	server, seen := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"video_id": "dQw4w9WgXcQ", "images": 2}`)
	})

	if err := newClient(t, server.URL).ReportImages(context.Background(), 9, anExtraction()); err != nil {
		t.Fatalf("ReportImages() returned an unexpected error: %v", err)
	}

	if len(*seen) != 1 {
		t.Fatalf("the API saw %d requests, want 1", len(*seen))
	}
	got := (*seen)[0]
	if got.method != http.MethodPost || got.path != "/api/jobs/9/images" {
		t.Errorf("ReportImages() sent %s %s", got.method, got.path)
	}
	// Writing rows is writing on a lease, exactly as fanning out is.
	if got.body["worker_id"] != "worker-under-test" {
		t.Errorf("body carried worker_id %v", got.body["worker_id"])
	}
	// M8.4: the threshold and the configuration travel with the rows they
	// produced, in the same request, because the API writes them in one batch.
	if got.body["dedup_threshold"] != float64(8) {
		t.Errorf("body carried dedup_threshold %v", got.body["dedup_threshold"])
	}
	if got.body["config_version"] != "extract=ffmpeg-fps1;phash=dct64;threshold=8" {
		t.Errorf("body carried config_version %v", got.body["config_version"])
	}
	if got.body["frames_extracted"] != float64(60) || got.body["frames_kept"] != float64(2) {
		t.Errorf("body carried extracted=%v kept=%v, want 60 and 2",
			got.body["frames_extracted"], got.body["frames_kept"])
	}

	images, ok := got.body["images"].([]any)
	if !ok || len(images) != 2 {
		t.Fatalf("body carried images %v, want 2 rows", got.body["images"])
	}
	first, _ := images[0].(map[string]any)
	if first["r2_key"] != "frames/dQw4w9WgXcQ/00120.000.jpg" {
		t.Errorf("first row's r2_key is %v", first["r2_key"])
	}
	// A whole number on the wire, not 120.00001: the float32 the generated
	// type uses represents every second of a six-hour video exactly, and a
	// timestamp that drifted would land the row beside its object rather than
	// on it.
	if first["timestamp_seconds"] != float64(120) {
		t.Errorf("first row's timestamp_seconds is %v, want 120", first["timestamp_seconds"])
	}
	if first["phash"] != "af3c9e1b2d4f7a80" {
		t.Errorf("first row's phash is %v", first["phash"])
	}
}

func TestReportImagesReportsALostLease(t *testing.T) {
	server, _ := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error": "no job with this id is held by this worker"}`)
	})

	err := newClient(t, server.URL).ReportImages(context.Background(), 9, anExtraction())

	// The reaper took the chunk back while it was uploading. Same event, same
	// error, same response: stop, and let whoever holds it now finish it.
	if !errors.Is(err, queue.ErrLeaseLost) {
		t.Fatalf("ReportImages() error = %v, want ErrLeaseLost", err)
	}
}

func TestReportImagesReportsARefusedReportAsPermanent(t *testing.T) {
	server, _ := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error": "frames_kept (3) must equal images.length (2)"}`)
	})

	err := newClient(t, server.URL).ReportImages(context.Background(), 9, anExtraction())

	// A report the contract refuses is this worker's bug, and it is the same
	// bug on the next attempt: counts that disagree, a phash that is not hex,
	// a timestamp outside the segment. Retrying spends the ceiling to be told
	// the same thing three times.
	if !errors.Is(err, queue.ErrRejected) {
		t.Fatalf("ReportImages() error = %v, want ErrRejected", err)
	}
	if errors.Is(err, queue.ErrLeaseLost) {
		t.Fatalf("ReportImages() error = %v, want it distinct from a lost lease", err)
	}
}

func TestImagesReturnsTheVideosCandidatePoolAndSendsTheWorkerIDAsAQuery(t *testing.T) {
	server, seen := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{
			"video_id": "dQw4w9WgXcQ",
			"images": [
				{"r2_key": "frames/dQw4w9WgXcQ/00000.000.jpg", "timestamp_seconds": 0},
				{"r2_key": "frames/dQw4w9WgXcQ/00600.000.jpg", "timestamp_seconds": 600}
			]
		}`)
	})

	candidates, err := newClient(t, server.URL).Images(context.Background(), "dQw4w9WgXcQ")
	if err != nil {
		t.Fatalf("Images() returned an unexpected error: %v", err)
	}

	got := (*seen)[0]
	if got.method != http.MethodGet {
		t.Errorf("Images() sent %s, want GET", got.method)
	}
	if got.path != "/api/videos/dQw4w9WgXcQ/images?worker_id=worker-under-test" {
		t.Errorf("Images() sent %s, want the video-scoped path with worker_id as a query "+
			"parameter — Images is the one lease-checked call in this package with no JSON "+
			"body for its identity to live in", got.path)
	}

	want := []queue.SampleCandidate{
		{Key: "frames/dQw4w9WgXcQ/00000.000.jpg", TimestampSeconds: 0},
		{Key: "frames/dQw4w9WgXcQ/00600.000.jpg", TimestampSeconds: 600},
	}
	if len(candidates) != len(want) {
		t.Fatalf("Images() = %+v, want %+v", candidates, want)
	}
	for i := range want {
		if candidates[i] != want[i] {
			t.Errorf("Images()[%d] = %+v, want %+v", i, candidates[i], want[i])
		}
	}
}

func TestImagesReportsALostLease(t *testing.T) {
	server, _ := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error": "no prelabel job for this video is held by this worker"}`)
	})

	_, err := newClient(t, server.URL).Images(context.Background(), "dQw4w9WgXcQ")

	// The reaper took the prelabel job back, or this worker was never handed
	// this video at all. Same vocabulary as every other lease-checked call:
	// stop, do not retry against a lease that is not held.
	if !errors.Is(err, queue.ErrLeaseLost) {
		t.Fatalf("Images() error = %v, want ErrLeaseLost", err)
	}
}

func TestImagesReportsAnEmptyPoolWithoutError(t *testing.T) {
	// A prelabel job held for a video with no images rows yet (or none that
	// survived dedup) is a real, if unlikely, state — not an error.
	server, _ := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"video_id": "dQw4w9WgXcQ", "images": []}`)
	})

	candidates, err := newClient(t, server.URL).Images(context.Background(), "dQw4w9WgXcQ")
	if err != nil {
		t.Fatalf("Images() returned an unexpected error: %v", err)
	}
	if len(candidates) != 0 {
		t.Errorf("Images() = %+v, want an empty pool", candidates)
	}
}

func TestReportPredictionsSendsTheSampledImagesAlongsideTheBoxes(t *testing.T) {
	server, seen := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"video_id": "dQw4w9WgXcQ", "predictions": 1}`)
	})

	detections := queue.Detections{
		ModelID: "owlvit-base-patch32.onnx",
		Boxes: []queue.Box{
			{Key: "frames/dQw4w9WgXcQ/00000.000.jpg", ClassName: "Paimon", Confidence: 0.9},
		},
		// Two frames were sampled; only one produced a box — the case
		// selection_reason's stamp exists to cover on its own (M11.3).
		SampledKeys: []string{
			"frames/dQw4w9WgXcQ/00000.000.jpg",
			"frames/dQw4w9WgXcQ/00600.000.jpg",
		},
	}

	if err := newClient(t, server.URL).ReportPredictions(context.Background(), 9, detections); err != nil {
		t.Fatalf("ReportPredictions() returned an unexpected error: %v", err)
	}

	got := (*seen)[0]
	sampled, ok := got.body["sampled_images"].([]any)
	if !ok || len(sampled) != 2 {
		t.Fatalf("body carried sampled_images %v, want 2 keys", got.body["sampled_images"])
	}
	if sampled[0] != "frames/dQw4w9WgXcQ/00000.000.jpg" || sampled[1] != "frames/dQw4w9WgXcQ/00600.000.jpg" {
		t.Errorf("sampled_images = %v, want the two sampled keys in order", sampled)
	}
}

func TestReportPredictionsSendsAnEmptySampleAsAnEmptyArrayNotNull(t *testing.T) {
	// json.Marshal already renders a nil slice as `[]`, but the field is
	// built explicitly (queue.go's own comment on why) — this pins that a
	// zero-value Detections{} still produces `[]`, not a bare `null` a
	// stricter decoder on the API side could choke on.
	server, seen := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"video_id": "dQw4w9WgXcQ", "predictions": 0}`)
	})

	if err := newClient(t, server.URL).ReportPredictions(context.Background(), 9, queue.Detections{
		ModelID: "owlvit-base-patch32.onnx",
	}); err != nil {
		t.Fatalf("ReportPredictions() returned an unexpected error: %v", err)
	}

	sampled, ok := (*seen)[0].body["sampled_images"].([]any)
	if !ok {
		t.Fatalf("body carried sampled_images %v, want an empty array", (*seen)[0].body["sampled_images"])
	}
	if len(sampled) != 0 {
		t.Errorf("sampled_images = %v, want empty", sampled)
	}
}

func TestStatsDecodesEveryStatusAndKind(t *testing.T) {
	server, seen := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{
			"pending": {"download": 1, "chunk": 5},
			"claimed": {"download": 1, "chunk": 0},
			"done":    {"download": 40, "chunk": 300},
			"failed":  {"download": 0, "chunk": 2}
		}`)
	})

	stats, err := newClient(t, server.URL).Stats(context.Background())
	if err != nil {
		t.Fatalf("Stats() returned an unexpected error: %v", err)
	}

	got := (*seen)[0]
	if got.method != http.MethodGet || got.path != "/api/jobs/stats" {
		t.Errorf("Stats() sent %s %s, want GET /api/jobs/stats", got.method, got.path)
	}

	want := queue.Stats{
		Pending: queue.StatusCounts{Download: 1, Chunk: 5},
		Claimed: queue.StatusCounts{Download: 1, Chunk: 0},
		Done:    queue.StatusCounts{Download: 40, Chunk: 300},
		Failed:  queue.StatusCounts{Download: 0, Chunk: 2},
	}
	if stats != want {
		t.Errorf("Stats() = %+v, want %+v", stats, want)
	}
}

// An empty queue is a real answer, not an error — every status is present at
// zero, because the API zero-fills rather than omitting combinations that
// have no rows (schemas.ts's JobStats comment). Stats must hand that
// straight through rather than treating an all-zero body as malformed.
func TestStatsReportsAnEmptyQueueAsZeroesNotAnError(t *testing.T) {
	server, _ := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{
			"pending": {"download": 0, "chunk": 0},
			"claimed": {"download": 0, "chunk": 0},
			"done":    {"download": 0, "chunk": 0},
			"failed":  {"download": 0, "chunk": 0}
		}`)
	})

	stats, err := newClient(t, server.URL).Stats(context.Background())
	if err != nil {
		t.Fatalf("Stats() returned an unexpected error: %v", err)
	}
	if stats != (queue.Stats{}) {
		t.Errorf("Stats() = %+v, want the zero value", stats)
	}
}

func TestStatsReportsAnAPIFailure(t *testing.T) {
	server, _ := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	if _, err := newClient(t, server.URL).Stats(context.Background()); err == nil {
		t.Fatal("Stats() returned no error for a 500")
	}
}

func TestReportDryRunSendsTheBoxesAndTheSample(t *testing.T) {
	server, seen := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"dryrun_id": 3, "boxes": 1}`)
	})

	result := queue.DryRunResult{
		ModelID: "owlvit-base-patch32.onnx",
		Boxes: []queue.DryRunBox{
			{Key: "frames/dQw4w9WgXcQ/00000.000.jpg", XMax: 0.5, YMax: 0.5, Confidence: 0.41},
		},
		SampledKeys: []string{
			"frames/dQw4w9WgXcQ/00000.000.jpg",
			"frames/dQw4w9WgXcQ/00600.000.jpg",
		},
	}

	if err := newClient(t, server.URL).ReportDryRun(context.Background(), 11, result); err != nil {
		t.Fatalf("ReportDryRun() returned an unexpected error: %v", err)
	}

	got := (*seen)[0]
	if got.path != "/api/jobs/11/dryrun" {
		t.Errorf("posted to %s, want the dry-run report path", got.path)
	}
	boxes, ok := got.body["boxes"].([]any)
	if !ok || len(boxes) != 1 {
		t.Fatalf("body carried boxes %v, want one", got.body["boxes"])
	}
	// No class_name and no prompt_version on a dry-run's boxes: one run is one
	// wording for one class, both already on the row this reports against.
	box, ok := boxes[0].(map[string]any)
	if !ok {
		t.Fatalf("box was %T, want an object", boxes[0])
	}
	if _, present := box["class_name"]; present {
		t.Errorf("box carried class_name %v, want none", box["class_name"])
	}
	if _, present := box["prompt_version"]; present {
		t.Errorf("box carried prompt_version %v, want none", box["prompt_version"])
	}
	sampled, ok := got.body["sampled_images"].([]any)
	if !ok || len(sampled) != 2 {
		t.Fatalf("body carried sampled_images %v, want 2 keys", got.body["sampled_images"])
	}
}

func TestReportDryRunTreatsA404AsALostLease(t *testing.T) {
	server, _ := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error": "no job with this id is held by this worker"}`)
	})

	err := newClient(t, server.URL).ReportDryRun(context.Background(), 11, queue.DryRunResult{
		ModelID: "owlvit-base-patch32.onnx",
	})

	if !errors.Is(err, queue.ErrLeaseLost) {
		t.Errorf("ReportDryRun() = %v, want ErrLeaseLost", err)
	}
}

func TestReportDryRunTreatsA400AsRejected(t *testing.T) {
	// A box outside [0, 1], a batch past the bound, or a job that is not a
	// dry-run: this worker's bug, identical on the next attempt, so the
	// pipeline retires it rather than leaving it for the reaper.
	server, _ := serverRecording(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error": "only a dry-run job can report a dry-run result"}`)
	})

	err := newClient(t, server.URL).ReportDryRun(context.Background(), 11, queue.DryRunResult{
		ModelID: "owlvit-base-patch32.onnx",
	})

	if !errors.Is(err, queue.ErrRejected) {
		t.Errorf("ReportDryRun() = %v, want ErrRejected", err)
	}
}
