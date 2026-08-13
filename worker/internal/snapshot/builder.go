// Package snapshot builds the artifact M15.1 exists to produce: every image
// the inclusion policy currently admits, copied into one R2 prefix, and the
// manifest that ties each one to its labels and its train/eval split
// (M15.2).
package snapshot

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/queue"
)

// DefaultCopyConcurrency bounds how many CopyObject calls Build runs at
// once. frames.Uploader's own reasoning applies unchanged: the home box has
// 2 physical cores and one residential uplink, so beyond a handful of
// in-flight requests the concurrency buys nothing but contention.
const DefaultCopyConcurrency = 4

// ManifestName is the fixed filename every snapshot's manifest is written
// under, inside its own prefix.
const ManifestName = "manifest.json"

// S3API is the subset of *s3.Client Build calls, declared on the consumer
// side so tests substitute a fake with no network — frames.Uploader's own
// pattern (worker/internal/frames/upload.go).
type S3API interface {
	CopyObject(ctx context.Context, params *s3.CopyObjectInput, optFns ...func(*s3.Options)) (*s3.CopyObjectOutput, error)
	PutObject(ctx context.Context, params *s3.PutObjectInput, optFns ...func(*s3.Options)) (*s3.PutObjectOutput, error)
}

// Builder copies the images one snapshot admits into R2 under a single
// prefix and writes the manifest describing them — the whole of "images,
// labels and manifest written to R2 under a stable snapshot id"
// (ROADMAP.md M15.1).
//
// A server-side copy (S3's CopyObject), not a download followed by an
// upload: the bytes never pass through this process, which is the only way
// a box with one residential uplink can bundle a multi-thousand-image
// dataset without paying for its own bandwidth twice.
type Builder struct {
	Client      S3API
	Bucket      string
	Concurrency int // zero means DefaultCopyConcurrency
}

// ManifestLabel is one label on one manifest image — SnapshotLabel's shape,
// restated as a JSON-tagged struct because it is written to R2 rather than
// carried over the wire to this process's own caller.
type ManifestLabel struct {
	ClassName string  `json:"class_name"`
	XMin      float64 `json:"x_min"`
	YMin      float64 `json:"y_min"`
	XMax      float64 `json:"x_max"`
	YMax      float64 `json:"y_max"`
}

// ManifestImage is one image's entry in manifest.json. `R2Key` is relative
// to the snapshot's own prefix — the same key the source frame had under
// `frames/` — so the manifest reads correctly however the prefix it lives
// under is named, and does not repeat a job-specific path in every entry.
type ManifestImage struct {
	R2Key            string  `json:"r2_key"`
	VideoID          string  `json:"video_id"`
	TimestampSeconds float64 `json:"timestamp_seconds"`
	// Split is M15.2's whole rule, resolved once here rather than left for a
	// training script to compute: "train" or "eval". See splitFor.
	Split  string          `json:"split"`
	Labels []ManifestLabel `json:"labels"`
}

// manifest is the whole of manifest.json — one file rather than a separate
// labels.json, because every field here is read together by the one thing
// that ever reads it (a training script deciding what to feed itself), and
// two files describing the same set of images would only be two places the
// same fact could drift apart.
type manifest struct {
	Images []ManifestImage `json:"images"`
}

// splitFor is M15.2's whole rule: "holds selection_reason = 'random' images
// out of train" (ROADMAP.md). The random slice is the frozen evaluation
// pool (CONTEXT.md §Q16); everything else is train.
//
// Until M17 (plan §B), v2 never wrote a selection_reason other than
// "random" — the uncertain and diverse legs of the weighted mix are v4's
// (CONTEXT.md §Q16's amendment: "the column ships, the weighting does not")
// — so every admitted image really was "eval" in practice, and this
// function's `else` branch was reachable only through the nil case a
// pre-M11.3 row could carry. That was not a bug in this function: it was the
// honest consequence of v2 training nothing, and the reason this rule exists
// now rather than when v4 needs it is exactly §Q21's trap — a training
// script that globbed the directory instead of reading the manifest would
// not notice the difference until it had silently trained on the eval pool.
//
// M17 gives the `else` branch a second, deliberate way to reach it:
// "manual", an admin's hand-picked supplementary selection
// (`apps/api/src/routes/admin-prelabel.ts`). This function needed no change
// for that — it already treated "not random" as "train" — but the images
// that route flows through it are now the first ones this rule has ever
// actually routed into `train`, and it is worth being explicit here that
// this is the feature, not a side effect: a hand-picked frame is a biased
// sample by construction (CONTEXT.md §Q16), so it must never count toward
// the unbiased evaluation slice the mAP chart depends on.
func splitFor(reason *string) string {
	if reason != nil && *reason == "random" {
		return "eval"
	}
	return "train"
}

