package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/queue"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/telemetry"
)

// The regression M11.4 fixed: queue.StatusCounts grew a Prelabel field in
// M11.1, but this adapter kept building its slice from a fixed eight-entry
// literal that never mentioned it — decoded off the wire by queue.Client.Stats
// and then silently dropped on the way into the gauge. A drained prelabel
// queue and a worker that had never reported it would have looked identical
// in Prometheus, which is exactly the failure NewQueueDepthGauge's own doc
// comment says queue_depth exists to rule out. This test would have failed
// against that version: it asserts every (status, kind) pair the stats
// endpoint's zero-fill promises, prelabel included, not just that the call
// succeeds.
func TestQueueDepthCountsIncludesPrelabel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{
			"pending": {"download": 1, "chunk": 5,  "prelabel": 2},
			"claimed": {"download": 0, "chunk": 1,  "prelabel": 1},
			"done":    {"download": 40, "chunk": 300, "prelabel": 12},
			"failed":  {"download": 0, "chunk": 2,  "prelabel": 3}
		}`)
	}))
	defer server.Close()

	jobs, err := queue.New(server.URL, "worker-under-test")
	if err != nil {
		t.Fatalf("queue.New() returned an unexpected error: %v", err)
	}

	got, err := queueDepthCounts(jobs)(context.Background())
	if err != nil {
		t.Fatalf("queueDepthCounts fetcher returned an unexpected error: %v", err)
	}

	want := []telemetry.QueueCount{
		{Status: "pending", Kind: "download", Count: 1},
		{Status: "pending", Kind: "chunk", Count: 5},
		{Status: "pending", Kind: "prelabel", Count: 2},
		{Status: "claimed", Kind: "download", Count: 0},
		{Status: "claimed", Kind: "chunk", Count: 1},
		{Status: "claimed", Kind: "prelabel", Count: 1},
		{Status: "done", Kind: "download", Count: 40},
		{Status: "done", Kind: "chunk", Count: 300},
		{Status: "done", Kind: "prelabel", Count: 12},
		{Status: "failed", Kind: "download", Count: 0},
		{Status: "failed", Kind: "chunk", Count: 2},
		{Status: "failed", Kind: "prelabel", Count: 3},
	}

	if len(got) != len(want) {
		t.Fatalf("queueDepthCounts returned %d entries, want %d (twelve — four statuses times three kinds): %+v",
			len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("entry %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}
