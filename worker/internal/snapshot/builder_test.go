package snapshot_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/queue"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/snapshot"
)

func readAll(r io.Reader) ([]byte, error) { return io.ReadAll(r) }

// fakeS3 is snapshot.S3API, recording every call so the tests need no
// network — frames.Uploader's own fakeS3 does the identical thing for
// PutObject alone (worker/internal/frames/upload_test.go).
type fakeS3 struct {
	mu     sync.Mutex
	puts   []*s3.PutObjectInput
	copies []*s3.CopyObjectInput

	// failKey, if non-empty, is the one CopySource CopyObject reports an
	// error for.
	failKey string
}

func (f *fakeS3) CopyObject(_ context.Context, params *s3.CopyObjectInput, _ ...func(*s3.Options)) (*s3.CopyObjectOutput, error) {
	f.mu.Lock()
	f.copies = append(f.copies, params)
	f.mu.Unlock()

	if f.failKey != "" && aws.ToString(params.CopySource) == f.failKey {
		return nil, fmt.Errorf("simulated failure for %s", f.failKey)
	}
	return &s3.CopyObjectOutput{}, nil
}

func (f *fakeS3) PutObject(_ context.Context, params *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	f.mu.Lock()
	f.puts = append(f.puts, params)
	f.mu.Unlock()
	return &s3.PutObjectOutput{}, nil
}

func strPtr(s string) *string { return &s }

func TestBuildEmptySourceWritesOnlyAnEmptyManifest(t *testing.T) {
	fake := &fakeS3{}
	b := snapshot.Builder{Client: fake, Bucket: "crowdmon-frames"}

	artifact, err := b.Build(t.Context(), "snapshots/job-1", queue.SnapshotSource{})
	if err != nil {
		t.Fatalf("Build() returned an unexpected error: %v", err)
	}

	if artifact.ImageCount != 0 || artifact.LabelCount != 0 {
		t.Errorf("artifact = %+v, want zero counts", artifact)
	}
	if len(fake.copies) != 0 {
		t.Errorf("CopyObject called %d times for an empty source", len(fake.copies))
	}
	if len(fake.puts) != 1 {
		t.Fatalf("PutObject called %d times, want exactly one manifest write", len(fake.puts))
	}
}