// Build copies every admitted image under prefix and writes prefix's
// manifest, returning what the snapshot contains.
func (b Builder) Build(
	ctx context.Context, prefix string, source queue.SnapshotSource,
) (queue.SnapshotArtifact, error) {
	images := make([]ManifestImage, len(source.Images))
	labelCount := 0

	for i, image := range source.Images {
		labels := make([]ManifestLabel, len(image.Labels))
		for j, label := range image.Labels {
			labels[j] = ManifestLabel{
				ClassName: label.ClassName,
				XMin:      label.XMin,
				YMin:      label.YMin,
				XMax:      label.XMax,
				YMax:      label.YMax,
			}
		}
		labelCount += len(labels)

		images[i] = ManifestImage{
			R2Key:            image.Key,
			VideoID:          image.VideoID,
			TimestampSeconds: image.TimestampSeconds,
			Split:            splitFor(image.SelectionReason),
			Labels:           labels,
		}
	}

	if err := b.copyAll(ctx, prefix, source.Images); err != nil {
		return queue.SnapshotArtifact{}, err
	}

	if err := b.putManifest(ctx, prefix, manifest{Images: images}); err != nil {
		return queue.SnapshotArtifact{}, err
	}

	return queue.SnapshotArtifact{
		R2Key:      prefix,
		ImageCount: len(images),
		LabelCount: labelCount,
	}, nil
}

// copyAll copies every image's object under prefix, bounded by Concurrency —
// frames.Uploader.Upload's own shape: a semaphore channel, results awaited
// by a WaitGroup, and the first error cancelling every copy still in flight.
//
// A partial copy is safe to re-run for the reason a partial upload is
// (frames.Uploader.Upload's own comment): the destination key is
// deterministic in (prefix, image key), so the next attempt overwrites
// exactly the objects that did not make it and duplicates nothing.
func (b Builder) copyAll(ctx context.Context, prefix string, images []queue.SnapshotImage) error {
	if len(images) == 0 {
		return nil
	}

	concurrency := b.Concurrency
	if concurrency <= 0 {
		concurrency = DefaultCopyConcurrency
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	sem := make(chan struct{}, concurrency)

	var (
		wg       sync.WaitGroup
		errOnce  sync.Once
		firstErr error
	)

	for _, image := range images {
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			wg.Wait()
			if firstErr != nil {
				return firstErr
			}
			return ctx.Err()
		}

		wg.Add(1)
		go func(key string) {
			defer wg.Done()
			defer func() { <-sem }()

			if err := b.copyOne(ctx, prefix, key); err != nil {
				errOnce.Do(func() {
					firstErr = fmt.Errorf("copying %s: %w", key, err)
					cancel()
				})
			}
		}(image.Key)
	}

	wg.Wait()
	return firstErr
}

func (b Builder) copyOne(ctx context.Context, prefix, key string) error {
	_, err := b.Client.CopyObject(ctx, &s3.CopyObjectInput{
		Bucket:      aws.String(b.Bucket),
		Key:         aws.String(prefix + "/" + key),
		CopySource:  aws.String(copySource(b.Bucket, key)),
		ContentType: aws.String("image/jpeg"),
	})
	return err
}

// copySource builds S3's CopySource header value — "bucket/key",
// percent-encoded per path segment. `url.PathEscape` rather than
// `url.QueryEscape`: the latter turns a literal space into `+`, which S3
// does not decode back on the read side, and CopySource is parsed as a path,
// not a query string.
//
// Every key frames.Key produces (a fixed prefix, a YouTube video id, and a
// zero-padded timestamp) is already URL-safe, so this is defensive rather
// than load-bearing today — but a hand-rolled CopySource is exactly the kind
// of thing that works in every test and breaks on the one deployment with an
// unusual character in a title-derived path, and escaping costs nothing to
// get right up front.
func copySource(bucket, key string) string {
	segments := strings.Split(key, "/")
	for i, segment := range segments {
		segments[i] = url.PathEscape(segment)
	}
	return bucket + "/" + strings.Join(segments, "/")
}

func (b Builder) putManifest(ctx context.Context, prefix string, m manifest) error {
	body, err := json.Marshal(m)
	if err != nil {
		return fmt.Errorf("encoding the manifest: %w", err)
	}

	_, err = b.Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(b.Bucket),
		Key:         aws.String(prefix + "/" + ManifestName),
		Body:        bytes.NewReader(body),
		ContentType: aws.String("application/json"),
	})
	if err != nil {
		return fmt.Errorf("writing the manifest: %w", err)
	}
	return nil
}
