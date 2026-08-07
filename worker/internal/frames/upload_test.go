package frames_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/frames"
)

// fakeS3 is frames.S3API, recording every call so the tests need no network —
// the whole point of declaring the interface on the consumer side (M8.3).
type fakeS3 struct {
	mu    sync.Mutex
	calls []*s3.PutObjectInput

	inFlight    int32
	maxInFlight int32

	// delay is how long PutObject waits before answering, so tests can make
	// calls overlap (to observe concurrency) or finish out of order.
	delay func(key string) time.Duration
	// failKey, if non-empty, is the one key PutObject reports an error for.
	failKey string
}

func (f *fakeS3) PutObject(ctx context.Context, params *s3.PutObjectInput, optFns ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	n := atomic.AddInt32(&f.inFlight, 1)
	defer atomic.AddInt32(&f.inFlight, -1)
	for {
		cur := atomic.LoadInt32(&f.maxInFlight)
		if n <= cur {
			break
		}
		if atomic.CompareAndSwapInt32(&f.maxInFlight, cur, n) {
			break
		}
	}

	key := aws.ToString(params.Key)

	f.mu.Lock()
	f.calls = append(f.calls, params)
	f.mu.Unlock()

	if f.failKey != "" && key == f.failKey {
		return nil, fmt.Errorf("simulated failure for %s", key)
	}

	if f.delay != nil {
		select {
		case <-time.After(f.delay(key)):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}

	return &s3.PutObjectOutput{}, nil
}

// frameFile writes a tiny file on disk and returns a Kept pointing at it.
// Upload reads Frame.Path over the wire, so the fixture has to be a real
// file, not just a struct literal — frames.Frame documents Path as "on disk".
func frameFile(t *testing.T, dir string, timestamp float64) frames.Kept {
	t.Helper()

	path := filepath.Join(dir, fmt.Sprintf("frame-%09.3f.jpg", timestamp))
	if err := os.WriteFile(path, []byte("jpeg bytes"), 0o644); err != nil {
		t.Fatalf("writing fixture frame: %v", err)
	}

	return frames.Kept{
		Frame: frames.Frame{Path: path, TimestampSeconds: timestamp},
		PHash: frames.Hash(0),
	}
}

func TestUploadEmptyInputIsANoOp(t *testing.T) {
	fake := &fakeS3{}
	u := frames.Uploader{Client: fake, Bucket: "crowdmon-frames"}

	keys, err := u.Upload(t.Context(), "video1", nil)
	if err != nil {
		t.Fatalf("Upload() with no frames returned an error: %v", err)
	}
	if keys != nil {
		t.Errorf("Upload() with no frames returned %v, want nil", keys)
	}
	if len(fake.calls) != 0 {
		t.Errorf("PutObject was called %d times for an empty upload", len(fake.calls))
	}
}

// The key format is frames.Key's alone (M8.3's idempotency argument), so this
// test pins the exact string rather than round-tripping through frames.Key —
// a bug in frames.Key itself would then pass silently on both sides.
func TestUploadKeysAndContentType(t *testing.T) {
	dir := t.TempDir()
	kept := []frames.Kept{
		frameFile(t, dir, 0),
		frameFile(t, dir, 123.4),
	}

	fake := &fakeS3{}
	u := frames.Uploader{Client: fake, Bucket: "crowdmon-frames"}

	keys, err := u.Upload(t.Context(), "dQw4w9WgXcQ", kept)
	if err != nil {
		t.Fatalf("Upload() returned an unexpected error: %v", err)
	}

	want := []string{
		"frames/dQw4w9WgXcQ/00000.000.jpg",
		"frames/dQw4w9WgXcQ/00123.400.jpg",
	}
	for i, w := range want {
		if keys[i] != w {
			t.Errorf("keys[%d] = %q, want %q", i, keys[i], w)
		}
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.calls) != len(want) {
		t.Fatalf("PutObject called %d times, want %d", len(fake.calls), len(want))
	}
	for _, call := range fake.calls {
		if aws.ToString(call.Bucket) != "crowdmon-frames" {
			t.Errorf("Bucket = %q, want crowdmon-frames", aws.ToString(call.Bucket))
		}
		if aws.ToString(call.ContentType) != "image/jpeg" {
			t.Errorf("ContentType = %q, want image/jpeg", aws.ToString(call.ContentType))
		}
	}
}

// The returned slice has to stay in input order even when the network answers
// out of order — Upload writes into a preallocated slice by index rather than
// appending under a mutex specifically to make this true.
func TestUploadReturnsKeysInInputOrder(t *testing.T) {
	dir := t.TempDir()
	var kept []frames.Kept
	for i := 0; i < 5; i++ {
		kept = append(kept, frameFile(t, dir, float64(i)))
	}

	// The first key gets the longest delay and each next one less, so
	// completion order is the exact reverse of input order — a naive
	// "append on completion" implementation would return the keys reversed.
	delays := map[string]time.Duration{
		frames.Key("video1", 0): 40 * time.Millisecond,
		frames.Key("video1", 1): 30 * time.Millisecond,
		frames.Key("video1", 2): 20 * time.Millisecond,
		frames.Key("video1", 3): 10 * time.Millisecond,
		frames.Key("video1", 4): 0,
	}
	fake := &fakeS3{delay: func(key string) time.Duration { return delays[key] }}

	u := frames.Uploader{Client: fake, Bucket: "b", Concurrency: len(kept)}

	keys, err := u.Upload(t.Context(), "video1", kept)
	if err != nil {
		t.Fatalf("Upload() returned an unexpected error: %v", err)
	}

	for i, k := range kept {
		want := frames.Key("video1", k.TimestampSeconds)
		if keys[i] != want {
			t.Errorf("keys[%d] = %q, want %q (input order, not completion order)", i, keys[i], want)
		}
	}
}

// Concurrency must be bounded (M8.3's acceptance criterion): more in-flight
// uploads than Uploader.Concurrency allows would contend for the home box's
// one uplink for no benefit (CONTEXT.md §Q13's fan-out amendment makes the
// identical argument about ffmpeg threads).
func TestUploadBoundsConcurrency(t *testing.T) {
	dir := t.TempDir()
	var kept []frames.Kept
	for i := 0; i < 12; i++ {
		kept = append(kept, frameFile(t, dir, float64(i)))
	}

	const bound = 3
	fake := &fakeS3{
		delay: func(string) time.Duration { return 20 * time.Millisecond },
	}
	u := frames.Uploader{Client: fake, Bucket: "b", Concurrency: bound}

	if _, err := u.Upload(t.Context(), "video1", kept); err != nil {
		t.Fatalf("Upload() returned an unexpected error: %v", err)
	}

	max := atomic.LoadInt32(&fake.maxInFlight)
	if max > bound {
		t.Errorf("max in-flight PutObject calls = %d, want <= %d", max, bound)
	}
	if max < bound {
		t.Errorf("max in-flight PutObject calls = %d, want exactly %d (concurrency never saturated — test isn't exercising the bound)", max, bound)
	}
}

// The zero value defaults to DefaultUploadConcurrency rather than serialising
// every upload, which would defeat the point of bounding concurrency instead
// of just not having any.
func TestUploadDefaultConcurrencyIsBounded(t *testing.T) {
	dir := t.TempDir()
	var kept []frames.Kept
	for i := 0; i < 12; i++ {
		kept = append(kept, frameFile(t, dir, float64(i)))
	}

	fake := &fakeS3{
		delay: func(string) time.Duration { return 20 * time.Millisecond },
	}
	u := frames.Uploader{Client: fake, Bucket: "b"} // Concurrency unset

	if _, err := u.Upload(t.Context(), "video1", kept); err != nil {
		t.Fatalf("Upload() returned an unexpected error: %v", err)
	}

	max := atomic.LoadInt32(&fake.maxInFlight)
	if max > frames.DefaultUploadConcurrency {
		t.Errorf("max in-flight PutObject calls = %d, want <= DefaultUploadConcurrency (%d)", max, frames.DefaultUploadConcurrency)
	}
}

// The first failure has to cancel the rest and name the key it happened on —
// a partial upload is safe only because the caller can tell what to retry
// stayed harmless, and the deterministic keys mean the retry is just "run the
// job again," not "figure out which objects made it."
func TestUploadFirstErrorCancelsAndNamesTheKey(t *testing.T) {
	dir := t.TempDir()
	kept := []frames.Kept{
		frameFile(t, dir, 0),
		frameFile(t, dir, 1),
		frameFile(t, dir, 2),
	}
	failing := frames.Key("video1", 1)

	fake := &fakeS3{
		failKey: failing,
		// The non-failing keys sleep, respecting ctx, so a working cancel
		// makes this test fast instead of hanging for the full delay.
		delay: func(string) time.Duration { return 2 * time.Second },
	}
	u := frames.Uploader{Client: fake, Bucket: "b", Concurrency: len(kept)}

	start := time.Now()
	keys, err := u.Upload(t.Context(), "video1", kept)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("Upload() succeeded, want an error from the simulated failure")
	}
	if keys != nil {
		t.Errorf("Upload() returned keys %v alongside an error, want nil", keys)
	}
	if !strings.Contains(err.Error(), failing) {
		t.Errorf("error %q does not name the failing key %q", err.Error(), failing)
	}
	if elapsed > time.Second {
		t.Errorf("Upload() took %v; cancellation should have cut short the other uploads' 2s delay", elapsed)
	}
}