// The property M15.1 and M15.2 both exist to hold down: every admitted image
// is copied under the snapshot's own prefix, and the manifest resolves each
// one's labels and split from what the source reported.
func TestBuildCopiesImagesAndWritesTheManifest(t *testing.T) {
	fake := &fakeS3{}
	b := snapshot.Builder{Client: fake, Bucket: "crowdmon-frames"}

	source := queue.SnapshotSource{
		Images: []queue.SnapshotImage{
			{
				Key:              "frames/dQw4w9WgXcQ/00000.000.jpg",
				VideoID:          "dQw4w9WgXcQ",
				TimestampSeconds: 0,
				SelectionReason:  strPtr("random"),
				Labels: []queue.SnapshotLabel{
					{ClassName: "Paimon", XMin: 0.1, YMin: 0.1, XMax: 0.4, YMax: 0.5},
				},
			},
			{
				// No selection_reason at all — unreachable in v2 in practice
				// (every predicted image has been stamped), but splitFor must
				// still answer something rather than panic on a nil pointer,
				// and the honest answer for "not random" is "train".
				Key:              "frames/other11111/00042.000.jpg",
				VideoID:          "other11111",
				TimestampSeconds: 42,
				SelectionReason:  nil,
				Labels: []queue.SnapshotLabel{
					{ClassName: "Paimon", XMin: 0.2, YMin: 0.2, XMax: 0.3, YMax: 0.3},
					{ClassName: "Klee", XMin: 0.5, YMin: 0.5, XMax: 0.6, YMax: 0.6},
				},
			},
		},
	}

	artifact, err := b.Build(t.Context(), "snapshots/job-142", source)
	if err != nil {
		t.Fatalf("Build() returned an unexpected error: %v", err)
	}

	if artifact.R2Key != "snapshots/job-142" {
		t.Errorf("R2Key = %q, want the prefix", artifact.R2Key)
	}
	if artifact.ImageCount != 2 {
		t.Errorf("ImageCount = %d, want 2", artifact.ImageCount)
	}
	if artifact.LabelCount != 3 {
		t.Errorf("LabelCount = %d, want 3 (1 + 2)", artifact.LabelCount)
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()

	if len(fake.copies) != 2 {
		t.Fatalf("CopyObject called %d times, want one per image", len(fake.copies))
	}
	byDest := map[string]*s3.CopyObjectInput{}
	for _, c := range fake.copies {
		byDest[aws.ToString(c.Key)] = c
	}

	first, ok := byDest["snapshots/job-142/frames/dQw4w9WgXcQ/00000.000.jpg"]
	if !ok {
		t.Fatal("no copy destined for the first image's snapshot-prefixed key")
	}
	if aws.ToString(first.CopySource) != "crowdmon-frames/frames/dQw4w9WgXcQ/00000.000.jpg" {
		t.Errorf("CopySource = %q, want bucket/original-key", aws.ToString(first.CopySource))
	}
	if aws.ToString(first.Bucket) != "crowdmon-frames" {
		t.Errorf("Bucket = %q, want crowdmon-frames", aws.ToString(first.Bucket))
	}

	if len(fake.puts) != 1 {
		t.Fatalf("PutObject called %d times, want exactly one manifest write", len(fake.puts))
	}
	manifestPut := fake.puts[0]
	if aws.ToString(manifestPut.Key) != "snapshots/job-142/manifest.json" {
		t.Errorf("manifest key = %q, want prefix/manifest.json", aws.ToString(manifestPut.Key))
	}

	var decoded struct {
		Images []struct {
			R2Key            string  `json:"r2_key"`
			VideoID          string  `json:"video_id"`
			TimestampSeconds float64 `json:"timestamp_seconds"`
			Split            string  `json:"split"`
			Labels           []struct {
				ClassName string `json:"class_name"`
			} `json:"labels"`
		} `json:"images"`
	}
	body, err := readAll(manifestPut.Body)
	if err != nil {
		t.Fatalf("reading the manifest body: %v", err)
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("decoding the manifest: %v", err)
	}

	if len(decoded.Images) != 2 {
		t.Fatalf("manifest carries %d images, want 2", len(decoded.Images))
	}

	// The property M15.2 exists for: selection_reason = 'random' is held out
	// of train, everything else lands in it.
	if decoded.Images[0].Split != "eval" {
		t.Errorf("image 0 split = %q, want eval (selection_reason=random)", decoded.Images[0].Split)
	}
	if decoded.Images[1].Split != "train" {
		t.Errorf("image 1 split = %q, want train (no selection_reason)", decoded.Images[1].Split)
	}
	if len(decoded.Images[1].Labels) != 2 {
		t.Errorf("image 1 carries %d labels, want 2", len(decoded.Images[1].Labels))
	}
}

// TestBuildRoutesManualSelectionToTrainAndRandomToEval is the Go half of the
// M17 plan's required end-to-end test (plan §"Required tests": "a
// hand-picked pass writes manual, and a snapshot built afterwards puts those
// images in the train split while random images stay in eval — end to end
// through splitFor"). The TypeScript half
// (apps/api/test/workers/admin-prelabel.test.ts) proves
// `createPrelabelHandler` and `reportPredictionsHandler` actually write
// `manual` onto `images.selection_reason` for a hand-picked pass; this test
// proves the other end of the pipe — once that value reaches
// `queue.SnapshotSource` (via `GET /api/jobs/{id}/snapshot-source`, which
// echoes the column verbatim), `splitFor` routes it to `train`, distinctly
// from a `random` image in the same build, which stays in `eval`.
//
// Both `TestBuildCopiesImagesAndWritesTheManifest` above and this test
// exercise `splitFor`'s "not random -> train" branch, but only this one
// spells out that the non-random reason is a hand-picked selection rather
// than the reachable-but-inert nil case that test also carries — the
// distinction CONTEXT.md §Q16's non-negotiable rule is actually about.
func TestBuildRoutesManualSelectionToTrainAndRandomToEval(t *testing.T) {
	fake := &fakeS3{}
	b := snapshot.Builder{Client: fake, Bucket: "crowdmon-frames"}

	source := queue.SnapshotSource{
		Images: []queue.SnapshotImage{
			{
				// The automatic first pass's own reason (M11.1): an unbiased
				// draw across the whole timeline, so it stays out of train
				// forever.
				Key:              "frames/dQw4w9WgXcQ/00000.000.jpg",
				VideoID:          "dQw4w9WgXcQ",
				TimestampSeconds: 0,
				SelectionReason:  strPtr("random"),
				Labels:           []queue.SnapshotLabel{{ClassName: "Paimon", XMax: 0.5, YMax: 0.5}},
			},
			{
				// An admin's hand-picked supplementary selection (M17, plan
				// §B): a biased sample by construction, so it is the first
				// kind of image this rule was ever meant to route into
				// train.
				Key:              "frames/dQw4w9WgXcQ/00042.000.jpg",
				VideoID:          "dQw4w9WgXcQ",
				TimestampSeconds: 42,
				SelectionReason:  strPtr("manual"),
				Labels:           []queue.SnapshotLabel{{ClassName: "Paimon", XMax: 0.4, YMax: 0.4}},
			},
		},
	}

	artifact, err := b.Build(t.Context(), "snapshots/job-200", source)
	if err != nil {
		t.Fatalf("Build() returned an unexpected error: %v", err)
	}
	if artifact.ImageCount != 2 {
		t.Fatalf("ImageCount = %d, want 2", artifact.ImageCount)
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()

	if len(fake.puts) != 1 {
		t.Fatalf("PutObject called %d times, want exactly one manifest write", len(fake.puts))
	}

	var decoded struct {
		Images []struct {
			R2Key string `json:"r2_key"`
			Split string `json:"split"`
		} `json:"images"`
	}
	body, err := readAll(fake.puts[0].Body)
	if err != nil {
		t.Fatalf("reading the manifest body: %v", err)
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("decoding the manifest: %v", err)
	}

	splitByKey := map[string]string{}
	for _, image := range decoded.Images {
		splitByKey[image.R2Key] = image.Split
	}

	if got := splitByKey["frames/dQw4w9WgXcQ/00000.000.jpg"]; got != "eval" {
		t.Errorf("random image split = %q, want eval — the permanent evaluation pool (CONTEXT.md §Q16)", got)
	}
	if got := splitByKey["frames/dQw4w9WgXcQ/00042.000.jpg"]; got != "train" {
		t.Errorf("manual image split = %q, want train — a hand-picked frame is a biased sample by construction", got)
	}
}

// TestBuildRoutesDiverseSelectionToTrain is M25's whole claim, and the plan
// says so in as many words: "A test that a `diverse` image lands in the train
// split of a built snapshot. That is the milestone's whole claim, and it is
// one `splitFor()` call away from being provable."
//
// Worth its own test rather than a third image in the one above, because it
// is asserting something different. That test proves `splitFor` distinguishes
// two reasons; this one proves the *specific* string the M25 selector writes
// (`apps/api/src/selection.ts`, stamped by `createPrelabelHandler` and
// `reportPredictionsHandler`) is routed to train — a typo anywhere along that
// chain would still route to train here, since "not random" is the whole
// rule, but this test is where the value is spelled out in Go so that a
// rename on the TypeScript side has a place to fail.
//
// Measured against production on 2026-08-27, before M25: 1,013 sampled
// images, every one of them `random`, and a snapshot built that day would
// have contained zero train-split images. That is what this test exists to
// stop being true.
func TestBuildRoutesDiverseSelectionToTrain(t *testing.T) {
	fake := &fakeS3{}
	b := snapshot.Builder{Client: fake, Bucket: "crowdmon-frames"}

	source := queue.SnapshotSource{
		Images: []queue.SnapshotImage{
			{
				// Unchanged and non-negotiable: the frozen evaluation pool
				// (CONTEXT.md §Q16). M25 adds a selector beside this one, it
				// does not touch this one.
				Key:              "frames/dQw4w9WgXcQ/00000.000.jpg",
				VideoID:          "dQw4w9WgXcQ",
				TimestampSeconds: 0,
				SelectionReason:  strPtr("random"),
				Labels:           []queue.SnapshotLabel{{ClassName: "Paimon", XMax: 0.5, YMax: 0.5}},
			},
			{
				// The pHash farthest-point draw (M25, plan §A): biased on
				// purpose, which is exactly what makes it training data.
				Key:              "frames/dQw4w9WgXcQ/00099.000.jpg",
				VideoID:          "dQw4w9WgXcQ",
				TimestampSeconds: 99,
				SelectionReason:  strPtr("diverse"),
				Labels:           []queue.SnapshotLabel{{ClassName: "Paimon", XMax: 0.3, YMax: 0.3}},
			},
		},
	}

	artifact, err := b.Build(t.Context(), "snapshots/job-250", source)
	if err != nil {
		t.Fatalf("Build() returned an unexpected error: %v", err)
	}
	if artifact.ImageCount != 2 {
		t.Fatalf("ImageCount = %d, want 2", artifact.ImageCount)
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()

	var decoded struct {
		Images []struct {
			R2Key string `json:"r2_key"`
			Split string `json:"split"`
		} `json:"images"`
	}
	body, err := readAll(fake.puts[0].Body)
	if err != nil {
		t.Fatalf("reading the manifest body: %v", err)
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("decoding the manifest: %v", err)
	}

	splitByKey := map[string]string{}
	for _, image := range decoded.Images {
		splitByKey[image.R2Key] = image.Split
	}

	if got := splitByKey["frames/dQw4w9WgXcQ/00099.000.jpg"]; got != "train" {
		t.Errorf("diverse image split = %q, want train — this is the whole of M25", got)
	}
	if got := splitByKey["frames/dQw4w9WgXcQ/00000.000.jpg"]; got != "eval" {
		t.Errorf("random image split = %q, want eval — adding a selector must not thaw the frozen pool", got)
	}

	// The count, not just the routing: a manifest that admitted the diverse
	// image and quietly dropped the random one would satisfy both checks
	// above and still be a snapshot with no evaluation set.
	trains, evals := 0, 0
	for _, image := range decoded.Images {
		switch image.Split {
		case "train":
			trains++
		case "eval":
			evals++
		default:
			t.Errorf("image %s carries split %q, which is neither train nor eval", image.R2Key, image.Split)
		}
	}
	if trains != 1 || evals != 1 {
		t.Errorf("manifest has %d train and %d eval images, want 1 of each", trains, evals)
	}
}

// The first copy failure has to cancel the rest and name the key it happened
// on, matching frames.Uploader.Upload's own guarantee — a partial copy is
// safe to retry only because the caller can tell what broke.
func TestBuildFirstCopyErrorStopsTheBuild(t *testing.T) {
	failing := "crowdmon-frames/frames/bad/00000.000.jpg"
	fake := &fakeS3{failKey: failing}
	b := snapshot.Builder{Client: fake, Bucket: "crowdmon-frames"}

	source := queue.SnapshotSource{
		Images: []queue.SnapshotImage{
			{Key: "frames/bad/00000.000.jpg", VideoID: "bad", Labels: []queue.SnapshotLabel{{ClassName: "Paimon"}}},
		},
	}

	_, err := b.Build(t.Context(), "snapshots/job-1", source)
	if err == nil {
		t.Fatal("Build() succeeded, want an error from the simulated copy failure")
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.puts) != 0 {
		t.Errorf("manifest was written despite a failed copy — a partial build must not look finished")
	}
}
